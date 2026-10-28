-- ==========================================================
-- BarrilFacil — apagar estilo e chope; razão social nas unidades
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil Testes (beta),
-- depois no BarrilFacil Lojas (main). Sem isto, apagar estilo/chope e salvar unidade dão erro.
-- Pode rodar mais de uma vez.
-- ==========================================================

-- 1) Razão social da unidade ----------------------------------------------------
-- A coluna nome continua sendo o nome mostrado no app (agora chamado de nome fantasia) e continua única.
-- Nas unidades que já existem a razão social fica vazia até alguém editar a unidade.
alter table public.unidades add column if not exists razao_social text;

-- O resumo da tela Unidades passa a devolver a razão social (drop + create, refazendo o grant abaixo)
drop function if exists public.fn_unidades_resumo();
create function public.fn_unidades_resumo()
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(r order by r.id), '[]'::json) from (
    select u.id, u.nome, u.nome_curto, u.razao_social, u.ativo, u.cnpj, u.endereco,
      (select count(*) from barris b where b.unidade_id = u.id and b.status <> 'recolhido')::int as barris,
      (select count(*) from usuario_unidades ua join usuarios us on us.id = ua.usuario_id
        where ua.unidade_id = u.id and us.ativo)::int as usuarios,
      (select count(*) from torneiras t where t.unidade_id = u.id and t.ativo)::int as torneiras,
      (select count(*) from engates e where e.unidade_id = u.id and e.retirado_em is null)::int as "torneirasOcupadas"
    from unidades u) r
$$;

-- 2) Apagar estilo ----------------------------------------------------------------
-- Estilo com chopes (ativos ou não) só é apagado se os chopes passarem para outro estilo ativo (p_destino).
-- Os barris desses chopes passam a mostrar o estilo novo (barris.estilo), inclusive no histórico. Tudo ou nada.
create or replace function public.fn_estilo_apagar(p_estilo bigint, p_destino bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_estilo estilos%rowtype;
  v_destino estilos%rowtype;
  v_chopes bigint[];
  v_nomes text;
  v_barris int := 0;
begin
  select * into v_estilo from estilos where id = p_estilo for update;
  if not found then
    raise exception 'Estilo não encontrado.';
  end if;

  select coalesce(array_agg(id order by lower(nome)), '{}'), string_agg(nome, ', ' order by lower(nome))
    into v_chopes, v_nomes
    from chopes where estilo_id = p_estilo;

  if cardinality(v_chopes) > 0 then
    if p_destino is null then
      raise exception 'O estilo "%" tem % chope(s): %. Escolha para qual estilo eles vão antes de apagar.',
        v_estilo.nome, cardinality(v_chopes), v_nomes;
    end if;
    if p_destino = p_estilo then
      raise exception 'Escolha outro estilo para receber os chopes.';
    end if;
    select * into v_destino from estilos where id = p_destino for share;
    if not found then
      raise exception 'O estilo escolhido para receber os chopes não existe mais.';
    end if;
    if not v_destino.ativo then
      raise exception 'O estilo "%" está desativado. Escolha um estilo ativo.', v_destino.nome;
    end if;
    update chopes set estilo_id = p_destino where id = any (v_chopes);
    update barris set estilo = v_destino.nome where chope_id = any (v_chopes);
    get diagnostics v_barris = row_count;
  end if;

  delete from estilos where id = p_estilo;

  return jsonb_build_object('nome', v_estilo.nome, 'chopes', cardinality(v_chopes), 'barris', v_barris,
    'destino', v_destino.nome);
end $$;

-- 3) Apagar chope -----------------------------------------------------------------
-- Só apaga chope que nenhum barril usa (barris.chope_id). Com barris, o certo é desativar ou editar.
create or replace function public.fn_chope_apagar(p_chope bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_chope chopes%rowtype;
  v_estilo text;
  v_barris int;
begin
  select * into v_chope from chopes where id = p_chope for update;
  if not found then
    raise exception 'Chope não encontrado.';
  end if;
  select count(*) into v_barris from barris where chope_id = p_chope;
  if v_barris > 0 then
    raise exception 'O chope "%" é usado por % barril(is) e não pode ser apagado. Desative o chope (ele some do cadastro de barris) ou edite o nome.',
      v_chope.nome, v_barris;
  end if;
  select nome into v_estilo from estilos where id = v_chope.estilo_id;
  delete from chopes where id = p_chope;
  return jsonb_build_object('nome', v_chope.nome, 'estilo', v_estilo);
end $$;

-- Permissões: as funções só podem ser executadas pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_unidades_resumo', 'fn_estilo_apagar', 'fn_chope_apagar') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Faz a API do Supabase enxergar as mudanças na hora
notify pgrst, 'reload schema';
