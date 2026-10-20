-- ==========================================================
-- MeuChopp — catálogo de chopes e estilos
-- Rodar à mão no SQL Editor do Supabase ANTES de publicar o código novo.
-- Pode rodar mais de uma vez: nada é duplicado e nada é apagado.
--
-- O que faz:
--   1) cria as tabelas estilos e chopes (nome único sem diferenciar maiúsculas);
--   2) adiciona barris.chope_id e barris.chope_nome
--      (barris.estilo continua existindo e sendo preenchida: histórico,
--       transferências e funções fn_* usam essa coluna);
--   3) ativa o RLS nas tabelas novas, sem policies (só o servidor, com a chave secreta, acessa);
--   4) carga inicial: um estilo para cada estilo já usado nos barris, um chope com o
--      mesmo nome para cada um, e liga os barris existentes ao chope correspondente.
-- ==========================================================
begin;

-- 1) Tabelas ------------------------------------------------
create table if not exists public.estilos (
  id        bigint generated always as identity primary key,
  nome      text not null,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
create unique index if not exists estilos_nome_lower_key on public.estilos (lower(nome));

create table if not exists public.chopes (
  id        bigint generated always as identity primary key,
  nome      text not null,
  estilo_id bigint not null references public.estilos(id),
  ativo     boolean not null default true,
  criado_em timestamptz default now()
);
create unique index if not exists chopes_nome_lower_key on public.chopes (lower(nome));
create index if not exists chopes_estilo_id_idx on public.chopes (estilo_id);

-- 2) Colunas novas em barris ---------------------------------
alter table public.barris add column if not exists chope_id bigint null references public.chopes(id);
alter table public.barris add column if not exists chope_nome text null;
create index if not exists barris_chope_id_idx on public.barris (chope_id);

-- 3) RLS sem policies -----------------------------------------
alter table public.estilos enable row level security;
alter table public.chopes  enable row level security;

-- 4) Carga inicial --------------------------------------------
-- Só considera barris ainda sem chope: rodar de novo não recria chopes que
-- o administrador já renomeou ou desativou.

-- 4a) Um estilo para cada valor distinto de trim(barris.estilo), sem diferenciar maiúsculas.
--     Entre as grafias de um mesmo estilo ("pilsen", "Pilsen"), fica a mais usada.
with usados as (
  select btrim(estilo) as nome, count(*) as qtd
  from public.barris
  where chope_id is null and estilo is not null and btrim(estilo) <> ''
  group by btrim(estilo)
)
insert into public.estilos (nome)
select distinct on (lower(nome)) nome
from usados
order by lower(nome), qtd desc, nome
on conflict do nothing;

-- 4b) Um chope com o mesmo nome para cada um desses estilos.
insert into public.chopes (nome, estilo_id)
select e.nome, e.id
from public.estilos e
where exists (
  select 1 from public.barris b
  where b.chope_id is null and lower(btrim(b.estilo)) = lower(e.nome)
)
on conflict do nothing;

-- 4c) Liga os barris existentes ao chope do estilo correspondente.
update public.barris b
set chope_id = c.id,
    chope_nome = c.nome
from public.estilos e
join public.chopes c on c.estilo_id = e.id and lower(c.nome) = lower(e.nome)
where b.chope_id is null
  and b.estilo is not null
  and lower(btrim(b.estilo)) = lower(e.nome);

commit;

-- Faz a API do Supabase enxergar as tabelas e colunas novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional): só devem aparecer barris sem estilo preenchido
-- select id, codigo, estilo from public.barris where chope_id is null;
