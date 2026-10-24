-- ==========================================================
-- BarrilFacil — Relatório de barris (uso por estilo num período)
-- Rodar à mão no SQL Editor do Supabase (MeuChopp2) ANTES do deploy.
-- Só acrescenta coisas (dois índices e duas funções) e pode rodar mais de uma vez.
--
-- O código do barril se repete: o vasilhame recolhido volta como uma linha nova em barris.
-- Cada linha de barris é um ciclo, então tudo aqui conta por barris.id, nunca pelo código.
--
-- Números de cada linha (estilo + chope) no período [p_de, p_ate):
--   recebidos   barris com movimentação 'entrada' tendo a unidade como destino. O recebimento de transferência também
--               grava 'entrada', mas com a unidade de origem preenchida: esse não conta
--   utilizados  barris cujo PRIMEIRO engate nas unidades (o menor engates.engatado_em) cai no período:
--               o barril engatado em 30/09 e esvaziado em 02/10 conta só em setembro, nunca em dois meses
--   litros      soma do tamanho_l dos utilizados
--   esvaziados  barris com movimentação 'esgotado' no período
--   recolhidos  barris com movimentação 'recolhimento' no período
--   agora       situação atual dos barris das unidades (retrato do momento, não depende do período)
-- Estilo e chope vêm do catálogo (barris.chope_id -> chopes -> estilos). Barril antigo sem chope_id usa
-- barris.chope_nome e barris.estilo; sem nada disso, "Sem estilo".
-- ==========================================================

-- Índices para as consultas por período
create index if not exists engates_unidade_engatado_idx on public.engates (unidade_id, engatado_em);
create index if not exists mov_operacao_criado_idx on public.movimentacoes (operacao, criado_em);

-- Linhas da tabela (uma por chope, com o estilo), a situação agora e os totais
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
           coalesce(s.nome, nullif(btrim(b.estilo), ''), 'Sem estilo') as estilo,
           coalesce(c.nome, nullif(btrim(b.chope_nome), '')) as chope,
           -- Barril antigo (sem chope do catálogo): identifica a linha pelo texto gravado no barril
           case when c.id is null then coalesce(btrim(b.estilo), '') end as estilo_chave,
           case when c.id is null then coalesce(btrim(b.chope_nome), '') end as chope_chave
      from (select barril_id from marcas union select barril_id from agora) ids
      join barris b on b.id = ids.barril_id
      left join marcas mk on mk.barril_id = b.id
      left join agora ag on ag.barril_id = b.id
      left join chopes c on c.id = b.chope_id
      left join estilos s on s.id = c.estilo_id
  ),
  linhas as (
    select estilo, chope, chope_id, estilo_chave, chope_chave,
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
     group by estilo, chope, chope_id, estilo_chave, chope_chave
  )
  select json_build_object(
    'gerado_em', now(),
    'linhas', coalesce((
      select json_agg(l order by lower(l.estilo), lower(coalesce(l.chope, '')))
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

-- Detalhe de uma linha: os barris utilizados (primeiro engate no período) de um chope.
-- Chope do catálogo: p_chope. Barril antigo: p_chope nulo + p_estilo e p_chope_nome (estilo_chave e chope_chave da linha).
create or replace function public.fn_relatorio_barris_detalhe(p_unidades bigint[], p_de timestamptz, p_ate timestamptz,
                                                              p_chope bigint, p_estilo text, p_chope_nome text)
returns json language sql stable set search_path = public as $$
  with primeiro as (
    select distinct on (e.barril_id) e.barril_id, e.unidade_id, e.engatado_em, e.retirado_em, e.torneira_numero
      from engates e
     where e.unidade_id = any(p_unidades)
       and e.barril_id in (select n.barril_id from engates n
                            where n.unidade_id = any(p_unidades) and n.engatado_em >= p_de and n.engatado_em < p_ate)
     order by e.barril_id, e.engatado_em, e.id
  )
  select coalesce(json_agg(json_build_object(
           'id', b.id, 'codigo', b.codigo, 'tamanho_l', b.tamanho_l, 'validade', b.validade,
           'engatado_em', p.engatado_em, 'retirado_em', p.retirado_em, 'torneira', p.torneira_numero,
           'unidade', u.nome_curto)
         order by p.engatado_em, b.codigo), '[]'::json)
    from primeiro p
    join barris b on b.id = p.barril_id
    left join unidades u on u.id = p.unidade_id
   where p.engatado_em >= p_de and p.engatado_em < p_ate
     and case when p_chope is not null then b.chope_id = p_chope
              else b.chope_id is null
                   and coalesce(btrim(b.estilo), '') = coalesce(p_estilo, '')
                   and coalesce(btrim(b.chope_nome), '') = coalesce(p_chope_nome, '') end
$$;

-- Permissões: as funções novas só podem ser executadas pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_relatorio_barris', 'fn_relatorio_barris_detalhe') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Faz a API do Supabase enxergar as funções novas na hora
notify pgrst, 'reload schema';
