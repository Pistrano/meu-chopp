-- ==========================================================
-- MeuChopp — schema inicial do banco (Supabase / Postgres 17)
-- Extraído do projeto "MeuChopp" (EUA, us-east-1) em 2026-10-21
-- e aplicado no projeto "MeuChopp2" (São Paulo, sa-east-1).
--
-- Diferenças em relação ao banco dos EUA:
--   * as tabelas "clientes" e "funcionarios" (vazias e não usadas pelo código) ficaram de fora;
--   * as funções fn_* ganharam "set search_path = public" (recomendação de segurança do Supabase).
--
-- Acesso: só o servidor (chave secreta / service_role) usa o banco.
-- RLS ligado em todas as tabelas, sem policies; funções sem EXECUTE para anon/authenticated.
-- ==========================================================

-- ---------- Tabelas ----------

create table public.unidades (
  id          bigint generated always as identity primary key,
  nome        text not null,
  nome_curto  text not null,
  cnpj        text unique,
  endereco    text,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);
create unique index unidades_nome_lower_uq on public.unidades (lower(nome));

create table public.usuarios (
  id             bigint generated always as identity primary key,
  nome           text not null,
  usuario        text not null unique,
  email          text unique,
  senha_hash     text not null,
  cargo          text not null check (cargo = any (array['admin', 'operador'])),
  ativo          boolean not null default true,
  trocar_senha   boolean not null default false,
  falhas         integer not null default 0,
  bloqueado_ate  bigint,
  ultimo_login   timestamptz,
  criado_em      timestamptz not null default now()
);

create table public.usuario_unidades (
  usuario_id  bigint not null references public.usuarios (id) on delete cascade,
  unidade_id  bigint not null references public.unidades (id),
  primary key (usuario_id, unidade_id)
);

create table public.torneiras (
  id          bigint generated always as identity primary key,
  unidade_id  bigint not null references public.unidades (id),
  numero      integer not null check (numero >= 1 and numero <= 999),
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);
create unique index torneiras_numero_ativo_uq on public.torneiras (unidade_id, numero) where ativo;

create table public.barris (
  id          bigint generated always as identity primary key,
  codigo      text not null unique,
  estilo      text not null,
  tamanho_l   numeric not null check (tamanho_l > 0),
  unidade_id  bigint not null references public.unidades (id),
  status      text not null default 'disponivel'
              check (status = any (array['disponivel', 'em_uso', 'em_transferencia', 'esgotado'])),
  criado_em   timestamptz not null default now()
);
create index barris_unidade_idx on public.barris (unidade_id, status);

create table public.engates (
  id               bigint generated always as identity primary key,
  barril_id        bigint not null references public.barris (id),
  torneira_id      bigint not null references public.torneiras (id),
  unidade_id       bigint not null references public.unidades (id),
  torneira_numero  integer not null,
  engatado_por     bigint references public.usuarios (id),
  engatado_em      timestamptz not null default now(),
  retirado_por     bigint references public.usuarios (id),
  retirado_em      timestamptz
);
create unique index engates_barril_ativo_uq on public.engates (barril_id) where retirado_em is null;
create unique index engates_torneira_ativo_uq on public.engates (torneira_id) where retirado_em is null;

create table public.movimentacoes (
  id                  bigint generated always as identity primary key,
  barril_id           bigint not null references public.barris (id),
  operacao            text not null check (operacao = any (array['entrada', 'transferencia', 'utilizacao', 'esgotado'])),
  usuario_id          bigint not null references public.usuarios (id),
  origem_unidade_id   bigint references public.unidades (id),
  destino_unidade_id  bigint references public.unidades (id),
  observacao          text,
  torneira_id         bigint references public.torneiras (id),
  torneira_numero     integer,
  criado_em           timestamptz not null default now()
);
create index mov_barril_idx on public.movimentacoes (barril_id);
create index mov_origem_idx on public.movimentacoes (origem_unidade_id);
create index mov_destino_idx on public.movimentacoes (destino_unidade_id);

create table public.transferencias (
  id              bigint generated always as identity primary key,
  barril_id       bigint not null references public.barris (id),
  origem_id       bigint not null references public.unidades (id),
  destino_id      bigint not null references public.unidades (id),
  solicitante_id  bigint not null references public.usuarios (id),
  recebedor_id    bigint references public.usuarios (id),
  status          text not null default 'pendente' check (status = any (array['pendente', 'confirmada', 'cancelada'])),
  criado_em       timestamptz not null default now(),
  resolvido_em    timestamptz
);

create table public.auditoria (
  id          bigint generated always as identity primary key,
  usuario_id  bigint references public.usuarios (id),
  acao        text not null,
  detalhe     text,
  criado_em   timestamptz not null default now()
);

-- ---------- Segurança: RLS ligado, sem policies (só a service_role acessa) ----------

alter table public.unidades         enable row level security;
alter table public.usuarios         enable row level security;
alter table public.usuario_unidades enable row level security;
alter table public.torneiras        enable row level security;
alter table public.barris           enable row level security;
alter table public.engates          enable row level security;
alter table public.movimentacoes    enable row level security;
alter table public.transferencias   enable row level security;
alter table public.auditoria        enable row level security;

-- ---------- Funções ----------

create or replace function public.fn_status_texto(s text)
returns text language sql immutable set search_path = public as $$
  select case s when 'disponivel' then 'Disponível' when 'em_uso' then 'Em uso'
                when 'em_transferencia' then 'Em transferência' when 'esgotado' then 'Chopp Esgotado' else s end
$$;

create or replace function public.fn_alertas_esgotados(p_unit bigint)
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(b.codigo), '[]'::json)
    from barris b
   where b.unidade_id = p_unit and b.status = 'esgotado'
     and (select max(m.criado_em) from movimentacoes m where m.barril_id = b.id) < now() - interval '3 days'
$$;

create or replace function public.fn_dashboard_stats(p_unit bigint)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'total', count(*)::int,
    'disponiveis', (count(*) filter (where status = 'disponivel'))::int,
    'emUso', (count(*) filter (where status = 'em_uso'))::int,
    'emTransferencia', (count(*) filter (where status = 'em_transferencia'))::int,
    'choppEsgotado', (count(*) filter (where status = 'esgotado'))::int)
  from barris where unidade_id = p_unit
$$;

create or replace function public.fn_unidades_resumo()
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(r order by r.id), '[]'::json) from (
    select u.id, u.nome, u.nome_curto, u.ativo, u.cnpj, u.endereco,
      (select count(*) from barris b where b.unidade_id = u.id)::int as barris,
      (select count(*) from usuario_unidades ua join usuarios us on us.id = ua.usuario_id
        where ua.unidade_id = u.id and us.ativo)::int as usuarios,
      (select count(*) from torneiras t where t.unidade_id = u.id and t.ativo)::int as torneiras,
      (select count(*) from engates e where e.unidade_id = u.id and e.retirado_em is null)::int as "torneirasOcupadas"
    from unidades u) r
$$;

create or replace function public.fn_barril_criar(p_codigo text, p_estilo text, p_tamanho numeric, p_unidade bigint, p_usuario bigint)
returns bigint language plpgsql set search_path = public as $$
declare v_id bigint;
begin
  insert into barris (codigo, estilo, tamanho_l, unidade_id)
    values (p_codigo, p_estilo, p_tamanho, p_unidade) returning id into v_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, destino_unidade_id, observacao)
    values (v_id, 'entrada', p_usuario, p_unidade, 'Cadastro do barril');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_cadastrado', format('Barril #%s (%s, %s L)', p_codigo, p_estilo, p_tamanho));
  return v_id;
exception when unique_violation then
  raise exception 'Já existe um barril com o código #%.', p_codigo;
end $$;

create or replace function public.fn_barril_engatar(p_barril bigint, p_torneira bigint, p_usuario bigint)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; t torneiras%rowtype; occ text; un text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'disponivel' then
    raise exception 'O barril #% não pode ser engatado: está "%". Só barris disponíveis podem ser engatados.', b.codigo, fn_status_texto(b.status);
  end if;
  if exists (select 1 from engates where barril_id = b.id and retirado_em is null) then
    raise exception 'O barril #% já está engatado em uma torneira.', b.codigo;
  end if;
  select * into t from torneiras where id = p_torneira for update;
  if not found or t.unidade_id <> b.unidade_id then
    raise exception 'Torneira inválida: ela não pertence à unidade deste barril.';
  end if;
  if not t.ativo then raise exception 'A Torneira % está desativada.', t.numero; end if;
  select b2.codigo into occ from engates e join barris b2 on b2.id = e.barril_id
   where e.torneira_id = t.id and e.retirado_em is null;
  if occ is not null then
    raise exception 'A Torneira % está ocupada pelo barril #%. Escolha outra torneira.', t.numero, occ;
  end if;

  insert into engates (barril_id, torneira_id, unidade_id, torneira_numero, engatado_por)
    values (b.id, t.id, b.unidade_id, t.numero, p_usuario);
  update barris set status = 'em_uso' where id = b.id;
  select nome into un from unidades where id = b.unidade_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'utilizacao', p_usuario, b.unidade_id, 'Engatado na Torneira ' || t.numero, t.id, t.numero);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_em_uso', format('Barril #%s engatado na Torneira %s (%s)', b.codigo, t.numero, un));
  return json_build_object('codigo', b.codigo, 'estilo', b.estilo, 'unidade', un, 'torneira', t.numero);
exception when unique_violation then
  raise exception 'A torneira ou o barril acabou de ser usado em outro engate. Atualize a tela e tente de novo.';
end $$;

create or replace function public.fn_barril_esgotar(p_barril bigint, p_usuario bigint)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; e engates%rowtype; t torneiras%rowtype; un text; v_num int; v_tid bigint;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'em_uso' then
    raise exception 'O barril #% não está em uso (status atual: "%").', b.codigo, fn_status_texto(b.status);
  end if;
  select nome into un from unidades where id = b.unidade_id;
  select * into e from engates where barril_id = b.id and retirado_em is null for update;
  if found then
    select * into t from torneiras where id = e.torneira_id;
    if t.id is null or t.unidade_id <> b.unidade_id or e.unidade_id <> b.unidade_id then
      raise exception 'Registro de engate inconsistente para este barril. Nada foi alterado; avise o administrador.';
    end if;
    update engates set retirado_por = p_usuario, retirado_em = now() where id = e.id;
    v_num := t.numero; v_tid := t.id;
  end if;
  update barris set status = 'esgotado' where id = b.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'esgotado', p_usuario, b.unidade_id,
            case when v_num is not null then 'Retirado da Torneira ' || v_num || ' (torneira liberada)'
                 else 'Retirado sem torneira registrada (engate feito antes do controle de torneiras)' end,
            v_tid, v_num);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_esgotado',
            format('Barril #%s%s (%s)', b.codigo,
                   case when v_num is not null then ' retirado da Torneira ' || v_num else ' (sem torneira registrada)' end, un));
  return json_build_object('codigo', b.codigo, 'unidade', un, 'torneira', v_num);
end $$;

create or replace function public.fn_barril_reabastecer(p_barril bigint, p_usuario bigint)
returns boolean language plpgsql set search_path = public as $$
declare b barris%rowtype;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'esgotado' then
    raise exception 'O barril #% não está no status esperado para esta ação.', b.codigo;
  end if;
  update barris set status = 'disponivel' where id = b.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, destino_unidade_id, observacao)
    values (b.id, 'entrada', p_usuario, b.unidade_id, 'Barril reabastecido');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_reabastecido', 'Barril #' || b.codigo);
  return true;
end $$;

create or replace function public.fn_torneiras_criar(p_unidade bigint, p_qtd integer, p_usuario bigint)
returns json language plpgsql set search_path = public as $$
declare u unidades%rowtype; nxt int; nums int[] := '{}'; i int;
begin
  select * into u from unidades where id = p_unidade for update;
  if not found then raise exception 'Unidade não encontrada.'; end if;
  if not u.ativo then raise exception 'Esta unidade está desativada. Reative-a antes de cadastrar torneiras.'; end if;
  if p_qtd is null or p_qtd < 1 or p_qtd > 50 then raise exception 'Informe uma quantidade de 1 a 50 torneiras.'; end if;
  select coalesce(max(numero), 0) into nxt from torneiras where unidade_id = u.id and ativo;
  for i in 1..p_qtd loop
    nxt := nxt + 1;
    if nxt > 999 then raise exception 'Limite de numeração atingido (999).'; end if;
    insert into torneiras (unidade_id, numero) values (u.id, nxt);
    nums := nums || nxt;
  end loop;
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'torneira_cadastrada', u.nome || ': Torneira ' || array_to_string(nums, ', '));
  return to_json(nums);
end $$;

create or replace function public.fn_transferencia_criar(p_barril bigint, p_destino bigint, p_usuario bigint)
returns boolean language plpgsql set search_path = public as $$
declare b barris%rowtype;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if p_destino is null or p_destino = b.unidade_id then
    raise exception 'Escolha uma unidade de destino diferente da origem.';
  end if;
  if not exists (select 1 from unidades where id = p_destino and ativo) then
    raise exception 'Unidade de destino inválida ou desativada.';
  end if;
  if b.status <> 'disponivel' then
    raise exception 'Só é possível transferir barris disponíveis (#% está indisponível).', b.codigo;
  end if;
  update barris set status = 'em_transferencia' where id = b.id;
  insert into transferencias (barril_id, origem_id, destino_id, solicitante_id)
    values (b.id, b.unidade_id, p_destino, p_usuario);
  insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, destino_unidade_id)
    values (b.id, 'transferencia', p_usuario, b.unidade_id, p_destino);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_iniciada', 'Barril #' || b.codigo);
  return true;
end $$;

create or replace function public.fn_transferencia_confirmar(p_id bigint, p_usuario bigint)
returns boolean language plpgsql set search_path = public as $$
declare t transferencias%rowtype; b barris%rowtype;
begin
  select * into t from transferencias where id = p_id for update;
  if not found or t.status <> 'pendente' then raise exception 'Transferência não está pendente.'; end if;
  select * into b from barris where id = t.barril_id for update;
  update barris set unidade_id = t.destino_id, status = 'disponivel' where id = b.id;
  update transferencias set status = 'confirmada', recebedor_id = p_usuario, resolvido_em = now() where id = t.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, destino_unidade_id, observacao)
    values (b.id, 'entrada', p_usuario, t.origem_id, t.destino_id, 'Recebimento de transferência');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_confirmada', 'Barril #' || b.codigo);
  return true;
end $$;

create or replace function public.fn_transferencia_cancelar(p_id bigint, p_usuario bigint)
returns boolean language plpgsql set search_path = public as $$
declare t transferencias%rowtype; b barris%rowtype; dnome text;
begin
  select * into t from transferencias where id = p_id for update;
  if not found or t.status <> 'pendente' then raise exception 'Transferência não está pendente.'; end if;
  select * into b from barris where id = t.barril_id for update;
  update barris set status = 'disponivel' where id = b.id;
  update transferencias set status = 'cancelada', resolvido_em = now() where id = t.id;
  select nome into dnome from unidades where id = t.destino_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, observacao)
    values (b.id, 'transferencia', p_usuario, t.origem_id,
            'Transferência para ' || dnome || ' cancelada. O barril continua na origem.');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_cancelada', 'Barril #' || b.codigo);
  return true;
end $$;

-- ---------- Permissões das funções: só postgres e service_role ----------

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'fn\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
