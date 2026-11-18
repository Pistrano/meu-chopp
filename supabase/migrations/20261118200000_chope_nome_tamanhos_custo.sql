-- ==========================================================
-- BarrilFacil — chope só com o nome, tamanhos de barril cadastrados e custo por litro do chope
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil-Beta, depois no BarrilFacil-Lojas.
-- Roda depois do SQL da pesagem (20261118100000_pesagens_saldo.sql). Pode rodar mais de uma vez.
--
-- O que faz:
--   - chopes.estilo_id passa a aceitar nulo: chope novo é gravado sem estilo. A tabela estilos, a coluna
--     barris.estilo e os dados que já existem ficam como estão (fn_estilo_apagar fica no banco, sem uso);
--   - tamanhos_barril: os tamanhos de barril cadastrados. Já entram 20, 30 e 50 L (prefixos BA2, BA3 e BA5)
--     e qualquer outro tamanho que já exista nos barris;
--   - chopes.preco_por_tamanho e custos_chope: o custo por litro de cada chope, com a data de início.
--     Mudar o preço grava linhas novas; as antigas ficam (o cálculo de perdas usa o preço da data do barril);
--   - fn_custo_litro(chope, tamanho, data): o custo por litro que vale para um barril;
--   - fn_barril_entrada (mesma assinatura): grava barris.estilo = nome do chope e recusa tamanho que não
--     esteja cadastrado e ativo;
--   - fn_relatorio_barris (mesma assinatura): uma linha por chope, sem estilo. fn_relatorio_barris_detalhe passa
--     a receber o nome do chope da linha (a versão com estilo é apagada);
--   - fn_usuario_apagar passa a levar os tamanhos e os custos cadastrados pelo usuário apagado.
--
-- Não apaga nem muda nenhum dado que já existe.
-- Entre este SQL e a atualização do servidor, só o Relatório de barris do servidor antigo dá erro; o resto funciona.
-- ==========================================================
begin;

-- 1) Chope sem estilo --------------------------------------------------------------------
alter table public.chopes alter column estilo_id drop not null;
-- Desmarcado: um custo por litro para qualquer tamanho. Marcado: um preço de barril por tamanho.
alter table public.chopes add column if not exists preco_por_tamanho boolean not null default false;

-- 2) Tamanhos de barril --------------------------------------------------------------------
-- Tamanho usado em barril não é apagado, só desativado (some do cadastro de barril e dos campos de preço).
create table if not exists public.tamanhos_barril (
  id              bigint generated always as identity primary key,
  litros          numeric not null unique check (litros > 0 and litros <= 200),
  prefixo_codigo  text check (prefixo_codigo is null or prefixo_codigo ~ '^[A-Z0-9]{1,10}$'),
  ativo           boolean not null default true,
  criado_em       timestamptz not null default now(),
  criado_por      bigint references public.usuarios (id)
);
create unique index if not exists tamanhos_barril_prefixo_uq on public.tamanhos_barril (prefixo_codigo)
  where prefixo_codigo is not null;

insert into public.tamanhos_barril (litros, prefixo_codigo)
values (20, 'BA2'), (30, 'BA3'), (50, 'BA5')
on conflict (litros) do nothing;

insert into public.tamanhos_barril (litros)
select distinct tamanho_l from public.barris where tamanho_l > 0 and tamanho_l <= 200
on conflict (litros) do nothing;

-- 3) Custo por litro de cada chope ---------------------------------------------------------
-- tamanho_l nulo: vale para qualquer tamanho (chope com preco_por_tamanho = false).
-- Por tamanho: preco_barril é o preço do barril e custo_litro = preco_barril / tamanho_l (o servidor calcula).
create table if not exists public.custos_chope (
  id            bigint generated always as identity primary key,
  chope_id      bigint not null references public.chopes (id) on delete cascade,
  tamanho_l     numeric,
  preco_barril  numeric(12,2),
  custo_litro   numeric(12,4) not null check (custo_litro > 0),
  inicio        date not null,
  criado_em     timestamptz not null default now(),
  criado_por    bigint references public.usuarios (id),
  constraint custos_chope_tamanho_preco_check check (
    (tamanho_l is null and preco_barril is null) or (tamanho_l > 0 and preco_barril > 0))
);
create index if not exists custos_chope_chope_idx on public.custos_chope (chope_id, tamanho_l, inicio);

-- RLS ligado e sem policies, como as outras tabelas (só o servidor acessa)
alter table public.tamanhos_barril enable row level security;
alter table public.custos_chope    enable row level security;

-- 4) Custo por litro que vale para um barril -------------------------------------------------
-- Por tamanho: as linhas daquele tamanho; senão, as linhas com tamanho nulo. Entre elas, a de maior início até
-- p_data (a data de cadastro do barril); sem nenhuma até essa data, a de menor início. Nulo se não houver preço.
-- No mesmo início, vale a gravada por último.
create or replace function public.fn_custo_litro(p_chope bigint, p_tamanho numeric, p_data date)
returns numeric language sql stable set search_path = public as $$
  with linhas as (
    select k.id, k.custo_litro, k.inicio
      from custos_chope k
      join chopes c on c.id = k.chope_id
     where k.chope_id = p_chope
       and case when c.preco_por_tamanho then k.tamanho_l = p_tamanho else k.tamanho_l is null end
  )
  select coalesce(
    (select custo_litro from linhas where inicio <= p_data order by inicio desc, id desc limit 1),
    (select custo_litro from linhas order by inicio, id desc limit 1))
$$;

-- 5) Entrada do barril: sem estilo e só com tamanho cadastrado e ativo ------------------------------
-- barris.estilo é not null e continua sendo preenchida: recebe o nome do chope.
create or replace function public.fn_barril_entrada(p_codigo text, p_chope bigint, p_tamanho numeric, p_validade date,
                                                    p_unidade bigint, p_usuario bigint, p_funcionario bigint default null)
returns bigint language plpgsql set search_path = public as $$
declare v_id bigint; v_cod text := upper(btrim(p_codigo)); c chopes%rowtype; t tamanhos_barril%rowtype; v_func text;
begin
  if v_cod is null or v_cod = '' then raise exception 'Informe o código do barril.'; end if;
  if p_tamanho is null or p_tamanho <= 0 then raise exception 'Informe o tamanho do barril.'; end if;
  if p_validade is null then raise exception 'Informe a data de validade do barril.'; end if;
  if not exists (select 1 from unidades where id = p_unidade and ativo) then
    raise exception 'Unidade não encontrada ou desativada.';
  end if;
  select * into t from tamanhos_barril where litros = p_tamanho;
  if not found then
    raise exception 'Não há barril de % cadastrado. Escolha outro tamanho.', fn_litros_texto(p_tamanho);
  end if;
  if not t.ativo then
    raise exception 'O barril de % está desativado. Escolha outro tamanho.', fn_litros_texto(t.litros);
  end if;
  select * into c from chopes where id = p_chope;
  if not found then raise exception 'Chope não encontrado. Recarregue a página e escolha de novo.'; end if;
  if not c.ativo then raise exception 'O chope "%" está desativado. Escolha outro.', c.nome; end if;
  if exists (select 1 from barris where codigo = v_cod and status <> 'recolhido') then
    raise exception 'Já existe um barril com o código #% em operação', v_cod;
  end if;
  select nome into v_func from funcionarios where id = p_funcionario;

  insert into barris (codigo, estilo, chope_nome, chope_id, tamanho_l, unidade_id, validade)
    values (v_cod, c.nome, c.nome, c.id, t.litros, p_unidade, p_validade) returning id into v_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, destino_unidade_id, observacao)
    values (v_id, 'entrada', p_usuario, p_funcionario, p_unidade, 'Cadastro do barril');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_cadastrado',
            format('Barril #%s (%s, %s, validade %s)', v_cod, c.nome, fn_litros_texto(t.litros), to_char(p_validade, 'DD/MM/YYYY'))
            || coalesce(' · funcionário ' || v_func, ''));
  return v_id;
exception when unique_violation then
  raise exception 'Já existe um barril com o código #% em operação', v_cod;
end $$;

-- 6) Relatório de barris: uma linha por chope ------------------------------------------------------
-- Nome do chope: o do catálogo; barril antigo sem chope usa barris.chope_nome e, sem ele, barris.estilo.
-- Barril antigo com o mesmo nome de um chope do catálogo cai na mesma linha (sem diferenciar maiúsculas).
create or replace function public.fn_relatorio_barris(p_unidades bigint[], p_de timestamptz, p_ate timestamptz)
returns json language sql stable set search_path = public as $$
  with
  -- Primeiro engate no período: engatado no período e sem nenhum engate antes dele nestas unidades
  utilizados as (
    select distinct e.barril_id
      from engates e
     where e.unidade_id = any(p_unidades) and e.engatado_em >= p_de and e.engatado_em < p_ate
       and not exists (select 1 from engates a
                        where a.barril_id = e.barril_id and a.unidade_id = any(p_unidades) and a.engatado_em < p_de)
  ),
  movs as (
    select m.barril_id, m.operacao
      from movimentacoes m
     where m.operacao in ('entrada', 'esgotado', 'recolhimento')
       and m.criado_em >= p_de and m.criado_em < p_ate
       and case when m.operacao = 'entrada' then m.destino_unidade_id = any(p_unidades) and m.origem_unidade_id is null
                else m.origem_unidade_id = any(p_unidades) end
  ),
  marcas as (
    select barril_id,
           bool_or(op = 'entrada') as recebido,
           bool_or(op = 'utilizado') as utilizado,
           bool_or(op = 'esgotado') as esvaziado,
           bool_or(op = 'recolhimento') as recolhido
      from (select barril_id, operacao as op from movs
            union all
            select barril_id, 'utilizado' from utilizados) x
     group by barril_id
  ),
  agora as (
    select id as barril_id, status
      from barris
     where unidade_id = any(p_unidades) and status in ('disponivel', 'em_uso', 'esgotado', 'em_transferencia')
  ),
  base as (
    select b.tamanho_l,
           coalesce(mk.recebido, false) as recebido, coalesce(mk.utilizado, false) as utilizado,
           coalesce(mk.esvaziado, false) as esvaziado, coalesce(mk.recolhido, false) as recolhido,
           ag.status as status_agora,
           c.id as chope_id,
           c.nome as nome_catalogo,
           coalesce(c.nome, nullif(btrim(b.chope_nome), ''), nullif(btrim(b.estilo), ''), 'Sem nome') as chope
      from (select barril_id from marcas union select barril_id from agora) ids
      join barris b on b.id = ids.barril_id
      left join marcas mk on mk.barril_id = b.id
      left join agora ag on ag.barril_id = b.id
      left join chopes c on c.id = b.chope_id
  ),
  linhas as (
    select coalesce(max(nome_catalogo), min(chope)) as chope,
           max(chope_id) as chope_id,
           count(*) filter (where recebido)::int as recebidos,
           count(*) filter (where utilizado)::int as utilizados,
           coalesce(sum(tamanho_l) filter (where utilizado), 0) as litros,
           count(*) filter (where esvaziado)::int as esvaziados,
           count(*) filter (where recolhido)::int as recolhidos,
           count(*) filter (where status_agora = 'disponivel')::int as estoque,
           count(*) filter (where status_agora = 'em_uso')::int as engatados,
           count(*) filter (where status_agora = 'esgotado')::int as vazios,
           count(*) filter (where status_agora = 'em_transferencia')::int as em_transferencia
      from base
     group by lower(chope)
  )
  select json_build_object(
    'gerado_em', now(),
    'linhas', coalesce((
      select json_agg(l order by lower(l.chope))
        from linhas l
       where l.recebidos + l.utilizados + l.esvaziados + l.recolhidos
             + l.estoque + l.engatados + l.vazios + l.em_transferencia > 0), '[]'::json),
    'totais', (
      select json_build_object(
        'recebidos', count(*) filter (where recebido),
        'utilizados', count(*) filter (where utilizado),
        'litros', coalesce(sum(tamanho_l) filter (where utilizado), 0),
        'esvaziados', count(*) filter (where esvaziado),
        'recolhidos', count(*) filter (where recolhido),
        'estoque', count(*) filter (where status_agora = 'disponivel'),
        'engatados', count(*) filter (where status_agora = 'em_uso'),
        'vazios', count(*) filter (where status_agora = 'esgotado'),
        'em_transferencia', count(*) filter (where status_agora = 'em_transferencia'))
        from base))
$$;

-- Detalhe de uma linha: os barris utilizados (primeiro engate no período) do chope p_chope (o nome da linha)
drop function if exists public.fn_relatorio_barris_detalhe(bigint[], timestamptz, timestamptz, bigint, text, text);
create or replace function public.fn_relatorio_barris_detalhe(p_unidades bigint[], p_de timestamptz, p_ate timestamptz,
                                                              p_chope text)
returns json language sql stable set search_path = public as $$
  with primeiro as (
    select distinct on (e.barril_id) e.barril_id, e.unidade_id, e.engatado_em, e.retirado_em, e.torneira_numero,
           e.engatado_por, e.engatado_func_id, e.retirado_por, e.retirado_func_id
      from engates e
     where e.unidade_id = any(p_unidades)
       and e.barril_id in (select n.barril_id from engates n
                            where n.unidade_id = any(p_unidades) and n.engatado_em >= p_de and n.engatado_em < p_ate)
     order by e.barril_id, e.engatado_em, e.id
  )
  select coalesce(json_agg(json_build_object(
           'id', b.id, 'codigo', b.codigo, 'tamanho_l', b.tamanho_l, 'validade', b.validade,
           'engatado_em', p.engatado_em, 'retirado_em', p.retirado_em, 'torneira', p.torneira_numero,
           'unidade', u.nome_curto,
           'engatado_por', coalesce(fe.nome, ue.nome),
           'retirado_por', case when p.retirado_em is not null then coalesce(fr.nome, ur.nome) end)
         order by p.engatado_em, b.codigo), '[]'::json)
    from primeiro p
    join barris b on b.id = p.barril_id
    left join chopes c on c.id = b.chope_id
    left join unidades u on u.id = p.unidade_id
    left join funcionarios fe on fe.id = p.engatado_func_id
    left join usuarios ue on ue.id = p.engatado_por
    left join funcionarios fr on fr.id = p.retirado_func_id
    left join usuarios ur on ur.id = p.retirado_por
   where p.engatado_em >= p_de and p.engatado_em < p_ate
     and lower(coalesce(c.nome, nullif(btrim(b.chope_nome), ''), nullif(btrim(b.estilo), ''), 'Sem nome'))
         = lower(btrim(p_chope))
$$;

-- 7) Apagar usuário: os tamanhos e os custos que ele cadastrou também passam para quem recebe o histórico -------
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
    update tamanhos_barril set criado_por = p_destino where criado_por = p_usuario;
    update custos_chope set criado_por = p_destino where criado_por = p_usuario;
    update auditoria set usuario_id = p_destino where usuario_id = p_usuario;
  else
    update taras set criado_por = null where criado_por = p_usuario;
    update tamanhos_barril set criado_por = null where criado_por = p_usuario;
    update custos_chope set criado_por = null where criado_por = p_usuario;
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
              and p.proname in ('fn_custo_litro', 'fn_barril_entrada', 'fn_relatorio_barris', 'fn_relatorio_barris_detalhe',
                                'fn_usuario_apagar') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as tabelas, colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional):
-- select litros, prefixo_codigo, ativo from tamanhos_barril order by litros;        -- 20 BA2, 30 BA3, 50 BA5
-- select is_nullable from information_schema.columns
--  where table_schema = 'public' and table_name = 'chopes' and column_name = 'estilo_id';  -- YES
