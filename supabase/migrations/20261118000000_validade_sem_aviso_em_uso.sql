-- ==========================================================
-- BarrilFacil — barril engatado não gera aviso de validade
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil Testes (beta),
-- depois no BarrilFacil Lojas (main). Sem isto, o sino continua avisando a validade de barris engatados.
-- Pode rodar mais de uma vez. Não mexe em nenhum dado: só troca o filtro da função dos alertas.
-- O servidor que está no ar continua funcionando depois deste SQL (a assinatura da função é a mesma).
-- ==========================================================

-- Barris parados que vencem até amanhã (ou já venceram). p_hoje vem do servidor, no fuso da operação.
-- Avisa: 'disponivel' e 'em_transferencia'. Não avisa: 'em_uso' (engatado, na câmara fria sendo consumido),
-- 'esgotado' e 'recolhido' (o chope já saiu do barril).
create or replace function public.fn_alertas_validade(p_unit bigint, p_hoje date)
returns json language sql stable set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'codigo', b.codigo, 'chope', coalesce(b.chope_nome, b.estilo), 'validade', b.validade, 'status', b.status)
         order by b.validade, b.codigo), '[]'::json)
    from barris b
   where b.unidade_id = p_unit
     and b.status in ('disponivel', 'em_transferencia')
     and b.validade <= p_hoje + 1
$$;

-- Permissões: a função só pode ser executada pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname = 'fn_alertas_validade' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Faz a API do Supabase enxergar a mudança na hora
notify pgrst, 'reload schema';
