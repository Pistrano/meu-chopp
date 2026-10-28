-- ==========================================================
-- BarrilFacil — funcionários do quiosque: quem fez cada ação
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil Testes (beta),
-- depois no BarrilFacil Lojas (main). Sem isto, o servidor novo não salva nenhuma ação com barril.
-- Pode rodar mais de uma vez.
--
-- O servidor que está no ar continua funcionando depois deste SQL: as funções das ações ganham o
-- parâmetro p_funcionario com default null (a versão antiga, sem ele, é apagada para não ficarem duas).
-- Os registros antigos ficam sem funcionário.
-- ==========================================================
begin;

-- Segurança: o banco antigo dos EUA tinha uma tabela "funcionarios" diferente. Se ela existir, para aqui.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'funcionarios')
     and not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'funcionarios' and column_name = 'ativo') then
    raise exception 'Já existe uma tabela public.funcionarios diferente da esperada. Nada foi alterado.';
  end if;
end $$;

-- 1) Funcionários e as unidades de cada um -----------------------------------------
-- Funcionário não é apagado, só desativado: o histórico aponta para ele.
create table if not exists public.funcionarios (
  id         bigint generated always as identity primary key,
  nome       text not null,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);
create unique index if not exists funcionarios_nome_lower_uq on public.funcionarios (lower(nome));

create table if not exists public.funcionario_unidades (
  funcionario_id  bigint not null references public.funcionarios (id) on delete cascade,
  unidade_id      bigint not null references public.unidades (id),
  primary key (funcionario_id, unidade_id)
);
create index if not exists funcionario_unidades_unidade_idx on public.funcionario_unidades (unidade_id);

-- RLS ligado e sem policies, como as outras tabelas (só o servidor acessa)
alter table public.funcionarios         enable row level security;
alter table public.funcionario_unidades enable row level security;

-- 2) Quem fez: colunas novas, nulas ----------------------------------------------
alter table public.movimentacoes  add column if not exists funcionario_id      bigint references public.funcionarios (id);
alter table public.engates        add column if not exists engatado_func_id    bigint references public.funcionarios (id);
alter table public.engates        add column if not exists retirado_func_id    bigint references public.funcionarios (id);
alter table public.transferencias add column if not exists solicitante_func_id bigint references public.funcionarios (id);
alter table public.transferencias add column if not exists recebedor_func_id   bigint references public.funcionarios (id);
create index if not exists mov_funcionario_idx on public.movimentacoes (funcionario_id);

-- 3) Funções das ações: p_funcionario no fim, default null ------------------------
-- Drop da assinatura antiga e create da nova. A auditoria ganha " · funcionário <nome>" quando há funcionário.
drop function if exists public.fn_barril_entrada(text, bigint, numeric, date, bigint, bigint);
drop function if exists public.fn_barril_engatar(bigint, bigint, bigint);
drop function if exists public.fn_barril_esgotar(bigint, bigint);
drop function if exists public.fn_barris_recolher(bigint[], bigint, bigint);
drop function if exists public.fn_transferencia_criar(bigint, bigint, bigint);
drop function if exists public.fn_transferencia_confirmar(bigint, bigint);
drop function if exists public.fn_transferencia_cancelar(bigint, bigint);

-- Entrada do barril: cadastro com chope, validade, movimentação e auditoria numa única transação
create or replace function public.fn_barril_entrada(p_codigo text, p_chope bigint, p_tamanho numeric, p_validade date,
                                                    p_unidade bigint, p_usuario bigint, p_funcionario bigint default null)
returns bigint language plpgsql set search_path = public as $$
declare v_id bigint; v_cod text := upper(btrim(p_codigo)); c chopes%rowtype; v_estilo text; v_func text;
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
  select nome into v_func from funcionarios where id = p_funcionario;

  insert into barris (codigo, estilo, chope_nome, chope_id, tamanho_l, unidade_id, validade)
    values (v_cod, v_estilo, c.nome, c.id, p_tamanho, p_unidade, p_validade) returning id into v_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, destino_unidade_id, observacao)
    values (v_id, 'entrada', p_usuario, p_funcionario, p_unidade, 'Cadastro do barril');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_cadastrado',
            format('Barril #%s (%s · %s, %s L, validade %s)', v_cod, c.nome, v_estilo, p_tamanho, to_char(p_validade, 'DD/MM/YYYY'))
            || coalesce(' · funcionário ' || v_func, ''));
  return v_id;
exception when unique_violation then
  raise exception 'Já existe um barril com o código #% em operação', v_cod;
end $$;

create or replace function public.fn_barril_engatar(p_barril bigint, p_torneira bigint, p_usuario bigint,
                                                    p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; t torneiras%rowtype; occ text; un text; v_func text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'disponivel' then
    raise exception 'O barril #% não pode ser engatado: está "%". Só barris disponíveis podem ser engatados.', b.codigo, fn_status_texto(b.status);
  end if;
  if exists (select 1 from engates where barril_id = b.id and retirado_em is null) then
    raise exception 'O barril #% já está engatado em uma torneira.', b.codigo;
  end if;
  select * into t from torneiras where id = p_torneira for update;
  if not found or t.unidade_id <> b.unidade_id then
    raise exception 'Torneira inválida: ela não pertence à unidade deste barril.';
  end if;
  if not t.ativo then raise exception 'A Torneira % está desativada.', t.numero; end if;
  select b2.codigo into occ from engates e join barris b2 on b2.id = e.barril_id
   where e.torneira_id = t.id and e.retirado_em is null;
  if occ is not null then
    raise exception 'A Torneira % está ocupada pelo barril #%. Escolha outra torneira.', t.numero, occ;
  end if;
  select nome into v_func from funcionarios where id = p_funcionario;

  insert into engates (barril_id, torneira_id, unidade_id, torneira_numero, engatado_por, engatado_func_id)
    values (b.id, t.id, b.unidade_id, t.numero, p_usuario, p_funcionario);
  update barris set status = 'em_uso' where id = b.id;
  select nome into un from unidades where id = b.unidade_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'utilizacao', p_usuario, p_funcionario, b.unidade_id, 'Engatado na Torneira ' || t.numero, t.id, t.numero);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_em_uso', format('Barril #%s engatado na Torneira %s (%s)', b.codigo, t.numero, un)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('codigo', b.codigo, 'estilo', b.estilo, 'unidade', un, 'torneira', t.numero);
exception when unique_violation then
  raise exception 'A torneira ou o barril acabou de ser usado em outro engate. Atualize a tela e tente de novo.';
end $$;

create or replace function public.fn_barril_esgotar(p_barril bigint, p_usuario bigint, p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare b barris%rowtype; e engates%rowtype; t torneiras%rowtype; un text; v_num int; v_tid bigint; v_func text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if b.status <> 'em_uso' then
    raise exception 'O barril #% não está em uso (status atual: "%").', b.codigo, fn_status_texto(b.status);
  end if;
  select nome into un from unidades where id = b.unidade_id;
  select nome into v_func from funcionarios where id = p_funcionario;
  select * into e from engates where barril_id = b.id and retirado_em is null for update;
  if found then
    select * into t from torneiras where id = e.torneira_id;
    if t.id is null or t.unidade_id <> b.unidade_id or e.unidade_id <> b.unidade_id then
      raise exception 'Registro de engate inconsistente para este barril. Nada foi alterado; avise o administrador.';
    end if;
    update engates set retirado_por = p_usuario, retirado_func_id = p_funcionario, retirado_em = now() where id = e.id;
    v_num := t.numero; v_tid := t.id;
  end if;
  update barris set status = 'esgotado' where id = b.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao, torneira_id, torneira_numero)
    values (b.id, 'esgotado', p_usuario, p_funcionario, b.unidade_id,
            case when v_num is not null then 'Retirado da Torneira ' || v_num || ' (torneira liberada)'
                 else 'Retirado sem torneira registrada (engate feito antes do controle de torneiras)' end,
            v_tid, v_num);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barril_esgotado',
            format('Barril #%s%s (%s)', b.codigo,
                   case when v_num is not null then ' retirado da Torneira ' || v_num else ' (sem torneira registrada)' end, un)
            || coalesce(' · funcionário ' || v_func, ''));
  return json_build_object('codigo', b.codigo, 'unidade', un, 'torneira', v_num);
end $$;

-- Recolhimento: vários barris vazios de uma vez, numa única transação (ou todos, ou nenhum)
create or replace function public.fn_barris_recolher(p_barris bigint[], p_unidade bigint, p_usuario bigint,
                                                     p_funcionario bigint default null)
returns json language plpgsql set search_path = public as $$
declare v_ids bigint[]; v_id bigint; b barris%rowtype; un text; cods text[] := '{}'; v_func text;
begin
  select array_agg(distinct x order by x) into v_ids from unnest(p_barris) x where x is not null;
  if v_ids is null then raise exception 'Marque ao menos um barril para registrar o recolhimento.'; end if;
  select nome into un from unidades where id = p_unidade;
  if un is null then raise exception 'Unidade não encontrada.'; end if;
  select nome into v_func from funcionarios where id = p_funcionario;

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
    insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao)
      values (b.id, 'recolhimento', p_usuario, p_funcionario, p_unidade, 'Vasilhame recolhido pela fábrica');
    cods := cods || b.codigo;
  end loop;

  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'barris_recolhidos',
            format('%s: %s barril(is) recolhido(s): #%s', un, array_length(cods, 1), array_to_string(cods, ', #'))
            || coalesce(' · funcionário ' || v_func, ''));
  return to_json(cods);
end $$;

create or replace function public.fn_transferencia_criar(p_barril bigint, p_destino bigint, p_usuario bigint,
                                                         p_funcionario bigint default null)
returns boolean language plpgsql set search_path = public as $$
declare b barris%rowtype; v_func text;
begin
  select * into b from barris where id = p_barril for update;
  if not found then raise exception 'Barril não encontrado.'; end if;
  if p_destino is null or p_destino = b.unidade_id then
    raise exception 'Escolha uma unidade de destino diferente da origem.';
  end if;
  if not exists (select 1 from unidades where id = p_destino and ativo) then
    raise exception 'Unidade de destino inválida ou desativada.';
  end if;
  if b.status <> 'disponivel' then
    raise exception 'Só é possível transferir barris disponíveis (#% está indisponível).', b.codigo;
  end if;
  select nome into v_func from funcionarios where id = p_funcionario;
  update barris set status = 'em_transferencia' where id = b.id;
  insert into transferencias (barril_id, origem_id, destino_id, solicitante_id, solicitante_func_id)
    values (b.id, b.unidade_id, p_destino, p_usuario, p_funcionario);
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, destino_unidade_id)
    values (b.id, 'transferencia', p_usuario, p_funcionario, b.unidade_id, p_destino);
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_iniciada', 'Barril #' || b.codigo || coalesce(' · funcionário ' || v_func, ''));
  return true;
end $$;

create or replace function public.fn_transferencia_confirmar(p_id bigint, p_usuario bigint, p_funcionario bigint default null)
returns boolean language plpgsql set search_path = public as $$
declare t transferencias%rowtype; b barris%rowtype; v_func text;
begin
  select * into t from transferencias where id = p_id for update;
  if not found or t.status <> 'pendente' then raise exception 'Transferência não está pendente.'; end if;
  select * into b from barris where id = t.barril_id for update;
  select nome into v_func from funcionarios where id = p_funcionario;
  update barris set unidade_id = t.destino_id, status = 'disponivel' where id = b.id;
  update transferencias set status = 'confirmada', recebedor_id = p_usuario, recebedor_func_id = p_funcionario, resolvido_em = now()
   where id = t.id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, destino_unidade_id, observacao)
    values (b.id, 'entrada', p_usuario, p_funcionario, t.origem_id, t.destino_id, 'Recebimento de transferência');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_confirmada', 'Barril #' || b.codigo || coalesce(' · funcionário ' || v_func, ''));
  return true;
end $$;

create or replace function public.fn_transferencia_cancelar(p_id bigint, p_usuario bigint, p_funcionario bigint default null)
returns boolean language plpgsql set search_path = public as $$
declare t transferencias%rowtype; b barris%rowtype; dnome text; v_func text;
begin
  select * into t from transferencias where id = p_id for update;
  if not found or t.status <> 'pendente' then raise exception 'Transferência não está pendente.'; end if;
  select * into b from barris where id = t.barril_id for update;
  select nome into v_func from funcionarios where id = p_funcionario;
  update barris set status = 'disponivel' where id = b.id;
  update transferencias set status = 'cancelada', resolvido_em = now() where id = t.id;
  select nome into dnome from unidades where id = t.destino_id;
  insert into movimentacoes (barril_id, operacao, usuario_id, funcionario_id, origem_unidade_id, observacao)
    values (b.id, 'transferencia', p_usuario, p_funcionario, t.origem_id,
            'Transferência para ' || dnome || ' cancelada. O barril continua na origem.');
  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'transferencia_cancelada', 'Barril #' || b.codigo || coalesce(' · funcionário ' || v_func, ''));
  return true;
end $$;

-- 4) Detalhe do Relatório de barris: quem engatou e quem retirou -------------------
-- Mesma assinatura e mesmo tipo (json): só ganha os campos engatado_por e retirado_por
-- (o funcionário; sem funcionário, o nome do usuário).
create or replace function public.fn_relatorio_barris_detalhe(p_unidades bigint[], p_de timestamptz, p_ate timestamptz,
                                                              p_chope bigint, p_estilo text, p_chope_nome text)
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
    left join unidades u on u.id = p.unidade_id
    left join funcionarios fe on fe.id = p.engatado_func_id
    left join usuarios ue on ue.id = p.engatado_por
    left join funcionarios fr on fr.id = p.retirado_func_id
    left join usuarios ur on ur.id = p.retirado_por
   where p.engatado_em >= p_de and p.engatado_em < p_ate
     and case when p_chope is not null then b.chope_id = p_chope
              else b.chope_id is null
                   and coalesce(btrim(b.estilo), '') = coalesce(p_estilo, '')
                   and coalesce(btrim(b.chope_nome), '') = coalesce(p_chope_nome, '') end
$$;

-- Permissões: as funções só podem ser executadas pelo servidor (service_role)
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('fn_barril_entrada', 'fn_barril_engatar', 'fn_barril_esgotar', 'fn_barris_recolher',
                                'fn_transferencia_criar', 'fn_transferencia_confirmar', 'fn_transferencia_cancelar',
                                'fn_relatorio_barris_detalhe') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as tabelas, colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional): cada função com uma versão só, já com p_funcionario
-- select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace
--   and p.proname in ('fn_barril_entrada', 'fn_barril_engatar', 'fn_barril_esgotar', 'fn_barris_recolher',
--                     'fn_transferencia_criar', 'fn_transferencia_confirmar', 'fn_transferencia_cancelar');
