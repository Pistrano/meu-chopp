-- ==========================================================
-- BarrilFacil — vendas importadas da Teknisa (relatório "Vendas Realizadas no Período"), com o horário de cada venda
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil-Beta, depois no BarrilFacil-Lojas.
-- Roda depois do SQL do chope com nome, tamanhos e custo (20261118200000_chope_nome_tamanhos_custo.sql).
-- Pode rodar mais de uma vez.
--
-- O que faz:
--   - unidades.codigo_teknisa: o código da loja na Teknisa (ex.: "0003"), único;
--   - produtos_teknisa: o de-para dos produtos da Teknisa (pelo nome, sem acento e em maiúsculas) para o chope
--     do catálogo, com os litros de chope por unidade vendida, ou "ignorar" (lata, água, comida, kit...);
--   - importacoes_vendas: cada arquivo importado, por unidade (um arquivo com duas lojas vira duas importações);
--   - vendas_itens: os itens de chope vendidos, com a hora da venda. Cada item guarda uma cópia do chope e do
--     volume do produto no dia da importação (mudar o de-para depois não muda o que já foi importado).
--     Uma venda é (unidade, caixa, número); "linha" é a posição do item dentro da venda. Item que já existe é pulado;
--   - fn_vendas_importar: grava as escolhas dos produtos e as importações numa transação só;
--   - fn_vendas_existentes, fn_vendas_cancelar, fn_importacao_resumo e fn_vendas_preco_litro;
--   - fn_chope_apagar não apaga chope que tem venda importada; fn_usuario_apagar leva as importações do usuário.
--
-- Não apaga nem muda nenhum dado que já existe. O servidor antigo continua funcionando depois deste SQL.
-- ==========================================================
begin;

-- 1) Código da loja na Teknisa ---------------------------------------------------------------
alter table public.unidades add column if not exists codigo_teknisa text unique
  check (codigo_teknisa is null or codigo_teknisa ~ '^[0-9A-Z]{1,10}$');

-- 2) De-para dos produtos da Teknisa ------------------------------------------------------------
-- nome: o nome do produto normalizado (maiúsculas, sem acento, sem espaços repetidos). É a chave: o código muda
-- entre relatórios. volume_l: litros de chope por unidade vendida (caneca de 300 ml = 0,36; combo com 2 canecas = 0,72).
create table if not exists public.produtos_teknisa (
  id             bigint generated always as identity primary key,
  nome           text not null unique,
  codigo         text,
  chope_id       bigint references public.chopes (id) on delete set null,
  volume_l       numeric check (volume_l is null or (volume_l > 0 and volume_l <= 100)),
  ignorar        boolean not null default false,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

-- 3) Importações -----------------------------------------------------------------------------
-- periodo_de/periodo_ate: o período informado na tela (os itens fora dele não são importados).
-- linhas = itens de chope do arquivo no período; linhas_novas = gravados; linhas_repetidas = já existiam.
-- total_litros e total_valor: dos itens gravados. Cancelar apaga os itens desta importação e marca cancelada.
create table if not exists public.importacoes_vendas (
  id                bigint generated always as identity primary key,
  unidade_id        bigint not null references public.unidades (id),
  arquivo_nome      text,
  periodo_de        date not null,
  periodo_ate       date not null,
  primeira_venda    timestamptz,
  ultima_venda      timestamptz,
  linhas            int not null default 0,
  linhas_novas      int not null default 0,
  linhas_repetidas  int not null default 0,
  total_litros      numeric not null default 0,
  total_valor       numeric not null default 0,
  criado_em         timestamptz not null default now(),
  usuario_id        bigint references public.usuarios (id),
  cancelada         boolean not null default false,
  cancelada_em      timestamptz,
  cancelada_por     bigint references public.usuarios (id),
  constraint importacoes_vendas_periodo_check check (periodo_ate >= periodo_de)
);
create index if not exists importacoes_vendas_unidade_idx on public.importacoes_vendas (unidade_id, criado_em desc);

-- 4) Itens vendidos ----------------------------------------------------------------------------
-- vendido_em: o horário usado (a abertura da comanda; sem ela, a data da venda).
-- dt_venda e comanda_aberta_em: as duas datas do arquivo. A data da venda dos terminais de autoatendimento vem no
-- horário de Brasília e é gravada assim (o instante certo); as outras datas estão no horário da loja.
create table if not exists public.vendas_itens (
  id                 bigint generated always as identity primary key,
  unidade_id         bigint not null references public.unidades (id),
  importacao_id      bigint not null references public.importacoes_vendas (id) on delete cascade,
  caixa              text not null,
  nr_venda           text not null,
  linha              int not null check (linha > 0),
  vendido_em         timestamptz not null,
  dt_venda           timestamptz,
  comanda_aberta_em  timestamptz,
  modalidade         text,
  produto_id         bigint not null references public.produtos_teknisa (id),
  chope_id           bigint not null references public.chopes (id),
  quantidade         numeric not null,
  volume_l           numeric not null,
  litros             numeric not null,
  valor_total        numeric not null default 0,
  constraint vendas_itens_venda_linha_key unique (unidade_id, caixa, nr_venda, linha)
);
create index if not exists vendas_itens_importacao_idx on public.vendas_itens (importacao_id);
create index if not exists vendas_itens_unidade_idx on public.vendas_itens (unidade_id, vendido_em);
create index if not exists vendas_itens_chope_idx on public.vendas_itens (chope_id, vendido_em);

-- RLS ligado e sem policies, como as outras tabelas (só o servidor acessa)
alter table public.produtos_teknisa   enable row level security;
alter table public.importacoes_vendas enable row level security;
alter table public.vendas_itens       enable row level security;

-- 5) Quais itens do arquivo já foram importados ---------------------------------------------------
-- p_chaves: [{ "i": posição, "caixa": "002", "nr": "0000000123", "linha": 1 }]. Devolve as posições que já existem.
create or replace function public.fn_vendas_existentes(p_unidade bigint, p_chaves jsonb)
returns int[] language sql stable set search_path = public as $$
  select coalesce(array_agg(k.i order by k.i), '{}')
    from jsonb_to_recordset(coalesce(p_chaves, '[]'::jsonb)) as k(i int, caixa text, nr text, linha int)
   where exists (select 1 from vendas_itens v
                  where v.unidade_id = p_unidade and v.caixa = k.caixa and v.nr_venda = k.nr and v.linha = k.linha)
$$;

-- 6) Importar ------------------------------------------------------------------------------------
-- p_produtos: [{ "nome", "codigo", "chope_id", "volume_l", "ignorar" }] — as escolhas da tela, gravadas no de-para.
-- p_lotes: um por unidade: { "unidade_id", "codigo_teknisa", "primeira", "ultima", "itens": [{ "caixa", "nr", "linha",
--   "vendido_em", "dt_venda", "comanda", "modalidade", "produto" (nome normalizado), "quantidade", "valor" }] }.
-- Só entram itens de produto não ignorado (chope e volume vêm do de-para, copiados). Unidade sem item novo não
-- ganha importação. Tudo numa transação: ou grava tudo, ou nada.
create or replace function public.fn_vendas_importar(p_usuario bigint, p_arquivo text, p_de date, p_ate date,
                                                     p_produtos jsonb, p_lotes jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare
  l jsonb;
  v_unidade bigint;
  v_cod text;
  v_atual text;
  v_imp bigint;
  v_linhas int;
  v_novas int;
  v_litros numeric;
  v_valor numeric;
  v_out jsonb := '[]'::jsonb;
  v_prod text;
begin
  if p_de is null or p_ate is null or p_ate < p_de then
    raise exception 'Informe o período (de e até).';
  end if;

  -- Escolhas dos produtos: produto não ignorado precisa de chope e de volume
  select x.nome into v_prod
    from jsonb_to_recordset(coalesce(p_produtos, '[]'::jsonb)) as x(nome text, chope_id bigint, volume_l numeric, ignorar boolean)
   where not coalesce(x.ignorar, false)
     and (x.chope_id is null or x.volume_l is null or x.volume_l <= 0
          or not exists (select 1 from chopes c where c.id = x.chope_id))
   limit 1;
  if v_prod is not null then
    raise exception 'Escolha o chope e o volume de "%" ou marque para ignorar.', v_prod;
  end if;

  insert into produtos_teknisa as p (nome, codigo, chope_id, volume_l, ignorar)
  select x.nome, x.codigo, x.chope_id, x.volume_l, coalesce(x.ignorar, false)
    from jsonb_to_recordset(coalesce(p_produtos, '[]'::jsonb))
         as x(nome text, codigo text, chope_id bigint, volume_l numeric, ignorar boolean)
   where coalesce(btrim(x.nome), '') <> ''
  on conflict (nome) do update
     set codigo = coalesce(excluded.codigo, p.codigo),
         chope_id = excluded.chope_id,
         volume_l = excluded.volume_l,
         ignorar = excluded.ignorar,
         atualizado_em = case when (p.chope_id, p.volume_l, p.ignorar) is distinct from
                                   (excluded.chope_id, excluded.volume_l, excluded.ignorar)
                              then now() else p.atualizado_em end;

  for l in select * from jsonb_array_elements(coalesce(p_lotes, '[]'::jsonb)) loop
    v_unidade := (l->>'unidade_id')::bigint;
    v_cod := nullif(btrim(l->>'codigo_teknisa'), '');

    select codigo_teknisa into v_atual from unidades where id = v_unidade for update;
    if not found then
      raise exception 'Unidade não encontrada.';
    end if;
    if v_cod is not null then
      if v_atual is null then
        update unidades set codigo_teknisa = v_cod where id = v_unidade;
      elsif v_atual <> v_cod then
        raise exception 'Esta unidade já tem o código Teknisa %.', v_atual;
      end if;
    end if;

    insert into importacoes_vendas (unidade_id, arquivo_nome, periodo_de, periodo_ate, primeira_venda, ultima_venda, usuario_id)
    values (v_unidade, left(p_arquivo, 200), p_de, p_ate, (l->>'primeira')::timestamptz, (l->>'ultima')::timestamptz, p_usuario)
    returning id into v_imp;

    with itens as (
      select i.*, pt.id as produto_id, pt.chope_id, pt.volume_l
        from jsonb_to_recordset(coalesce(l->'itens', '[]'::jsonb))
             as i(caixa text, nr text, linha int, vendido_em timestamptz, dt_venda timestamptz, comanda timestamptz,
                  modalidade text, produto text, quantidade numeric, valor numeric)
        join produtos_teknisa pt on pt.nome = i.produto and not pt.ignorar
    ), novos as (
      insert into vendas_itens (unidade_id, importacao_id, caixa, nr_venda, linha, vendido_em, dt_venda, comanda_aberta_em,
                                modalidade, produto_id, chope_id, quantidade, volume_l, litros, valor_total)
      select v_unidade, v_imp, caixa, nr, linha, vendido_em, dt_venda, comanda, modalidade, produto_id, chope_id,
             quantidade, volume_l, round(quantidade * volume_l, 4), coalesce(valor, 0)
        from itens
      on conflict (unidade_id, caixa, nr_venda, linha) do nothing
      returning litros, valor_total
    )
    select (select count(*) from itens), count(*), coalesce(sum(litros), 0), coalesce(sum(valor_total), 0)
      into v_linhas, v_novas, v_litros, v_valor
      from novos;

    if v_novas = 0 then
      delete from importacoes_vendas where id = v_imp;
      v_imp := null;
    else
      update importacoes_vendas
         set linhas = v_linhas, linhas_novas = v_novas, linhas_repetidas = v_linhas - v_novas,
             total_litros = v_litros, total_valor = v_valor
       where id = v_imp;
    end if;

    v_out := v_out || jsonb_build_object(
      'unidade_id', v_unidade, 'importacao_id', v_imp, 'linhas', v_linhas, 'novas', v_novas,
      'repetidas', v_linhas - v_novas, 'litros', v_litros, 'valor', v_valor);
  end loop;

  return v_out;
end $$;

-- 7) Cancelar uma importação: apaga os itens que ela gravou e marca como cancelada -------------------------
create or replace function public.fn_vendas_cancelar(p_importacao bigint, p_usuario bigint)
returns jsonb language plpgsql set search_path = public as $$
declare v importacoes_vendas%rowtype; v_itens int;
begin
  select * into v from importacoes_vendas where id = p_importacao for update;
  if not found then
    raise exception 'Importação não encontrada.';
  end if;
  if v.cancelada then
    raise exception 'Esta importação já foi cancelada.';
  end if;
  delete from vendas_itens where importacao_id = p_importacao;
  get diagnostics v_itens = row_count;
  update importacoes_vendas set cancelada = true, cancelada_em = now(), cancelada_por = p_usuario where id = p_importacao;
  return jsonb_build_object('itens', v_itens, 'unidade_id', v.unidade_id,
                            'periodo_de', v.periodo_de, 'periodo_ate', v.periodo_ate);
end $$;

-- 8) Resumo de uma importação: litros e valor por chope e por dia (dia no fuso da loja, p_tz) -------------
create or replace function public.fn_importacao_resumo(p_importacao bigint, p_tz text)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'chopes', coalesce((
      select jsonb_agg(jsonb_build_object('chope_id', x.chope_id, 'nome', x.nome, 'quantidade', x.quantidade,
                                          'litros', x.litros, 'valor', x.valor) order by x.litros desc, x.nome)
        from (select v.chope_id, c.nome, sum(v.quantidade) as quantidade, sum(v.litros) as litros, sum(v.valor_total) as valor
                from vendas_itens v join chopes c on c.id = v.chope_id
               where v.importacao_id = p_importacao
               group by v.chope_id, c.nome) x), '[]'::jsonb),
    'dias', coalesce((
      select jsonb_agg(jsonb_build_object('dia', x.dia, 'quantidade', x.quantidade, 'litros', x.litros, 'valor', x.valor)
                       order by x.dia)
        from (select (v.vendido_em at time zone p_tz)::date as dia, sum(v.quantidade) as quantidade,
                     sum(v.litros) as litros, sum(v.valor_total) as valor
                from vendas_itens v
               where v.importacao_id = p_importacao
               group by 1) x), '[]'::jsonb))
$$;

-- 9) Preço de venda por litro de cada chope desde uma data, nas unidades informadas ----------------------
create or replace function public.fn_vendas_preco_litro(p_unidades bigint[], p_desde timestamptz)
returns table (chope_id bigint, litros numeric, valor numeric) language sql stable set search_path = public as $$
  select v.chope_id, sum(v.litros), sum(v.valor_total)
    from vendas_itens v
   where v.unidade_id = any (p_unidades) and v.vendido_em >= p_desde
   group by v.chope_id
$$;

-- 10) Apagar chope: também não apaga chope com venda importada ----------------------------------------
create or replace function public.fn_chope_apagar(p_chope bigint)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_chope chopes%rowtype;
  v_estilo text;
  v_barris int;
  v_vendas int;
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
  select count(*) into v_vendas from vendas_itens where chope_id = p_chope;
  if v_vendas > 0 then
    raise exception 'O chope "%" tem % item(ns) de venda importado(s) da Teknisa e não pode ser apagado. Desative o chope ou edite o nome.',
      v_chope.nome, v_vendas;
  end if;
  select nome into v_estilo from estilos where id = v_chope.estilo_id;
  delete from chopes where id = p_chope;
  return jsonb_build_object('nome', v_chope.nome, 'estilo', v_estilo);
end $$;

-- 11) Apagar usuário: as importações que ele fez ou cancelou vão para quem recebe o histórico (ou ficam sem nome) ---
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
    update importacoes_vendas set usuario_id = p_destino where usuario_id = p_usuario;
    update importacoes_vendas set cancelada_por = p_destino where cancelada_por = p_usuario;
    update auditoria set usuario_id = p_destino where usuario_id = p_usuario;
  else
    update taras set criado_por = null where criado_por = p_usuario;
    update tamanhos_barril set criado_por = null where criado_por = p_usuario;
    update custos_chope set criado_por = null where criado_por = p_usuario;
    update importacoes_vendas set usuario_id = null where usuario_id = p_usuario;
    update importacoes_vendas set cancelada_por = null where cancelada_por = p_usuario;
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
              and p.proname in ('fn_vendas_existentes', 'fn_vendas_importar', 'fn_vendas_cancelar', 'fn_importacao_resumo',
                                'fn_vendas_preco_litro', 'fn_chope_apagar', 'fn_usuario_apagar') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as tabelas, colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional):
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'unidades' and column_name = 'codigo_teknisa';   -- 1 linha
-- select count(*) from produtos_teknisa;   -- 0
-- select count(*) from vendas_itens;       -- 0
