/* ==========================================================
   BarrilFacil — regras de negócio (API do servidor) — versão Supabase
   Toda operação passa por aqui: valida permissão, grava no
   banco e registra quem fez (movimentação + auditoria).
   Cada aparelho tem a própria sessão (cookie).

   Mudanças em relação à versão SQLite:
   - Tudo é assíncrono (await). O estado da requisição (usuário logado,
     IP, pedido de login/logout) agora vive num objeto `ctx` por requisição,
     e não mais em variáveis globais (que se misturariam com await).
   - Operações com várias gravações (engatar, esgotar, transferir...) rodam
     como funções SQL (RPC) no Supabase: ou gravam tudo, ou nada.
   ========================================================== */
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { supabase } = require("./supabase");
const teknisa = require("./teknisa");

const handlers = new Map();   // canal -> { fn, auth, perm }

const CARGO_LABEL = { admin: "Administrador", gerente: "Gerente", operador: "Operador" };

/* ---------- Permissões (num lugar só) ----------
   O que cada cargo pode fazer além do dia a dia (barris, engates, transferências, histórico e relatório),
   que é de todos. As rotas pedem uma permissão com handle(canal, fn, { perm }) e as telas perguntam com MC.pode(). */
const PERMISSOES_TODAS = ["usuarios", "unidades", "auditoria", "exportar", "catalogo:editar", "funcionarios", "vendas", "torneiras:horario"];
const PERMISSOES = {
  admin: PERMISSOES_TODAS,
  gerente: ["catalogo:editar", "funcionarios", "vendas", "torneiras:horario"],
  operador: [],
};
const pode = (user, perm) => !!user && (PERMISSOES[user.cargo] || []).includes(perm);

/* ---------- Infraestrutura ---------- */
// Sessão sem uso: administrador e gerente (contas pessoais) saem após 15 min. Operador é a conta compartilhada do
// celular do quiosque, que fica parado boa parte do dia: sai após 12 h (quem fez cada ação é escolhido na própria ação).
const IDLE_MS = 15 * 60 * 1000;
const IDLE_OPERADOR_MS = 12 * 60 * 60 * 1000;
const idleDe = (user) => (user && user.cargo === "operador" ? IDLE_OPERADOR_MS : IDLE_MS);
const MAX_FALHAS = 5;                     // tentativas erradas antes de bloquear
const BLOQUEIO_MS = 15 * 60 * 1000;       // duração do bloqueio
const PERMITIDOS_TROCA = new Set(["auth:me", "session:bootstrap", "auth:logout", "auth:ping", "auth:completeProfile"]);

// Fuso da operação, usado para mostrar datas (APP_TZ no .env; APP_TIMEZONE é o nome antigo e continua aceito)
const TZ = process.env.APP_TZ || process.env.APP_TIMEZONE || "America/Cuiaba";
const tsFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fmtTs = (v) => (v ? tsFmt.format(new Date(v)) : null); // "AAAA-MM-DD HH:MM:SS"
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hojeTZ = () => dayFmt.format(new Date()); // "AAAA-MM-DD" de hoje no fuso da operação (nunca em UTC)
const somaDias = (dia, n) => {                  // "AAAA-MM-DD" + n dias
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const diaMes = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`; // "2026-10-22" -> "22/10"
// Instante em que o dia "AAAA-MM-DD" começa no fuso da operação (ex.: 2026-10-01 em Cuiabá = 2026-10-01T04:00:00Z)
const inicioDoDia = (dia) => {
  const meiaNoiteUTC = new Date(`${dia}T00:00:00Z`);
  const lidoNoFuso = new Date(tsFmt.format(meiaNoiteUTC).replace(" ", "T") + "Z");
  return new Date(meiaNoiteUTC.getTime() - (lidoNoFuso - meiaNoiteUTC));
};
/* "AAAA-MM-DDTHH:MM" lido no fuso da operação -> instante (Date). Formato ou data inválidos -> null.
   Usado no "Lançar com horário": a pessoa informa o dia e a hora como no relógio da loja. */
const instanteNoFuso = (texto) => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(texto || "").trim());
  if (!m) return null;
  const alvo = new Date(`${m[1]}T${m[2]}:00Z`);
  if (Number.isNaN(alvo.getTime()) || alvo.toISOString().slice(0, 16) !== `${m[1]}T${m[2]}`) return null; // 31/02, 25:00...
  const lidoNoFuso = new Date(tsFmt.format(alvo).replace(" ", "T") + "Z");
  return new Date(alvo.getTime() - (lidoNoFuso - alvo));
};
// Quem entrega os barris: aparece como origem das entradas no histórico (NOME_FORNECEDOR no .env)
const FORNECEDOR = String(process.env.NOME_FORNECEDOR || "").trim() || "Fornecedor";
// APP_ENV=beta marca o ambiente de testes (as telas mostram a faixa amarela). Sem APP_ENV: servidor das lojas.
const AMBIENTE = String(process.env.APP_ENV || "").trim().toLowerCase() || null;
// Densidade do chope (kg por litro) para converter o peso da balança em litros. Fica só aqui: vai para as telas
// (config.densidade, para mostrar os litros enquanto a pessoa digita) e é copiada em cada pesagem gravada.
const DENSIDADE_CHOPE = 1.01;
const b2i = (v) => (v ? 1 : 0);

class AppError extends Error {
  constructor(message, code, detail, info) {
    super(message);
    this.appCode = code;
    this.detail = detail;
    this.info = info; // dados extras que a tela usa (vão na resposta junto com o erro)
  }
}

/* auth: true exige sessão; false dispensa; "opcional" usa a sessão se houver uma válida (ex.: config:get na tela de login).
   perm: permissão que o cargo precisa ter (tabela PERMISSOES); sem perm, qualquer usuário logado. */
function handle(channel, fn, { auth = true, perm = null } = {}) {
  handlers.set(channel, { fn, auth, perm });
}

/* Converte erro do Supabase/Postgres em erro do app.
   P0001 = "raise exception" das funções SQL (mensagem pronta para o usuário). */
function dbError(error, dupMsg) {
  if (!error) return;
  if (error.code === "23505") throw new AppError(dupMsg || "Já existe um registro com esse valor.");
  if (error.code === "P0001") {
    // Retirada com chope que deu 0,5 L ou menos: a tela pergunta se marca o barril como vazio
    const quase = /^QUASE_VAZIO:([\d.]+)$/.exec(error.hint || "");
    if (quase) throw new AppError(error.message, "QUASE_VAZIO", null, { litros: Number(quase[1]) });
    // Erro de um campo do lançamento com horário: a tela marca o campo (ret, eng, barril, torneira, funcionario)
    const campo = /^CAMPO:(\w+)$/.exec(error.hint || "");
    if (campo) throw new AppError(error.message, "CAMPO", null, { campo: campo[1] });
    throw new AppError(error.message);
  }
  console.error("[supabase]", error);
  throw new Error(error.message || "Falha no banco de dados.");
}
const ok = (res, dupMsg) => { dbError(res.error, dupMsg); return res.data; };
const rpc = async (fn, args) => ok(await supabase.rpc(fn, args));

/* Remove caracteres que quebrariam filtros .or()/.ilike() do PostgREST */
const cleanTerm = (q) => String(q || "").replace("#", "").replace(/[,()%*\\_]/g, "").trim();

/* Limite de tentativas de login por aparelho/IP (somado ao bloqueio por conta) */
const IP_MAX = 30;
const IP_WINDOW_MS = 15 * 60 * 1000;
const ipFails = new Map();
const ipBlocked = (ip) => {
  const r = ipFails.get(ip);
  if (!r) return false;
  if (Date.now() > r.reset) { ipFails.delete(ip); return false; }
  return r.count >= IP_MAX;
};
const ipFail = (ip) => {
  if (ipFails.size > 5000) ipFails.clear();
  const r = ipFails.get(ip);
  if (!r || Date.now() > r.reset) ipFails.set(ip, { count: 1, reset: Date.now() + IP_WINDOW_MS });
  else r.count += 1;
};
const ipInfo = (ctx) => (ctx.clientIp ? ` (IP ${ctx.clientIp})` : "");

/* ---------- Auditoria ---------- */
async function audit(ctx, acao, detalhe, userId) {
  const uid = userId !== undefined ? userId : ctx.session ? ctx.session.id : null;
  const { error } = await supabase.from("auditoria").insert({ usuario_id: uid, acao, detalhe: detalhe || null });
  if (error) console.error("[auditoria]", error.message);
}

/* ---------- Sessões ----------
   Cada login vira uma linha em public.sessoes com o hash SHA-256 do token (o token em si só existe no cookie
   mc_session). Assim a sessão sobrevive a uma atualização do servidor, e desativar um usuário derruba a sessão dele.
   Cache em memória: a sessão lida do banco vale 60 s. Depois disso é relida junto com os dados atuais do usuário,
   então mudança de nome, cargo ou senha vale em até 60 s. ultima_atividade vai para o banco no máximo uma vez por minuto. */
const CACHE_SESSAO_MS = 60 * 1000;
const GRAVA_ATIVIDADE_MS = 60 * 1000;
const sessionCache = new Map(); // hash do token -> { hash, usuarioId, ativo, user, ultimaAtividade, gravadaEm, lidaEm }
const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* Sessão do token, do cache (lida há menos de 60 s) ou do banco. null = não existe.
   Falha do banco sobe como erro técnico: a chamada nunca passa sem sessão. */
async function buscarSessao(token) {
  const hash = hashToken(token);
  const agora = Date.now();
  const c = sessionCache.get(hash);
  if (c && agora - c.lidaEm < CACHE_SESSAO_MS) return c;
  const r = await supabase.from("sessoes")
    .select("ultima_atividade, usuarios(id, nome, email, usuario, cargo, ativo, trocar_senha)")
    .eq("token_hash", hash).maybeSingle();
  dbError(r.error);
  if (!r.data || !r.data.usuarios) { sessionCache.delete(hash); return null; }
  const u = r.data.usuarios;
  const gravada = new Date(r.data.ultima_atividade).getTime();
  const rec = {
    hash, usuarioId: u.id, ativo: !!u.ativo, user: publicUser(u),
    ultimaAtividade: Math.max(gravada, c ? c.ultimaAtividade : 0), // a memória pode estar até 1 min à frente do banco
    gravadaEm: Math.max(gravada, c ? c.gravadaEm : 0),
    lidaEm: agora,
  };
  sessionCache.set(hash, rec);
  return rec;
}

async function criarSessao(user, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = hashToken(token);
  dbError((await supabase.from("sessoes").insert({ token_hash: hash, usuario_id: user.id, ip: ip || null })).error);
  const agora = Date.now();
  sessionCache.set(hash, { hash, usuarioId: user.id, ativo: true, user, ultimaAtividade: agora, gravadaEm: agora, lidaEm: agora });
  return token;
}

async function apagarSessao(hash) {
  sessionCache.delete(hash);
  dbError((await supabase.from("sessoes").delete().eq("token_hash", hash)).error);
}

async function marcarAtividade(rec) {
  const agora = Date.now();
  rec.ultimaAtividade = agora;
  if (agora - rec.gravadaEm < GRAVA_ATIVIDADE_MS) return;
  rec.gravadaEm = agora;
  const { error } = await supabase.from("sessoes").update({ ultima_atividade: new Date(agora).toISOString() }).eq("token_hash", rec.hash);
  if (error) console.error("[sessoes] atividade:", error.message);
}

/* Derruba as sessões do usuário, no banco e no cache. excetoToken: a sessão de quem fez a ação continua aberta. */
async function encerrarSessoes(usuarioId, { excetoToken } = {}) {
  const exceto = excetoToken ? hashToken(excetoToken) : null;
  for (const [hash, rec] of sessionCache) if (rec.usuarioId === usuarioId && hash !== exceto) sessionCache.delete(hash);
  let q = supabase.from("sessoes").delete().eq("usuario_id", usuarioId);
  if (exceto) q = q.neq("token_hash", exceto);
  dbError((await q).error);
}

/* Só esquece o cache do usuário: a próxima chamada dele busca os dados novos no banco */
function recarregarSessoes(usuarioId) {
  for (const [hash, rec] of sessionCache) if (rec.usuarioId === usuarioId) sessionCache.delete(hash);
}

/* Esquece as unidades liberadas guardadas em todas as sessões (ver allowedUnitIds): uma unidade foi criada, ativada
   ou desativada, e isso muda o que cada um vê */
function esquecerUnidadesDasSessoes() {
  for (const rec of sessionCache.values()) delete rec.unidades;
}

/* Executa uma operação para o aparelho identificado por `token` (cookie de sessão).
   Retorna { body, setToken?, clearToken? }. */
async function dispatch(channel, payload, token, meta = {}) {
  const entry = handlers.get(channel);
  if (!entry) return { body: { ok: false, error: "Operação desconhecida.", code: "NOT_FOUND" } };
  const { fn, auth, perm } = entry;
  const ctx = { session: null, sessionAction: null, clientIp: meta.ip || "", token: token || null };

  let body;
  try {
    if (channel === "auth:login" && ipBlocked(ctx.clientIp))
      throw new AppError("Muitas tentativas deste aparelho. Aguarde alguns minutos.");
    if (auth === "opcional") {
      const rec = token ? await buscarSessao(token) : null;
      if (rec && rec.ativo && Date.now() - rec.ultimaAtividade <= idleDe(rec.user)) { ctx.session = rec.user; ctx.sessao = rec; }
    } else if (auth) {
      const rec = token ? await buscarSessao(token) : null;
      if (!rec) throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      if (!rec.ativo) {
        await apagarSessao(rec.hash);
        throw new AppError("Sessão expirada. Faça login novamente.", "SESSION");
      }
      if (Date.now() - rec.ultimaAtividade > idleDe(rec.user)) {
        ctx.session = rec.user; // a auditoria registra de quem era a sessão
        await audit(ctx, "sessao_expirada", "Encerrada por inatividade");
        ctx.session = null;
        await apagarSessao(rec.hash);
        throw new AppError("Sua sessão expirou por inatividade. Entre novamente.", "SESSION");
      }
      ctx.session = rec.user;
      ctx.sessao = rec; // a sessão em memória (allowedUnitIds guarda nela as unidades liberadas)
      if (ctx.session.trocarSenha && !PERMITIDOS_TROCA.has(channel))
        throw new AppError("Defina sua senha para continuar.", "MUST_CHANGE");
      await marcarAtividade(rec);
    }
    if (perm && !pode(ctx.session, perm)) throw new AppError("Você não tem permissão para esta ação.");
    const data = await fn(payload || {}, ctx);
    body = { ok: true, data };
  } catch (err) {
    if (err && err.appCode === "FORBIDDEN" && ctx.session) {
      await audit(ctx, "acesso_negado", `${channel}: ${err.detail || err.message}`).catch(() => {});
    }
    if (err instanceof AppError) {
      body = { ok: false, error: err.message, code: err.appCode };   // erro de regra: mensagem para o usuário
      if (err.info) body.info = err.info;
    } else {
      console.error(`[erro] ${channel}:`, err);                       // falha técnica: detalhe só no servidor
      body = { ok: false, error: "Erro inesperado. Tente novamente." };
    }
  }

  const out = { body };
  if (ctx.sessionAction === "end") {
    if (token) await apagarSessao(hashToken(token)).catch((err) => console.error("[sessoes] logout:", err.message));
    out.clearToken = true;
  } else if (ctx.sessionAction === "start" && body.ok) {
    try {
      if (token) await apagarSessao(hashToken(token)); // novo token a cada login (evita fixação de sessão)
      out.setToken = await criarSessao(ctx.session, ctx.clientIp);
    } catch (err) {
      console.error(`[erro] ${channel}: não foi possível criar a sessão:`, err);
      out.body = { ok: false, error: "Erro inesperado. Tente novamente." };
    }
  }
  if (channel === "auth:login") {
    if (body.ok) ipFails.delete(ctx.clientIp);
    else ipFail(ctx.clientIp);
  }
  return out;
}

/* Limpa as sessões vencidas: as do banco (com 1 min de folga, porque ultima_atividade pode estar até
   1 min atrás da memória) e as do cache. No banco: paradas há mais de 12 h (o maior prazo) e, das contas
   de administrador e gerente, paradas há mais de 15 min. */
setInterval(async () => {
  const agora = Date.now();
  const antes = (ms) => new Date(agora - ms - GRAVA_ATIVIDADE_MS).toISOString();
  for (const [h, r] of sessionCache) if (agora - r.ultimaAtividade > idleDe(r.user) + GRAVA_ATIVIDADE_MS) sessionCache.delete(h);
  try {
    let { error } = await supabase.from("sessoes").delete().lt("ultima_atividade", antes(IDLE_OPERADOR_MS));
    if (error) return console.error("[sessoes] limpeza:", error.message);
    const pessoais = await supabase.from("usuarios").select("id").neq("cargo", "operador");
    if (pessoais.error) return console.error("[sessoes] limpeza:", pessoais.error.message);
    if (!pessoais.data.length) return;
    ({ error } = await supabase.from("sessoes").delete().in("usuario_id", pessoais.data.map((u) => u.id)).lt("ultima_atividade", antes(IDLE_MS)));
    if (error) console.error("[sessoes] limpeza:", error.message);
  } catch (err) {
    console.error("[sessoes] limpeza:", err.message);
  }
}, 5 * 60 * 1000).unref();

/* ---------- Segurança de senhas e e-mails ---------- */
const hashPassword = (pw) => bcrypt.hash(String(pw), 12);
const SENHAS_COMUNS = new Set([
  "12345678", "123456789", "1234567890", "11111111", "password", "password1", "senha123", "senha1234",
  "admin123", "admin1234", "qwerty123", "abc12345", "chopp123", "meuchopp1", "meuchopp123",
  "barrilfacil1", "barrilfacil123",
]);

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    throw new AppError("Informe um e-mail válido, como nome@empresa.com.");
  return email;
}

function checkPassword(password, email) {
  const pw = String(password || "");
  if (pw.length < 8) throw new AppError("A senha precisa ter ao menos 8 caracteres.");
  if (pw.length > 72) throw new AppError("A senha pode ter no máximo 72 caracteres.");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AppError("A senha precisa ter letras e números.");
  if (SENHAS_COMUNS.has(pw.toLowerCase())) throw new AppError("Essa senha é muito comum. Escolha outra.");
  const local = String(email || "").split("@")[0];
  if (local.length >= 4 && pw.toLowerCase().includes(local))
    throw new AppError("A senha não pode conter o seu e-mail.");
}

/* Senha temporária aleatória (10 caracteres, sem letras ambíguas como I, l, O, 0) */
function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  for (;;) {
    let pw = "";
    for (let i = 0; i < 10; i++) pw += chars[crypto.randomInt(chars.length)];
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/* ---------- CNPJ ----------
   Aceita o CNPJ numérico e o alfanumérico: 12 caracteres de A-Z/0-9 + 2 dígitos verificadores.
   Cada caractere vale (código ASCII − 48). Guardado sem pontuação. */
function cnpjCheckDigit(chars) {
  const pesos = chars.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const soma = chars.split("").reduce((acc, c, i) => acc + (c.charCodeAt(0) - 48) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? "0" : String(11 - resto);
}
function normalizeCnpj(value) {
  const raw = String(value || "").toUpperCase().replace(/[.\/\-\s]/g, "");
  if (!raw) throw new AppError("Informe o CNPJ da unidade.");
  if (!/^[A-Z0-9]{12}\d{2}$/.test(raw)) throw new AppError("CNPJ inválido. Ele deve ter 14 caracteres, como 11.222.333/0001-81.");
  if (/^(\d)\1{13}$/.test(raw)) throw new AppError("CNPJ inválido. Confira os números digitados.");
  const dv1 = cnpjCheckDigit(raw.slice(0, 12));
  const dv2 = cnpjCheckDigit(raw.slice(0, 12) + dv1);
  if (raw.slice(12) !== dv1 + dv2) throw new AppError("CNPJ inválido: os dígitos verificadores não conferem.");
  return raw;
}
const formatCnpj = (c) => (c ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : null);

const STATUS_TEXTO = {
  disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência",
  esgotado: "Vazio (aguardando recolhimento)", recolhido: "Recolhido",
};

/* Validade (conta a partir da chegada na loja). O sistema só avisa, nunca bloqueia.
   Engatados não têm situação (estão na câmara fria sendo consumidos), nem vazios e recolhidos (o chope já saiu
   do barril). É a mesma regra da fn_alertas_validade, que alimenta o sino. */
function situacaoValidade(validade, status, hoje = hojeTZ()) {
  if (!validade || status === "em_uso" || status === "esgotado" || status === "recolhido") return null;
  if (validade < hoje) return "vencido";
  if (validade === hoje) return "vence_hoje";
  if (validade === somaDias(hoje, 1)) return "vence_amanha";
  return "ok";
}
/* Litros com uma casa, como nas telas: 18.217 -> "18,2 L"; 50 -> "50 L" */
const litrosTexto = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} L`;
/* Disponível com saldo (sobrou chope de uma retirada): "Disponível · 18,2 L" ou "Disponível · ≈ 37,5 L" (estimado) */
const situacaoTexto = (b, labels) => {
  const base = labels[b.status] || b.status;
  if (b.status !== "disponivel" || b.saldo_l === null || b.saldo_l === undefined) return base;
  return `${base} · ${b.saldo_estimado ? "≈ " : ""}${litrosTexto(b.saldo_l)}`;
};
/* Medida de uma pesagem vinda da tela -> parâmetros das funções SQL (que fazem as contas e as conferências).
   Balança: pesoBruto (kg, aceita vírgula), taraId (vazio = a padrão do tamanho) e, na primeira pesagem do tamanho,
   taraNovaKg. Estimativa: nivel (100, 75, 50 ou 25). A densidade é sempre a do servidor (DENSIDADE_CHOPE). */
function argsMedida({ metodo, pesoBruto, taraId, taraNovaKg, nivel }) {
  const num = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(String(v).trim().replace(",", ".")));
  if (metodo === "estimativa") {
    const n = Number(nivel);
    if (![100, 75, 50, 25].includes(n)) throw new AppError("Escolha quanto chope sobrou: cerca de 100%, 75%, 50% ou 25%.");
    return { p_metodo: "estimativa", p_peso_bruto: null, p_tara: null, p_nivel: n, p_densidade: null, p_tara_nova: null };
  }
  if (metodo !== "balanca") throw new AppError("Escolha pesar na balança ou estimar sem balança.");
  const peso = num(pesoBruto);
  if (!(peso > 0)) throw new AppError("Informe o peso do barril na balança (kg).");
  const tara = Number(taraId) || null;
  const nova = tara ? null : num(taraNovaKg);
  if (nova !== null && !(nova > 0)) throw new AppError("Informe o peso do vasilhame vazio (kg).");
  return { p_metodo: "balanca", p_peso_bruto: peso, p_tara: tara, p_nivel: null, p_densidade: DENSIDADE_CHOPE, p_tara_nova: nova };
}
const MSG_SEM_TORNEIRA = "Não há torneiras disponíveis nesta unidade. Verifique as torneiras cadastradas ou libere uma torneira antes de continuar.";

async function emailTaken(email, exceptId = 0) {
  const rows = ok(await supabase.from("usuarios").select("id").eq("email", email).neq("id", exceptId).limit(1));
  return rows.length > 0;
}

async function findUserByIdent(ident) {
  let r = await supabase.from("usuarios").select("*").eq("email", ident).maybeSingle();
  dbError(r.error);
  if (!r.data) {
    r = await supabase.from("usuarios").select("*").eq("usuario", ident).maybeSingle();
    dbError(r.error);
  }
  return r.data;
}

async function getUserById(id) {
  const r = await supabase.from("usuarios").select("*").eq("id", id).maybeSingle();
  dbError(r.error);
  return r.data;
}

/* ---------- Torneiras ----------
   A situação (livre/ocupada) nunca é gravada na torneira: ela é derivada do engate ativo
   (engates.retirado_em IS NULL). */
// "ativos": só o engate em andamento de cada torneira (filtro retirado_em nulo em tapsOfUnit), não o histórico inteiro
const TAPS_SELECT =
  "id, unidade_id, numero, ativo, ativos:engates(id, barril_id, engatado_em, retirado_em, engate_lancado_em, barris(codigo, estilo, chope_nome, tamanho_l, validade, status)," +
  " usuarios!engatado_por(nome), funcionarios!engatado_func_id(nome))";

function tapRow(t) {
  const e = (t.ativos || []).find((x) => x.retirado_em === null) || null;
  return {
    id: t.id,
    unidade_id: t.unidade_id,
    numero: t.numero,
    ativo: b2i(t.ativo),
    engate_id: e ? e.id : null,
    engatado_em: e ? fmtTs(e.engatado_em) : null,
    engatado_em_iso: e ? e.engatado_em : null,
    engatado_por: e ? quemFezEngate(e) : null,
    engate_lancado: !!(e && e.engate_lancado_em), // engate lançado com horário (o cartão mostra "horário informado")
    barril_id: e ? e.barril_id : null,
    codigo: e && e.barris ? e.barris.codigo : null,
    estilo: e && e.barris ? e.barris.estilo : null,
    chope_nome: e && e.barris ? e.barris.chope_nome : null,
    tamanho_l: e && e.barris ? e.barris.tamanho_l : null,
    validade: e && e.barris ? e.barris.validade : null,
    situacao_validade: e && e.barris ? situacaoValidade(e.barris.validade, e.barris.status) : null,
    ...(t.usos ? { usos: t.usos[0] ? t.usos[0].count : 0 } : {}),
    ocupada: !!e,
  };
}

/* Torneiras da unidade com o engate em andamento. usos (quantos engates a torneira já teve) só quando pedido:
   é uma contagem no banco, usada só nos detalhes da unidade (tela Unidades). */
async function tapsOfUnit(unitId, { usos = false } = {}) {
  const rows = ok(
    await supabase.from("torneiras").select(usos ? `${TAPS_SELECT}, usos:engates(count)` : TAPS_SELECT)
      .eq("unidade_id", unitId).is("ativos.retirado_em", null)
      .order("ativo", { ascending: false }).order("numero", { ascending: true })
  );
  return rows.map(tapRow);
}

async function activeEngateOfTap(torneiraId) {
  const r = await supabase
    .from("engates").select("id, barris(codigo)").eq("torneira_id", torneiraId).is("retirado_em", null).maybeSingle();
  dbError(r.error);
  return r.data ? { id: r.data.id, codigo: r.data.barris ? r.data.barris.codigo : "?" } : null;
}

/* ---------- Acesso por quiosque ----------
   Administrador: todos os quiosques ativos.
   Gerente e operador: somente os quiosques que um administrador liberou para eles.
   O resultado fica guardado junto da sessão em memória e vale o mesmo que ela: até 60 s, ou até
   recarregarSessoes/encerrarSessoes (trocar unidades, cargo, desativar) ou esquecerUnidadesDasSessoes
   (unidade criada, ativada ou desativada). */
async function allowedUnitIds(ctx) {
  const rec = ctx.sessao && ctx.sessao.user === ctx.session ? ctx.sessao : null;
  if (rec && rec.unidades) return rec.unidades.slice();
  let ids;
  if (ctx.session.cargo === "admin") {
    ids = ok(await supabase.from("unidades").select("id").eq("ativo", true).order("id")).map((r) => r.id);
  } else {
    const rows = ok(
      await supabase.from("usuario_unidades").select("unidade_id, unidades!inner(ativo)")
        .eq("usuario_id", ctx.session.id).eq("unidades.ativo", true)
    );
    ids = rows.map((r) => r.unidade_id).sort((a, b) => a - b);
  }
  if (rec) rec.unidades = ids;
  return ids.slice();
}

async function assertUnit(ctx, unitId) {
  const id = Number(unitId);
  if (!(await allowedUnitIds(ctx)).includes(id))
    throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
}

/* Quiosque em uso na tela: o pedido (se permitido) ou o primeiro liberado para o usuário */
async function resolveUnit(ctx, unitId) {
  const allowed = await allowedUnitIds(ctx);
  if (!allowed.length)
    throw new AppError("Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar.");
  const id = Number(unitId);
  if (!id) return allowed[0];
  if (!allowed.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
  return id;
}

async function loadBarril(ctx, id) {
  const r = await supabase.from("barris").select("*").eq("id", Number(id)).maybeSingle();
  dbError(r.error);
  if (!r.data) throw new AppError("Barril não encontrado.");
  await assertUnit(ctx, r.data.unidade_id);
  return r.data;
}

/* ---------- Quem fez a ação ----------
   O celular de cada loja fica logado numa conta de operador compartilhada. Antes de salvar uma ação com barril,
   a pessoa escolhe o próprio nome (funcionarioId): se a unidade da ação tem funcionários ativos, ele é obrigatório,
   precisa estar ativo e cadastrado nessa unidade. Unidade sem funcionários: a ação passa sem (a loja não trava).
   Administrador e gerente usam conta pessoal: a ação fica no nome da conta e o funcionarioId é ignorado.
   Devolve o id para gravar (p_funcionario) ou null. */
async function funcionarioDaAcao(ctx, unitId, funcionarioId) {
  if (ctx.session.cargo !== "operador") return null;
  const ativos = ok(
    await supabase.from("funcionario_unidades").select("funcionario_id, funcionarios!inner(ativo)")
      .eq("unidade_id", Number(unitId)).eq("funcionarios.ativo", true)
  );
  if (!ativos.length) return null;
  const id = Number(funcionarioId) || 0;
  if (!id) throw new AppError("Escolha quem está fazendo antes de salvar.", "FUNCIONARIO");
  if (ativos.some((a) => a.funcionario_id === id)) return id;
  const r = await supabase.from("funcionarios").select("nome, ativo").eq("id", id).maybeSingle();
  dbError(r.error);
  if (!r.data) throw new AppError("Funcionário não encontrado. Feche a janela e escolha de novo.", "FUNCIONARIO");
  if (!r.data.ativo) throw new AppError(`${r.data.nome} está desativado. Escolha outro nome.`, "FUNCIONARIO");
  throw new AppError(`${r.data.nome} não está cadastrado nesta unidade. Escolha outro nome.`, "FUNCIONARIO");
}
// Nome de quem fez: o funcionário escolhido ou, sem funcionário, o usuário da conta (como antes)
const quemFez = (func, usuario) => (func && func.nome) || (usuario && usuario.nome) || null;
/* Engate e retirada lançados com horário: quem fez é só o funcionário escolhido ("Não sei" = ninguém). A conta que lançou
   aparece à parte ("Engate lançado com horário por ..."), porque ela não fez o engate. */
const quemFezEngate = (e) => (e.engate_lancado_em ? (e.funcionarios && e.funcionarios.nome) || null : quemFez(e.funcionarios, e.usuarios));
const quemFezRetirada = (e) => (e.retirada_lancada_em ? (e.func_retirou && e.func_retirou.nome) || null : quemFez(e.func_retirou, e.retirou));

function publicUser(u) {
  return {
    id: u.id,
    nome: u.nome,
    email: u.email || null,
    usuario: u.usuario,
    cargo: u.cargo,
    cargoLabel: CARGO_LABEL[u.cargo],
    permissoes: PERMISSOES[u.cargo] || [],
    inatividadeMs: idleDe(u), // a tela encerra a sessão depois desse tempo sem uso (o servidor confere de novo)
    iniciais: u.nome.trim().charAt(0).toUpperCase(),
    trocarSenha: !!u.trocar_senha || !u.email,
  };
}

/* ---------- Consulta de movimentações (usada em dashboard, histórico e CSV) ---------- */
/* semPesagens: o Painel não mostra as pesagens (um inventário encheria as movimentações recentes); o Histórico mostra. */
async function queryMovements({ unitId, q, operacao, funcionarioId, limit, semPesagens = false }) {
  const unit = Number(unitId);
  let query = supabase
    .from("movimentacoes")
    .select(
      "id, operacao, criado_em, lancado_em, observacao, torneira_numero, barris!inner(codigo, estilo, chope_nome), usuarios(nome), funcionarios(nome)," +
      " origem:unidades!origem_unidade_id(nome), destino:unidades!destino_unidade_id(nome), pesagens(litros, metodo)"
    )
    .or(`origem_unidade_id.eq.${unit},destino_unidade_id.eq.${unit}`)
    // Pelo horário: um engate ou uma retirada lançados com horário ficam no lugar certo da lista
    .order("criado_em", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(Number(limit) || 5000, 5000));
  const termo = cleanTerm(q);
  if (termo) query = query.ilike("barris.codigo", `%${termo}%`);
  if (operacao) query = query.eq("operacao", String(operacao));
  else if (semPesagens) query = query.neq("operacao", "pesagem");
  if (Number(funcionarioId)) query = query.eq("funcionario_id", Number(funcionarioId));
  const rows = ok(await query);
  return rows.map((m) => ({
    id: m.id,
    operacao: m.operacao,
    criado_em: fmtTs(m.criado_em),
    lancado_em: fmtTs(m.lancado_em), // lançado com horário (o Histórico mostra "horário informado"); nulo = na hora
    observacao: m.observacao,
    torneira_numero: m.torneira_numero,
    codigo: m.barris ? m.barris.codigo : null,
    estilo: m.barris ? m.barris.estilo : null,
    chope_nome: m.barris ? m.barris.chope_nome : null,
    responsavel: quemFez(m.funcionarios, m.usuarios), // coluna "Quem fez"
    usuario: m.usuarios ? m.usuarios.nome : null,
    funcionario: m.funcionarios ? m.funcionarios.nome : null,
    origem: m.origem ? m.origem.nome : null,
    destino: m.destino ? m.destino.nome : null,
    // Retirado com chope e pesagem: os litros da pesagem e se foi estimado (sem balança)
    litros: m.pesagens ? Number(m.pesagens.litros) : null,
    estimado: m.pesagens ? m.pesagens.metodo === "estimativa" : null,
  }));
}

function registerHandlers() {
  /* ======== Autenticação ======== */
  const GENERIC = "E-mail ou senha incorretos.";
  const unknownAttempts = new Map(); // tentativas com e-mails que não existem (também limitadas)
  let dummyHash = null;              // evita revelar, pelo tempo de resposta, se o e-mail existe

  const lockMessage = (until) => {
    const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return `Muitas tentativas. Tente novamente em ${min} minuto${min > 1 ? "s" : ""}.`;
  };

  const startSession = (ctx, user) => {
    ctx.session = publicUser(user);
    ctx.sessionAction = "start";
    return ctx.session;
  };

  // Verifica se a base está vazia para mostrar a tela de 1º acesso
  handle("auth:needsSetup", async () => {
    const { count, error } = await supabase.from("usuarios").select("id", { count: "exact", head: true });
    if (error) {
      console.error("[needsSetup]", error);
      throw new AppError("Não foi possível acessar o banco de dados. Verifique a configuração do Supabase (arquivo .env e as migrations de supabase/migrations).");
    }
    return count === 0;
  }, { auth: false });

  // Cria a primeira conta de Administrador do sistema
  handle("auth:setup", async ({ nome, email, senha }, ctx) => {
    const { count, error: cErr } = await supabase.from("usuarios").select("id", { count: "exact", head: true });
    dbError(cErr);
    if (count > 0) throw new AppError("O sistema já foi configurado. Entre com o seu e-mail e senha.");

    const name = String(nome || "").trim();
    if (!name) throw new AppError("Informe o seu nome.");
    const em = normalizeEmail(email);
    checkPassword(senha, em);

    const newUser = ok(
      await supabase.from("usuarios")
        .insert({ nome: name, usuario: em, email: em, senha_hash: await hashPassword(senha), cargo: "admin", trocar_senha: false, ativo: true })
        .select().single(),
      "Este e-mail já está em uso."
    );

    startSession(ctx, newUser);
    await audit(ctx, "configuracao_inicial", `Administrador ${em} criado`);
    return ctx.session;
  }, { auth: false });

  handle("auth:login", async ({ identifier, password }, ctx) => {
    const ident = String(identifier || "").trim().toLowerCase();
    const pass = String(password || "");
    if (!ident || !pass) throw new AppError(GENERIC);

    const user = await findUserByIdent(ident);
    const now = Date.now();
    const unknown = unknownAttempts.get(ident);
    const lockedUntil = user ? Number(user.bloqueado_ate) || 0 : unknown ? unknown.until : 0;
    if (lockedUntil > now) {
      await audit(ctx, "login_bloqueado", `Tentativa durante bloqueio (${ident})`, user ? user.id : null);
      throw new AppError(lockMessage(lockedUntil));
    }

    if (!dummyHash) dummyHash = await hashPassword("senha-ficticia-barrilfacil");
    const match = await bcrypt.compare(pass, user && user.ativo ? user.senha_hash : dummyHash);

    if (!(user && user.ativo && match)) {
      let until = 0;
      if (user) {
        const falhas = (user.falhas || 0) + 1;
        if (falhas >= MAX_FALHAS) {
          until = now + BLOQUEIO_MS;
          dbError((await supabase.from("usuarios").update({ falhas: 0, bloqueado_ate: until }).eq("id", user.id)).error);
        } else {
          dbError((await supabase.from("usuarios").update({ falhas }).eq("id", user.id)).error);
        }
      } else {
        if (unknownAttempts.size > 1000) unknownAttempts.clear();
        const rec = unknown || { count: 0, until: 0 };
        rec.count += 1;
        if (rec.count >= MAX_FALHAS) { rec.until = now + BLOQUEIO_MS; rec.count = 0; }
        unknownAttempts.set(ident, rec);
        until = rec.until;
      }
      await audit(ctx, "login_falhou", `Tentativa com "${ident}"${ipInfo(ctx)}`, user ? user.id : null);
      throw new AppError(until > now ? lockMessage(until) : GENERIC);
    }

    dbError(
      (await supabase.from("usuarios")
        .update({ falhas: 0, bloqueado_ate: null, ultimo_login: new Date().toISOString() }).eq("id", user.id)).error
    );
    unknownAttempts.delete(ident);
    startSession(ctx, user);
    await audit(ctx, "login", "Entrou no sistema" + ipInfo(ctx));
    return ctx.session;
  }, { auth: false });

  handle("auth:logout", async (_p, ctx) => {
    await audit(ctx, "logout", "Saiu do sistema");
    ctx.sessionAction = "end";
    return true;
  });

  handle("auth:me", (_p, ctx) => ctx.session);

  // Dados do servidor que as telas usam (carregados junto com o cabeçalho).
  // Sem login (telas de entrar, primeiro acesso e configuração) devolve só o ambiente, para a faixa de testes.
  const configDe = (ctx) => (ctx.session
    ? { fornecedor: FORNECEDOR, hoje: hojeTZ(), ambiente: AMBIENTE, densidade: DENSIDADE_CHOPE }
    : { ambiente: AMBIENTE });
  handle("config:get", (_p, ctx) => configDe(ctx), { auth: "opcional" });

  /* Tudo o que o cabeçalho das telas precisa numa ida só: o usuário (como auth:me), as unidades liberadas (como
     units:list) e a config (como config:get). Quem ainda precisa trocar a senha recebe as unidades vazias e a tela
     leva ao primeiro acesso. */
  handle("session:bootstrap", async (_p, ctx) => ({
    user: ctx.session,
    units: ctx.session.trocarSenha ? [] : await unidadesDoUsuario(ctx),
    config: configDe(ctx),
  }));
  handle("auth:ping", () => true); // mantém a sessão viva enquanto o usuário está ativo

  /* Primeiro acesso / senha temporária: define e-mail (se faltar) e uma senha nova */
  handle("auth:completeProfile", async ({ email, nova }, ctx) => {
    const u = await getUserById(ctx.session.id);
    const em = normalizeEmail(email || u.email);
    checkPassword(nova, em);
    if (await bcrypt.compare(String(nova), u.senha_hash))
      throw new AppError("A nova senha precisa ser diferente da senha temporária.");
    if (await emailTaken(em, u.id)) throw new AppError("Este e-mail já está sendo usado por outro usuário.");
    dbError(
      (await supabase.from("usuarios")
        .update({ email: em, usuario: em, senha_hash: await hashPassword(nova), trocar_senha: false }).eq("id", u.id)).error,
      "Este e-mail já está sendo usado por outro usuário."
    );
    startSession(ctx, await getUserById(u.id));
    await audit(ctx, "primeiro_acesso", "Definiu e-mail e nova senha");
    return ctx.session;
  });

  handle("auth:changePassword", async ({ atual, nova }, ctx) => {
    const u = await getUserById(ctx.session.id);
    if (!(await bcrypt.compare(String(atual || ""), u.senha_hash))) throw new AppError("Senha atual incorreta.");
    checkPassword(nova, u.email);
    if (String(nova) === String(atual)) throw new AppError("A nova senha precisa ser diferente da atual.");
    dbError((await supabase.from("usuarios").update({ senha_hash: await hashPassword(nova) }).eq("id", u.id)).error);
    await encerrarSessoes(u.id, { excetoToken: ctx.token }); // os outros aparelhos saem; este continua
    await audit(ctx, "senha_alterada", "Alterou a própria senha");
    return true;
  });

  /* ======== Quiosques ======== */
  // Quiosques que o usuário pode acessar (alimenta o seletor do cabeçalho)
  async function unidadesDoUsuario(ctx) {
    const ids = await allowedUnitIds(ctx);
    if (!ids.length) return [];
    return ok(await supabase.from("unidades").select("id, nome, nome_curto").in("id", ids).order("id"));
  }
  handle("units:list", (_p, ctx) => unidadesDoUsuario(ctx));

  // Destinos possíveis de uma transferência: só nomes dos quiosques ativos
  handle("units:all", async () =>
    ok(await supabase.from("unidades").select("id, nome, nome_curto").eq("ativo", true).order("id"))
  );

  handle("units:adminList", async () => {
    const [rows, codigos] = await Promise.all([
      rpc("fn_unidades_resumo", {}),
      supabase.from("unidades").select("id, codigo_teknisa").then((r) => ok(r)),
    ]);
    const codigo = new Map(codigos.map((c) => [c.id, c.codigo_teknisa]));
    return rows.map((u) => ({ ...u, ativo: b2i(u.ativo), cnpjFormatado: formatCnpj(u.cnpj), codigo_teknisa: codigo.get(u.id) || null }));
  }, { perm: "unidades" });

  /* Detalhes de uma unidade + suas torneiras (tela Unidades) */
  handle("units:details", async ({ id }) => {
    const r = await supabase.from("unidades").select("id, nome, nome_curto, razao_social, ativo, cnpj, endereco, codigo_teknisa").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Unidade não encontrada.");
    const u = r.data;
    return { ...u, ativo: b2i(u.ativo), cnpjFormatado: formatCnpj(u.cnpj), torneiras: await tapsOfUnit(u.id, { usos: true }) };
  }, { perm: "unidades" });

  /* Razão social, nome fantasia (coluna nome: o nome mostrado no app), CNPJ e endereço são obrigatórios
     ao cadastrar e ao editar. */
  const likeEscape = (s) => s.replace(/[\\%_]/g, "\\$&");
  /* Código da loja no sistema de caixa (opcional): o número antes do " - " na coluna Unidade do relatório de vendas (ex.: "0003") */
  const cleanCodigoTeknisa = async (v, exceptId = 0) => {
    const cod = String(v ?? "").trim().toUpperCase();
    if (!cod) return null;
    if (!/^[0-9A-Z]{1,10}$/.test(cod)) throw new AppError("O código no sistema de caixa tem só números e letras, até 10 (ex.: 0003).");
    const outra = ok(await supabase.from("unidades").select("nome").eq("codigo_teknisa", cod).neq("id", exceptId).limit(1));
    if (outra.length) throw new AppError(`O código ${cod} no sistema de caixa já está na unidade "${outra[0].nome}".`);
    return cod;
  };
  const cleanUnitData = async ({ razaoSocial, nome, nomeCurto, cnpj, endereco }, exceptId = 0) => {
    const razao = String(razaoSocial || "").trim().replace(/\s+/g, " ");
    if (razao.length < 2) throw new AppError("Informe a razão social da unidade.");
    if (razao.length > 120) throw new AppError("Razão social muito longa (máximo 120 caracteres).");
    const full = String(nome || "").trim();
    const short = String(nomeCurto || "").trim() || full;
    if (full.length < 2) throw new AppError("Informe o nome fantasia da unidade.");
    if (full.length > 60 || short.length > 30) throw new AppError("Nome fantasia ou nome curto muito longo (máximo 60 e 30 caracteres).");
    const mesmoNome = ok(await supabase.from("unidades").select("id").ilike("nome", likeEscape(full)).neq("id", exceptId).limit(1));
    if (mesmoNome.length) throw new AppError(`Já existe uma unidade com o nome fantasia "${full}".`);
    const doc = normalizeCnpj(cnpj);
    const outra = ok(await supabase.from("unidades").select("nome").eq("cnpj", doc).neq("id", exceptId).limit(1));
    if (outra.length) throw new AppError(`Este CNPJ já está cadastrado na unidade "${outra[0].nome}".`);
    const end = String(endereco || "").trim().replace(/\s+/g, " ");
    if (end.length < 8) throw new AppError("Informe o endereço completo da unidade (rua, número, bairro, cidade, estado e CEP).");
    if (end.length > 300) throw new AppError("Endereço muito longo (máximo 300 caracteres).");
    return { razao, full, short, doc, end };
  };

  handle("units:create", async (p, ctx) => {
    const { razao, full, short, doc, end } = await cleanUnitData(p);
    const cod = await cleanCodigoTeknisa(p.codigoTeknisa);
    const row = ok(
      await supabase.from("unidades").insert({ razao_social: razao, nome: full, nome_curto: short, cnpj: doc, endereco: end, codigo_teknisa: cod }).select("id").single(),
      "Já existe uma unidade com esse nome fantasia, CNPJ ou código no sistema de caixa."
    );
    esquecerUnidadesDasSessoes(); // o administrador vê todas as unidades ativas: a nova aparece já
    await audit(ctx, "unidade_criada", `${full}, razão social ${razao} (CNPJ ${formatCnpj(doc)})${cod ? `, código no sistema de caixa ${cod}` : ""}`);
    return { id: row.id };
  }, { perm: "unidades" });

  handle("units:update", async (p, ctx) => {
    const id = Number(p.id);
    const ex = ok(await supabase.from("unidades").select("id").eq("id", id));
    if (!ex.length) throw new AppError("Unidade não encontrada.");
    const { razao, full, short, doc, end } = await cleanUnitData(p, id);
    // Sem o campo no pedido (tela antiga): o código fica como está
    const mudaCodigo = Object.prototype.hasOwnProperty.call(p, "codigoTeknisa");
    const cod = mudaCodigo ? await cleanCodigoTeknisa(p.codigoTeknisa, id) : undefined;
    dbError(
      (await supabase.from("unidades").update({
        razao_social: razao, nome: full, nome_curto: short, cnpj: doc, endereco: end, ...(mudaCodigo ? { codigo_teknisa: cod } : {}),
      }).eq("id", id)).error,
      "Já existe uma unidade com esse nome fantasia, CNPJ ou código no sistema de caixa."
    );
    await audit(ctx, "unidade_editada", `${full}, razão social ${razao} (CNPJ ${formatCnpj(doc)})${cod ? `, código no sistema de caixa ${cod}` : ""}`);
    return true;
  }, { perm: "unidades" });

  handle("units:toggle", async ({ id }, ctx) => {
    const r = await supabase.from("unidades").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    const u = r.data;
    if (!u) throw new AppError("Unidade não encontrada.");
    if (u.ativo) {
      const a = await supabase.from("barris").select("id", { count: "exact", head: true }).eq("unidade_id", u.id).not("status", "in", "(esgotado,recolhido)");
      dbError(a.error);
      const b = await supabase.from("transferencias").select("id", { count: "exact", head: true }).eq("destino_id", u.id).eq("status", "pendente");
      dbError(b.error);
      if (a.count || b.count)
        throw new AppError(
          `Esta unidade ainda tem ${a.count} barril(is) em estoque e ${b.count} transferência(s) a receber. Resolva antes de desativar.`
        );
    }
    dbError((await supabase.from("unidades").update({ ativo: !u.ativo }).eq("id", u.id)).error);
    esquecerUnidadesDasSessoes();
    await audit(ctx, u.ativo ? "unidade_desativada" : "unidade_reativada", u.nome);
    return true;
  }, { perm: "unidades" });

  /* ======== Torneiras ======== */
  const loadTap = async (id) => {
    const r = await supabase.from("torneiras").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Torneira não encontrada.");
    return r.data;
  };
  const cleanTapNumber = (n) => {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 999) throw new AppError("O número da torneira deve ser um número inteiro entre 1 e 999.");
    return num;
  };
  const tapNumberTaken = async (unitId, numero, exceptId = 0) =>
    ok(await supabase.from("torneiras").select("id").eq("unidade_id", unitId).eq("numero", numero).eq("ativo", true).neq("id", exceptId).limit(1)).length > 0;
  const unitById = async (id) => {
    const r = await supabase.from("unidades").select("nome, ativo").eq("id", id).maybeSingle();
    dbError(r.error);
    return r.data;
  };

  // Cadastra uma ou mais torneiras com os próximos números livres da unidade
  handle("taps:create", async ({ unitId, quantidade = 1 }, ctx) => {
    const numeros = await rpc("fn_torneiras_criar", {
      p_unidade: Number(unitId), p_qtd: Number(quantidade), p_usuario: ctx.session.id,
    });
    return { numeros };
  }, { perm: "unidades" });

  // Altera o número visível. O histórico guarda o número usado em cada operação, então não muda.
  handle("taps:update", async ({ id, numero }, ctx) => {
    const t = await loadTap(id);
    const num = cleanTapNumber(numero);
    if (num === t.numero) return true;
    if (t.ativo && (await tapNumberTaken(t.unidade_id, num, t.id)))
      throw new AppError(`Já existe uma Torneira ${num} ativa nesta unidade.`);
    dbError((await supabase.from("torneiras").update({ numero: num }).eq("id", t.id)).error, `Já existe uma Torneira ${num} ativa nesta unidade.`);
    const un = await unitById(t.unidade_id);
    await audit(ctx, "torneira_renumerada", `${un.nome}: Torneira ${t.numero} → Torneira ${num}`);
    return true;
  }, { perm: "unidades" });

  // Desativa/reativa. Torneiras nunca são apagadas: o histórico de engates continua apontando para elas.
  handle("taps:toggle", async ({ id }, ctx) => {
    const t = await loadTap(id);
    const un = await unitById(t.unidade_id);
    if (t.ativo) {
      const e = await activeEngateOfTap(t.id);
      if (e) throw new AppError(`A Torneira ${t.numero} está ocupada pelo barril #${e.codigo}. Retire o barril antes de desativá-la.`);
    } else {
      if (!un.ativo) throw new AppError("Esta unidade está desativada. Reative-a antes de reativar a torneira.");
      if (await tapNumberTaken(t.unidade_id, t.numero, t.id))
        throw new AppError(`Já existe uma Torneira ${t.numero} ativa nesta unidade. Altere o número desta torneira antes de reativá-la.`);
    }
    dbError((await supabase.from("torneiras").update({ ativo: !t.ativo }).eq("id", t.id)).error);
    await audit(ctx, t.ativo ? "torneira_desativada" : "torneira_reativada", `${un.nome}: Torneira ${t.numero}`);
    return true;
  }, { perm: "unidades" });

  // Torneiras da unidade do barril, para o funcionário escolher no engate (respeita o acesso à unidade)
  handle("taps:forBarril", async ({ barrilId }, ctx) => {
    const b = await loadBarril(ctx, barrilId);
    const r = await supabase.from("unidades").select("id, nome").eq("id", b.unidade_id).single();
    dbError(r.error);
    const torneiras = (await tapsOfUnit(b.unidade_id))
      .filter((t) => t.ativo)
      .map((t) => ({
        id: t.id, numero: t.numero, ocupada: t.ocupada, barril: t.codigo || null, estilo: t.estilo || null, chope_nome: t.chope_nome || null,
      }));
    return {
      barril: {
        id: b.id, codigo: b.codigo, estilo: b.estilo, chope_nome: b.chope_nome || null, status: b.status,
        validade: b.validade, situacao_validade: situacaoValidade(b.validade, b.status),
        tamanho_l: b.tamanho_l, saldo_l: b.saldo_l, saldo_estimado: b.saldo_estimado,
      },
      unidade: r.data,
      torneiras,
    };
  });

  // Aba Torneiras: situação de cada torneira ativa da unidade (qualquer usuário com acesso à unidade)
  handle("taps:board", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const torneiras = (await tapsOfUnit(unit))
      .filter((t) => t.ativo)
      .sort((a, b) => a.numero - b.numero)
      .map((t) => ({
        id: t.id,
        numero: t.numero,
        ocupada: t.ocupada,
        barril_id: t.ocupada ? t.barril_id : null, // para retirar o barril direto pela aba Torneiras
        codigo: t.ocupada ? t.codigo : null,
        chope_nome: t.ocupada ? t.chope_nome : null,
        estilo: t.ocupada ? t.estilo : null,
        tamanho_l: t.ocupada ? t.tamanho_l : null,
        validade: t.ocupada ? t.validade : null,
        situacao_validade: t.ocupada ? t.situacao_validade : null,
        engatado_em: t.engatado_em,
        engatado_em_iso: t.engatado_em_iso,
        engatado_por: t.engatado_por,
      }));
    // "agora" = relógio do servidor, para o "há quanto tempo"; "fuso" = fuso da operação (o "Lançar com horário" usa)
    return { agora: new Date().toISOString(), fuso: TZ, torneiras };
  });

  // Últimos 50 engates de uma torneira, do mais recente para o mais antigo
  handle("taps:history", async ({ torneiraId }, ctx) => {
    const t = await loadTap(torneiraId);
    await assertUnit(ctx, t.unidade_id);
    const rows = ok(
      await supabase.from("engates")
        .select("id, engatado_em, retirado_em, barris(codigo, estilo, chope_nome), usuarios!engatado_por(nome)," +
          " retirou:usuarios!retirado_por(nome), funcionarios!engatado_func_id(nome), func_retirou:funcionarios!retirado_func_id(nome)," +
          " engate_lancado_em, retirada_lancada_em, eng_lancou:usuarios!engate_lancado_por(nome), ret_lancou:usuarios!retirada_lancada_por(nome)")
        .eq("torneira_id", t.id)
        .order("engatado_em", { ascending: false })
        .order("id", { ascending: false })
        .limit(50)
    );
    return {
      torneira: { id: t.id, numero: t.numero },
      agora: new Date().toISOString(),
      engates: rows.map((e) => ({
        codigo: e.barris ? e.barris.codigo : null,
        chope_nome: e.barris ? e.barris.chope_nome : null,
        estilo: e.barris ? e.barris.estilo : null,
        engatado_em: fmtTs(e.engatado_em),
        engatado_em_iso: e.engatado_em,
        retirado_em: fmtTs(e.retirado_em),
        retirado_em_iso: e.retirado_em || null,
        engatado_por: quemFezEngate(e),
        retirado_por: e.retirado_em ? quemFezRetirada(e) : null,
        // Lançados com horário: quem lançou e quando (nulo = lançado na hora)
        engate_lancado: e.engate_lancado_em ? { por: e.eng_lancou ? e.eng_lancou.nome : null, em: fmtTs(e.engate_lancado_em) } : null,
        retirada_lancada: e.retirada_lancada_em ? { por: e.ret_lancou ? e.ret_lancou.nome : null, em: fmtTs(e.retirada_lancada_em) } : null,
      })),
    };
  });

  /* Lançar com horário (administrador e gerente, permissão torneiras:horario): troca de barril, só retirada ou só
     engate que não foram lançados na hora, gravados com o horário em que aconteceram (dia e hora no fuso da operação,
     "AAAA-MM-DDTHH:MM"). retirada: { quando, vazio, medida } (medida como na retirada com chope: balança ou estimativa);
     engate: { barrilId, quando }; funcionarioId: quem fez (vazio = "Não sei"). As regras (nada no futuro nem de mais de
     30 dias, depois do engate e do último registro do barril, depois da última retirada da torneira...) ficam no banco,
     em fn_lancamento_com_horario, numa transação só. Erro de um campo vem com code CAMPO e info.campo. */
  handle("taps:lancarComHorario", async ({ unitId, torneiraId, tipo, retirada, engate, funcionarioId }, ctx) => {
    const t = await loadTap(torneiraId);
    await assertUnit(ctx, t.unidade_id);
    if (unitId && Number(unitId) !== t.unidade_id) throw new AppError("Esta torneira não é da unidade selecionada. Atualize a tela.");
    if (!["troca", "retirada", "engate"].includes(tipo))
      throw new AppError("Escolha o que aconteceu: troca de barril, só retirada ou só engate.");
    const erroCampo = (msg, campo) => new AppError(msg, "CAMPO", null, { campo });
    const instante = (v, msg, campo) => {
      const d = instanteNoFuso(v);
      if (!d) throw erroCampo(msg, campo);
      return d.toISOString();
    };
    const temRet = tipo !== "engate";
    const temEng = tipo !== "retirada";
    const ret = retirada || {};
    const eng = engate || {};

    let pRet = null;
    let medida = { p_metodo: null, p_peso_bruto: null, p_tara: null, p_nivel: null, p_densidade: null, p_tara_nova: null };
    if (temRet) {
      pRet = instante(ret.quando, "Informe o dia e a hora da retirada.", "ret");
      if (typeof ret.vazio !== "boolean") throw erroCampo("Escolha como o barril saiu: vazio ou ainda com chope.", "ret");
      if (!ret.vazio) medida = argsMedida(ret.medida || {});
    }
    let barril = null;
    let pEng = null;
    if (temEng) {
      if (!Number(eng.barrilId)) throw erroCampo("Escolha o barril que foi engatado.", "barril");
      barril = await loadBarril(ctx, eng.barrilId); // acesso à unidade do barril; o banco confere que é a da torneira
      pEng = instante(eng.quando, "Informe o dia e a hora do engate.", "eng");
    }

    const r = await rpc("fn_lancamento_com_horario", {
      p_torneira: t.id, p_usuario: ctx.session.id, p_funcionario: Number(funcionarioId) || null, p_tipo: tipo,
      p_ret_quando: pRet, p_ret_vazio: temRet ? ret.vazio : null, ...medida,
      p_eng_barril: barril ? barril.id : null, p_eng_quando: pEng, p_tz: TZ,
    });
    // Barril vencido no dia do engate: a mesma auditoria do engate de sempre (aqui não há o que confirmar: já foi engatado)
    if (r.engate && barril.validade && barril.validade < dayFmt.format(new Date(pEng))) {
      const [ano, mes, dia] = barril.validade.split("-");
      await audit(ctx, "engate_barril_vencido",
        `Barril #${barril.codigo} (validade ${dia}/${mes}/${ano}) engatado vencido na Torneira ${r.torneira} (${r.unidade}), lançado com horário (${r.engate.quando})`);
    }
    return r;
  }, { perm: "torneiras:horario" });

  /* ======== Chopes, tamanhos de barril e custo por litro ========
     O chope tem só o nome. A tabela estilos e a coluna barris.estilo ficam no banco: barris.estilo recebe o nome do
     chope, e o barril antigo sem chope do catálogo aparece pelo estilo gravado nele.
     Cadastrar chope: qualquer usuário logado (direto do cadastro de barril). Editar, desativar, apagar, preços e
     tamanhos de barril: permissão catalogo:editar (administrador e gerente). Quem não tem essa permissão não recebe
     custos em nenhuma resposta: o operador cria o chope só com o nome e ele fica "Sem preço". */
  const cleanCatalogName = (value, tipo) => {
    const nome = String(value || "").trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 60) throw new AppError(`O nome do ${tipo} deve ter de 2 a 60 caracteres.`);
    return nome;
  };
  // Nome repetido, sem diferenciar maiúsculas (o índice único em lower(nome) garante no banco)
  const catalogNameTaken = async (tabela, tipo, nome, exceptId = 0) => {
    const rows = ok(await supabase.from(tabela).select("nome, ativo").ilike("nome", likeEscape(nome)).neq("id", exceptId).limit(10));
    const igual = rows.find((r) => r.nome.toLowerCase() === nome.toLowerCase());
    if (!igual) return;
    const extra = igual.ativo ? "" : " (desativado). Peça a um administrador para reativá-lo";
    throw new AppError(`Já existe um ${tipo} chamado "${igual.nome}"${extra}.`);
  };
  const loadChope = async (id) => {
    const r = await supabase.from("chopes").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Chope não encontrado.");
    return r.data;
  };
  const wantsAll = (p, ctx) => !!p.todos && pode(ctx.session, "catalogo:editar");

  /* ---------- Tamanhos de barril ----------
     Todos os cargos veem os ativos (cadastro de barril, tara). Cadastrar, desativar e reativar: catalogo:editar.
     Tamanho usado em barril não é apagado, só desativado: some do cadastro de barril e dos campos de preço. */
  const loadTamanho = async (id) => {
    const r = await supabase.from("tamanhos_barril").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Tamanho de barril não encontrado.");
    return r.data;
  };
  const tamanhosAtivos = async () =>
    ok(await supabase.from("tamanhos_barril").select("litros").eq("ativo", true).order("litros")).map((t) => Number(t.litros));
  // Litros: inteiro ou uma casa decimal, de mais que 0 a 200
  const cleanLitros = (v) => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").trim().replace(",", "."));
    if (String(v ?? "").trim() === "" || !(n > 0) || n > 200) throw new AppError("Informe os litros do barril: mais que 0 e até 200 (ex.: 40).");
    if (Math.abs(Math.round(n * 10) - n * 10) > 1e-9) throw new AppError("Use no máximo uma casa decimal nos litros (ex.: 7,5).");
    return Math.round(n * 10) / 10;
  };
  const cleanPrefixo = (v) => {
    const p = String(v ?? "").trim().toUpperCase();
    if (!p) return null;
    if (!/^[A-Z0-9]{1,10}$/.test(p)) throw new AppError("O prefixo do código deve ter de 1 a 10 letras ou números, sem espaço (ex.: BA4).");
    return p;
  };
  const tamanhoTexto = (t) => `Barril de ${litrosTexto(t.litros)}${t.prefixo_codigo ? ` (prefixo ${t.prefixo_codigo})` : ""}`;

  // todos (só quem edita): também os desativados, com quantos barris usam cada tamanho (inclusive os recolhidos)
  handle("tamanhos:list", async (p, ctx) => {
    const todos = wantsAll(p || {}, ctx);
    let query = supabase.from("tamanhos_barril").select("id, litros, prefixo_codigo, ativo").order("litros");
    if (!todos) query = query.eq("ativo", true);
    const rows = ok(await query).map((t) => ({ id: t.id, litros: Number(t.litros), prefixo: t.prefixo_codigo, ativo: b2i(t.ativo) }));
    if (!todos) return rows;
    const usos = await Promise.all(rows.map((t) =>
      supabase.from("barris").select("id", { count: "exact", head: true }).eq("tamanho_l", t.litros)));
    return rows.map((t, i) => { dbError(usos[i].error); return { ...t, barris: usos[i].count || 0 }; });
  });

  handle("tamanhos:create", async ({ litros, prefixo }, ctx) => {
    const n = cleanLitros(litros);
    const pre = cleanPrefixo(prefixo);
    const igual = ok(await supabase.from("tamanhos_barril").select("ativo").eq("litros", n).maybeSingle());
    const repetido = `Já existe o barril de ${litrosTexto(n)}`;
    if (igual) throw new AppError(igual.ativo ? repetido : `${repetido} (desativado). Reative em Chopes, na seção Tamanhos de barril.`);
    if (pre) {
      const dono = ok(await supabase.from("tamanhos_barril").select("litros").eq("prefixo_codigo", pre).maybeSingle());
      if (dono) throw new AppError(`O prefixo ${pre} já é do barril de ${litrosTexto(dono.litros)}.`);
    }
    const row = ok(await supabase.from("tamanhos_barril").insert({ litros: n, prefixo_codigo: pre, criado_por: ctx.session.id })
      .select("id, litros, prefixo_codigo, ativo").single(), repetido);
    await audit(ctx, "tamanho_barril_criado", tamanhoTexto(row));
    return { id: row.id, litros: Number(row.litros), prefixo: row.prefixo_codigo, ativo: 1 };
  }, { perm: "catalogo:editar" });

  handle("tamanhos:toggle", async ({ id }, ctx) => {
    const t = await loadTamanho(id);
    if (t.ativo) {
      const outros = ok(await supabase.from("tamanhos_barril").select("id").eq("ativo", true).neq("id", t.id).limit(1));
      if (!outros.length) throw new AppError("Deixe pelo menos um tamanho de barril ativo.");
    }
    dbError((await supabase.from("tamanhos_barril").update({ ativo: !t.ativo }).eq("id", t.id)).error);
    await audit(ctx, t.ativo ? "tamanho_barril_desativado" : "tamanho_barril_reativado", tamanhoTexto(t));
    return true;
  }, { perm: "catalogo:editar" });

  /* ---------- Custo por litro do chope ----------
     Preço único (preco_por_tamanho = false): uma linha com tamanho nulo e o custo por litro digitado.
     Por tamanho: uma linha por tamanho com o preço do barril; custo_litro = preço ÷ litros, calculado aqui.
     Mudar o preço grava linhas novas com a data de início; as antigas ficam (fn_custo_litro escolhe pela data). */
  const reais = (n) => `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const diaBR = (dia) => dia.split("-").reverse().join("/");
  // "300", "300,50", "1.234,56", "R$ 575,00" ou número
  const dinheiroBR = (v) => {
    if (typeof v === "number") return v;
    let t = String(v ?? "").replace(/R\$|\s/g, "");
    if (t === "") return null;
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    return Number(t);
  };
  const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
  const cleanDinheiro = (v, oque) => {
    const n = dinheiroBR(v);
    if (!(n > 0) || n > 1000000) throw new AppError(`Informe ${oque} em reais (ex.: 300,00).`);
    return Math.round(n * 100) / 100;
  };
  const cleanInicio = (v) => {
    const dia = String(v || "").trim();
    if (!dia) return hojeTZ();
    if (!diaValido(dia)) throw new AppError("Data de início inválida.");
    if (dia < "2020-01-01") throw new AppError("A data de início está muito no passado.");
    if (dia > somaDias(hojeTZ(), 366)) throw new AppError("A data de início pode ser no máximo um ano à frente.");
    return dia;
  };
  const mesmoTamanho = (l, tamanho) => (tamanho === null ? l.tamanho_l === null : l.tamanho_l !== null && Number(l.tamanho_l) === tamanho);
  // Mesma regra da fn_custo_litro: entre as linhas, a de maior início até a data; sem nenhuma, a de menor início.
  // No mesmo início, vale a gravada por último.
  function custoVigente(linhas, dia) {
    let ate = null;
    let primeira = null;
    for (const l of linhas) {
      if (l.inicio <= dia && (!ate || l.inicio > ate.inicio || (l.inicio === ate.inicio && l.id > ate.id))) ate = l;
      if (!primeira || l.inicio < primeira.inicio || (l.inicio === primeira.inicio && l.id > primeira.id)) primeira = l;
    }
    return ate || primeira;
  }
  /* O que vale hoje para o chope: custoLitro (preço único) ou precos (um por tamanho ativo), a faixa do custo por litro
     e o que está sem preço (semPreco = nenhum preço; semPrecoTamanhos = tamanhos sem preço no chope por tamanho). */
  function resumoCusto(c, linhas, tamanhos, dia) {
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    if (!c.preco_por_tamanho) {
      const v = custoVigente(linhas.filter((l) => l.tamanho_l === null), dia);
      const custo = v ? num(v.custo_litro) : null;
      return { porTamanho: false, custoLitro: custo, precos: [], min: custo, max: custo, semPreco: custo === null, semPrecoTamanhos: [] };
    }
    const precos = tamanhos.map((t) => {
      const v = custoVigente(linhas.filter((l) => mesmoTamanho(l, t)), dia);
      return { tamanho: t, precoBarril: v ? num(v.preco_barril) : null, custoLitro: v ? num(v.custo_litro) : null };
    });
    const valores = precos.filter((x) => x.custoLitro !== null).map((x) => x.custoLitro);
    return {
      porTamanho: true, custoLitro: null, precos,
      min: valores.length ? Math.min(...valores) : null, max: valores.length ? Math.max(...valores) : null,
      semPreco: !valores.length, semPrecoTamanhos: precos.filter((x) => x.custoLitro === null).map((x) => x.tamanho),
    };
  }
  const linhasCusto = async (ids) => (ids.length
    ? ok(await supabase.from("custos_chope").select("id, chope_id, tamanho_l, preco_barril, custo_litro, inicio").in("chope_id", ids))
    : []);

  /* Lê e confere os preços enviados (antes de gravar qualquer coisa). Retorna as linhas novas, sem o chope.
     precoPorTamanho falso: custoLitro. Verdadeiro: precos = { "20": 300, "50": 575 } (litros -> preço do barril);
     pelo menos um tamanho ativo preenchido, o vazio fica "Sem preço". */
  async function lerPrecos({ precoPorTamanho, custoLitro, precos, inicio }) {
    const porTamanho = !!precoPorTamanho;
    const dia = cleanInicio(inicio);
    if (!porTamanho) {
      if (vazio(custoLitro)) throw new AppError("Informe o custo por litro (R$).");
      return { porTamanho, dia, linhas: [{ tamanho_l: null, preco_barril: null, custo_litro: cleanDinheiro(custoLitro, "o custo por litro") }] };
    }
    const linhas = [];
    for (const t of await tamanhosAtivos()) {
      const bruto = precos && typeof precos === "object" ? precos[String(t)] : null;
      if (vazio(bruto)) continue;
      const preco = cleanDinheiro(bruto, `o preço do barril de ${litrosTexto(t)}`);
      linhas.push({ tamanho_l: t, preco_barril: preco, custo_litro: Math.round((preco / t) * 10000) / 10000 });
    }
    if (!linhas.length) throw new AppError("Informe o preço de pelo menos um tamanho de barril.");
    return { porTamanho, dia, linhas };
  }
  const precoTexto = (l) => (l.tamanho_l === null
    ? `${reais(l.custo_litro)}/L (qualquer tamanho)`
    : `barril de ${litrosTexto(l.tamanho_l)} ${reais(l.preco_barril)} (${reais(l.custo_litro)}/L)`);

  /* Grava só o que muda na data de início (comparando com o preço que vale nessa data) e a troca entre preço único e
     por tamanho. Auditoria "chope_preco" com o chope, os valores e o início. */
  async function gravarPrecos(ctx, chope, lido) {
    const antigas = await linhasCusto([chope.id]);
    const novas = lido.linhas.filter((n) => {
      const v = custoVigente(antigas.filter((l) => mesmoTamanho(l, n.tamanho_l)), lido.dia);
      return !v || Number(v.custo_litro) !== n.custo_litro || (n.preco_barril !== null && Number(v.preco_barril) !== n.preco_barril);
    });
    const mudouModo = lido.porTamanho !== !!chope.preco_por_tamanho;
    if (!novas.length && !mudouModo) return { gravadas: 0, mudouModo: false };
    if (novas.length) {
      dbError((await supabase.from("custos_chope").insert(novas.map((l) => ({
        ...l, chope_id: chope.id, inicio: lido.dia, criado_por: ctx.session.id,
      })))).error);
    }
    // Depois das linhas: se a troca de modo falhar, as linhas novas ficam sem efeito até salvar de novo
    if (mudouModo) dbError((await supabase.from("chopes").update({ preco_por_tamanho: lido.porTamanho }).eq("id", chope.id)).error);
    const modo = mudouModo ? (lido.porTamanho ? " · preço por tamanho do barril" : " · preço único") : "";
    const valores = novas.length ? novas.map(precoTexto).join("; ") : "sem valor novo";
    await audit(ctx, "chope_preco", `${chope.nome}: ${valores}${modo} · início ${diaBR(lido.dia)}`);
    return { gravadas: novas.length, mudouModo };
  }

  /* Preço de venda por litro de cada chope nas vendas importadas desde `desde`, nas unidades liberadas para a
     pessoa: chope_id -> { litros, valor, precoLitro }. Sem o SQL das vendas no banco: vazio. */
  async function vendasPorLitro(ctx, desde) {
    const ids = await allowedUnitIds(ctx);
    if (!ids.length) return new Map();
    const { data, error } = await supabase.rpc("fn_vendas_preco_litro", { p_unidades: ids, p_desde: desde.toISOString() });
    if (error && error.code === "PGRST202") return new Map();
    dbError(error);
    return new Map((data || []).filter((v) => Number(v.litros) > 0).map((v) => [v.chope_id, {
      litros: Number(v.litros), valor: Number(v.valor), precoLitro: Math.round((Number(v.valor) / Number(v.litros)) * 100) / 100,
    }]));
  }

  /* Ativos por padrão (o cadastro de barril). todos: também os desativados (só quem edita).
     custos (só quem edita): o resumo do custo por litro de cada chope e o preço de venda por litro dos últimos 30 dias
     (vendas importadas), para a tela Chopes. */
  handle("chopes:list", async (p, ctx) => {
    const q = p || {};
    const editar = pode(ctx.session, "catalogo:editar");
    let query = supabase.from("chopes").select("id, nome, ativo, preco_por_tamanho").order("nome");
    if (!wantsAll(q, ctx)) query = query.eq("ativo", true);
    const rows = ok(await query);
    if (!editar || !q.custos) return rows.map((c) => ({ id: c.id, nome: c.nome, ativo: b2i(c.ativo) }));
    const hoje = hojeTZ();
    const [tamanhos, linhas, vendas] = await Promise.all([
      tamanhosAtivos(), linhasCusto(rows.map((c) => c.id)), vendasPorLitro(ctx, inicioDoDia(somaDias(hoje, -29))),
    ]);
    return rows.map((c) => ({
      id: c.id, nome: c.nome, ativo: b2i(c.ativo),
      custo: resumoCusto(c, linhas.filter((l) => l.chope_id === c.id), tamanhos, hoje),
      venda: vendas.get(c.id) || null,
    }));
  });

  // Quem edita o catálogo informa o preço junto (obrigatório). Os outros cargos criam só com o nome: os preços são ignorados.
  handle("chopes:create", async (p, ctx) => {
    const q = p || {};
    const n = cleanCatalogName(q.nome, "chope");
    const editar = pode(ctx.session, "catalogo:editar");
    const lido = editar ? await lerPrecos(q) : null;
    await catalogNameTaken("chopes", "chope", n);
    const row = ok(
      await supabase.from("chopes").insert({ nome: n, preco_por_tamanho: lido ? lido.porTamanho : false })
        .select("id, nome, preco_por_tamanho").single(),
      `Já existe um chope chamado "${n}".`
    );
    await audit(ctx, "chope_criado", n);
    if (lido) await gravarPrecos(ctx, row, lido);
    return { id: row.id, nome: row.nome };
  });

  /* Preços de um chope para o formulário: o que vale hoje nos dois modos (custoLitro do preço único e precos, um por
     tamanho ativo), para a pessoa poder trocar de modo, e o histórico, do mais novo para o mais antigo. */
  handle("chopes:custos", async ({ id }) => {
    const c = await loadChope(id);
    const [tamanhos, historico] = await Promise.all([
      tamanhosAtivos(),
      supabase.from("custos_chope").select("id, tamanho_l, preco_barril, custo_litro, inicio, criado_em, usuarios(nome)")
        .eq("chope_id", c.id).order("inicio", { ascending: false }).order("id", { ascending: false }).then((r) => ok(r)),
    ]);
    const hoje = hojeTZ();
    const unico = resumoCusto({ preco_por_tamanho: false }, historico, tamanhos, hoje);
    const porTamanho = resumoCusto({ preco_por_tamanho: true }, historico, tamanhos, hoje);
    return {
      id: c.id, nome: c.nome, hoje, tamanhos, porTamanho: !!c.preco_por_tamanho,
      custoLitro: unico.custoLitro, precos: porTamanho.precos,
      historico: historico.map((l) => ({
        tamanho: l.tamanho_l === null ? null : Number(l.tamanho_l),
        precoBarril: l.preco_barril === null ? null : Number(l.preco_barril),
        custoLitro: Number(l.custo_litro), inicio: l.inicio,
        criadoEm: fmtTs(l.criado_em), criadoPor: l.usuarios ? l.usuarios.nome : null,
      })),
    };
  }, { perm: "catalogo:editar" });

  // Salvar preços: grava linhas novas, sem apagar as antigas. Dá para trocar entre preço único e por tamanho.
  handle("chopes:precos", async (p, ctx) => {
    const c = await loadChope((p || {}).id);
    return gravarPrecos(ctx, c, await lerPrecos(p || {}));
  }, { perm: "catalogo:editar" });

  // Renomear o chope atualiza chope_nome e estilo de todos os barris dele (barris.estilo guarda o nome do chope)
  handle("chopes:update", async ({ id, nome }, ctx) => {
    const c = await loadChope(id);
    const n = cleanCatalogName(nome, "chope");
    if (n === c.nome) return true;
    await catalogNameTaken("chopes", "chope", n, c.id);
    dbError((await supabase.from("chopes").update({ nome: n }).eq("id", c.id)).error, `Já existe um chope chamado "${n}".`);
    dbError((await supabase.from("barris").update({ chope_nome: n, estilo: n }).eq("chope_id", c.id)).error);
    await audit(ctx, "chope_editado", `${c.nome} → ${n}`);
    return true;
  }, { perm: "catalogo:editar" });

  handle("chopes:toggle", async ({ id }, ctx) => {
    const c = await loadChope(id);
    dbError((await supabase.from("chopes").update({ ativo: !c.ativo }).eq("id", c.id)).error);
    await audit(ctx, c.ativo ? "chope_desativado" : "chope_reativado", c.nome);
    return true;
  }, { perm: "catalogo:editar" });

  // Só chope sem barris (fn_chope_apagar; os preços dele vão junto); com barris, a mensagem do banco sugere desativar ou editar
  handle("chopes:delete", async ({ id }, ctx) => {
    const c = await loadChope(id);
    const r = await rpc("fn_chope_apagar", { p_chope: c.id });
    await audit(ctx, "chope_apagado", r.nome);
    return { nome: r.nome };
  }, { perm: "catalogo:editar" });

  /* ======== Dashboard ======== */
  /* semFuncionarios (só para quem cadastra funcionários): nome da unidade que ainda não tem nenhum funcionário ativo.
     O Painel mostra o aviso para cadastrar, senão ninguém escolhe quem fez cada ação. */
  handle("dashboard:get", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const stats = await rpc("fn_dashboard_stats_v2", { p_unit: unit });
    let semFuncionarios = null;
    if (pode(ctx.session, "funcionarios")) {
      const ativos = ok(await supabase.from("funcionario_unidades").select("funcionario_id, funcionarios!inner(ativo)")
        .eq("unidade_id", unit).eq("funcionarios.ativo", true).limit(1));
      if (!ativos.length) semFuncionarios = ok(await supabase.from("unidades").select("nome").eq("id", unit).single()).nome;
    }
    return { stats, movimentacoes: await queryMovements({ unitId: unit, limit: 8, semPesagens: true }), semFuncionarios };
  });

  /* Ordem: validade (vencidos primeiro), transferências pendentes, vazios aguardando recolhimento.
     nivel "erro" = barril vencido (a tela destaca em vermelho). */
  handle("alerts:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const alerts = [];

    // As quatro consultas saem juntas; os alertas são montados depois, na mesma ordem de antes
    const hoje = hojeTZ();
    const [validade, pend, vazios, estoque] = await Promise.all([
      rpc("fn_alertas_validade", { p_unit: unit, p_hoje: hoje }),
      supabase.from("transferencias")
        .select("id, origem_id, destino_id, barris(codigo), origem:unidades!origem_id(nome), destino:unidades!destino_id(nome)")
        .eq("status", "pendente")
        .or(`origem_id.eq.${unit},destino_id.eq.${unit}`)
        .then((r) => ok(r)),
      rpc("fn_alertas_vazios", { p_unit: unit }),
      // Estoque baixo por chope (considera apenas tipos já presentes na unidade).
      supabase.from("barris")
        .select("chope_id, chope_nome, estilo, status")
        .eq("unidade_id", unit)
        .neq("status", "recolhido")
        .limit(5000)
        .then((r) => ok(r)),
    ]);
    validade.forEach((b) => {
      const quem = `Barril #${b.codigo}${b.chope ? ` (${b.chope})` : ""}`;
      if (b.validade < hoje)
        alerts.push({ nivel: "erro", texto: `${quem} venceu em ${diaMes(b.validade)}. Confira se estava na câmara fria.` });
      else if (b.validade === hoje) alerts.push({ texto: `${quem} vence hoje.` });
      else alerts.push({ texto: `${quem} vence amanhã (${diaMes(b.validade)}).` });
    });

    pend.forEach((t) => {
      const codigo = t.barris ? t.barris.codigo : "?";
      alerts.push({
        texto:
          t.destino_id === unit
            ? `Barril #${codigo} vindo de ${t.origem.nome} aguardando seu recebimento.`
            : `Barril #${codigo} aguardando confirmação de ${t.destino.nome}.`,
      });
    });

    vazios.forEach((v) => alerts.push({ texto: `Barril #${v.codigo} vazio aguardando recolhimento há ${v.dias} dias` }));

    const porChope = new Map();
    estoque.forEach((b) => {
      const chave = b.chope_id || `${b.chope_nome || ""}|${b.estilo || ""}`;
      const item = porChope.get(chave) || { nome: b.chope_nome || b.estilo || "Chope", disponiveis: 0 };
      if (b.status === "disponivel") item.disponiveis += 1;
      porChope.set(chave, item);
    });
    porChope.forEach((b) => {
      if (b.disponiveis <= 2) alerts.push({
        nivel: b.disponiveis === 0 ? "erro" : "aviso",
        texto: b.disponiveis === 0
          ? `Estoque baixo: nenhum barril disponível de ${b.nome} nesta unidade.`
          : `Estoque baixo: restam ${b.disponiveis} barris disponíveis de ${b.nome} nesta unidade.`,
      });
    });

    return alerts;
  });

  /* ======== Barris ======== */
  handle("barris:list", async ({ unitId, status, q }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    let query = supabase
      .from("barris")
      .select("*, unidades(nome_curto), engates(retirado_em, torneiras(numero))")
      .eq("unidade_id", unit)
      .order("codigo", { ascending: true })
      .limit(1000);
    // Recolhidos já voltaram para a fábrica: só aparecem quando o filtro pede por eles
    query = status ? query.eq("status", String(status)) : query.neq("status", "recolhido");
    const termo = cleanTerm(q);
    // Código ou chope (barril antigo sem chope: o estilo gravado nele é o nome)
    if (termo) query = query.or(`codigo.ilike.*${termo}*,chope_nome.ilike.*${termo}*,and(chope_nome.is.null,estilo.ilike.*${termo}*)`);

    const data = ok(await query);
    const hoje = hojeTZ();
    return data.map(({ unidades, engates, ...b }) => {
      const ativo = (engates || []).find((e) => e.retirado_em === null);
      return {
        ...b,
        situacao_validade: situacaoValidade(b.validade, b.status, hoje),
        criado_em: fmtTs(b.criado_em),
        unidade: unidades ? unidades.nome_curto : null,
        torneira_numero: ativo && ativo.torneiras ? ativo.torneiras.numero : null,
      };
    });
  });

  /* Leitura da etiqueta (Torneiras e Transferências): o barril pelo código, em qualquer situação, para a tela dizer
     por que não dá para usar (outra unidade, engatado, em transferência, vazio, recolhido) em vez de só "não achei".
     codigo: o código inteiro ("BA5-2630"); numero: só os números ("2630" = todo barril cujo código termina em -2630).
     A unidade aberta na tela (unitId) precisa estar liberada para a pessoa. Barril de unidade sem acesso: só o código e
     o nome da unidade (acesso: false); a situação só quando ele está em transferência para uma unidade da pessoa.
     O mesmo código pode ter ciclos antigos recolhidos: com um ciclo em andamento, os recolhidos não aparecem. */
  const CODIGO_LIDO_RE = /^[A-Z]{1,4}\d-\d{1,6}$/;
  handle("barris:porCodigo", async ({ unitId, codigo, numero }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const cod = String(codigo || "").trim().toUpperCase();
    const num = String(numero || "").trim();
    if (cod && !CODIGO_LIDO_RE.test(cod)) throw new AppError(`"${cod.slice(0, 30)}" não parece um código de barril. O formato é BA5-1234.`);
    if (!cod && !/^\d{2,6}$/.test(num)) throw new AppError("Leia ou digite o código do barril (ex.: BA5-2630 ou só 2630).");
    let query = supabase
      .from("barris")
      .select("id, codigo, chope_nome, estilo, tamanho_l, status, validade, saldo_l, saldo_estimado, unidade_id," +
        " unidades(nome), engates(retirado_em, torneiras(numero))")
      .order("id", { ascending: false })
      .limit(50);
    // Código inteiro: também o mesmo código gravado sem o hífen (cadastro digitado à mão)
    query = cod ? query.in("codigo", [cod, cod.replace("-", "")]) : query.like("codigo", `*-${num}`);
    const rows = ok(await query);

    // Por código: o ciclo em andamento; sem nenhum, só o recolhido mais recente (as linhas vêm do mais novo)
    const porCodigo = new Map();
    rows.forEach((b) => porCodigo.set(b.codigo, [...(porCodigo.get(b.codigo) || []), b]));
    const escolhidos = [];
    porCodigo.forEach((lista) => {
      const andamento = lista.filter((b) => b.status !== "recolhido");
      escolhidos.push(...(andamento.length ? andamento : [lista[0]]));
    });

    // Em transferência: o destino (a tela avisa "está vindo para esta loja")
    const emTransf = escolhidos.filter((b) => b.status === "em_transferencia").map((b) => b.id);
    const destinos = new Map();
    if (emTransf.length) {
      ok(await supabase.from("transferencias").select("barril_id, destino_id, destino:unidades!destino_id(nome)")
        .in("barril_id", emTransf).eq("status", "pendente"))
        .forEach((t) => destinos.set(t.barril_id, { destino_id: t.destino_id, destino: t.destino ? t.destino.nome : null }));
    }

    const permitidas = await allowedUnitIds(ctx);
    const hoje = hojeTZ();
    return escolhidos
      .map(({ unidades, engates, ...b }) => {
        const unidade = unidades ? unidades.nome : null;
        const transf = destinos.get(b.id) || null;
        if (!permitidas.includes(b.unidade_id)) {
          const vemParaMim = transf && permitidas.includes(transf.destino_id);
          return { codigo: b.codigo, unidade_id: b.unidade_id, unidade, acesso: false,
            ...(vemParaMim ? { status: b.status, ...transf } : {}) };
        }
        const ativo = (engates || []).find((e) => e.retirado_em === null);
        return {
          ...b,
          ...(transf || {}),
          unidade,
          acesso: true,
          situacao_validade: situacaoValidade(b.validade, b.status, hoje),
          torneira_numero: ativo && ativo.torneiras ? ativo.torneiras.numero : null,
        };
      })
      // A unidade aberta primeiro, depois as outras; dentro delas, pelo código
      .sort((a, b) => (b.unidade_id === unit) - (a.unidade_id === unit) ||
        String(a.codigo).localeCompare(String(b.codigo), "pt-BR", { numeric: true }));
  });

  handle("barris:exportStock", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(await supabase.from("barris")
      .select("codigo, chope_nome, estilo, tamanho_l, validade, status, saldo_l, saldo_estimado, unidades(nome_curto), engates(retirado_em, torneiras(numero))," +
        " movimentacoes(id, usuarios(nome), funcionarios(nome))")
      .eq("unidade_id", unit)
      .neq("status", "recolhido")
      .order("codigo", { ascending: true })
      .limit(5000));
    const labels = { disponivel: "Disponível", em_uso: "Em uso", em_transferencia: "Em transferência", esgotado: "Vazio" };
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    // Funcionário: quem fez a última ação do barril (a que o deixou na situação atual: recebeu, engatou, retirou ou enviou)
    const header = ["Barril", "Chope", "Tamanho (L)", "Situação", "Validade", "Unidade", "Torneira", "Funcionário"];
    const lines = rows.map((b) => {
      const engate = (b.engates || []).find((e) => e.retirado_em === null);
      const ultima = (b.movimentacoes || []).reduce((a, m) => (!a || m.id > a.id ? m : a), null);
      return ["#" + b.codigo, b.chope_nome || b.estilo, b.tamanho_l, situacaoTexto(b, labels), b.validade,
        b.unidades ? b.unidades.nome_curto : "", engate && engate.torneiras ? `Torneira ${engate.torneiras.numero}` : "",
        ultima ? quemFez(ultima.funcionarios, ultima.usuarios) : ""]
        .map(esc).join(";");
    });
    await audit(ctx, "relatorio_estoque_exportado", `${rows.length} barris`);
    return {
      filename: `relatorio-estoque-${hojeTZ()}.csv`,
      csv: "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"),
      total: rows.length,
    };
  }, { perm: "exportar" });

  /* Entrada do barril: chope do catálogo + tamanho cadastrado e ativo + validade informada (olhando a data no barril).
     A fn_barril_entrada confere o tamanho e grava o barril (com barris.estilo = nome do chope), a movimentação e a
     auditoria numa única transação. */
  const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
  const diaValido = (v) => DIA_RE.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

  handle("barris:create", async ({ codigo, chopeId, tamanho, validade, unitId, funcionarioId }, ctx) => {
    const cod = String(codigo || "").replace("#", "").trim().toUpperCase();
    const tam = Number(tamanho);
    if (!cod || !Number(chopeId) || !(tam > 0)) throw new AppError("Preencha código, chope e tamanho do barril.");
    const val = String(validade || "").trim();
    if (!val) throw new AppError("Informe a data de validade do barril.");
    if (!diaValido(val)) throw new AppError("Data de validade inválida.");
    if (val < hojeTZ()) throw new AppError("A validade não pode estar no passado");
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const func = await funcionarioDaAcao(ctx, unit, funcionarioId);
    const id = await rpc("fn_barril_entrada", {
      p_codigo: cod, p_chope: Number(chopeId), p_tamanho: tam, p_validade: val, p_unidade: unit, p_usuario: ctx.session.id,
      p_funcionario: func,
    });
    return { id: Number(id) };
  });

  /* Engate (início de uso): disponível → em uso, sempre em uma torneira livre da unidade do barril.
     A função SQL faz todas as verificações e gravações numa única transação. */
  /* Barril vencido: não engata sem confirmação (BARRIL_VENCIDO). Com confirmarVencido, engata e registra
     na auditoria. Nunca bloqueia: quem decide é a gerência. */
  handle("barris:use", async ({ id, torneiraId, unitId, confirmarVencido, funcionarioId }, ctx) => {
    const b = await loadBarril(ctx, id); // barril existe + usuário tem acesso à unidade dele
    if (unitId && Number(unitId) !== b.unidade_id)
      throw new AppError(`O barril #${b.codigo} não pertence à unidade selecionada.`);
    const func = await funcionarioDaAcao(ctx, b.unidade_id, funcionarioId);
    const vencido = b.status === "disponivel" && situacaoValidade(b.validade, b.status) === "vencido";
    if (vencido && torneiraId && confirmarVencido !== true)
      throw new AppError(
        `Este barril venceu em ${diaMes(b.validade)}. Confira se ele estava armazenado na câmara fria. Engatar mesmo assim?`,
        "BARRIL_VENCIDO", null, { codigo: b.codigo, validade: b.validade }
      );

    if (!torneiraId) {
      if (b.status !== "disponivel")
        throw new AppError(`O barril #${b.codigo} não pode ser engatado: está "${STATUS_TEXTO[b.status]}". Só barris disponíveis podem ser engatados.`);
      const livres = (await tapsOfUnit(b.unidade_id)).filter((t) => t.ativo && !t.ocupada).length;
      throw new AppError(livres ? "Selecione a torneira em que o barril será engatado." : MSG_SEM_TORNEIRA);
    }
    const r = await rpc("fn_barril_engatar", {
      p_barril: b.id, p_torneira: Number(torneiraId), p_usuario: ctx.session.id, p_funcionario: func,
    });
    if (vencido) {
      const [ano, mes, dia] = b.validade.split("-");
      await audit(ctx, "engate_barril_vencido",
        `Barril #${b.codigo} (validade ${dia}/${mes}/${ano}) engatado vencido na Torneira ${r.torneira} (${r.unidade})`);
    }
    return r;
  });

  /* Retirada (o barril sai da torneira quando o chopp acaba): em uso → vazio (status esgotado).
     A torneira vem do engate registrado — nunca é escolhida pelo usuário — e é liberada aqui. */
  handle("barris:empty", async ({ id, funcionarioId }, ctx) => {
    const b = await loadBarril(ctx, id);
    const func = await funcionarioDaAcao(ctx, b.unidade_id, funcionarioId);
    return rpc("fn_barril_esgotar", { p_barril: b.id, p_usuario: ctx.session.id, p_funcionario: func });
  });

  /* Retirada com chope: o barril sai da torneira e volta para o estoque com o que sobrou, medido na balança
     (metodo "balanca": pesoBruto em kg e taraId; sem tara para o tamanho, taraNovaKg cadastra a primeira) ou estimado
     (metodo "estimativa": nivel 100, 75, 50 ou 25). Sobrou 0,5 L ou menos: erro QUASE_VAZIO, nada é gravado e a tela
     pergunta se retira como vazio (barris:empty). */
  handle("barris:retirarComChope", async (p, ctx) => {
    const b = await loadBarril(ctx, p.id);
    const func = await funcionarioDaAcao(ctx, b.unidade_id, p.funcionarioId);
    return rpc("fn_barril_retirar_com_chope", {
      p_barril: b.id, p_usuario: ctx.session.id, p_funcionario: func, ...argsMedida(p),
    });
  });

  /* Barris vazios da unidade para o recolhimento, com há quantos dias cada um está vazio */
  handle("barris:emptyList", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(
      await supabase.from("barris")
        .select("id, codigo, estilo, chope_nome, tamanho_l, movimentacoes(operacao, criado_em)")
        .eq("unidade_id", unit).eq("status", "esgotado").order("codigo")
    );
    const agora = Date.now();
    return rows.map(({ movimentacoes, ...b }) => {
      const datas = (movimentacoes || []).map((m) => ({ op: m.operacao, t: new Date(m.criado_em).getTime() }));
      const vazio = datas.filter((m) => m.op === "esgotado");
      const desde = Math.max(...(vazio.length ? vazio : datas).map((m) => m.t), 0) || null;
      return { ...b, vazio_desde: desde ? fmtTs(desde) : null, dias: desde ? Math.floor((agora - desde) / 86400000) : null };
    });
  });

  /* Recolhimento: a fábrica leva os vasilhames vazios. Vários de uma vez, tudo ou nada (fn_barris_recolher).
     Se o mesmo vasilhame voltar, é um cadastro novo com o mesmo código. */
  handle("barris:collect", async ({ ids, unitId, funcionarioId }, ctx) => {
    const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!lista.length) throw new AppError("Marque ao menos um barril para registrar o recolhimento.");
    if (lista.length > 500) throw new AppError("Recolhimento grande demais de uma vez. Divida em partes.");
    const unit = await resolveUnit(ctx, unitId);
    await assertUnit(ctx, unit);
    const func = await funcionarioDaAcao(ctx, unit, funcionarioId);
    const codigos = await rpc("fn_barris_recolher", { p_barris: lista, p_unidade: unit, p_usuario: ctx.session.id, p_funcionario: func });
    return { codigos };
  });

  /* ======== Transferências ======== */
  handle("transfer:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const rows = ok(
      await supabase.from("transferencias")
        .select(
          "*, barris(codigo, estilo, chope_nome), origem:unidades!origem_id(nome_curto), destino:unidades!destino_id(nome_curto)," +
          " solicitante:usuarios!solicitante_id(nome), recebedor:usuarios!recebedor_id(nome)," +
          " func_solicitante:funcionarios!solicitante_func_id(nome), func_recebedor:funcionarios!recebedor_func_id(nome)"
        )
        .or(`origem_id.eq.${unit},destino_id.eq.${unit}`)
        .order("id", { ascending: false })
        .limit(100)
    );
    return rows.map(({ barris, origem, destino, solicitante, recebedor, func_solicitante, func_recebedor, ...t }) => ({
      ...t,
      criado_em: fmtTs(t.criado_em),
      resolvido_em: fmtTs(t.resolvido_em),
      codigo: barris ? barris.codigo : null,
      estilo: barris ? barris.estilo : null,
      chope_nome: barris ? barris.chope_nome : null,
      origem: origem ? origem.nome_curto : null,
      destino: destino ? destino.nome_curto : null,
      solicitante: quemFez(func_solicitante, solicitante),
      recebedor: quemFez(func_recebedor, recebedor),
    }));
  });

  handle("transfer:create", async ({ barrilId, destinoId, funcionarioId }, ctx) => {
    const b = await loadBarril(ctx, barrilId);
    const func = await funcionarioDaAcao(ctx, b.unidade_id, funcionarioId); // quem envia, na unidade de origem
    return rpc("fn_transferencia_criar", {
      p_barril: b.id, p_destino: Number(destinoId) || null, p_usuario: ctx.session.id, p_funcionario: func,
    });
  });

  const loadTransfer = async (id) => {
    const r = await supabase.from("transferencias").select("*").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data || r.data.status !== "pendente") throw new AppError("Transferência não está pendente.");
    return r.data;
  };

  handle("transfer:confirm", async ({ id, funcionarioId }, ctx) => {
    const t = await loadTransfer(id);
    await assertUnit(ctx, t.destino_id); // quem recebe é quem confirma
    const func = await funcionarioDaAcao(ctx, t.destino_id, funcionarioId);
    return rpc("fn_transferencia_confirmar", { p_id: t.id, p_usuario: ctx.session.id, p_funcionario: func });
  });

  handle("transfer:cancel", async ({ id, funcionarioId }, ctx) => {
    const t = await loadTransfer(id);
    await assertUnit(ctx, t.origem_id); // quem enviou é quem cancela
    const func = await funcionarioDaAcao(ctx, t.origem_id, funcionarioId);
    return rpc("fn_transferencia_cancelar", { p_id: t.id, p_usuario: ctx.session.id, p_funcionario: func });
  });

  /* ======== Pesagem: taras dos vasilhames, pesagem avulsa e inventário ========
     Todos os cargos pesam e cadastram tara. Editar, desativar e apagar tara: catalogo:editar (administrador e gerente).
     Tara usada em pesagem não é apagada, só desativada (a pesagem guarda uma cópia do peso). */
  const numeroBR = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(String(v).trim().replace(",", ".")));
  const cleanTaraPeso = (v) => {
    const n = numeroBR(v);
    if (!(n > 0) || n >= 1000) throw new AppError("Informe o peso do vasilhame vazio em kg (ex.: 13,5).");
    return Math.round(n * 100) / 100;
  };
  const cleanTaraDescricao = (v) => {
    const d = String(v || "").trim().replace(/\s+/g, " ");
    if (d.length > 80) throw new AppError("A descrição da tara deve ter até 80 caracteres.");
    return d || null;
  };
  const loadTara = async (id) => {
    const r = await supabase.from("taras").select("*, pesagens(count)").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Tara não encontrada.");
    const { pesagens, ...t } = r.data;
    return { ...t, pesagens: pesagens && pesagens[0] ? pesagens[0].count : 0 };
  };
  const taraTexto = (t) => `Vasilhame de ${litrosTexto(t.tamanho_l)}: ${Number(t.peso_kg).toLocaleString("pt-BR")} kg${t.descricao ? ` (${t.descricao})` : ""}`;

  /* Ativas por padrão (as do diálogo de pesagem, a padrão de cada tamanho primeiro). todos: também as desativadas. */
  handle("taras:list", async ({ todos }) => {
    let query = supabase.from("taras").select("id, tamanho_l, peso_kg, descricao, ativo, criado_em, usuarios(nome), pesagens(count)")
      .order("tamanho_l").order("criado_em", { ascending: false }).order("id", { ascending: false });
    if (!todos) query = query.eq("ativo", true);
    const padrao = new Set();
    return ok(await query).map(({ usuarios, pesagens, ...t }) => {
      const ehPadrao = t.ativo && !padrao.has(Number(t.tamanho_l));
      if (ehPadrao) padrao.add(Number(t.tamanho_l));
      return {
        ...t, tamanho_l: Number(t.tamanho_l), peso_kg: Number(t.peso_kg), ativo: b2i(t.ativo), padrao: ehPadrao,
        criado_em: fmtTs(t.criado_em), criado_por: usuarios ? usuarios.nome : null,
        pesagens: pesagens && pesagens[0] ? pesagens[0].count : 0,
      };
    });
  });

  handle("taras:create", async ({ tamanho, pesoKg, descricao }, ctx) => {
    const tam = Number(tamanho);
    if (!(await tamanhosAtivos()).includes(tam)) throw new AppError("Escolha um tamanho de barril cadastrado.");
    const row = ok(await supabase.from("taras")
      .insert({ tamanho_l: tam, peso_kg: cleanTaraPeso(pesoKg), descricao: cleanTaraDescricao(descricao), criado_por: ctx.session.id })
      .select("id, tamanho_l, peso_kg, descricao").single());
    await audit(ctx, "tara_cadastrada", taraTexto(row));
    return row;
  });

  // Muda o peso e a descrição. As pesagens já feitas guardam o peso antigo (não mudam).
  handle("taras:update", async ({ id, pesoKg, descricao }, ctx) => {
    const t = await loadTara(id);
    const novo = { peso_kg: cleanTaraPeso(pesoKg), descricao: cleanTaraDescricao(descricao) };
    if (Number(t.peso_kg) === novo.peso_kg && (t.descricao || null) === novo.descricao) return true;
    dbError((await supabase.from("taras").update(novo).eq("id", t.id)).error);
    await audit(ctx, "tara_editada", `${taraTexto(t)} → ${Number(novo.peso_kg).toLocaleString("pt-BR")} kg${novo.descricao ? ` (${novo.descricao})` : ""}`);
    return true;
  }, { perm: "catalogo:editar" });

  handle("taras:toggle", async ({ id }, ctx) => {
    const t = await loadTara(id);
    dbError((await supabase.from("taras").update({ ativo: !t.ativo }).eq("id", t.id)).error);
    await audit(ctx, t.ativo ? "tara_desativada" : "tara_reativada", taraTexto(t));
    return true;
  }, { perm: "catalogo:editar" });

  // Só a tara nunca usada (cadastrada errada). Usada em pesagem: desativar.
  handle("taras:delete", async ({ id }, ctx) => {
    const t = await loadTara(id);
    if (t.pesagens > 0)
      throw new AppError(`Esta tara já foi usada em ${t.pesagens} pesagem(ns) e não pode ser apagada. Desative-a para não aparecer mais.`);
    dbError((await supabase.from("taras").delete().eq("id", t.id)).error);
    await audit(ctx, "tara_apagada", taraTexto(t));
    return true;
  }, { perm: "catalogo:editar" });

  /* Pesagem fora da retirada: avulsa ou de inventário (inventarioId). Barril engatado ou disponível. O status não muda;
     o disponível passa a ter o saldo pesado. */
  handle("pesagens:registrar", async (p, ctx) => {
    const b = await loadBarril(ctx, p.barrilId);
    const inventario = Number(p.inventarioId) || null;
    const func = await funcionarioDaAcao(ctx, b.unidade_id, p.funcionarioId);
    return rpc("fn_pesagem_registrar", {
      p_barril: b.id, p_usuario: ctx.session.id, p_funcionario: func, ...argsMedida(p),
      p_motivo: inventario ? "inventario" : "avulsa", p_inventario: inventario,
    });
  });

  /* Inventário da unidade: o aberto (ou null), os barris da lista e o último concluído.
     Lista: engatados (com a torneira) e disponíveis. precisa = engatado ou disponível com saldo (tem de pesar);
     o disponível cheio entra como 100% ao concluir, sem pesar. pesagem = a última deste inventário. */
  async function inventarioDaUnidade(unit) {
    const [aberto, ultimo, barris] = await Promise.all([
      supabase.from("inventarios").select("id, iniciado_em, usuarios(nome)").eq("unidade_id", unit).is("concluido_em", null).maybeSingle()
        .then((r) => ok(r)),
      supabase.from("inventarios").select("id, concluido_em").eq("unidade_id", unit).not("concluido_em", "is", null)
        .order("concluido_em", { ascending: false }).limit(1).then((r) => ok(r)),
      supabase.from("barris")
        .select("id, codigo, estilo, chope_nome, tamanho_l, status, saldo_l, saldo_estimado, engates(retirado_em, torneira_numero)")
        .eq("unidade_id", unit).in("status", ["em_uso", "disponivel"]).order("codigo").limit(2000).then((r) => ok(r)),
    ]);
    const pesagens = aberto
      ? ok(await supabase.from("pesagens").select("id, barril_id, litros, metodo, criado_em, usuarios(nome), funcionarios(nome)")
        .eq("inventario_id", aberto.id).order("id"))
      : [];
    const ultimaDe = new Map(pesagens.map((x) => [x.barril_id, x])); // em ordem de id: fica a última
    const lista = barris.map(({ engates, ...b }) => {
      const engate = (engates || []).find((e) => e.retirado_em === null);
      const pes = ultimaDe.get(b.id);
      return {
        ...b,
        tamanho_l: Number(b.tamanho_l),
        saldo_l: b.saldo_l === null ? null : Number(b.saldo_l),
        torneira_numero: engate ? engate.torneira_numero : null,
        precisa: b.status === "em_uso" || b.saldo_l !== null,
        pesagem: pes ? {
          litros: Number(pes.litros), estimado: pes.metodo === "estimativa",
          criado_em: fmtTs(pes.criado_em), quem: quemFez(pes.funcionarios, pes.usuarios),
        } : null,
      };
    });
    // Engatados (pela torneira), depois os disponíveis com saldo, depois os cheios
    const ordem = (b) => (b.status === "em_uso" ? 0 : b.precisa ? 1 : 2);
    lista.sort((a, b) => ordem(a) - ordem(b) || (a.torneira_numero || 0) - (b.torneira_numero || 0)
      || String(a.codigo).localeCompare(String(b.codigo), "pt-BR", { numeric: true }));
    return {
      inventario: aberto ? { id: aberto.id, iniciado_em: fmtTs(aberto.iniciado_em), iniciado_por: aberto.usuarios ? aberto.usuarios.nome : null } : null,
      ultimo: ultimo[0] ? { id: ultimo[0].id, concluido_em: fmtTs(ultimo[0].concluido_em) } : null,
      barris: lista,
    };
  }

  handle("inventarios:atual", async ({ unitId }, ctx) => inventarioDaUnidade(await resolveUnit(ctx, unitId)));

  handle("inventarios:iniciar", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    await rpc("fn_inventario_iniciar", { p_unidade: unit, p_usuario: ctx.session.id });
    return inventarioDaUnidade(unit);
  });

  // Só conclui com todos os engatados e disponíveis com saldo pesados (o banco confere e lista os que faltam)
  handle("inventarios:concluir", async ({ id, funcionarioId }, ctx) => {
    const r = await supabase.from("inventarios").select("id, unidade_id").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Inventário não encontrado. Atualize a tela.");
    await assertUnit(ctx, r.data.unidade_id);
    const func = await funcionarioDaAcao(ctx, r.data.unidade_id, funcionarioId);
    return rpc("fn_inventario_concluir", { p_inventario: r.data.id, p_usuario: ctx.session.id, p_funcionario: func });
  });

  /* ======== Histórico e relatórios ======== */
  handle("history:list", async ({ unitId, q, operacao, funcionarioId }, ctx) =>
    queryMovements({ unitId: await resolveUnit(ctx, unitId), q, operacao, funcionarioId, limit: 300 })
  );

  handle("history:export", async ({ unitId, q, operacao, funcionarioId }, ctx) => {
    const rows = await queryMovements({ unitId: await resolveUnit(ctx, unitId), q, operacao, funcionarioId });
    const labels = {
      entrada: "Entrada", transferencia: "Transferência", utilizacao: "Utilização", esgotado: "Vazio", recolhimento: "Recolhimento",
      retirada_com_chope: "Retirado com chope", pesagem: "Pesagem",
    };
    // Células que começam com = + - @ viram texto (evita que o Excel execute fórmulas digitadas por usuários)
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    // Responsável = conta que estava logada; Funcionário = quem o operador escolheu na ação (vazio se ninguém foi escolhido)
    const header = ["Data/Hora", "Barril", "Chope", "Operação", "Origem", "Destino", "Torneira", "Responsável", "Funcionário", "Observação"];
    const lines = rows.map((r) =>
      [r.criado_em, "#" + r.codigo, r.chope_nome || r.estilo || "", labels[r.operacao], r.origem || FORNECEDOR, r.destino || "",
       r.torneira_numero ? `Torneira ${r.torneira_numero}` : "", r.usuario, r.funcionario || "",
       r.lancado_em ? `${r.observacao || ""} (horário informado; lançado em ${r.lancado_em})`.trim() : r.observacao]
        .map(esc)
        .join(";")
    );
    const csv = "\uFEFF" + [header.map(esc).join(";"), ...lines].join("\r\n"); // BOM p/ Excel abrir com acentos

    await audit(ctx, "relatorio_exportado", `${rows.length} movimentações`);
    const dia = new Date().toISOString().slice(0, 10);
    return { filename: `relatorio-movimentacoes-${dia}.csv`, csv, total: rows.length };
  }, { perm: "exportar" });

  /* Relatório de barris: uso por chope num período, mais a situação agora.
     Cada linha de barris é um ciclo (o código se repete depois do recolhimento), por isso o banco conta por barris.id.
     unidadeId vazio = todas as unidades liberadas para o usuário. */
  async function reportUnits(ctx, unidadeId) {
    const allowed = await allowedUnitIds(ctx);
    if (!allowed.length)
      throw new AppError("Você ainda não tem acesso a nenhuma unidade. Peça a um administrador para liberar.");
    if (unidadeId === null || unidadeId === undefined || unidadeId === "")
      return { ids: allowed, nome: "Todas as minhas unidades", slug: "todas" };
    const id = Number(unidadeId);
    if (!allowed.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${unidadeId}`);
    const u = ok(await supabase.from("unidades").select("nome_curto").eq("id", id).maybeSingle());
    const nome = u ? u.nome_curto : `Unidade ${id}`;
    const slug = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { ids: [id], nome, slug: slug || `unidade-${id}` };
  }

  // De e Até contam inteiros, no fuso da operação: do começo de De ao começo do dia seguinte a Até
  function reportPeriod(de, ate) {
    if (!diaValido(String(de || "")) || !diaValido(String(ate || ""))) throw new AppError("Informe as datas De e Até do período.");
    if (de > ate) throw new AppError("A data De não pode ser depois da data Até.");
    const dias = (Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000 + 1;
    if (dias > 400) throw new AppError("Escolha um período de até 400 dias.");
    return { de, ate, inicio: inicioDoDia(de).toISOString(), fim: inicioDoDia(somaDias(ate, 1)).toISOString() };
  }

  // Sem o SQL do relatório no banco, o PostgREST responde PGRST202 (função não encontrada)
  async function rpcRelatorio(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error && error.code === "PGRST202")
      throw new AppError("O relatório de barris ainda não foi instalado no banco. Peça para rodar o SQL do relatório no Supabase.");
    dbError(error);
    return data;
  }

  const REL_NUMS = ["recebidos", "utilizados", "litros", "esvaziados", "recolhidos", "estoque", "engatados", "vazios", "em_transferencia"];
  const relNums = (src) => Object.fromEntries(REL_NUMS.map((k) => [k, Number(src ? src[k] : 0) || 0]));

  /* Uma linha por chope, já em ordem de nome. O banco junta o barril antigo (sem chope do catálogo) pelo nome:
     barris.chope_nome ou, sem ele, barris.estilo. O nome da linha é a chave do detalhe. */
  const linhasPorChope = (linhas) => linhas.map((l) => ({ chope: l.chope || "Sem nome", ...relNums(l) }));

  async function relatorioBarris(ctx, { unidadeId, de, ate }) {
    const periodo = reportPeriod(de, ate);
    const unidade = await reportUnits(ctx, unidadeId);
    const r = await rpcRelatorio("fn_relatorio_barris", { p_unidades: unidade.ids, p_de: periodo.inicio, p_ate: periodo.fim });
    return {
      de: periodo.de, ate: periodo.ate,
      unidade: unidade.nome, slug: unidade.slug,
      geradoEm: fmtTs(r.gerado_em),
      chopes: linhasPorChope(r.linhas || []),
      total: relNums(r.totais),
    };
  }

  handle("reports:barrels", async (p, ctx) => {
    const { slug, ...rel } = await relatorioBarris(ctx, p || {});
    return rel;
  });

  // Barris do chope (nome da linha) que tiveram o primeiro engate no período. engatado_por/retirado_por: o funcionário (ou o usuário).
  async function detalheBarris(unidade, periodo, chope) {
    const nome = String(chope ?? "").trim();
    if (!nome) throw new AppError("Escolha o chope.");
    const rows = await rpcRelatorio("fn_relatorio_barris_detalhe", {
      p_unidades: unidade.ids, p_de: periodo.inicio, p_ate: periodo.fim, p_chope: nome,
    });
    return (rows || []).map((b) => ({
      id: b.id, codigo: b.codigo, tamanho_l: b.tamanho_l, validade: b.validade,
      engatado_em: fmtTs(b.engatado_em), retirado_em: fmtTs(b.retirado_em),
      torneira: b.torneira, unidade: b.unidade,
      engatado_por: b.engatado_por || null, retirado_por: b.retirado_por || null,
    }));
  }

  handle("reports:barrelsDetail", async (p, ctx) => {
    const { unidadeId, de, ate } = p || {};
    const periodo = reportPeriod(de, ate);
    const unidade = await reportUnits(ctx, unidadeId);
    return detalheBarris(unidade, periodo, (p || {}).chope);
  });

  handle("reports:barrelsExport", async (p, ctx) => {
    const rel = await relatorioBarris(ctx, p || {});
    // Depois do resumo, os barris utilizados no período (os mesmos do detalhe de cada chope), com quem engatou e quem retirou
    const periodo = reportPeriod(rel.de, rel.ate);
    const unidade = await reportUnits(ctx, (p || {}).unidadeId);
    const detalhes = await Promise.all(rel.chopes.filter((c) => c.utilizados > 0).map(async (c) =>
      (await detalheBarris(unidade, periodo, c.chope)).map((b) => ({ ...b, chope: c.chope }))));
    const esc = (v) => {
      let t = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return `"${t.replace(/"/g, '""')}"`;
    };
    const num = (n) => String(n).replace(".", ","); // litros com vírgula, como o Excel em português espera
    const linha = (chope, n) => [chope, n.recebidos, n.utilizados, num(n.litros), n.esvaziados, n.recolhidos,
      n.estoque, n.engatados, n.vazios, n.em_transferencia].map(esc).join(";");
    const header = ["Chope", "Recebidos", "Utilizados", "Litros utilizados", "Esvaziados", "Recolhidos",
      "Em estoque agora", "Engatados agora", "Vazios aguardando recolhimento", "Em transferência agora"];
    const lines = rel.chopes.map((c) => linha(c.chope, c));
    lines.push(linha("Total geral", rel.total));
    const br = (dia) => dia.split("-").reverse().join("/");
    lines.push("", ["Período", `${br(rel.de)} a ${br(rel.ate)}`].map(esc).join(";"),
      ["Unidade", rel.unidade].map(esc).join(";"),
      ["Situação agora em", rel.geradoEm ? `${br(rel.geradoEm.slice(0, 10))} ${rel.geradoEm.slice(11, 16)}` : ""].map(esc).join(";"),
      esc("Utilizado = barril engatado pela primeira vez dentro do período."));
    const barris = detalhes.flat();
    if (barris.length) {
      const hora = (ts) => (ts ? `${br(ts.slice(0, 10))} ${ts.slice(11, 16)}` : "");
      lines.push("", esc("Barris utilizados no período"),
        ["Chope", "Barril", "Tamanho (L)", "Validade", "Engatado em", "Retirado em", "Torneira", "Unidade",
          "Funcionário (engate)", "Funcionário (retirada)"].map(esc).join(";"),
        ...barris.map((b) => [b.chope, "#" + b.codigo, num(b.tamanho_l), b.validade ? br(b.validade) : "",
          hora(b.engatado_em), hora(b.retirado_em), b.torneira ? `Torneira ${b.torneira}` : "", b.unidade || "",
          b.engatado_por || "", b.retirado_por || ""].map(esc).join(";")));
    }
    await audit(ctx, "relatorio_barris_exportado", `${rel.unidade}, ${br(rel.de)} a ${br(rel.ate)}`);
    return {
      filename: `relatorio-barris-${rel.slug}-${rel.de}-a-${rel.ate}.csv`,
      csv: "﻿" + [header.map(esc).join(";"), ...lines].join("\r\n"),
      total: rel.chopes.length,
    };
  }, { perm: "exportar" });

  /* ======== Vendas (hoje só o relatório da Teknisa) ========
     Importa o relatório "Vendas Realizadas no Período" (XLSX) com o horário de cada venda (leitura em teknisa.js).
     Administrador e gerente (permissão "vendas"); o gerente só nas unidades dele.
     vendas:ler lê o arquivo e devolve a prévia (nada é gravado); vendas:importar lê de novo e grava, numa transação,
     as escolhas dos produtos (de-para em produtos_teknisa) e uma importação por unidade do arquivo. */
  const litrosVenda = (n) => `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} L`;
  const periodoTexto = (de, ate) => (de === ate ? diaBR(de) : `${diaBR(de)} a ${diaBR(ate)}`);
  const precoPorLitro = (valor, litros) => (Number(litros) > 0 ? Math.round((Number(valor) / Number(litros)) * 100) / 100 : null);

  async function lerArquivoTeknisa(p) {
    const b64 = typeof p.arquivo === "string" ? p.arquivo : "";
    if (!b64) throw new AppError("Escolha o arquivo XLSX exportado da Teknisa.");
    const buf = Buffer.from(b64, "base64");
    if (buf.length > teknisa.MAX_ARQUIVO) throw new AppError("O arquivo passa de 10 MB.");
    try {
      return await teknisa.lerArquivo(buf, { tz: TZ });
    } catch (err) {
      if (err instanceof teknisa.ErroTeknisa) throw new AppError(err.message);
      throw err;
    }
  }
  const extremos = (lista) => lista.reduce((r, t) => [Math.min(r[0], t), Math.max(r[1], t)], [Infinity, -Infinity]);
  // Todas as linhas de uma consulta, de 1000 em 1000 (o Supabase devolve no máximo 1000 por vez)
  async function todasAsLinhas(consulta) {
    const out = [];
    for (let de = 0; ; de += 1000) {
      const parte = ok(await consulta().range(de, de + 999));
      out.push(...parte);
      if (parte.length < 1000) return out;
    }
  }
  const nomeArquivo = (p) => String(p.nome || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 200) || "arquivo.xlsx";

  /* Unidades do arquivo, pelo código antes do " - " ("0003 - LOJA ..." -> "0003").
     escolhidas: { "0003": unidadeId } para código que ainda não está em nenhuma unidade (a importação grava o código).
     acesso: a pessoa pode importar nesta unidade (o gerente, só nas dele). */
  async function unidadesDoArquivo(ctx, itens, escolhidas) {
    const codigos = [...new Set(itens.map((i) => i.unidade))];
    const permitidas = await allowedUnitIds(ctx);
    const comCodigo = ok(await supabase.from("unidades").select("id, nome, codigo_teknisa").in("codigo_teknisa", codigos));
    const pedidas = escolhidas && typeof escolhidas === "object" ? escolhidas : {};
    const usadas = new Set();
    const out = [];
    for (const codigo of codigos) {
      const doArquivo = itens.find((i) => i.unidade === codigo);
      const u = { codigo, nomeTeknisa: doArquivo.unidadeNome, unidadeId: null, unidadeNome: null, nova: false, acesso: false };
      const cadastrada = comCodigo.find((x) => x.codigo_teknisa === codigo);
      if (cadastrada) {
        Object.assign(u, { unidadeId: cadastrada.id, unidadeNome: cadastrada.nome, acesso: permitidas.includes(cadastrada.id) });
      } else if (Number(pedidas[codigo])) {
        const id = Number(pedidas[codigo]);
        if (!permitidas.includes(id)) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${id}`);
        const r = ok(await supabase.from("unidades").select("id, nome, codigo_teknisa").eq("id", id).maybeSingle());
        if (!r) throw new AppError("Unidade não encontrada.");
        if (r.codigo_teknisa) throw new AppError(`A unidade ${r.nome} já tem o código ${r.codigo_teknisa} no sistema de caixa.`);
        if (usadas.has(id)) throw new AppError(`Escolha unidades diferentes para as lojas do arquivo (${r.nome} foi escolhida duas vezes).`);
        Object.assign(u, { unidadeId: id, unidadeNome: r.nome, nova: true, acesso: true });
      }
      if (u.unidadeId) usadas.add(u.unidadeId);
      out.push(u);
    }
    return out;
  }

  // Produtos do arquivo (nome normalizado), com o último código visto, a quantidade, o valor e as linhas
  function produtosDoArquivo(itens) {
    const mapa = new Map();
    for (const i of itens) {
      const p = mapa.get(i.produto) || { nome: i.produto, codigo: null, quantidade: 0, valor: 0, linhas: 0 };
      if (i.codigoProduto) p.codigo = i.codigoProduto;
      p.quantidade += i.quantidade;
      p.valor += i.valor;
      p.linhas += 1;
      mapa.set(i.produto, p);
    }
    return [...mapa.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }
  const todosChopes = async () =>
    ok(await supabase.from("chopes").select("id, nome, ativo").order("nome")).map((c) => ({ id: c.id, nome: c.nome, ativo: b2i(c.ativo) }));

  // Volume digitado: "0,36", "0.36" ou número. Vazio: null.
  const lerVolume = (v) => {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };
  // Confere a escolha de um produto: não ignorado precisa de chope do catálogo e de volume (até 100 L por item)
  function escolhaValida(nome, e, idsChopes) {
    const ignorar = !!e.ignorar;
    const chopeId = Number(e.chopeId) || null;
    const volume = lerVolume(e.volume);
    if (chopeId && !idsChopes.has(chopeId)) throw new AppError(`O chope escolhido para "${nome}" não existe mais. Escolha de novo.`);
    if (volume !== null && !(volume > 0 && volume <= 100)) throw new AppError(`Volume inválido em "${nome}": use os litros de chope por item vendido (ex.: 0,36).`);
    if (!ignorar && !chopeId) throw new AppError(`Escolha o chope de "${nome}" ou marque para ignorar.`);
    if (!ignorar && volume === null) throw new AppError(`Informe o volume em litros de "${nome}" (ex.: 0,36).`);
    return { chope_id: chopeId, volume_l: volume === null ? null : Math.round(volume * 10000) / 10000, ignorar };
  }

  // Itens que já foram importados (posições em `itens`), por unidade
  async function itensExistentes(unidadeId, itens) {
    if (!itens.length) return new Set();
    const chaves = itens.map((i, n) => ({ i: n, caixa: i.caixa, nr: i.nr, linha: i.linha }));
    return new Set(await rpc("fn_vendas_existentes", { p_unidade: unidadeId, p_chaves: chaves }));
  }

  /* Prévia. Devolve o período do arquivo, as unidades (com os totais do arquivo para conferir com o sistema de caixa), os produtos
     (os conhecidos com o que está gravado; os novos com a sugestão) e, por unidade, grupos por produto e dia:
     q/v/n = quantidade, valor e itens; qr/vr/nr = o que já tinha sido importado (será pulado). A tela calcula os litros. */
  handle("vendas:ler", async (p, ctx) => {
    const itens = await lerArquivoTeknisa(p || {});
    const unidades = await unidadesDoArquivo(ctx, itens, (p || {}).unidades);
    const produtos = produtosDoArquivo(itens);
    const [chopes, salvos] = await Promise.all([
      todosChopes(),
      todasAsLinhas(() => supabase.from("produtos_teknisa").select("nome, chope_id, volume_l, ignorar").order("id")),
    ]);
    const salvo = new Map(salvos.map((r) => [r.nome, r]));
    const ativos = chopes.filter((c) => c.ativo);
    const indice = new Map(produtos.map((x, i) => [x.nome, i]));
    const listaProdutos = produtos.map((x) => {
      const s = salvo.get(x.nome);
      const base = { nome: x.nome, codigo: x.codigo, quantidade: x.quantidade, valor: Math.round(x.valor * 100) / 100, linhas: x.linhas };
      if (s) return { ...base, novo: false, chopeId: s.chope_id, volume: s.volume_l === null ? null : Number(s.volume_l), ignorar: !!s.ignorar, aviso: null, parecidos: [] };
      return { ...base, novo: true, ...teknisa.sugestaoProduto(x.nome, ativos) };
    });

    const blocos = [];
    for (const u of unidades) {
      const daUnidade = itens.filter((i) => i.unidade === u.codigo);
      const existentes = u.unidadeId && u.acesso ? await itensExistentes(u.unidadeId, daUnidade) : new Set();
      const grupos = new Map();
      daUnidade.forEach((i, n) => {
        const k = `${indice.get(i.produto)}|${i.dia}`;
        const g = grupos.get(k) || { p: indice.get(i.produto), dia: i.dia, q: 0, v: 0, n: 0, qr: 0, vr: 0, nr: 0 };
        g.q += i.quantidade; g.v += i.valor; g.n += 1;
        if (existentes.has(n)) { g.qr += i.quantidade; g.vr += i.valor; g.nr += 1; }
        grupos.set(k, g);
      });
      const [primeiraU, ultimaU] = extremos(daUnidade.map((i) => i.vendidoEm.getTime()));
      blocos.push({
        ...u,
        linhas: daUnidade.length,
        quantidade: daUnidade.reduce((s, i) => s + i.quantidade, 0),
        valor: Math.round(daUnidade.reduce((s, i) => s + i.valor, 0) * 100) / 100,
        primeiraVenda: fmtTs(primeiraU), ultimaVenda: fmtTs(ultimaU),
        grupos: [...grupos.values()].map((g) => ({ ...g, v: Math.round(g.v * 100) / 100, vr: Math.round(g.vr * 100) / 100 })),
      });
    }
    const [t0, t1] = extremos(itens.map((i) => i.vendidoEm.getTime()));
    const primeira = new Date(t0);
    const ultima = new Date(t1);
    // Unidades que podem receber um código novo: as liberadas para a pessoa, ainda sem código no sistema de caixa
    const permitidas = await allowedUnitIds(ctx);
    const livres = permitidas.length
      ? ok(await supabase.from("unidades").select("id, nome").in("id", permitidas).is("codigo_teknisa", null).order("nome"))
      : [];
    return {
      arquivo: nomeArquivo(p || {}),
      primeiraVenda: fmtTs(primeira), ultimaVenda: fmtTs(ultima),
      de: teknisa.diaNoFuso(primeira, TZ), ate: teknisa.diaNoFuso(ultima, TZ),
      unidades: blocos, unidadesLivres: livres, produtos: listaProdutos, chopes,
    };
  }, { perm: "vendas" });

  /* Importar: { arquivo, nome, de, ate, unidades: { codigo: unidadeId }, produtos: [{ nome, chopeId, volume, ignorar }] }.
     Só entram os itens de chope (produto não ignorado) com o dia da venda dentro do período. */
  handle("vendas:importar", async (p, ctx) => {
    const q = p || {};
    const periodo = reportPeriod(q.de, q.ate);
    const itens = await lerArquivoTeknisa(q);
    const unidades = await unidadesDoArquivo(ctx, itens, q.unidades);
    const semUnidade = unidades.find((u) => !u.unidadeId);
    if (semUnidade) throw new AppError(`Escolha a unidade da loja ${semUnidade.codigo} - ${semUnidade.nomeTeknisa}.`);
    const lotesUnidades = unidades.filter((u) => u.acesso);
    if (!lotesUnidades.length) throw new AppError("Você não tem acesso a nenhuma unidade deste arquivo.", "FORBIDDEN", "vendas:importar");

    const chopes = await todosChopes();
    const idsChopes = new Set(chopes.map((c) => c.id));
    const escolhas = new Map((Array.isArray(q.produtos) ? q.produtos : [])
      .filter((x) => x && typeof x === "object").map((x) => [teknisa.normalizar(x.nome), x]));
    const produtos = produtosDoArquivo(itens).map((x) => {
      const e = escolhas.get(x.nome);
      if (!e) throw new AppError(`Falta a escolha do produto "${x.nome}". Escolha o arquivo de novo.`);
      return { nome: x.nome, codigo: x.codigo, ...escolhaValida(x.nome, e, idsChopes) };
    });
    const ignorado = new Set(produtos.filter((x) => x.ignorar).map((x) => x.nome));
    const iso = (d) => (d ? d.toISOString() : null);
    const lotes = lotesUnidades.map((u) => {
      const doPeriodo = itens.filter((i) => i.unidade === u.codigo && i.dia >= periodo.de && i.dia <= periodo.ate);
      const [t0, t1] = extremos(doPeriodo.map((i) => i.vendidoEm.getTime()));
      return {
        unidade_id: u.unidadeId,
        codigo_teknisa: u.nova ? u.codigo : null,
        primeira: doPeriodo.length ? new Date(t0).toISOString() : null,
        ultima: doPeriodo.length ? new Date(t1).toISOString() : null,
        itens: doPeriodo.filter((i) => !ignorado.has(i.produto)).map((i) => ({
          caixa: i.caixa, nr: i.nr, linha: i.linha, vendido_em: iso(i.vendidoEm), dt_venda: iso(i.dtVenda), comanda: iso(i.comanda),
          modalidade: i.modalidade, produto: i.produto, quantidade: i.quantidade, valor: i.valor,
        })),
      };
    });
    const arquivo = nomeArquivo(q);
    const r = ok(await supabase.rpc("fn_vendas_importar", {
      p_usuario: ctx.session.id, p_arquivo: arquivo, p_de: periodo.de, p_ate: periodo.ate, p_produtos: produtos, p_lotes: lotes,
    }), "Este código do sistema de caixa já está em outra unidade.");

    const resultado = r.map((x) => {
      const u = lotesUnidades.find((y) => y.unidadeId === Number(x.unidade_id));
      return {
        importacaoId: x.importacao_id, unidadeId: u.unidadeId, unidade: u.unidadeNome, codigo: u.codigo,
        linhas: x.linhas, novas: x.novas, repetidas: x.repetidas, litros: Number(x.litros), valor: Number(x.valor),
      };
    });
    for (const x of resultado) {
      if (!x.importacaoId) continue;
      await audit(ctx, "vendas_importadas",
        `${x.unidade}: período ${periodoTexto(periodo.de, periodo.ate)}, ${x.novas} ${x.novas === 1 ? "item novo" : "itens novos"}, ` +
        `${litrosVenda(x.litros)}${x.repetidas ? `, ${x.repetidas} já importado(s)` : ""} (arquivo ${arquivo})`);
    }
    for (const u of lotesUnidades.filter((y) => y.nova))
      await audit(ctx, "unidade_codigo_teknisa", `${u.unidadeNome}: código no sistema de caixa ${u.codigo} (na importação de vendas)`);
    return {
      de: periodo.de, ate: periodo.ate, importacoes: resultado,
      semAcesso: unidades.filter((u) => !u.acesso).map((u) => `${u.codigo} - ${u.nomeTeknisa}`),
    };
  }, { perm: "vendas" });

  const importacaoLinha = (x) => ({
    id: x.id, unidadeId: x.unidade_id, unidade: x.unidades ? x.unidades.nome : null, arquivo: x.arquivo_nome,
    de: x.periodo_de, ate: x.periodo_ate, primeiraVenda: fmtTs(x.primeira_venda), ultimaVenda: fmtTs(x.ultima_venda),
    linhas: x.linhas, novas: x.linhas_novas, repetidas: x.linhas_repetidas,
    litros: Number(x.total_litros), valor: Number(x.total_valor), precoLitro: precoPorLitro(x.total_valor, x.total_litros),
    criadoEm: fmtTs(x.criado_em), criadoPor: x.usuario ? x.usuario.nome : null,
    cancelada: !!x.cancelada, canceladaEm: fmtTs(x.cancelada_em), canceladaPor: x.cancelador ? x.cancelador.nome : null,
  });
  const IMPORTACAO_SELECT = "id, unidade_id, arquivo_nome, periodo_de, periodo_ate, primeira_venda, ultima_venda, linhas, linhas_novas," +
    " linhas_repetidas, total_litros, total_valor, criado_em, cancelada, cancelada_em, unidades(nome)," +
    " usuario:usuarios!usuario_id(nome), cancelador:usuarios!cancelada_por(nome)";
  async function loadImportacao(ctx, id) {
    const r = ok(await supabase.from("importacoes_vendas").select(IMPORTACAO_SELECT).eq("id", Number(id)).maybeSingle());
    if (!r) throw new AppError("Importação não encontrada.");
    await assertUnit(ctx, r.unidade_id);
    return r;
  }

  // As importações das unidades liberadas, da mais nova para a mais antiga (as 200 últimas)
  handle("vendas:importacoes", async (_p, ctx) => {
    const ids = await allowedUnitIds(ctx);
    if (!ids.length) return [];
    const rows = ok(await supabase.from("importacoes_vendas").select(IMPORTACAO_SELECT)
      .in("unidade_id", ids).order("id", { ascending: false }).limit(200));
    return rows.map(importacaoLinha);
  }, { perm: "vendas" });

  // "Ver": litros e valor por chope e por dia, com o preço de venda por litro (valor ÷ litros)
  handle("vendas:resumo", async ({ id }, ctx) => {
    const imp = await loadImportacao(ctx, id);
    const r = await rpc("fn_importacao_resumo", { p_importacao: imp.id, p_tz: TZ });
    const linha = (x) => ({ quantidade: Number(x.quantidade), litros: Number(x.litros), valor: Number(x.valor), precoLitro: precoPorLitro(x.valor, x.litros) });
    return {
      ...importacaoLinha(imp),
      chopes: (r.chopes || []).map((c) => ({ chopeId: c.chope_id, nome: c.nome, ...linha(c) })),
      dias: (r.dias || []).map((d) => ({ dia: d.dia, ...linha(d) })),
    };
  }, { perm: "vendas" });

  // Cancelar: apaga os itens que esta importação gravou e marca como cancelada (as outras importações ficam)
  handle("vendas:cancelar", async ({ id }, ctx) => {
    const imp = await loadImportacao(ctx, id);
    const r = await rpc("fn_vendas_cancelar", { p_importacao: imp.id, p_usuario: ctx.session.id });
    await audit(ctx, "vendas_importacao_cancelada",
      `${imp.unidades ? imp.unidades.nome : `Unidade ${imp.unidade_id}`}: período ${periodoTexto(imp.periodo_de, imp.periodo_ate)}, ` +
      `${r.itens} ${r.itens === 1 ? "item apagado" : "itens apagados"} (arquivo ${imp.arquivo_nome || "—"})`);
    return { itens: r.itens };
  }, { perm: "vendas" });

  /* Aba Produtos: o de-para. Mudar o chope ou o volume vale para as próximas importações; as vendas já importadas
     guardam a cópia que tinham. */
  handle("vendas:produtos", async () => {
    const [rows, chopes] = await Promise.all([
      todasAsLinhas(() => supabase.from("produtos_teknisa").select("id, nome, codigo, chope_id, volume_l, ignorar, atualizado_em, chopes(nome)")
        .order("nome").order("id")),
      todosChopes(),
    ]);
    return {
      chopes,
      produtos: rows.map((x) => ({
        id: x.id, nome: x.nome, codigo: x.codigo, chopeId: x.chope_id, chope: x.chopes ? x.chopes.nome : null,
        volume: x.volume_l === null ? null : Number(x.volume_l), ignorar: !!x.ignorar, atualizadoEm: fmtTs(x.atualizado_em),
      })),
    };
  }, { perm: "vendas" });

  handle("vendas:produtoSalvar", async (p, ctx) => {
    const q = p || {};
    const atual = ok(await supabase.from("produtos_teknisa").select("id, nome, chope_id, volume_l, ignorar").eq("id", Number(q.id)).maybeSingle());
    if (!atual) throw new AppError("Produto não encontrado.");
    const chopes = await todosChopes();
    const e = escolhaValida(atual.nome, q, new Set(chopes.map((c) => c.id)));
    const igual = e.chope_id === atual.chope_id && e.ignorar === atual.ignorar &&
      (e.volume_l === null ? atual.volume_l === null : atual.volume_l !== null && Number(atual.volume_l) === e.volume_l);
    if (igual) return { mudou: false };
    dbError((await supabase.from("produtos_teknisa").update({ ...e, atualizado_em: new Date().toISOString() }).eq("id", atual.id)).error);
    const chope = chopes.find((c) => c.id === e.chope_id);
    await audit(ctx, "produto_teknisa_editado", e.ignorar
      ? `${atual.nome}: ignorado`
      : `${atual.nome}: ${chope ? chope.nome : "—"}, ${litrosVenda(e.volume_l)} por item`);
    return { mudou: true };
  }, { perm: "vendas" });

  handle("audit:list", async () => {
    const rows = ok(
      await supabase.from("auditoria").select("id, acao, detalhe, criado_em, usuarios(nome)").order("id", { ascending: false }).limit(300)
    );
    return rows.map((a) => ({
      id: a.id, acao: a.acao, detalhe: a.detalhe, criado_em: fmtTs(a.criado_em), usuario: a.usuarios ? a.usuarios.nome : "—",
    }));
  }, { perm: "auditoria" });

  /* ======== Funcionários do quiosque ========
     Quem trabalha em cada unidade. No celular da loja (conta de operador compartilhada), a pessoa toca no próprio
     nome antes de salvar cada ação (funcionarioDaAcao). Cadastro: permissão "funcionarios" (administrador e gerente);
     o gerente só vê e mexe nas unidades liberadas para ele. Funcionário não é apagado, só desativado. */
  const cleanFuncNome = (value) => {
    const nome = String(value || "").trim().replace(/\s+/g, " ");
    if (nome.length < 2 || nome.length > 60) throw new AppError("O nome do funcionário deve ter de 2 a 60 caracteres.");
    return nome;
  };
  // Nome repetido, sem diferenciar maiúsculas (o índice único em lower(nome) garante no banco)
  const funcNomeTaken = async (nome, exceptId = 0) => {
    const rows = ok(await supabase.from("funcionarios").select("nome, ativo").ilike("nome", likeEscape(nome)).neq("id", exceptId).limit(10));
    const igual = rows.find((r) => r.nome.toLowerCase() === nome.toLowerCase());
    if (igual) throw new AppError(`Já existe um funcionário chamado "${igual.nome}"${igual.ativo ? "" : " (desativado)"}. Use outro nome, por exemplo com o sobrenome.`);
  };
  // Unidades escolhidas: ao menos uma, todas ativas e liberadas para quem está cadastrando
  const cleanFuncUnidades = async (ctx, ids) => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!list.length) throw new AppError("Escolha ao menos uma unidade para o funcionário.");
    const permitidas = await allowedUnitIds(ctx);
    const fora = list.find((id) => !permitidas.includes(id));
    if (fora) throw new AppError("Você não tem acesso a esta unidade.", "FORBIDDEN", `unidade ${fora}`);
    return list;
  };
  // Funcionário com as unidades dele. Gerente só mexe em quem trabalha em alguma unidade liberada para ele.
  const loadFuncionario = async (ctx, id) => {
    const r = await supabase.from("funcionarios").select("id, nome, ativo, funcionario_unidades(unidade_id)").eq("id", Number(id)).maybeSingle();
    dbError(r.error);
    if (!r.data) throw new AppError("Funcionário não encontrado.");
    const unidadeIds = (r.data.funcionario_unidades || []).map((x) => x.unidade_id);
    const permitidas = await allowedUnitIds(ctx);
    if (!unidadeIds.some((u) => permitidas.includes(u)))
      throw new AppError("Você não tem acesso a este funcionário.", "FORBIDDEN", `funcionário ${r.data.id}`);
    return { id: r.data.id, nome: r.data.nome, ativo: r.data.ativo, unidadeIds, permitidas };
  };
  const nomesUnidades = async (ids) =>
    ids.length ? ok(await supabase.from("unidades").select("id, nome_curto").in("id", ids).order("id")).map((u) => u.nome_curto) : [];

  /* Funcionários da unidade, em ordem alfabética. Quem cadastra vê todos (ativos e desativados) com as unidades
     liberadas para ele. Operador recebe só id e nome dos ativos (a lista de "Quem está fazendo?"). */
  handle("funcionarios:list", async ({ unitId }, ctx) => {
    const unit = await resolveUnit(ctx, unitId);
    const ids = ok(await supabase.from("funcionario_unidades").select("funcionario_id").eq("unidade_id", unit)).map((x) => x.funcionario_id);
    if (!ids.length) return [];
    if (!pode(ctx.session, "funcionarios")) {
      const ativos = ok(await supabase.from("funcionarios").select("id, nome").in("id", ids).eq("ativo", true));
      return ativos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
    }
    const [rows, permitidas, unidades] = await Promise.all([
      supabase.from("funcionarios").select("id, nome, ativo, funcionario_unidades(unidade_id)").in("id", ids).then((r) => ok(r)),
      allowedUnitIds(ctx),
      supabase.from("unidades").select("id, nome_curto").order("id").then((r) => ok(r)),
    ]);
    return rows
      .map((f) => {
        const minhas = (f.funcionario_unidades || []).map((x) => x.unidade_id).filter((u) => permitidas.includes(u)).sort((a, b) => a - b);
        return {
          id: f.id, nome: f.nome, ativo: b2i(f.ativo), unidadeIds: minhas,
          unidades: minhas.map((u) => (unidades.find((x) => x.id === u) || { nome_curto: `Unidade ${u}` }).nome_curto),
        };
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
  });

  handle("funcionarios:create", async ({ nome, unidadeIds }, ctx) => {
    const n = cleanFuncNome(nome);
    const units = await cleanFuncUnidades(ctx, unidadeIds);
    await funcNomeTaken(n);
    const row = ok(await supabase.from("funcionarios").insert({ nome: n }).select("id").single(), `Já existe um funcionário chamado "${n}".`);
    const r = await supabase.from("funcionario_unidades").insert(units.map((u) => ({ funcionario_id: row.id, unidade_id: u })));
    if (r.error) {
      await supabase.from("funcionarios").delete().eq("id", row.id); // desfaz: não deixa funcionário sem unidade
      dbError(r.error);
    }
    await audit(ctx, "funcionario_criado", `${n} (${(await nomesUnidades(units)).join(", ")})`);
    return { id: row.id, nome: n };
  }, { perm: "funcionarios" });

  /* Nome e unidades. O gerente só troca as unidades liberadas para ele: as outras unidades do funcionário continuam. */
  handle("funcionarios:update", async ({ id, nome, unidadeIds }, ctx) => {
    const f = await loadFuncionario(ctx, id);
    const n = cleanFuncNome(nome);
    const escolhidas = await cleanFuncUnidades(ctx, unidadeIds);
    if (n !== f.nome) await funcNomeTaken(n, f.id);
    const units = [...new Set([...f.unidadeIds.filter((u) => !f.permitidas.includes(u)), ...escolhidas])];
    if (n !== f.nome)
      dbError((await supabase.from("funcionarios").update({ nome: n }).eq("id", f.id)).error, `Já existe um funcionário chamado "${n}".`);
    // Primeiro adiciona as novas, depois remove as que saíram (nunca fica sem unidade no meio do caminho)
    dbError((await supabase.from("funcionario_unidades")
      .upsert(units.map((u) => ({ funcionario_id: f.id, unidade_id: u })), { onConflict: "funcionario_id,unidade_id", ignoreDuplicates: true })).error);
    dbError((await supabase.from("funcionario_unidades").delete().eq("funcionario_id", f.id).not("unidade_id", "in", `(${units.join(",")})`)).error);
    const nomeTxt = n === f.nome ? n : `${f.nome} → ${n}`;
    await audit(ctx, "funcionario_editado", `${nomeTxt}, unidades ${(await nomesUnidades(escolhidas)).join(", ")}`);
    return true;
  }, { perm: "funcionarios" });

  // Desativado some da escolha de quem está fazendo; o histórico continua apontando para ele
  handle("funcionarios:toggle", async ({ id }, ctx) => {
    const f = await loadFuncionario(ctx, id);
    dbError((await supabase.from("funcionarios").update({ ativo: !f.ativo }).eq("id", f.id)).error);
    await audit(ctx, f.ativo ? "funcionario_desativado" : "funcionario_reativado", f.nome);
    return true;
  }, { perm: "funcionarios" });

  /* ======== Usuários (somente administrador) ======== */
  const CARGOS = Object.keys(CARGO_LABEL);
  const cleanUnitIds = async (ids, cargo = "operador") => {
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean))];
    if (!list.length) throw new AppError(`Escolha ao menos uma unidade para o ${cargo === "gerente" ? "gerente" : "operador"}.`);
    const valid = ok(await supabase.from("unidades").select("id").eq("ativo", true)).map((r) => r.id);
    if (list.some((id) => !valid.includes(id))) throw new AppError("Unidade inválida ou desativada.");
    return list;
  };
  const loadUser = async (id) => {
    const u = await getUserById(Number(id));
    if (!u) throw new AppError("Usuário não encontrado.");
    return u;
  };
  // Existe outro administrador ativo além deste? (o sistema nunca fica sem nenhum)
  const outroAdminAtivo = async (exceptId) =>
    ok(await supabase.from("usuarios").select("id").eq("cargo", "admin").eq("ativo", true).neq("id", exceptId).limit(1)).length > 0;
  const ultimoAdmin = async (u) => u.cargo === "admin" && u.ativo && !(await outroAdminAtivo(u.id));
  // Troca as unidades liberadas: primeiro adiciona as novas, depois remove as que saíram (nunca fica sem acesso no meio do caminho)
  const gravarUnidades = async (usuarioId, units) => {
    dbError(
      (await supabase.from("usuario_unidades")
        .upsert(units.map((uid) => ({ usuario_id: usuarioId, unidade_id: uid })), { onConflict: "usuario_id,unidade_id", ignoreDuplicates: true })).error
    );
    dbError(
      (await supabase.from("usuario_unidades").delete().eq("usuario_id", usuarioId).not("unidade_id", "in", `(${units.join(",")})`)).error
    );
  };

  handle("users:list", async () => {
    const access = ok(await supabase.from("usuario_unidades").select("usuario_id, unidades(id, nome_curto)"))
      .filter((a) => a.unidades)
      .sort((a, b) => a.unidades.id - b.unidades.id);
    const users = ok(
      await supabase.from("usuarios")
        .select("id, nome, email, usuario, cargo, ativo, trocar_senha, bloqueado_ate, ultimo_login")
        .order("nome")
    );
    return users.map((u) => ({
      ...u,
      ativo: b2i(u.ativo),
      trocar_senha: b2i(u.trocar_senha),
      ultimo_login: fmtTs(u.ultimo_login),
      bloqueado: (Number(u.bloqueado_ate) || 0) > Date.now(),
      unidadeIds: access.filter((a) => a.usuario_id === u.id).map((a) => a.unidades.id),
      unidades: access.filter((a) => a.usuario_id === u.id).map((a) => a.unidades.nome_curto),
    }));
  }, { perm: "usuarios" });

  /* Cria o usuário com uma senha temporária aleatória, exibida uma única vez ao administrador */
  handle("users:create", async ({ nome, email, cargo, unidadeIds }, ctx) => {
    const name = String(nome || "").trim();
    if (!name) throw new AppError("Informe o nome.");
    const em = normalizeEmail(email);
    if (!CARGOS.includes(cargo)) throw new AppError("Cargo inválido.");
    const units = cargo === "admin" ? [] : await cleanUnitIds(unidadeIds, cargo);
    if (await emailTaken(em)) throw new AppError(`O e-mail ${em} já está cadastrado.`);

    const senha = generateTempPassword();
    const novo = ok(
      await supabase.from("usuarios")
        .insert({ nome: name, usuario: em, email: em, senha_hash: await hashPassword(senha), cargo, trocar_senha: true })
        .select("id").single(),
      `O e-mail ${em} já está cadastrado.`
    );
    if (units.length) {
      const r = await supabase.from("usuario_unidades").insert(units.map((uid) => ({ usuario_id: novo.id, unidade_id: uid })));
      if (r.error) {
        await supabase.from("usuarios").delete().eq("id", novo.id); // desfaz: não deixa usuário sem acesso pela metade
        dbError(r.error);
      }
    }
    await audit(ctx, "usuario_criado", `${em} (${cargo})`);
    return { email: em, senha };
  }, { perm: "usuarios" });

  /* Altera a quais quiosques o gerente ou operador tem acesso */
  handle("users:setUnits", async ({ id, unidadeIds }, ctx) => {
    const u = await loadUser(id);
    if (u.cargo === "admin") throw new AppError("Administradores têm acesso a todas as unidades.");
    const units = await cleanUnitIds(unidadeIds, u.cargo);
    await gravarUnidades(u.id, units);
    recarregarSessoes(u.id);
    await audit(ctx, "acesso_alterado", `${u.email || u.usuario}: unidades ${units.join(", ")}`);
    return true;
  }, { perm: "usuarios" });

  handle("users:resetPassword", async ({ id }, ctx) => {
    const u = await loadUser(id);
    const senha = generateTempPassword();
    dbError(
      (await supabase.from("usuarios")
        .update({ senha_hash: await hashPassword(senha), trocar_senha: true, falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error
    );
    await encerrarSessoes(u.id); // a pessoa sai de todos os aparelhos e entra de novo com a senha temporária
    await audit(ctx, "senha_temporaria_gerada", u.email || u.usuario);
    return { email: u.email || u.usuario, senha };
  }, { perm: "usuarios" });

  handle("users:unlock", async ({ id }, ctx) => {
    const u = await loadUser(id);
    dbError((await supabase.from("usuarios").update({ falhas: 0, bloqueado_ate: null }).eq("id", u.id)).error);
    await audit(ctx, "usuario_desbloqueado", u.email || u.usuario);
    return true;
  }, { perm: "usuarios" });

  handle("users:toggle", async ({ id }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode desativar o seu próprio usuário.");
    const u = await loadUser(id);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível desativar o último administrador ativo.");
    dbError((await supabase.from("usuarios").update({ ativo: !u.ativo }).eq("id", u.id)).error);
    if (u.ativo) await encerrarSessoes(u.id); // desativado: a próxima ação dele leva ao login
    await audit(ctx, u.ativo ? "usuario_desativado" : "usuario_ativado", u.email || u.usuario);
    return true;
  }, { perm: "usuarios" });

  /* Troca o cargo. Gerente e operador precisam de ao menos uma unidade; administrador vê todas (a lista sai). */
  handle("users:setRole", async ({ id, cargo, unidadeIds }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode alterar o seu próprio cargo.");
    if (!CARGOS.includes(cargo)) throw new AppError("Cargo inválido.");
    const u = await loadUser(id);
    if (u.cargo === cargo) throw new AppError(`${u.nome} já é ${CARGO_LABEL[cargo]}. Escolha outro cargo.`);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível tirar o cargo do último administrador ativo.");
    const units = cargo === "admin" ? [] : await cleanUnitIds(unidadeIds, cargo);
    if (units.length) await gravarUnidades(u.id, units);
    dbError((await supabase.from("usuarios").update({ cargo }).eq("id", u.id)).error);
    if (!units.length) dbError((await supabase.from("usuario_unidades").delete().eq("usuario_id", u.id)).error);
    recarregarSessoes(u.id); // a próxima chamada da pessoa já usa o cargo novo
    const extra = units.length ? `, unidades ${units.join(", ")}` : "";
    await audit(ctx, "cargo_alterado", `${u.email || u.usuario}: ${CARGO_LABEL[u.cargo]} → ${CARGO_LABEL[cargo]}${extra}`);
    return true;
  }, { perm: "usuarios" });

  /* Antes de apagar: quanto histórico a pessoa tem e para quem ele pode passar */
  const contar = async (tabela, filtro) => {
    const r = await filtro(supabase.from(tabela).select("id", { count: "exact", head: true }));
    dbError(r.error);
    return r.count || 0;
  };
  handle("users:deletePreview", async ({ id }, ctx) => {
    if (Number(id) === ctx.session.id) throw new AppError("Você não pode apagar o seu próprio usuário.");
    const u = await loadUser(id);
    if (await ultimoAdmin(u)) throw new AppError("Não é possível apagar o último administrador ativo.");
    const engates = await contar("engates", (q) => q.or(`engatado_por.eq.${u.id},retirado_por.eq.${u.id}`));
    const movimentacoes = await contar("movimentacoes", (q) => q.eq("usuario_id", u.id));
    const transferencias = await contar("transferencias", (q) => q.or(`solicitante_id.eq.${u.id},recebedor_id.eq.${u.id}`));
    const pesagens = await contar("pesagens", (q) => q.eq("usuario_id", u.id));
    const inventarios = await contar("inventarios", (q) => q.eq("usuario_id", u.id));
    const outros = ok(await supabase.from("usuarios").select("id, nome, email, usuario, ativo").neq("id", u.id).order("nome"));
    return {
      usuario: { id: u.id, nome: u.nome, email: u.email || u.usuario },
      engates, movimentacoes, transferencias, pesagens, inventarios,
      total: engates + movimentacoes + transferencias + pesagens + inventarios,
      outros: outros.map((o) => ({ id: o.id, nome: o.nome, email: o.email || o.usuario, ativo: b2i(o.ativo) })),
    };
  }, { perm: "usuarios" });

  /* Apaga de vez (fn_usuario_apagar: tudo ou nada). Com histórico, só passando o histórico para outro usuário (destinoId). */
  handle("users:delete", async ({ id, destinoId }, ctx) => {
    const u = await loadUser(id);
    const destino = Number(destinoId) || null;
    const r = await rpc("fn_usuario_apagar", { p_usuario: u.id, p_destino: destino, p_admin: ctx.session.id });
    recarregarSessoes(u.id); // as sessões saíram do banco junto com o usuário; aqui sai o cache
    let detalhe = u.email || u.usuario;
    if (destino && r.total > 0) {
      const d = await getUserById(destino);
      detalhe += `, histórico passado para ${d ? d.email || d.usuario : `usuário ${destino}`} (${r.total} registros)`;
    }
    await audit(ctx, "usuario_apagado", detalhe);
    return r;
  }, { perm: "usuarios" });
}

module.exports = { registerHandlers, dispatch };
