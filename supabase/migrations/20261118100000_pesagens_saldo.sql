-- ==========================================================
-- BarrilFacil — cálculo de perdas, parte 1: pesagem dos barris
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil-Beta, depois no BarrilFacil-Lojas.
-- Pode rodar mais de uma vez.
--
-- O que faz:
--   - taras (peso do vasilhame vazio por tamanho), pesagens (balança ou estimativa) e inventarios;
--   - barris.saldo_l (litros que sobraram; nulo = cheio) e barris.saldo_estimado;
--   - engates.litros_inicio/inicio_estimado/litros_fim/fim_estimado. Os engates que já existem ficam com
--     litros_inicio = tamanho do barril, e os já retirados com litros_fim = 0 (era sempre retirado vazio);
--   - movimentação nova 'retirada_com_chope' (o barril sai da torneira e volta para o estoque) e 'pesagem'
--     (pesagem avulsa ou de inventário), com movimentacoes.pesagem_id apontando para a pesagem;
--   - funções novas: fn_barril_retirar_com_chope, fn_pesagem_registrar, fn_inventario_iniciar, fn_inventario_concluir;
--   - fn_barril_engatar passa a gravar litros_inicio e fn_barril_esgotar, litros_fim = 0 (mesmas assinaturas);
--   - fn_usuario_apagar passa a levar as pesagens, os inventários e as taras do usuário apagado.
--
-- Não apaga nem muda nenhum dado que já existe, além de preencher as colunas novas dos engates.
-- O servidor que está no ar continua funcionando depois deste SQL (as funções que ele chama mantêm a assinatura).
-- ==========================================================
begin;

-- 1) Inventários ------------------------------------------------------------------
-- Um inventário aberto por unidade (concluido_em nulo). Os barris da lista são os da unidade na hora de concluir.
create table if not exists public.inventarios (
  id            bigint generated always as identity primary key,
  unidade_id    bigint not null references public.unidades (id),
  iniciado_em   timestamptz not null default now(),
  concluido_em  timestamptz,
  usuario_id    bigint not null references public.usuarios (id)
);
create unique index if not exists inventarios_aberto_uq on public.inventarios (unidade_id) where concluido_em is null;
create index if not exists inventarios_usuario_idx on public.inventarios (usuario_id);

-- 2) Taras dos vasilhames ------------------------------------------------------------
-- Pode haver mais de uma ativa por tamanho: a padrão é a ativa mais recente. Tara usada em pesagem não é apagada.
create table if not exists public.taras (
  id          bigint generated always as identity primary key,
  tamanho_l   numeric not null check (tamanho_l > 0),
  peso_kg     numeric(6,2) not null check (peso_kg > 0),
  descricao   text,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  criado_por  bigint references public.usuarios (id)
);
create index if not exists taras_tamanho_idx on public.taras (tamanho_l, ativo, criado_em desc);

-- 3) Pesagens --------------------------------------------------------------------------
-- Balança: litros = (peso_bruto_kg - tara_kg) / densidade. Estimativa: litros = tamanho × nivel_pct / 100.
-- tara_kg e densidade são cópias: mudar a tara ou a densidade depois não muda pesagens antigas.
create table if not exists public.pesagens (
  id              bigint generated always as identity primary key,
  barril_id       bigint not null references public.barris (id),
  unidade_id      bigint not null references public.unidades (id),
  criado_em       timestamptz not null default now(),
  usuario_id      bigint not null references public.usuarios (id),
  funcionario_id  bigint references public.funcionarios (id),
  motivo          text not null check (motivo in ('retirada', 'inventario', 'avulsa')),
  metodo          text not null check (metodo in ('balanca', 'estimativa')),
  peso_bruto_kg   numeric(6,2),
  tara_id         bigint references public.taras (id),
  tara_kg         numeric(6,2),
  densidade       numeric(5,3),
  nivel_pct       int check (nivel_pct in (100, 75, 50, 25)),
  litros          numeric not null check (litros >= 0),
  inventario_id   bigint references public.inventarios (id),
  constraint pesagens_metodo_campos_check check (
    (metodo = 'balanca' and peso_bruto_kg is not null and tara_id is not null and tara_kg is not null
       and densidade is not null and nivel_pct is null)
    or (metodo = 'estimativa' and nivel_pct is not null and peso_bruto_kg is null and tara_id is null
       and tara_kg is null and densidade is null)),
  constraint pesagens_inventario_check check ((motivo = 'inventario') = (inventario_id is not null))
);
create index if not exists pesagens_barril_idx on public.pesagens (barril_id, criado_em);
create index if not exists pesagens_inventario_idx on public.pesagens (inventario_id);
create index if not exists pesagens_unidade_idx on public.pesagens (unidade_id, criado_em);
create index if not exists pesagens_usuario_idx on public.pesagens (usuario_id);
create index if not exists pesagens_tara_idx on public.pesagens (tara_id);

-- RLS ligado e sem policies, como as outras tabelas (só o servidor acessa)
alter table public.inventarios enable row level security;
alter table public.taras       enable row level security;
alter table public.pesagens    enable row level security;

-- 4) Saldo do barril e litros do engate ----------------------------------------------
alter table public.barris  add column if not exists saldo_l         numeric;                       -- nulo = cheio
alter table public.barris  add column if not exists saldo_estimado  boolean not null default false;
alter table public.engates add column if not exists litros_inicio   numeric;
alter table public.engates add column if not exists inicio_estimado boolean;
alter table public.engates add column if not exists litros_fim      numeric;
alter table public.engates add column if not exists fim_estimado    boolean;

-- Engates que já existem: todo barril era engatado cheio e retirado vazio
update public.engates e set litros_inicio = b.tamanho_l, inicio_estimado = false
  from public.barris b where b.id = e.barril_id and e.litros_inicio is null;
update public.engates set litros_fim = 0, fim_estimado = false
 where retirado_em is not null and litros_fim is null;

-- 5) Movimentações: 'retirada_com_chope' e 'pesagem' -------------------------------------
alter table public.movimentacoes add column if not exists pesagem_id bigint references public.pesagens (id);
create index if not exists mov_pesagem_idx on public.movimentacoes (pesagem_id);

-- Apaga a check antiga pelo conteúdo (não depende do nome que o banco deu) e recria com as operações novas
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.movimentacoes'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%operacao%' loop
    execute format('alter table public.movimentacoes drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.movimentacoes add constraint movimentacoes_operacao_check
  check (operacao = any (array['entrada', 'transferencia', 'utilizacao', 'esgotado', 'recolhimento',
                               'retirada_com_chope', 'pesagem']));

-- 6) Funções de apoio ------------------------------------------------------------------
-- 18.217 -> '18,2 L'; 50 -> '50 L'
create or replace function public.fn_litros_texto(p numeric)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(replace(to_char(round(p, 1), 'FM999990.0'), '.', ','), ',0$', '') || ' L'
$$;

-- 45.5 -> '45,5'; 13 -> '13'
create or replace function public.fn_kg_texto(p numeric)
returns text language sql immutable set search_path = public as $$
  select replace(rtrim(rtrim(to_char(round(p, 2), 'FM999990.00'), '0'), '.'), '.', ',')
$$;

/* Litros de uma pesagem, com as conferências. Usada pela retirada com chope e pela pesagem avulsa/de inventário.
   Balança: p_tara = a tara escolhida (nula = a padrão do tamanho, a ativa mais recente). Sem nenhuma tara para o
   tamanho, p_tara_nova (peso do vasilhame vazio em kg) cadastra a tara aqui mesmo, na mesma transação.
   Devolve litros (2 casas), tara_id e tara_kg (nulos na estimativa). */
create or replace function public.fn_pesagem_calcular(p_tamanho numeric, p_metodo text, p_peso_bruto numeric, p_tara bigint,
                                                      p_nivel int, p_densidade numeric, p_tara_nova numeric, p_usuario bigint,
                                                      out litros numeric, out tara_id bigint, out tara_kg numeric)
language plpgsql set search_path = public as $$
declare t taras%rowtype; v_bruto numeric;
begin
  if p_metodo = 'estimativa' then
    if p_nivel is null or p_nivel not in (100, 75, 50, 25) then
      raise exception 'Escolha quanto chope sobrou: cerca de 100%%, 75%%, 50%% ou 25%%.';
    end if;
    litros := round(p_tamanho * p_nivel / 100.0, 2);
    return;
  end if;
  if p_metodo is distinct from 'balanca' then
    raise exception 'Escolha pesar na balança ou estimar sem balança.';
  end if;

  if p_densidade is null or p_densidade < 0.9 or p_densidade > 1.2 then
    raise exception 'Densidade do chope inválida. Avise o administrador.';
  end if;
  v_bruto := round(p_peso_bruto, 2);
  if v_bruto is null or v_bruto <= 0 then raise exception 'Informe o peso do barril na balança (kg).'; end if;
  if v_bruto >= 1000 then raise exception 'Confira o peso: % kg é demais para um barril.', fn_kg_texto(v_bruto); end if;

  if p_tara is not null then
    select * into t from taras where id = p_tara;
    if not found then raise exception 'Tara não encontrada. Feche a janela e escolha de novo.'; end if;
    if not t.ativo then raise exception 'Esta tara foi desativada. Escolha outra.'; end if;
    if t.tamanho_l <> p_tamanho then
      raise exception 'Esta tara é de vasilhame de %, e o barril é de %. Escolha outra tara.',
        fn_litros_texto(t.tamanho_l), fn_litros_texto(p_tamanho);
    end if;
  elsif p_tara_nova is not null then
    if round(p_tara_nova, 2) <= 0 or p_tara_nova >= 1000 then
      raise exception 'Informe o peso do vasilhame vazio (kg).';
    end if;
    insert into taras (tamanho_l, peso_kg, descricao, criado_por)
      values (p_tamanho, round(p_tara_nova, 2), 'Cadastrada na primeira pesagem', p_usuario)
      returning * into t;
    insert into auditoria (usuario_id, acao, detalhe)
      values (p_usuario, 'tara_cadastrada',
              format('Vasilhame de %s: %s kg (cadastrada na primeira pesagem)', fn_litros_texto(p_tamanho), fn_kg_texto(t.peso_kg)));
  else
    select * into t from taras where tamanho_l = p_tamanho and ativo order by criado_em desc, id desc limit 1;
    if not found then
      raise exception 'Primeira pesagem de barril de %: informe o peso do vasilhame vazio (kg).', fn_litros_texto(p_tamanho);
    end if;
  end if;

  if v_bruto < t.peso_kg then
    raise exception 'O peso informado (% kg) é menor que a tara do vasilhame (% kg). Confira o peso e a tara.',
      fn_kg_texto(v_bruto), fn_kg_texto(t.peso_kg);
  end if;
  litros := round((v_bruto - t.peso_kg) / p_densidade, 2);
  if litros > p_tamanho * 1.05 then
    raise exception 'Deu %, mais do que cabe no barril de %. Confira o peso e a tara.',
      fn_litros_texto(litros), fn_litros_texto(p_tamanho);
  end if;
  tara_id := t.id;
  tara_kg := t.peso_kg;
end $$;

-- 7) Engate e retirada ------------------------------------------------------------------
-- Engate: igual ao de antes, e grava os litros do início (o saldo do barril; cheio = o tamanho)
create or replace function public.fn_barril_engatar(p_barril bigint, p_torneira bigint, p_usuario bigint,
                                                    p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; t torneiras%rowtype; occ text; un text; v_func text;
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
  select nome into v_func from funcionarios where id = p_funcionario;

  insert into engates (barril_id, torneira_id, unidade_id, torneira_numero, engatado_por, engatado_func_id,
                       litros_inicio, inicio_estimado)
    values (b.id, t.id, b.unidade_id, t.numero, p_usuario, p_funcionario,
            coalesce(b.saldo_l, b.tamanho_l), b.saldo_l is not null and b.saldo_estimado);
  update barris set status = 'em_uso' where id = b.id;
  select nome into un from unidades where id = b.unidade_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'utilizacao', p_usuario, p_funcionario, b.unidade_id,
            'Engatado na Torneira ' || t.numero
            || case when b.saldo_l is not null then ' com ' || fn_litros_texto(b.saldo_l)
                    || case when b.saldo_estimado then ' (estimado)' else ' (pesado)' end else '' end,
            t.id, t.numero);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_em_uso', format('Barril #%s engatado na Torneira %s (%s)', b.codigo, t.numero, un)
            || case when b.saldo_l is not null then ' com ' || fn_litros_texto(b.saldo_l) else '' end
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('codigo', b.codigo, 'estilo', b.estilo, 'unidade', un, 'torneira', t.numero);
exception when unique_violation then
  raise exception 'A torneira ou o barril acabou de ser usado em outro engate. Atualize a tela e tente de novo.';
end $$;

-- Retirada como vazio: igual à de antes, e grava litros_fim = 0 e zera o saldo do barril
create or replace function public.fn_barril_esgotar(p_barril bigint, p_usuario bigint, p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; e engates%rowtype; t torneiras%rowtype; un text; v_num int; v_tid bigint; v_func text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'em_uso' then
    raise exception 'O barril #% não está em uso (status atual: "%").', b.codigo, fn_status_texto(b.status);
  end if;
  select nome into un from unidades where id = b.unidade_id;
  select nome into v_func from funcionarios where id = p_funcionario;
  select * into e from engates where barril_id = b.id and retirado_em is null for update;
  if found then
    select * into t from torneiras where id = e.torneira_id;
    if t.id is null or t.unidade_id <> b.unidade_id or e.unidade_id <> b.unidade_id then
      raise exception 'Registro de engate inconsistente para este barril. Nada foi alterado; avise o administrador.';
    end if;
    update engates set retirado_por = p_usuario, retirado_func_id = p_funcionario, retirado_em = now(),
                       litros_fim = 0, fim_estimado = false
     where id = e.id;
    v_num := t.numero; v_tid := t.id;
  end if;
  update barris set status = 'esgotado', saldo_l = 0, saldo_estimado = false where id = b.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'esgotado', p_usuario, p_funcionario, b.unidade_id,
            case when v_num is not null then 'Retirado da Torneira ' || v_num || ' (torneira liberada)'
                 else 'Retirado sem torneira registrada (engate feito antes do controle de torneiras)' end,
            v_tid, v_num);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_esgotado',
            format('Barril #%s%s (%s)', b.codigo,
                   case when v_num is not null then ' retirado da Torneira ' || v_num else ' (sem torneira registrada)' end, un)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('codigo', b.codigo, 'unidade', un, 'torneira', v_num);
end $$;

/* Retirada com chope: o barril sai da torneira e volta para o estoque ('disponivel') com o que sobrou.
   Fecha o engate (litros_fim), grava a pesagem (motivo 'retirada'), o saldo do barril, a movimentação
   'retirada_com_chope' e a auditoria, tudo numa transação. Sobrou 0,5 L ou menos: não grava nada e avisa com o
   hint QUASE_VAZIO:<litros> (a tela pergunta se quer marcar como vazio). */
create or replace function public.fn_barril_retirar_com_chope(p_barril bigint, p_usuario bigint, p_funcionario bigint,
                                                              p_metodo text, p_peso_bruto numeric, p_tara bigint, p_nivel int,
                                                              p_densidade numeric default null, p_tara_nova numeric default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; e engates%rowtype; t torneiras%rowtype; un text; v_num int; v_tid bigint; v_func text;
        c record; v_est boolean := p_metodo = 'estimativa'; v_pes bigint; v_txt text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'em_uso' then
    raise exception 'O barril #% não está em uso (status atual: "%").', b.codigo, fn_status_texto(b.status);
  end if;
  select * into c from fn_pesagem_calcular(b.tamanho_l, p_metodo, p_peso_bruto, p_tara, p_nivel, p_densidade, p_tara_nova, p_usuario);
  if c.litros <= 0.5 then
    raise exception 'Sobrou só % no barril #%. Retire como vazio.', fn_litros_texto(c.litros), b.codigo
      using hint = 'QUASE_VAZIO:' || c.litros;
  end if;

  select nome into un from unidades where id = b.unidade_id;
  select nome into v_func from funcionarios where id = p_funcionario;
  select * into e from engates where barril_id = b.id and retirado_em is null for update;
  if found then
    select * into t from torneiras where id = e.torneira_id;
    if t.id is null or t.unidade_id <> b.unidade_id or e.unidade_id <> b.unidade_id then
      raise exception 'Registro de engate inconsistente para este barril. Nada foi alterado; avise o administrador.';
    end if;
    update engates set retirado_por = p_usuario, retirado_func_id = p_funcionario, retirado_em = now(),
                       litros_fim = c.litros, fim_estimado = v_est
     where id = e.id;
    v_num := t.numero; v_tid := t.id;
  end if;

  insert into pesagens (barril_id, unidade_id, usuario_id, funcionario_id, motivo, metodo, peso_bruto_kg, tara_id, tara_kg,
                        densidade, nivel_pct, litros)
    values (b.id, b.unidade_id, p_usuario, p_funcionario, 'retirada', p_metodo,
            case when v_est then null else round(p_peso_bruto, 2) end, c.tara_id, c.tara_kg,
            case when v_est then null else p_densidade end, case when v_est then p_nivel end, c.litros)
    returning id into v_pes;
  update barris set status = 'disponivel', saldo_l = c.litros, saldo_estimado = v_est where id = b.id;

  v_txt := fn_litros_texto(c.litros) || case when v_est then ' (estimado)' else ' (pesado)' end;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao,
                             torneira_id, torneira_numero, pesagem_id)
    values (b.id, 'retirada_com_chope', p_usuario, p_funcionario, b.unidade_id,
            case when v_num is not null then 'Retirado da Torneira ' || v_num || ' com ' || v_txt || ' (torneira liberada)'
                 else 'Retirado sem torneira registrada, com ' || v_txt end,
            v_tid, v_num, v_pes);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_retirado_com_chope',
            format('Barril #%s%s com %s (%s)', b.codigo,
                   case when v_num is not null then ' retirado da Torneira ' || v_num else ' retirado (sem torneira registrada)' end,
                   v_txt, un)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('codigo', b.codigo, 'unidade', un, 'torneira', v_num, 'litros', c.litros, 'estimado', v_est);
end $$;

-- 8) Pesagem avulsa e inventário ----------------------------------------------------------
/* Pesa um barril engatado ou disponível (motivo 'avulsa' ou 'inventario'). O status não muda. Disponível: o saldo do
   barril passa a ser o pesado. Engatado: só registra (o saldo vale para o barril parado no estoque). */
create or replace function public.fn_pesagem_registrar(p_barril bigint, p_usuario bigint, p_funcionario bigint,
                                                       p_metodo text, p_peso_bruto numeric, p_tara bigint, p_nivel int,
                                                       p_densidade numeric, p_motivo text, p_inventario bigint default null,
                                                       p_tara_nova numeric default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; inv inventarios%rowtype; un text; v_func text; c record; v_est boolean := p_metodo = 'estimativa';
        v_pes bigint; v_txt text; v_tor int; v_tid bigint;
begin
  if p_motivo not in ('avulsa', 'inventario') then raise exception 'Motivo da pesagem inválido.'; end if;
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status not in ('em_uso', 'disponivel') then
    raise exception 'Só dá para pesar barril engatado ou disponível (o barril #% está "%").', b.codigo, fn_status_texto(b.status);
  end if;
  if p_motivo = 'inventario' then
    select * into inv from inventarios where id = p_inventario for share;
    if not found then raise exception 'Inventário não encontrado. Atualize a tela.'; end if;
    if inv.concluido_em is not null then raise exception 'Este inventário já foi concluído. Atualize a tela.'; end if;
    if inv.unidade_id <> b.unidade_id then
      raise exception 'O barril #% não é da unidade deste inventário.', b.codigo;
    end if;
  end if;
  select * into c from fn_pesagem_calcular(b.tamanho_l, p_metodo, p_peso_bruto, p_tara, p_nivel, p_densidade, p_tara_nova, p_usuario);

  select nome into un from unidades where id = b.unidade_id;
  select nome into v_func from funcionarios where id = p_funcionario;
  select e.torneira_numero, e.torneira_id into v_tor, v_tid from engates e where e.barril_id = b.id and e.retirado_em is null;

  insert into pesagens (barril_id, unidade_id, usuario_id, funcionario_id, motivo, metodo, peso_bruto_kg, tara_id, tara_kg,
                        densidade, nivel_pct, litros, inventario_id)
    values (b.id, b.unidade_id, p_usuario, p_funcionario, p_motivo, p_metodo,
            case when v_est then null else round(p_peso_bruto, 2) end, c.tara_id, c.tara_kg,
            case when v_est then null else p_densidade end, case when v_est then p_nivel end, c.litros,
            case when p_motivo = 'inventario' then p_inventario end)
    returning id into v_pes;
  if b.status = 'disponivel' then
    update barris set saldo_l = c.litros, saldo_estimado = v_est where id = b.id;
  end if;

  v_txt := fn_litros_texto(c.litros) || case when v_est then ' (estimado)' else ' (pesado)' end;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao,
                             torneira_id, torneira_numero, pesagem_id)
    values (b.id, 'pesagem', p_usuario, p_funcionario, b.unidade_id,
            case when p_motivo = 'inventario' then 'Pesagem de inventário: ' else 'Pesagem avulsa: ' end || v_txt
            || case when v_tor is not null then ' · engatado na Torneira ' || v_tor else '' end,
            v_tid, v_tor, v_pes);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_pesado',
            format('Barril #%s (%s): %s%s', b.codigo, un, v_txt,
                   case when p_motivo = 'inventario' then ' · inventário ' || p_inventario else ' · avulsa' end)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('id', v_pes, 'codigo', b.codigo, 'litros', c.litros, 'estimado', v_est);
end $$;

-- Começa o inventário da unidade, ou devolve o que já está aberto
create or replace function public.fn_inventario_iniciar(p_unidade bigint, p_usuario bigint)
returns bigint language plpgsql set search_path = public as $$
declare v_id bigint; un text;
begin
  select nome into un from unidades where id = p_unidade and ativo;
  if un is null then raise exception 'Unidade não encontrada ou desativada.'; end if;
  select id into v_id from inventarios where unidade_id = p_unidade and concluido_em is null;
  if v_id is not null then return v_id; end if;
  begin
    insert into inventarios (unidade_id, usuario_id) values (p_unidade, p_usuario) returning id into v_id;
  exception when unique_violation then        -- outro aparelho começou ao mesmo tempo: usa o dele
    select id into v_id from inventarios where unidade_id = p_unidade and concluido_em is null;
    return v_id;
  end;
  insert into auditoria (usuario_id, acao, detalhe) values (p_usuario, 'inventario_iniciado', format('%s (inventário %s)', un, v_id));
  return v_id;
end $$;

/* Conclui o inventário. Precisa ter pesagem neste inventário de cada barril engatado e de cada disponível com saldo
   da unidade. Os disponíveis cheios (sem saldo) e não pesados entram como 100%, sem pesar. O status dos barris não muda. */
create or replace function public.fn_inventario_concluir(p_inventario bigint, p_usuario bigint, p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare inv inventarios%rowtype; un text; v_func text; faltam text[]; v_pesados int; v_cheios int := 0; r record; v_pes bigint;
begin
  select * into inv from inventarios where id = p_inventario for update;
  if not found then raise exception 'Inventário não encontrado. Atualize a tela.'; end if;
  if inv.concluido_em is not null then raise exception 'Este inventário já foi concluído.'; end if;
  select nome into un from unidades where id = inv.unidade_id;
  select nome into v_func from funcionarios where id = p_funcionario;

  -- Trava os barris da unidade que entram na lista (ninguém engata ou retira no meio da conclusão)
  perform 1 from barris where unidade_id = inv.unidade_id and status in ('em_uso', 'disponivel') order by id for update;

  select array_agg('#' || b.codigo order by b.codigo) into faltam
    from barris b
   where b.unidade_id = inv.unidade_id
     and (b.status = 'em_uso' or (b.status = 'disponivel' and b.saldo_l is not null))
     and not exists (select 1 from pesagens p where p.inventario_id = inv.id and p.barril_id = b.id);
  if faltam is not null then
    raise exception 'Falta pesar % barril(is): %. Pese todos antes de concluir.', array_length(faltam, 1), array_to_string(faltam, ', ');
  end if;

  select count(distinct barril_id) into v_pesados from pesagens where inventario_id = inv.id;
  for r in select b.* from barris b
            where b.unidade_id = inv.unidade_id and b.status = 'disponivel' and b.saldo_l is null
              and not exists (select 1 from pesagens p where p.inventario_id = inv.id and p.barril_id = b.id)
            order by b.codigo loop
    insert into pesagens (barril_id, unidade_id, usuario_id, funcionario_id, motivo, metodo, nivel_pct, litros, inventario_id)
      values (r.id, r.unidade_id, p_usuario, p_funcionario, 'inventario', 'estimativa', 100, r.tamanho_l, inv.id)
      returning id into v_pes;
    insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao, pesagem_id)
      values (r.id, 'pesagem', p_usuario, p_funcionario, r.unidade_id,
              'Pesagem de inventário: cheio, ' || fn_litros_texto(r.tamanho_l) || ' (sem pesar)', v_pes);
    v_cheios := v_cheios + 1;
  end loop;

  update inventarios set concluido_em = now() where id = inv.id;
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'inventario_concluido',
            format('%s (inventário %s): %s barril(is) pesado(s), %s cheio(s) sem pesar', un, inv.id, v_pesados, v_cheios)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('id', inv.id, 'unidade', un, 'pesados', v_pesados, 'cheios', v_cheios);
end $$;

-- 9) Apagar usuário: as pesagens, os inventários e as taras também passam para quem recebe o histórico -----------
create or replace function public.fn_usuario_apagar(p_usuario bigint, p_destino bigint, p_admin bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_user usuarios%rowtype;
  v_engates int;
  v_movs int;
  v_transf int;
  v_pesagens int;
  v_invent int;
  v_audit int;
  v_total int;
begin
  if p_usuario = p_admin then
    raise exception 'Você não pode apagar o seu próprio usuário.';
  end if;

  select * into v_user from usuarios where id = p_usuario for update;
  if not found then
    raise exception 'Usuário não encontrado.';
  end if;

  -- Trava os administradores ativos: dois apagamentos ao mesmo tempo não deixam o sistema sem nenhum
  if v_user.cargo = 'admin' and v_user.ativo then
    perform 1 from usuarios where cargo = 'admin' and ativo order by id for update;
    if not exists (select 1 from usuarios where cargo = 'admin' and ativo and id <> p_usuario) then
      raise exception 'Não é possível apagar o último administrador ativo.';
    end if;
  end if;

  select count(*) into v_engates from engates where engatado_por = p_usuario or retirado_por = p_usuario;
  select count(*) into v_movs from movimentacoes where usuario_id = p_usuario;
  select count(*) into v_transf from transferencias where solicitante_id = p_usuario or recebedor_id = p_usuario;
  select count(*) into v_pesagens from pesagens where usuario_id = p_usuario;
  select count(*) into v_invent from inventarios where usuario_id = p_usuario;
  select count(*) into v_audit from auditoria where usuario_id = p_usuario;
  v_total := v_engates + v_movs + v_transf + v_pesagens + v_invent;

  if v_total > 0 and p_destino is null then
    raise exception 'Este usuário tem histórico (% engate(s), % movimentação(ões), % transferência(s)%). Escolha para quem passar o histórico antes de apagar.',
      v_engates, v_movs, v_transf,
      case when v_pesagens + v_invent > 0 then format(', %s pesagem(ns), %s inventário(s)', v_pesagens, v_invent) else '' end;
  end if;

  if p_destino is not null then
    if p_destino = p_usuario then
      raise exception 'Escolha outro usuário para receber o histórico.';
    end if;
    perform 1 from usuarios where id = p_destino for share;
    if not found then
      raise exception 'O usuário escolhido para receber o histórico não existe mais.';
    end if;
    update engates set engatado_por = p_destino where engatado_por = p_usuario;
    update engates set retirado_por = p_destino where retirado_por = p_usuario;
    update movimentacoes set usuario_id = p_destino where usuario_id = p_usuario;
    update transferencias set solicitante_id = p_destino where solicitante_id = p_usuario;
    update transferencias set recebedor_id = p_destino where recebedor_id = p_usuario;
    update pesagens set usuario_id = p_destino where usuario_id = p_usuario;
    update inventarios set usuario_id = p_destino where usuario_id = p_usuario;
    update taras set criado_por = p_destino where criado_por = p_usuario;
    update auditoria set usuario_id = p_destino where usuario_id = p_usuario;
  else
    update taras set criado_por = null where criado_por = p_usuario;
    update auditoria
       set usuario_id = null,
           detalhe = ltrim(coalesce(detalhe, '') || ' [usuário apagado: ' || coalesce(v_user.email, v_user.usuario) || ']')
     where usuario_id = p_usuario;
  end if;

  delete from usuarios where id = p_usuario;

  return jsonb_build_object(
    'engates', v_engates, 'movimentacoes', v_movs, 'transferencias', v_transf,
    'pesagens', v_pesagens, 'inventarios', v_invent,
    'auditoria', v_audit, 'total', v_total);
end $$;

-- Permissões: as funções só podem ser executadas pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_litros_texto', 'fn_kg_texto', 'fn_pesagem_calcular', 'fn_barril_engatar', 'fn_barril_esgotar',
                                'fn_barril_retirar_com_chope', 'fn_pesagem_registrar', 'fn_inventario_iniciar',
                                'fn_inventario_concluir', 'fn_usuario_apagar') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as tabelas, colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional):
-- select count(*) filter (where litros_inicio is null) as sem_inicio,
--        count(*) filter (where retirado_em is not null and litros_fim is null) as sem_fim from engates;   -- 0 e 0
-- select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
--   and p.proname in ('fn_barril_retirar_com_chope', 'fn_pesagem_registrar', 'fn_inventario_iniciar', 'fn_inventario_concluir');
