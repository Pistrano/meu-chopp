-- ==========================================================
-- BarrilFacil — lançar engate e retirada com o horário em que aconteceram (aba Torneiras, "Lançar com horário")
-- Rodar à mão no SQL Editor do Supabase ANTES do deploy: primeiro no BarrilFacil-Beta, depois no BarrilFacil-Lojas.
-- Roda depois do SQL das vendas da Teknisa (20261118300000_vendas_teknisa.sql).
-- Pode rodar mais de uma vez.
--
-- O que faz:
--   - engates: engate_lancado_por, engate_lancado_em, retirada_lancada_por, retirada_lancada_em (nulas = lançado na
--     hora, como sempre foi);
--   - movimentacoes.lancado_em e pesagens.lancado_em (nula = lançado na hora): o Histórico mostra "horário informado";
--     índice mov_criado_idx para o Histórico, que passa a ordenar pelo horário da movimentação;
--   - fn_lancamento_com_horario: troca de barril, só retirada (vazia ou com chope) ou só engate numa transação só, com o
--     horário informado. Usa por dentro fn_barril_esgotar, fn_barril_retirar_com_chope e fn_barril_engatar (que não
--     mudam) e depois acerta os horários das linhas criadas. Grava a auditoria "lancamento_com_horario";
--   - fn_barril_ultimo_registro (o último registro do barril, com o texto para as mensagens) e fn_dia_hora_texto;
--   - fn_usuario_apagar passa a levar também os lançamentos com horário do usuário apagado.
--
-- Não apaga nem muda nenhum dado que já existe. O servidor antigo continua funcionando depois deste SQL.
-- ==========================================================
begin;

-- 1) Colunas de "lançado com horário" -----------------------------------------------------------
alter table public.engates add column if not exists engate_lancado_por bigint references public.usuarios (id);
alter table public.engates add column if not exists engate_lancado_em timestamptz;
alter table public.engates add column if not exists retirada_lancada_por bigint references public.usuarios (id);
alter table public.engates add column if not exists retirada_lancada_em timestamptz;
create index if not exists engates_engate_lancado_por_idx on public.engates (engate_lancado_por) where engate_lancado_por is not null;
create index if not exists engates_retirada_lancada_por_idx on public.engates (retirada_lancada_por) where retirada_lancada_por is not null;

alter table public.movimentacoes add column if not exists lancado_em timestamptz;
alter table public.pesagens add column if not exists lancado_em timestamptz;
-- o Histórico passa a ordenar pelo horário da movimentação (um lançamento com horário entra no lugar certo)
create index if not exists mov_criado_idx on public.movimentacoes (criado_em desc, id desc);

-- 2) Textos de data e o último registro do barril ------------------------------------------------
-- '25/11 às 23:10' no fuso da operação
create or replace function public.fn_dia_hora_texto(p timestamptz, p_tz text default 'America/Cuiaba')
returns text language sql stable set search_path = public as $$
  select to_char(p at time zone p_tz, 'DD/MM "às" HH24:MI')
$$;

/* O último registro do barril: movimentação (entrada, transferência, engate, retirada, pesagem, recolhimento), pesagem
   ou o cadastro. Um horário informado (engate ou retirada) não pode ficar antes dele. texto: "foi pesado no inventário de
   25/11 às 22:30", "deu entrada em 23/11 às 09:00"... pesagem: o último registro é uma pesagem. */
create or replace function public.fn_barril_ultimo_registro(p_barril bigint, p_tz text default 'America/Cuiaba',
                                                            out quando timestamptz, out texto text, out pesagem boolean)
language sql stable set search_path = public as $$
  select x.quando, x.texto, x.pesagem
    from (
      select m.criado_em as quando, m.id as ordem,
             case m.operacao
               when 'entrada' then case when m.observacao = 'Recebimento de transferência' then 'chegou por transferência em '
                                        else 'deu entrada em ' end
               when 'transferencia' then case when m.observacao like 'Transferência para % cancelada%' then 'teve a transferência cancelada em '
                                              else 'foi enviado para outra unidade em ' end
               when 'utilizacao' then 'foi engatado' || coalesce(' na Torneira ' || m.torneira_numero, '') || ' em '
               when 'esgotado' then 'foi retirado' || coalesce(' da Torneira ' || m.torneira_numero, '') || ' em '
               when 'retirada_com_chope' then 'foi retirado' || coalesce(' da Torneira ' || m.torneira_numero, '') || ' em '
               when 'pesagem' then case when p.motivo = 'inventario' then 'foi pesado no inventário de ' else 'foi pesado em ' end
               when 'recolhimento' then 'foi recolhido em '
               else 'tem um registro em '
             end || fn_dia_hora_texto(m.criado_em, p_tz) as texto,
             m.operacao = 'pesagem' as pesagem
        from movimentacoes m left join pesagens p on p.id = m.pesagem_id
       where m.barril_id = p_barril
      union all
      select p.criado_em, 0,
             case when p.motivo = 'inventario' then 'foi pesado no inventário de ' else 'foi pesado em ' end
             || fn_dia_hora_texto(p.criado_em, p_tz), true
        from pesagens p
       where p.barril_id = p_barril and not exists (select 1 from movimentacoes m where m.pesagem_id = p.id)
      union all
      select b.criado_em, -1, 'deu entrada em ' || fn_dia_hora_texto(b.criado_em, p_tz), false
        from barris b where b.id = p_barril
    ) x
   order by x.quando desc, x.ordem desc
   limit 1
$$;

-- 3) Lançar com horário --------------------------------------------------------------------------
/* Troca de barril (retirada + engate), só retirada ou só engate, com o horário em que aconteceu.
   p_tipo: 'troca' | 'retirada' | 'engate'. p_funcionario: quem fez (nulo = "Não sei"); tem de estar ativo e cadastrado
   na unidade da torneira. p_usuario: quem lançou (fica nas colunas *_lancad*_por e na auditoria).
   Retirada: p_ret_quando; p_ret_vazio = true (vazio) ou false (com chope: p_metodo e os campos da medida, como em
   fn_barril_retirar_com_chope, inclusive o aviso QUASE_VAZIO). Engate: p_eng_barril e p_eng_quando.
   Regras: nada no futuro nem de mais de 30 dias atrás; a retirada depois do engate do barril e do último registro dele
   (pesagem de inventário, por exemplo); o engate depois do último registro do barril que entra e, numa torneira livre,
   depois da última retirada dela; na troca, o engate no mesmo horário da retirada ou depois.
   Erro de um campo leva o hint CAMPO:<ret|eng|barril|torneira|funcionario> (a tela marca o campo). */
create or replace function public.fn_lancamento_com_horario(p_torneira bigint, p_usuario bigint, p_funcionario bigint, p_tipo text,
                                                            p_ret_quando timestamptz, p_ret_vazio boolean,
                                                            p_metodo text, p_peso_bruto numeric, p_tara bigint, p_nivel int,
                                                            p_densidade numeric, p_tara_nova numeric,
                                                            p_eng_barril bigint, p_eng_quando timestamptz,
                                                            p_tz text default 'America/Cuiaba')
returns json language plpgsql set search_path = public as $$
declare
  t torneiras%rowtype; e engates%rowtype; b barris%rowtype; nb barris%rowtype; f funcionarios%rowtype;
  un text; v_agora timestamptz := now(); v_limite timestamptz := now() - interval '30 days';
  v_tem_ret boolean := p_tipo in ('troca', 'retirada'); v_tem_eng boolean := p_tipo in ('troca', 'engate');
  v_bid bigint; v_mov bigint; v_pes bigint; u record; v_livre record; r json; v_txt text := ''; v_ret json; v_eng json;
  v_litros numeric; v_est boolean;
begin
  if p_tipo is null or p_tipo not in ('troca', 'retirada', 'engate') then
    raise exception 'Escolha o que aconteceu: troca de barril, só retirada ou só engate.';
  end if;

  -- Torneira e o barril que está nela agora (lidos sem trava; os barris são travados antes da torneira, como no engate)
  select * into t from torneiras where id = p_torneira;
  if not found then raise exception 'Torneira não encontrada. Atualize a tela.' using hint = 'CAMPO:torneira'; end if;
  select barril_id into v_bid from engates where torneira_id = t.id and retirado_em is null;
  perform 1 from barris where id in (v_bid, p_eng_barril) order by id for update;
  select * into t from torneiras where id = p_torneira for update;
  if not t.ativo then raise exception 'A Torneira % está desativada.', t.numero using hint = 'CAMPO:torneira'; end if;
  select * into e from engates where torneira_id = t.id and retirado_em is null;
  if e.barril_id is distinct from v_bid then
    raise exception 'A Torneira % acabou de mudar em outro aparelho. Feche a janela e tente de novo.', t.numero;
  end if;
  select nome into un from unidades where id = t.unidade_id;

  -- Quem fez
  if p_funcionario is not null then
    select * into f from funcionarios where id = p_funcionario;
    if not found then
      raise exception 'Funcionário não encontrado. Feche a janela e escolha de novo.' using hint = 'CAMPO:funcionario';
    end if;
    if not f.ativo then raise exception '% está desativado. Escolha outro nome.', f.nome using hint = 'CAMPO:funcionario'; end if;
    if not exists (select 1 from funcionario_unidades where funcionario_id = f.id and unidade_id = t.unidade_id) then
      raise exception '% não está cadastrado nesta unidade. Escolha outro nome.', f.nome using hint = 'CAMPO:funcionario';
    end if;
  end if;

  -- Retirada: confere tudo antes de gravar
  if v_tem_ret then
    if e.id is null then
      raise exception 'A Torneira % está livre, não tem barril para retirar. Escolha outra torneira ou use Só engate.', t.numero
        using hint = 'CAMPO:torneira';
    end if;
    select * into b from barris where id = e.barril_id;
    if p_ret_quando is null then raise exception 'Informe o dia e a hora da retirada.' using hint = 'CAMPO:ret'; end if;
    if p_ret_quando > v_agora then
      raise exception 'A retirada não pode ficar no futuro. Agora são %.', to_char(v_agora at time zone p_tz, 'HH24:MI')
        using hint = 'CAMPO:ret';
    end if;
    if p_ret_quando < v_limite then
      raise exception 'A retirada tem de ser dos últimos 30 dias (depois de %).', fn_dia_hora_texto(v_limite, p_tz)
        using hint = 'CAMPO:ret';
    end if;
    if p_ret_quando <= e.engatado_em then
      raise exception 'O #% foi engatado em %. A retirada tem de ser depois disso.', b.codigo, fn_dia_hora_texto(e.engatado_em, p_tz)
        using hint = 'CAMPO:ret';
    end if;
    select * into u from fn_barril_ultimo_registro(b.id, p_tz);
    if p_ret_quando <= u.quando then
      raise exception 'O #% %. A retirada tem de ser depois disso.', b.codigo,
        u.texto || case when u.pesagem then ', ainda na torneira' else '' end
        using hint = 'CAMPO:ret';
    end if;
    if p_ret_vazio is null then raise exception 'Escolha como o barril saiu: vazio ou ainda com chope.' using hint = 'CAMPO:ret'; end if;
  end if;

  -- Engate: confere tudo antes de gravar
  if v_tem_eng then
    if p_tipo = 'engate' and e.id is not null then
      raise exception 'A Torneira % está com o #%. Para pôr outro barril nela, use Troca de barril.', t.numero,
        (select codigo from barris where id = e.barril_id) using hint = 'CAMPO:torneira';
    end if;
    if p_eng_barril is null then raise exception 'Escolha o barril que foi engatado.' using hint = 'CAMPO:barril'; end if;
    select * into nb from barris where id = p_eng_barril;
    if not found then raise exception 'Barril não encontrado.' using hint = 'CAMPO:barril'; end if;
    if nb.unidade_id <> t.unidade_id then
      raise exception 'O barril #% não é desta unidade.', nb.codigo using hint = 'CAMPO:barril';
    end if;
    if nb.status <> 'disponivel' then
      raise exception 'O barril #% não pode ser engatado: está "%". Só barris disponíveis podem ser engatados.',
        nb.codigo, fn_status_texto(nb.status) using hint = 'CAMPO:barril';
    end if;
    if p_eng_quando is null then raise exception 'Informe o dia e a hora do engate.' using hint = 'CAMPO:eng'; end if;
    if p_eng_quando > v_agora then
      raise exception 'O engate não pode ficar no futuro. Agora são %.', to_char(v_agora at time zone p_tz, 'HH24:MI')
        using hint = 'CAMPO:eng';
    end if;
    if p_eng_quando < v_limite then
      raise exception 'O engate tem de ser dos últimos 30 dias (depois de %).', fn_dia_hora_texto(v_limite, p_tz)
        using hint = 'CAMPO:eng';
    end if;
    if v_tem_ret then
      if p_eng_quando < p_ret_quando then
        raise exception 'O engate tem de ser no mesmo horário da retirada ou depois dela (%).', fn_dia_hora_texto(p_ret_quando, p_tz)
          using hint = 'CAMPO:eng';
      end if;
    else
      -- Torneira livre: o engate só depois da última retirada dela (comparada no minuto, como o horário informado)
      select x.retirado_em, br.codigo into v_livre
        from engates x join barris br on br.id = x.barril_id
       where x.torneira_id = t.id and x.retirado_em is not null
       order by x.retirado_em desc, x.id desc limit 1;
      if v_livre.retirado_em is not null and p_eng_quando < date_trunc('minute', v_livre.retirado_em) then
        raise exception 'A Torneira % só ficou livre em %, quando o #% saiu. O engate tem de ser depois disso.',
          t.numero, fn_dia_hora_texto(v_livre.retirado_em, p_tz), v_livre.codigo using hint = 'CAMPO:eng';
      end if;
    end if;
    select * into u from fn_barril_ultimo_registro(nb.id, p_tz);
    if p_eng_quando <= u.quando then
      raise exception 'O #% %. O engate tem de ser depois disso.', nb.codigo,
        u.texto || case when u.pesagem then ', fora da torneira' else '' end
        using hint = 'CAMPO:eng';
    end if;
  end if;

  -- Grava a retirada pelas funções de sempre e acerta os horários das linhas criadas
  if v_tem_ret then
    select coalesce(max(id), 0) into v_mov from movimentacoes;
    select coalesce(max(id), 0) into v_pes from pesagens;
    if p_ret_vazio then
      v_ret := fn_barril_esgotar(b.id, p_usuario, p_funcionario);
      v_litros := 0; v_est := false;
    else
      v_ret := fn_barril_retirar_com_chope(b.id, p_usuario, p_funcionario, p_metodo, p_peso_bruto, p_tara, p_nivel,
                                           p_densidade, p_tara_nova);
      v_litros := (v_ret ->> 'litros')::numeric; v_est := (v_ret ->> 'estimado')::boolean;
    end if;
    update engates set retirado_em = p_ret_quando, retirada_lancada_por = p_usuario, retirada_lancada_em = v_agora where id = e.id;
    update movimentacoes set criado_em = p_ret_quando, lancado_em = v_agora where id > v_mov and barril_id = b.id;
    update pesagens set criado_em = p_ret_quando, lancado_em = v_agora where id > v_pes and barril_id = b.id;
    v_txt := format('#%s retirado %s em %s', b.codigo,
                    case when p_ret_vazio then 'vazio'
                         else 'com ' || fn_litros_texto(v_litros) || case when v_est then ' (estimado)' else ' (pesado)' end end,
                    fn_dia_hora_texto(p_ret_quando, p_tz));
  end if;

  -- Grava o engate pela função de sempre e acerta os horários
  if v_tem_eng then
    select coalesce(max(id), 0) into v_mov from movimentacoes;
    v_eng := fn_barril_engatar(nb.id, t.id, p_usuario, p_funcionario);
    update engates set engatado_em = p_eng_quando, engate_lancado_por = p_usuario, engate_lancado_em = v_agora
     where barril_id = nb.id and retirado_em is null;
    update movimentacoes set criado_em = p_eng_quando, lancado_em = v_agora where id > v_mov and barril_id = nb.id;
    v_txt := v_txt || case when v_txt <> '' then '; ' else '' end
             || format('#%s engatado em %s', nb.codigo, fn_dia_hora_texto(p_eng_quando, p_tz));
  end if;

  insert into auditoria (usuario_id, acao, detalhe)
    values (p_usuario, 'lancamento_com_horario',
            format('Torneira %s (%s): %s · ', t.numero, un, v_txt)
            || coalesce('funcionário ' || f.nome, 'funcionário não informado'));

  return json_build_object(
    'torneira', t.numero, 'unidade', un,
    'retirada', case when v_tem_ret then json_build_object(
        'codigo', b.codigo, 'quando', fn_dia_hora_texto(p_ret_quando, p_tz), 'vazio', p_ret_vazio,
        'litros', v_litros, 'estimado', v_est) end,
    'engate', case when v_tem_eng then json_build_object(
        'codigo', nb.codigo, 'quando', fn_dia_hora_texto(p_eng_quando, p_tz), 'validade', nb.validade) end);
end $$;

-- 4) Apagar usuário: os lançamentos com horário também passam para quem recebe o histórico -------------
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

  select count(*) into v_engates from engates
   where engatado_por = p_usuario or retirado_por = p_usuario or engate_lancado_por = p_usuario or retirada_lancada_por = p_usuario;
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
    update engates set engate_lancado_por = p_destino where engate_lancado_por = p_usuario;
    update engates set retirada_lancada_por = p_destino where retirada_lancada_por = p_usuario;
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
    update engates set engate_lancado_por = null where engate_lancado_por = p_usuario;
    update engates set retirada_lancada_por = null where retirada_lancada_por = p_usuario;
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
              and p.proname in ('fn_dia_hora_texto', 'fn_barril_ultimo_registro', 'fn_lancamento_com_horario',
                                'fn_usuario_apagar') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;

-- Faz a API do Supabase enxergar as colunas e funções novas na hora
notify pgrst, 'reload schema';

-- Conferência (opcional):
-- select column_name from information_schema.columns
--  where table_schema = 'public' and table_name = 'engates' and column_name like '%lancad%';   -- 4 linhas
-- select count(*) from pg_proc where proname = 'fn_lancamento_com_horario';                    -- 1
