-- ==========================================================
-- BarrilFacil — cargo Gerente e apagar usuário
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil Testes (beta),
-- depois no BarrilFacil Lojas (main). Sem isto, criar gerente e apagar usuário dão erro.
-- Pode rodar mais de uma vez.
-- ==========================================================

-- 1) Cargo: admin, gerente ou operador ---------------------------------------------
-- Remove a regra antiga do cargo, qualquer que seja o nome dela, e cria a nova
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.usuarios'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%cargo%' loop
    execute format('alter table public.usuarios drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.usuarios drop constraint if exists usuarios_cargo_check;
alter table public.usuarios add constraint usuarios_cargo_check
  check (cargo = any (array['admin', 'gerente', 'operador']));

-- 2) Apagar usuário --------------------------------------------------------------
-- Tudo ou nada. Quem tem histórico (engates, movimentações, transferências) só é apagado se o histórico
-- passar para outro usuário (p_destino): é para a mesma pessoa com outra conta, como um cadastro com e-mail errado.
-- A auditoria vai para p_destino, se vier; senão fica sem usuário e o detalhe ganha o e-mail de quem foi apagado.
-- Acessos às unidades e sessões saem junto (on delete cascade).
create or replace function public.fn_usuario_apagar(p_usuario bigint, p_destino bigint, p_admin bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_user usuarios%rowtype;
  v_engates int;
  v_movs int;
  v_transf int;
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
  select count(*) into v_audit from auditoria where usuario_id = p_usuario;
  v_total := v_engates + v_movs + v_transf;

  if v_total > 0 and p_destino is null then
    raise exception 'Este usuário tem histórico (% engate(s), % movimentação(ões), % transferência(s)). Escolha para quem passar o histórico antes de apagar.',
      v_engates, v_movs, v_transf;
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
    update auditoria set usuario_id = p_destino where usuario_id = p_usuario;
  else
    update auditoria
       set usuario_id = null,
           detalhe = ltrim(coalesce(detalhe, '') || ' [usuário apagado: ' || coalesce(v_user.email, v_user.usuario) || ']')
     where usuario_id = p_usuario;
  end if;

  delete from usuarios where id = p_usuario;

  return jsonb_build_object(
    'engates', v_engates, 'movimentacoes', v_movs, 'transferencias', v_transf,
    'auditoria', v_audit, 'total', v_total);
end $$;

-- Permissões: a função só pode ser executada pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = 'fn_usuario_apagar' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Faz a API do Supabase enxergar a função nova na hora
notify pgrst, 'reload schema';
