-- ==========================================================
-- BarrilFacil — relatório de perdas: quanto saiu dos barris × quanto foi vendido no caixa, entre dois inventários
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil-Beta, depois no BarrilFacil-Lojas.
-- Roda depois do SQL do lançamento com horário (20261126000000_lancamento_com_horario.sql).
-- Pode rodar mais de uma vez.
--
-- O que faz:
--   - fn_perdas_periodo: a conta de um período, do fim de um inventário concluído até o fim de outro da mesma unidade
--     (Mais > Relatório de perdas). Uma linha por chope, o detalhe por barril, os totais e o aviso de vendas faltando;
--   - fn_perdas_periodos: os inventários concluídos da unidade e os totais de cada par seguido, nos últimos períodos.
--     Chama fn_perdas_periodo para cada par: a conta fica num lugar só (o Painel do computador usa esta);
--   - índices inventarios_unidade_concluido_idx e transferencias_origem_idx.
--
-- Não cria tabela nem muda nenhum dado. O servidor antigo continua funcionando depois deste SQL.
-- ==========================================================
begin;

create index if not exists inventarios_unidade_concluido_idx on public.inventarios (unidade_id, concluido_em);
create index if not exists transferencias_origem_idx on public.transferencias (origem_id, criado_em);

/* Período = (tA, tB]: tA = concluido_em do inventário do início (A), tB = concluido_em do inventário do fim (B).
   Por barril (litros):
     no início   = última pesagem do barril no inventário A (o inventário grava o barril cheio fechado como 100%);
     chegou      = barril novo na unidade no período ('entrada' sem origem, criado_em em (tA, tB]): o tamanho;
     recebido    = transferência confirmada para a unidade no período ('entrada' com origem): o nível na hora;
     enviado     = transferência não cancelada saindo da unidade no período (transferencias.criado_em): o nível na hora;
     no fim      = última pesagem do barril no inventário B; sem pesagem nele, 0 (acabou ou foi enviado);
     saiu        = no início + chegou + recebido - enviado - no fim.
   Nível numa hora = litros da última pesagem do barril até aquela hora; sem pesagem, o tamanho.
   Por chope: vendido = vendas_itens da unidade com vendido_em em [tA, tB), de importação não cancelada;
     perda = saiu - vendido; % = perda / saiu × 100; custo do litro = média do custo de cada barril
     (fn_custo_litro pelo tamanho e pela data de chegada em America/Cuiaba) pesada pelos litros que ele soltou;
     R$ = perda × custo do litro (4 casas), em centavos. Barril que soltou chope sem preço: o chope fica sem R$.
     estimado = barril aberto medido por estimativa (litros < tamanho) no inventário A ou no B.
   Sem nenhuma venda importada no período (nenhum dia coberto por importação ou nenhum item no período): não calcula
   a perda (vendido, perda, % e R$ nulos). dias_sem_vendas = dias de tA a tB (America/Cuiaba) que nenhuma importação
   não cancelada cobre (periodo_de a periodo_ate). */
create or replace function public.fn_perdas_periodo(p_unidade bigint, p_inv_de bigint, p_inv_ate bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tz constant text := 'America/Cuiaba';
  un unidades%rowtype; a inventarios%rowtype; b inventarios%rowtype;
  v_dias date[]; v_faltam date[]; v_sem_vendas boolean; v_chopes jsonb; v_total jsonb;
begin
  select * into un from unidades where id = p_unidade;
  if not found then raise exception 'Unidade não encontrada.'; end if;
  select * into a from inventarios where id = p_inv_de;
  if not found then raise exception 'Inventário não encontrado. Atualize a tela.'; end if;
  select * into b from inventarios where id = p_inv_ate;
  if not found then raise exception 'Inventário não encontrado. Atualize a tela.'; end if;
  if a.unidade_id <> p_unidade or b.unidade_id <> p_unidade then
    raise exception 'O inventário escolhido não é desta unidade.';
  end if;
  if a.concluido_em is null or b.concluido_em is null then
    raise exception 'Só entra no relatório inventário concluído. Conclua o inventário em Mais > Pesagem.';
  end if;
  if a.concluido_em >= b.concluido_em then
    raise exception 'O inventário do fim tem de ser depois do inventário do início.';
  end if;

  -- Dias do período e os que nenhuma importação de vendas cobre
  select array_agg(d::date order by d) into v_dias
    from generate_series((a.concluido_em at time zone v_tz)::date::timestamp,
                         (b.concluido_em at time zone v_tz)::date::timestamp, interval '1 day') d;
  select coalesce(array_agg(d order by d), '{}') into v_faltam
    from unnest(v_dias) d
   where not exists (select 1 from importacoes_vendas i
                      where i.unidade_id = p_unidade and not i.cancelada and d between i.periodo_de and i.periodo_ate);
  v_sem_vendas := cardinality(v_faltam) = cardinality(v_dias)
    or not exists (select 1 from vendas_itens v join importacoes_vendas i on i.id = v.importacao_id and not i.cancelada
                    where v.unidade_id = p_unidade and v.vendido_em >= a.concluido_em and v.vendido_em < b.concluido_em);

  with
  ini as (
    select distinct on (p.barril_id) p.barril_id, p.litros, (p.metodo = 'estimativa' and p.litros < br.tamanho_l) as estimado
      from pesagens p join barris br on br.id = p.barril_id
     where p.inventario_id = a.id
     order by p.barril_id, p.id desc
  ),
  fim as (
    select distinct on (p.barril_id) p.barril_id, p.litros, (p.metodo = 'estimativa' and p.litros < br.tamanho_l) as estimado
      from pesagens p join barris br on br.id = p.barril_id
     where p.inventario_id = b.id
     order by p.barril_id, p.id desc
  ),
  ent as (
    select distinct m.barril_id
      from movimentacoes m
     where m.operacao = 'entrada' and m.destino_unidade_id = p_unidade and m.origem_unidade_id is null
       and m.criado_em > a.concluido_em and m.criado_em <= b.concluido_em
  ),
  transf as (
    select m.barril_id, 'recebido' as tipo, m.criado_em as em, m.origem_unidade_id as outra
      from movimentacoes m
     where m.operacao = 'entrada' and m.destino_unidade_id = p_unidade and m.origem_unidade_id is not null
       and m.criado_em > a.concluido_em and m.criado_em <= b.concluido_em
    union all
    select t.barril_id, 'enviado', t.criado_em, t.destino_id
      from transferencias t
     where t.origem_id = p_unidade and t.status <> 'cancelada'
       and t.criado_em > a.concluido_em and t.criado_em <= b.concluido_em
  ),
  transf_nivel as (
    select x.barril_id, x.tipo, x.em, u.nome as outra_nome,
           coalesce((select p.litros from pesagens p
                      where p.barril_id = x.barril_id and p.criado_em <= x.em
                      order by p.criado_em desc, p.id desc limit 1), br.tamanho_l) as litros
      from transf x
      join barris br on br.id = x.barril_id
      left join unidades u on u.id = x.outra
  ),
  tr as (
    select barril_id,
           coalesce(sum(litros) filter (where tipo = 'recebido'), 0) as recebido,
           string_agg(distinct outra_nome, ', ') filter (where tipo = 'recebido') as recebido_de,
           coalesce(sum(litros) filter (where tipo = 'enviado'), 0) as enviado,
           string_agg(distinct outra_nome, ', ') filter (where tipo = 'enviado') as enviado_para
      from transf_nivel
     group by barril_id
  ),
  ids as (
    select barril_id from ini union select barril_id from fim union select barril_id from ent union select barril_id from tr
  ),
  bar as (
    select br.id, br.codigo, br.tamanho_l,
           -- barril antigo sem chope do catálogo: o chope de mesmo nome (sem diferenciar maiúsculas), se houver
           coalesce(br.chope_id, (select c.id from chopes c
                                   where lower(c.nome) = lower(coalesce(nullif(btrim(br.chope_nome), ''), btrim(br.estilo)))
                                   order by c.id limit 1)) as chope_id,
           coalesce(nullif(btrim(br.chope_nome), ''), nullif(btrim(br.estilo), ''), 'Sem nome') as nome_barril,
           (br.criado_em at time zone v_tz)::date as chegada,
           i.litros as inicio, coalesce(i.estimado, false) as inicio_estimado,
           (e.barril_id is not null) as chegou,
           coalesce(t.recebido, 0) as recebido, t.recebido_de,
           coalesce(t.enviado, 0) as enviado, t.enviado_para,
           f.litros as fim, coalesce(f.estimado, false) as fim_estimado
      from ids
      join barris br on br.id = ids.barril_id
      left join ini i on i.barril_id = br.id
      left join fim f on f.barril_id = br.id
      left join ent e on e.barril_id = br.id
      left join tr t on t.barril_id = br.id
  ),
  conta as (
    select x.*, coalesce(c.nome, x.nome_barril) as chope_nome,
           coalesce(x.chope_id::text, 'nome:' || lower(x.nome_barril)) as chave,
           coalesce(x.inicio, 0) + case when x.chegou then x.tamanho_l else 0 end + x.recebido - x.enviado
             - coalesce(x.fim, 0) as saiu,
           case when x.chope_id is not null then fn_custo_litro(x.chope_id, x.tamanho_l, x.chegada) end as custo
      from bar x
      left join chopes c on c.id = x.chope_id
  ),
  vend as (
    select v.chope_id, sum(v.litros) as litros
      from vendas_itens v
      join importacoes_vendas iv on iv.id = v.importacao_id and not iv.cancelada
     where v.unidade_id = p_unidade and v.vendido_em >= a.concluido_em and v.vendido_em < b.concluido_em
     group by v.chope_id
  ),
  por_chope as (
    select k.chave, max(k.chope_id) as chope_id, min(k.chope_nome) as nome,
           round(sum(k.saiu), 2) as saiu,
           sum(k.saiu * k.custo) filter (where k.saiu <> 0) as valor,
           coalesce(bool_or(k.saiu <> 0 and k.custo is null), false) as sem_preco,
           bool_or(k.inicio_estimado or k.fim_estimado) as estimado,
           jsonb_agg(jsonb_build_object(
             'barril_id', k.id, 'codigo', k.codigo, 'tamanho_l', k.tamanho_l,
             'inicio', k.inicio, 'inicio_estimado', k.inicio_estimado, 'chegou', k.chegou,
             'recebido', nullif(k.recebido, 0), 'recebido_de', k.recebido_de,
             'enviado', nullif(k.enviado, 0), 'enviado_para', k.enviado_para,
             'fim', k.fim, 'fim_estimado', k.fim_estimado, 'acabou', k.fim is null and k.enviado = 0,
             'saiu', round(k.saiu, 2), 'custo_litro', round(k.custo, 4))
             order by k.codigo)
             filter (where k.saiu <> 0 or k.recebido <> 0 or k.enviado <> 0 or k.inicio_estimado or k.fim_estimado) as barris
      from conta k
     group by k.chave
  ),
  linhas as (
    select coalesce(pc.chope_id, v.chope_id) as chope_id, coalesce(pc.nome, c.nome) as nome,
           coalesce(pc.saiu, 0) as saiu, coalesce(pc.valor, 0) as valor,
           coalesce(pc.sem_preco, false) as sem_preco, coalesce(pc.estimado, false) as estimado,
           coalesce(pc.barris, '[]'::jsonb) as barris,
           case when v_sem_vendas then null else round(coalesce(v.litros, 0), 2) end as vendido
      from por_chope pc
      full join vend v on v.chope_id = pc.chope_id
      left join chopes c on c.id = v.chope_id
  ),
  calc as (
    select l.*, l.saiu - l.vendido as perda,
           case when not l.sem_preco and l.saiu <> 0 then round(l.valor / l.saiu, 4) end as custo_litro
      from linhas l
  ),
  fin as (
    select c.*, case when c.saiu > 0 then round(c.perda / c.saiu * 100, 4) end as pct,
           round(c.perda * c.custo_litro, 2) as reais
      from calc c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'chope_id', f.chope_id, 'nome', f.nome, 'saiu', f.saiu, 'vendido', f.vendido, 'perda', f.perda,
           'pct', f.pct, 'custo_litro', f.custo_litro, 'reais', f.reais, 'estimado', f.estimado,
           'sem_preco', f.sem_preco, 'barris', f.barris)
           order by f.saiu desc, lower(f.nome)), '[]'::jsonb),
         jsonb_build_object(
           'saiu', coalesce(sum(f.saiu), 0),
           'vendido', case when v_sem_vendas then null else coalesce(sum(f.vendido), 0) end,
           'perda', case when v_sem_vendas then null else coalesce(sum(f.perda), 0) end,
           'pct', case when not v_sem_vendas and coalesce(sum(f.saiu), 0) > 0
                       then round(sum(f.perda) / sum(f.saiu) * 100, 4) end,
           'reais', case when v_sem_vendas then null else sum(f.reais) end,
           'estimado', coalesce(bool_or(f.estimado), false),
           'sem_preco', coalesce(jsonb_agg(f.nome order by lower(f.nome)) filter (where f.sem_preco), '[]'::jsonb))
    into v_chopes, v_total
    from fin f;

  return jsonb_build_object(
    'unidade', jsonb_build_object('id', un.id, 'nome', un.nome),
    'inventario_de', jsonb_build_object('id', a.id, 'iniciado_em', a.iniciado_em, 'concluido_em', a.concluido_em),
    'inventario_ate', jsonb_build_object('id', b.id, 'iniciado_em', b.iniciado_em, 'concluido_em', b.concluido_em),
    'de', a.concluido_em, 'ate', b.concluido_em,
    'sem_vendas', v_sem_vendas, 'dias_sem_vendas', to_jsonb(v_faltam),
    'total', v_total, 'chopes', v_chopes);
end $$;

/* Inventários concluídos da unidade (do mais novo para o mais velho), o inventário aberto (ou nulo) e os totais de cada
   par seguido de inventários concluídos nos últimos p_limite períodos (do mais novo para o mais velho). */
create or replace function public.fn_perdas_periodos(p_unidade bigint, p_limite int default 8)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_inv jsonb; v_aberto jsonb; v_per jsonb := '[]'::jsonb; r record; x jsonb;
begin
  if not exists (select 1 from unidades where id = p_unidade) then raise exception 'Unidade não encontrada.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'iniciado_em', i.iniciado_em, 'concluido_em', i.concluido_em)
                            order by i.concluido_em desc, i.id desc), '[]'::jsonb)
    into v_inv
    from inventarios i where i.unidade_id = p_unidade and i.concluido_em is not null;
  select jsonb_build_object('id', i.id, 'iniciado_em', i.iniciado_em) into v_aberto
    from inventarios i where i.unidade_id = p_unidade and i.concluido_em is null;

  for r in
    select s.de_id, s.de, s.ate_id, s.ate
      from (select i.id as ate_id, i.concluido_em as ate,
                   lag(i.id) over w as de_id, lag(i.concluido_em) over w as de
              from inventarios i
             where i.unidade_id = p_unidade and i.concluido_em is not null
            window w as (order by i.concluido_em, i.id)) s
     where s.de_id is not null and s.de < s.ate
     order by s.ate desc
     limit least(greatest(coalesce(p_limite, 8), 0), 100)
  loop
    x := fn_perdas_periodo(p_unidade, r.de_id, r.ate_id);
    v_per := v_per || jsonb_build_array(
      jsonb_build_object('inventario_de', r.de_id, 'inventario_ate', r.ate_id, 'de', r.de, 'ate', r.ate,
                         'sem_vendas', x -> 'sem_vendas', 'dias_sem_vendas', x -> 'dias_sem_vendas')
      || (x -> 'total'));
  end loop;

  return jsonb_build_object('inventarios', v_inv, 'aberto', v_aberto, 'periodos', v_per);
end $$;

-- Permissões: só o servidor (service_role) chama, como as outras funções
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_perdas_periodo', 'fn_perdas_periodos') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional):
-- select proname from pg_proc where proname like 'fn_perdas%';                                  -- 2 linhas
-- select fn_perdas_periodos(<id da unidade>, 3);                                                -- os últimos 3 períodos
