-- ==========================================================
-- BarrilFacil — sessões guardadas no banco + limpeza de sobras antigas
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil Testes (beta),
-- depois no BarrilFacil Lojas (main). Sem a tabela sessoes o servidor novo não cria sessão e ninguém entra.
-- Pode rodar mais de uma vez.
--
-- Sessões: antes ficavam só na memória do servidor, então cada atualização deslogava todo mundo e
-- desativar um usuário não derrubava a sessão que ele já tinha aberta. Agora cada login vira uma linha
-- aqui. O cookie mc_session guarda o token; o banco guarda só o hash SHA-256 dele.
-- ==========================================================

-- 1) Sessões ----------------------------------------------------------------------
create table if not exists public.sessoes (
  token_hash        text primary key,
  usuario_id        bigint not null references public.usuarios (id) on delete cascade,
  criado_em         timestamptz not null default now(),
  ultima_atividade  timestamptz not null default now(),
  ip                text
);
create index if not exists sessoes_usuario_idx on public.sessoes (usuario_id);

-- RLS ligado e sem policies, como as outras tabelas: só o servidor (service_role) acessa
alter table public.sessoes enable row level security;

-- 2) Funções que o código não usa mais ---------------------------------------------
-- (a fn_dashboard_stats_v2 continua em uso pelo Painel e NÃO sai)
drop function if exists public.fn_barril_criar(text, text, numeric, bigint, bigint);
drop function if exists public.fn_barril_reabastecer(bigint, bigint);
drop function if exists public.fn_alertas_esgotados(bigint);
drop function if exists public.fn_dashboard_stats(bigint);

-- 3) Validade sem valor padrão -------------------------------------------------------
-- O padrão (cadastro + 5 dias) existia só para a fn_barril_criar do servidor antigo.
-- Hoje a validade sempre vem do cadastro do barril (fn_barril_entrada).
alter table public.barris alter column validade drop default;

-- Faz a API do Supabase enxergar a tabela nova na hora
notify pgrst, 'reload schema';
