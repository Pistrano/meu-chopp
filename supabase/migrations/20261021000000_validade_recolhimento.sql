-- ==========================================================
-- BarrilFacil — recolhimento de vasilhames e data de validade
-- Rodar à mão no SQL Editor do Supabase ANTES do merge do PR.
-- Pode rodar mais de uma vez: nada é duplicado.
--
-- Feito para não quebrar o servidor que está no ar antes do merge:
--   * nenhuma função existente é apagada nem muda de assinatura (as novas ficam ao lado);
--   * barris.validade ganha um valor padrão, porque a fn_barril_criar (usada pelo
--     servidor antigo) não informa a validade. O servidor novo sempre informa.
--
-- O que faz:
--   1) coluna duplicada do nome do chope: fica barris.chope_nome (a que o código usa);
--      os valores de barris.nome_chope são copiados para ela e a nome_chope é apagada;
--   2) status 'recolhido' em barris e operação 'recolhimento' em movimentacoes;
--   3) código do barril único só entre os barris não recolhidos
--      (o mesmo vasilhame pode voltar meses depois como um cadastro novo);
--   4) barris.validade (date, obrigatória);
--   5) funções novas: fn_barris_recolher, fn_alertas_vazios, fn_dashboard_stats_v2,
--      fn_barril_entrada e fn_alertas_validade;
--   6) textos novos em fn_status_texto e fn_unidades_resumo sem contar os recolhidos.
-- ==========================================================
begin;

-- 1) Coluna duplicada: chope_nome fica, nome_chope sai --------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'barris' and column_name = 'nome_chope') then
    execute $q$
      update public.barris
         set chope_nome = btrim(nome_chope)
       where chope_nome is null and nullif(btrim(nome_chope), '') is not null
    $q$;
    alter table public.barris drop column nome_chope;
  end if;
end $$;

-- 2) Novos valores de status e de operação ---------------------------------------
-- Apaga as checks antigas pelo conteúdo (não depende do nome que o banco deu) e recria.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.barris'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table public.barris drop constraint %I', c.conname);
  end loop;
  for c in select conname from pg_constraint
            where conrelid = 'public.movimentacoes'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%operacao%' loop
    execute format('alter table public.movimentacoes drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.barris add constraint barris_status_check
  check (status = any (array['disponivel', 'em_uso', 'em_transferencia', 'esgotado', 'recolhido']));
alter table public.movimentacoes add constraint movimentacoes_operacao_check
  check (operacao = any (array['entrada', 'transferencia', 'utilizacao', 'esgotado', 'recolhimento']));

-- 3) Código único só entre os barris em operação (não recolhidos) ----------------
-- Primeiro cria o índice novo, depois apaga a unique antiga: nunca fica sem proteção.
create unique index if not exists barris_codigo_operacao_uq on public.barris (codigo) where status <> 'recolhido';
do $$
declare c record;
begin
  for c in select con.conname from pg_constraint con
            where con.conrelid = 'public.barris'::regclass and con.contype = 'u'
              and con.conkey = array[(select attnum from pg_attribute
                                       where attrelid = 'public.barris'::regclass and attname = 'codigo')]::smallint[] loop
    execute format('alter table public.barris drop constraint %I', c.conname);
  end loop;
end $$;

-- 4) Validade --------------------------------------------------------------------
alter table public.barris add column if not exists validade date;
-- Barris que já existem: 5 dias a partir do cadastro, no fuso da operação
update public.barris set validade = (criado_em at time zone 'America/Cuiaba')::date + 5 where validade is null;
-- Mesmo cálculo como padrão, só para quem insere sem informar a validade (a fn_barril_criar do servidor antigo)
alter table public.barris alter column validade set default ((now() at time zone 'America/Cuiaba')::date + 5);
alter table public.barris alter column validade set not null;

-- 5) Funções novas ---------------------------------------------------------------

-- Recolhimento: vários barris vazios de uma vez, numa única transação (ou todos, ou nenhum)
create or replace function public.fn_barris_recolher(p_barris bigint[], p_unidade bigint, p_usuario bigint)
returns json language plpgsql set search_path = public as $$
declare v_ids bigint[]; v_id bigint; b barris%rowtype; un text; cods text[] := '{}';
begin
  select array_agg(distinct x order by x) into v_ids from unnest(p_barris) x where x is not null;
  if v_ids is null then raise exception 'Marque ao menos um barril para registrar o recolhimento.'; end if;
  select nome into un from unidades where id = p_unidade;
  if un is null then raise exception 'Unidade não encontrada.'; end if;

  foreach v_id in array v_ids loop               -- em ordem de id: evita travamento entre dois recolhimentos
    select * into b from barris where id = v_id for update;
    if not found then raise exception 'Um dos barris marcados não foi encontrado. Atualize a tela e tente de novo.'; end if;
    if b.unidade_id <> p_unidade then
      raise exception 'O barril #% não é desta unidade. Nada foi registrado.', b.codigo;
    end if;
    if b.status <> 'esgotado' then
      raise exception 'O barril #% não pode ser recolhido: está "%". Só barris vazios são recolhidos. Nada foi registrado.',
        b.codigo, fn_status_texto(b.status);
    end if;
    update barris set status = 'recolhido' where id = b.id;
    insert into movimentacoes (barril_id, operacao, usuario_id, origem_unidade_id, observacao)
      values (b.id, 'recolhimento', p_usuario, p_unidade, 'Vasilhame recolhido pela fábrica');
    cods := cods || b.codigo;
  end loop;

  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barris_recolhidos',
            format('%s: %s barril(is) recolhido(s): #%s', un, array_length(cods, 1), array_to_string(cods, ', #')));
  return to_json(cods);
end $$;

-- Barris vazios há mais de 3 dias, com os dias desde que ficaram vazios
create or replace function public.fn_alertas_vazios(p_unit bigint)
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(json_build_object('codigo', v.codigo, 'dias', v.dias) order by v.dias desc, v.codigo), '[]'::json)
  from (
    select b.codigo, floor(extract(epoch from now() - x.vazio_em) / 86400)::int as dias
      from barris b
      cross join lateral (
        select coalesce(max(m.criado_em) filter (where m.operacao = 'esgotado'), max(m.criado_em)) as vazio_em
          from movimentacoes m where m.barril_id = b.id
      ) x
     where b.unidade_id = p_unit and b.status = 'esgotado' and x.vazio_em < now() - interval '3 days'
  ) v
$$;

-- Indicadores do Painel: os mesmos da fn_dashboard_stats + 'vazios'; 'total' sem os recolhidos
create or replace function public.fn_dashboard_stats_v2(p_unit bigint)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'total', (count(*) filter (where status <> 'recolhido'))::int,
    'disponiveis', (count(*) filter (where status = 'disponivel'))::int,
    'emUso', (count(*) filter (where status = 'em_uso'))::int,
    'emTransferencia', (count(*) filter (where status = 'em_transferencia'))::int,
    'choppEsgotado', (count(*) filter (where status = 'esgotado'))::int,
    'vazios', (count(*) filter (where status = 'esgotado'))::int)
  from barris where unidade_id = p_unit
$$;

-- Entrada do barril: cadastro com chope, validade, movimentação e auditoria numa única transação
create or replace function public.fn_barril_entrada(p_codigo text, p_chope bigint, p_tamanho numeric, p_validade date,
                                                    p_unidade bigint, p_usuario bigint)
returns bigint language plpgsql set search_path = public as $$
declare v_id bigint; v_cod text := upper(btrim(p_codigo)); c chopes%rowtype; v_estilo text;
begin
  if v_cod is null or v_cod = '' then raise exception 'Informe o código do barril.'; end if;
  if p_tamanho is null or p_tamanho <= 0 then raise exception 'Informe o tamanho do barril.'; end if;
  if p_validade is null then raise exception 'Informe a data de validade do barril.'; end if;
  if not exists (select 1 from unidades where id = p_unidade and ativo) then
    raise exception 'Unidade não encontrada ou desativada.';
  end if;
  select * into c from chopes where id = p_chope;
  if not found then raise exception 'Chope não encontrado. Recarregue a página e escolha de novo.'; end if;
  if not c.ativo then raise exception 'O chope "%" está desativado. Escolha outro.', c.nome; end if;
  select nome into v_estilo from estilos where id = c.estilo_id;
  if v_estilo is null then raise exception 'O chope "%" está sem estilo. Peça a um administrador para corrigir.', c.nome; end if;
  if exists (select 1 from barris where codigo = v_cod and status <> 'recolhido') then
    raise exception 'Já existe um barril com o código #% em operação', v_cod;
  end if;

  insert into barris (codigo, estilo, chope_nome, chope_id, tamanho_l, unidade_id, validade)
    values (v_cod, v_estilo, c.nome, c.id, p_tamanho, p_unidade, p_validade) returning id into v_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, destino_unidade_id, observacao)
    values (v_id, 'entrada', p_usuario, p_unidade, 'Cadastro do barril');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_cadastrado',
            format('Barril #%s (%s · %s, %s L, validade %s)', v_cod, c.nome, v_estilo, p_tamanho, to_char(p_validade, 'DD/MM/YYYY')));
  return v_id;
exception when unique_violation then
  raise exception 'Já existe um barril com o código #% em operação', v_cod;
end $$;

-- Barris em estoque que vencem até amanhã (ou já venceram). p_hoje vem do servidor, no fuso da operação.
create or replace function public.fn_alertas_validade(p_unit bigint, p_hoje date)
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'codigo', b.codigo, 'chope', coalesce(b.chope_nome, b.estilo), 'validade', b.validade, 'status', b.status)
         order by b.validade, b.codigo), '[]'::json)
    from barris b
   where b.unidade_id = p_unit
     and b.status in ('disponivel', 'em_uso', 'em_transferencia')
     and b.validade <= p_hoje + 1
$$;

-- 6) Funções existentes: só o conteúdo muda (mesma assinatura) --------------------
create or replace function public.fn_status_texto(s text)
returns text language sql immutable set search_path = public as $$
  select case s when 'disponivel' then 'Disponível' when 'em_uso' then 'Em uso'
                when 'em_transferencia' then 'Em transferência' when 'esgotado' then 'Vazio (aguardando recolhimento)'
                when 'recolhido' then 'Recolhido' else s end
$$;

-- Tela Unidades: a contagem de barris não inclui os vasilhames já recolhidos
create or replace function public.fn_unidades_resumo()
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(r order by r.id), '[]'::json) from (
    select u.id, u.nome, u.nome_curto, u.ativo, u.cnpj, u.endereco,
      (select count(*) from barris b where b.unidade_id = u.id and b.status <> 'recolhido')::int as barris,
      (select count(*) from usuario_unidades ua join usuarios us on us.id = ua.usuario_id
        where ua.unidade_id = u.id and us.ativo)::int as usuarios,
      (select count(*) from torneiras t where t.unidade_id = u.id and t.ativo)::int as torneiras,
      (select count(*) from engates e where e.unidade_id = u.id and e.retirado_em is null)::int as "torneirasOcupadas"
    from unidades u) r
$$;

-- Permissões: as funções novas só podem ser executadas pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_barris_recolher', 'fn_alertas_vazios', 'fn_dashboard_stats_v2',
                                'fn_barril_entrada', 'fn_alertas_validade', 'fn_status_texto', 'fn_unidades_resumo') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional): todos os barris com validade e nenhuma coluna nome_chope
-- select count(*) filter (where validade is null) as sem_validade, count(*) as total from public.barris;
-- select column_name from information_schema.columns where table_name = 'barris' and column_name = 'nome_chope';
