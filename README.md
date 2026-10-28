# BarrilFacil — controle de barris de chopp

## Como funciona

```
 Tablet / tela / PC da unidade A ─┐
 Tablet / tela / PC da unidade B ─┼──►  SERVIDOR (Node.js)  ──►  BANCO (Supabase)
 Celular / PC do administrador   ─┘
```

Os dados ficam **no Supabase**, não nos aparelhos nem na máquina do servidor. Por isso as transferências entre unidades,
o histórico e o painel do administrador funcionam para todos ao mesmo tempo. Cada aparelho só precisa abrir o endereço
do servidor.

Cada unidade só enxerga o próprio estoque. O administrador libera quais unidades cada pessoa pode acessar.

## 1) Testar o servidor no seu computador

1. Instale o **Node.js 18 ou superior** (https://nodejs.org).
2. Na pasta do projeto, copie `.env.example` para `.env` e preencha `SUPABASE_URL` (Supabase > *Project Settings* >
   *Data API*) e `SUPABASE_SECRET_KEY` (*Project Settings* > *API Keys* > *Secret keys*). O `.env` nunca vai para o repositório.
   Use um banco de testes, nunca o das lojas.
3. Rode:
   ```
   npm install --omit=dev
   npm run server
   ```
   (no Windows você também pode dar dois cliques em `iniciar-servidor.bat`)
4. Abra **http://localhost:3000**. Se o banco ainda não tem usuários, aparece a *Configuração inicial*: crie o administrador.

### Variáveis do `.env`

O modelo comentado está em `.env.example`. Só as duas primeiras são obrigatórias.

| Variável | Para que serve |
|---|---|
| `SUPABASE_URL` | Endereço do projeto no Supabase (sem `/rest/v1`). |
| `SUPABASE_SECRET_KEY` | Chave secreta do Supabase. Só o servidor usa. |
| `APP_TZ` | Fuso da operação (padrão `America/Cuiaba`). Usado para mostrar data e hora e para as datas "de hoje". |
| `NOME_FORNECEDOR` | Quem entrega os barris; aparece como origem das entradas no histórico (padrão "Fornecedor"). |
| `APP_ENV` | `beta` no servidor de testes: todas as telas mostram a faixa amarela "AMBIENTE DE TESTES" e a aba ganha "[TESTE]". Vazio no servidor das lojas. |
| `PORT`, `HOST`, `TRUST_PROXY` | Porta (padrão 3000), endereço de escuta (padrão 0.0.0.0) e `1` atrás do Caddy. No servidor Linux já vêm do serviço `deploy/barrilfacil.service`; não coloque no `.env` de lá, porque ele passaria por cima. |

## 2) Colocar o servidor no ar (VM Linux na Oracle Cloud)

O servidor precisa ficar **ligado o tempo todo** e acessível pela internet, com **HTTPS** (cadeado). O caminho usado é uma
máquina virtual Ubuntu na Oracle Cloud (região São Paulo), com o serviço `systemd` e o Caddy na frente.

```
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs caddy
sudo useradd --system --home /opt/barrilfacil --shell /usr/sbin/nologin barrilfacil
sudo git clone https://github.com/Pistrano/meu-chopp /opt/barrilfacil
sudo git config --system --add safe.directory /opt/barrilfacil
cd /opt/barrilfacil && sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env      # preencha SUPABASE_URL e SUPABASE_SECRET_KEY
sudo chown -R barrilfacil:barrilfacil /opt/barrilfacil && sudo chmod 600 /opt/barrilfacil/.env
sudo cp deploy/barrilfacil.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now barrilfacil
curl -s http://127.0.0.1:3000/healthz            # deve responder "BarrilFacil ok"
```

Na Oracle, libere as portas 80 e 443 na *Security List* da rede e também no firewall do Ubuntu:

```
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT
sudo netfilter-persistent save
```

HTTPS com **Caddy** (certificado automático): coloque o conteúdo de `deploy/Caddyfile` em `/etc/caddy/Caddyfile`, troque
o domínio de exemplo pelo de vocês e rode `sudo systemctl reload caddy`. O DNS do domínio precisa apontar para o IP da máquina.

Para atualizar depois do merge de um PR:

```
cd /opt/barrilfacil && sudo git pull && sudo npm ci --omit=dev && sudo chown -R barrilfacil:barrilfacil /opt/barrilfacil && sudo systemctl restart barrilfacil
```

Se o PR tiver um arquivo novo em `supabase/migrations/`, rode esse SQL no Supabase **antes** de atualizar o servidor.

**Importante:** sem HTTPS o sistema funciona, mas as senhas viajam sem proteção e o tablet não permite "instalar" o app.
Não coloque na internet sem HTTPS.

## 3) Instalar nos aparelhos das unidades

- **Tablet Android / celular:** abra o endereço no Chrome > menu ⋮ > *Instalar app* (ou *Adicionar à tela inicial*).
- **iPad / iPhone:** abra no Safari > Compartilhar > *Adicionar à Tela de Início*.
- **PC ou tablet Windows:** use o aplicativo `BarrilFacil-Setup-<versão>.exe` (gere com `npm run dist`). Na primeira abertura ele
  pede o endereço do servidor. Marque *Abrir em tela cheia* para deixar a tela da unidade travada no sistema (F11 alterna;
  tecla Alt abre o menu com *Alterar servidor*). Também funciona só pelo navegador.

### Atualização automática do aplicativo Windows

As telas vêm do servidor, então **mudanças nas telas chegam sozinhas** a todos os aparelhos assim que o servidor é atualizado
(basta recarregar; veja *Velocidade e cache*). A atualização automática do aplicativo serve só para o "casco" do Windows (janela, menu, ícone, tela de conexão).

O aplicativo instalado procura versão nova 10 segundos depois de abrir e a cada 6 horas, baixa em segundo plano e **avisa**
("Reiniciar agora" / "Depois"). Se a pessoa escolher *Depois*, instala quando o aplicativo for fechado. Nunca reinicia sozinho
no meio do uso. No menu (tecla Alt) há *Verificar atualizações…* e a versão instalada.

Para publicar uma versão nova do aplicativo (o repositório no GitHub precisa ser público):

1. Uma única vez, na pasta do projeto: `npm install electron-updater` (atualiza o `package.json` e o `package-lock.json`; faça o commit dos dois).
2. Aumente o `"version"` no `package.json` (ex.: `2.0.0` para `2.0.1`).
3. Gere um token do GitHub com permissão de escrita em *Contents* e rode (PowerShell):
   ```
   $env:GH_TOKEN="seu_token"; npm run dist:publicar
   ```
4. No GitHub, abra *Releases*, confira o rascunho criado e clique em **Publish release**. Só depois disso os aparelhos enxergam a versão.

Os aparelhos que já têm o aplicativo instalado **sem** essa função precisam instalar uma vez o novo `.exe` à mão; dali em diante atualizam sozinhos.

Sem internet o sistema não abre dados (aparece o aviso *Sem conexão* e ele tenta de novo sozinho). Nada se perde: o que já foi
registrado está no banco.

## 4) Dados

- Todos os dados ficam no **Supabase** (o projeto configurado no `.env`). O servidor não guarda nada em disco.
- O schema do banco está em `supabase/migrations/`. Cada mudança de banco vem num arquivo novo nessa pasta, que é rodado
  à mão no *SQL Editor* do Supabase antes do merge do PR que depende dele.

## Menu

- Abas principais, sempre visíveis: **Painel**, **Barris**, **Torneiras** e **Histórico**.
- O botão **Mais** abre as outras telas: Chopes, Relatório de barris, Transferências, Funcionários (administrador e gerente) e,
  para o administrador, Unidades e Usuários.
  Quando a tela aberta está dentro do Mais, o botão fica destacado com o nome dela. Toda tela nova entra no Mais por padrão
  (em `src/renderer/js/layout.js`, `principal: true` coloca uma tela nas abas principais).
- Clicar na logo leva ao Painel. Depois do login, o sistema abre no Painel.
- No celular e no tablet, o menu fica numa barra embaixo e o Mais vira ☰.

## Cargos e permissões

Três cargos. O dia a dia (barris, engates e retiradas, transferências, histórico e Relatório de barris) é de todos;
o resto depende da permissão do cargo:

| Permissão | Administrador | Gerente | Operador |
|---|:-:|:-:|:-:|
| `usuarios`: criar, trocar cargo, desativar e apagar usuários | ✓ | | |
| `unidades`: aba Unidades e cadastro de torneiras | ✓ | | |
| `auditoria`: aba Auditoria do sistema, no Histórico | ✓ | | |
| `exportar`: CSV de estoque, de movimentações e do Relatório de barris | ✓ | | |
| `catalogo:editar`: editar, desativar, reativar e apagar chopes e estilos | ✓ | ✓ | |
| `funcionarios`: funcionários do quiosque | ✓ | ✓ | |
| Unidades que vê | todas | as liberadas | as liberadas |

- A tabela fica num lugar só: `PERMISSOES` em `src/server/api.js`. As rotas pedem uma permissão com
  `handle(canal, fn, { perm: "exportar" })` e respondem *Você não tem permissão para esta ação.* para quem não tem.
- As telas perguntam com `MC.pode("exportar")` (a lista vem do servidor no login). Botão com `data-perm="exportar"`
  some sozinho para quem não tem; item do menu com `perm` também, e a tela manda de volta para o Painel.

## Conforto de uso

- **Tema claro/escuro:** menu do usuário (canto superior direito) > *Tema*. Alterna entre *Automático* (segue o Windows ou o
  navegador), *Claro* e *Escuro*. A escolha fica só naquele aparelho. As cores do escuro estão em `src/renderer/css/tema-escuro.css`
  e a lógica em `src/renderer/js/tema.js`. Tela nova: use sempre as variáveis `--mc-*` (nunca cor fixa) e ela já funciona nos dois temas.
- **Painel atualizado automaticamente:** o resumo e as movimentações recentes são recarregados a cada minuto e quando a tela volta a ficar visível.
- **Confirmações de ações importantes:** transferências, recolhimento de barris, desativação de usuários/unidades/torneiras/funcionários, apagar usuário, estilo ou chope e geração de senha temporária pedem confirmação antes de alterar os dados. No celular do quiosque, o cadastro de barril também pede confirmação, junto com a escolha de quem está fazendo.
- **Painel:** os cartões de estoque abrem a lista de barris já filtrada pela situação. O sino atualiza os alertas a cada minuto e avisa quando um chope em operação tem 2 ou menos barris disponíveis na unidade.
- **Relatório de estoque:** na aba Barris, *Exportar estoque (CSV)* (só administrador) baixa os barris em operação com chope, tamanho, situação, validade, unidade, torneira e o funcionário da última ação.
- **Ordenar tabelas:** clique no título da coluna (Barris, Histórico, Transferências, Usuários e Relatório de barris). Primeiro clique ordena de forma
  crescente, o segundo decrescente, o terceiro volta à ordem original. Campos vazios ficam sempre no fim. No Histórico a ordem vale
  para as linhas carregadas (até 300), não para o banco inteiro.
- **Filtros lembrados:** a busca e o filtro de Barris e do Histórico, e a ordem escolhida, continuam ao trocar de aba e voltar.
  Ficam só enquanto a janela estiver aberta e são apagados ao entrar e ao sair do sistema. Para usar em outra tela, chame
  `MC.rememberFields("nome-da-tela", { q, status })` antes da primeira carga e `MC.sortable(tabela, colunas, opções)` ao desenhar a lista.

## Velocidade e cache

A troca de abas não baixa de novo CSS e JS. Cada aba continua sendo uma página separada, mas:

- **Arquivos versionados:** ao iniciar, o servidor calcula uma versão curta (hash do conteúdo de `src/renderer/js`, `css`,
  `vendor` e `assets`) e, ao entregar um `.html`, acrescenta `?v=<versão>` aos `<script src>` e `<link href>` locais.
  Ninguém escreve versão à mão. Arquivo pedido com a versão atual vai com cache de 1 ano (`immutable`); sem versão, com
  versão antiga e as páginas `.html` continuam `no-cache`, com ETag e resposta 304 quando não mudou. Como a versão só é
  calculada ao iniciar, **depois de mudar arquivos das telas, reinicie o servidor** (o deploy já reinicia).
- **Service worker** (`src/renderer/sw.js`): arquivo com `?v=` e as fontes saem do cache primeiro; páginas vão à rede
  primeiro, com a cópia guardada como reserva; `/api/*` e `/healthz` sempre na rede. Na instalação ele já guarda o que toda
  tela usa. O servidor põe a versão no `sw.js` (`__VERSAO__`): cada versão tem o próprio cache e o anterior é apagado.
- **Fontes locais:** Manrope e Sora em `src/renderer/assets/fonts/` (woff2, `font-display: swap`), sem Google Fonts.
- **Topo numa chamada só:** `session:bootstrap` devolve usuário, unidades e config de uma vez (`auth:me`, `units:list` e
  `config:get` continuam). O `layout.js` guarda o resultado por 60 s na janela (`sessionStorage`), desenha o topo na hora
  com ele e confere com o servidor em seguida: se o cargo ou as unidades mudaram, a tela abre de novo com os dados novos;
  sessão encerrada vai para o login. Os alertas carregam em paralelo.
- **Servidor:** as unidades liberadas de cada sessão ficam em memória com a sessão (60 s; trocar acesso, cargo ou
  ativar/desativar/criar unidade limpa na hora). Os alertas consultam em paralelo e as torneiras trazem só o engate em andamento.
- **Transição e pré-carregamento** (Chrome e o app do Windows): a troca de página não pisca em branco (`@view-transition`)
  e as abas do menu são pré-carregadas (`speculationrules`, prefetch) quando o mouse passa ou o dedo encosta no link.
- **Medir:** toda resposta de `/api/*` traz `Server-Timing: app;dur=<ms>` (DevTools > Network > Timing) e chamadas acima
  de 300 ms vão para o log do servidor (`[lento] canal 412 ms`; na VM: `journalctl -u barrilfacil | grep lento`).

## Unidades e torneiras

- Aba **Unidades** (administrador): cadastro com razão social, nome fantasia, nome curto (opcional, aparece no seletor
  de unidade), CNPJ (numérico ou alfanumérico, com validação) e endereço, e o cadastro das torneiras de cada loja.
  O nome fantasia é o nome mostrado no app inteiro e não pode repetir. As unidades que já existiam ficam marcadas como
  *A preencher* até alguém informar a razão social, o CNPJ e o endereço reais em *Editar*.
- **Engate:** em *Barris > Engatar na torneira*, o funcionário escolhe uma torneira livre da unidade do barril.
  Sem torneira livre, o engate não é feito.
- **Retirada:** em *Barris > Retirar barril*, o sistema usa a torneira registrada no engate e a libera.
  O barril retirado fica *Vazio* (aguardando recolhimento).
- O histórico guarda o número da torneira usado em cada operação; renumerar ou desativar uma torneira não muda o passado.
- Aba **Torneiras** (todos os usuários com acesso à unidade): um cartão por torneira ativa, com o chope engatado, desde
  quando e por quem. Cada cartão tem dois botões:
  - Torneira livre: **Engatar barril** abre a lista dos barris disponíveis da unidade (o que vence primeiro fica em cima,
    com busca por código, chope ou estilo). Barril vencido pede a mesma confirmação da aba Barris.
  - Torneira ocupada: **Retirar barril**, com a mesma confirmação e o mesmo aviso da aba Barris. O barril fica *Vazio*.
  - **Histórico**: os engates daquela torneira.
- A tela se atualiza sozinha a cada minuto, menos enquanto uma janela estiver aberta. Se outro aparelho usou a torneira ou o
  barril nesse meio tempo, aparece o motivo e o quadro é recarregado.
- Engatar e retirar ficam num só lugar, `src/renderer/js/acoes-barril.js` (`MCBarril.engatar` e `MCBarril.retirar`),
  usado pelas abas Barris e Torneiras.

## Validade e recolhimento

- **Validade:** no cadastro do barril, a data de validade é obrigatória e começa em branco (a pessoa confere a data no
  barril; normalmente são 5 dias a partir da chegada). Não aceita data no passado. A lista de barris e a aba Torneiras
  mostram um selo amarelo quando o barril vence hoje ou amanhã e vermelho quando já venceu. O sino de alertas avisa
  os mesmos casos, com os vencidos primeiro.
- O sistema **só avisa, nunca bloqueia**: ao engatar um barril vencido, ele pede confirmação ("Engatar mesmo assim?").
  O engate confirmado fica registrado na *Auditoria* como `engate_barril_vencido`.
- **Recolhimento:** os barris vazios esperam a fábrica. Em *Barris > Registrar recolhimento*, marque os vasilhames que
  estão sendo levados (ou *Marcar todos*) e confirme. Eles passam para *Recolhido* e saem da lista (o filtro *Recolhidos*
  mostra o histórico). Se o mesmo vasilhame voltar, é um cadastro novo com o mesmo código.
- O Painel mostra quantos barris estão *Vazios para recolher*, e o sino avisa quando um vazio espera há mais de 3 dias.
- Datas "de hoje" seguem o fuso `APP_TZ` (padrão `America/Cuiaba`), nunca o horário UTC do servidor.

## Relatório de barris

- Em **Mais > Relatório de barris** (ou no botão *Relatório de barris* do Painel, que abre em *Este mês*). Todos os usuários
  abrem, cada um vê só as unidades liberadas para ele (uma unidade ou *Todas as minhas*).
- Período: atalhos *Hoje*, *Últimos 7 dias*, *Este mês* e *Mês passado*, ou as datas *De* e *Até* (os dois dias entram inteiros,
  no fuso `APP_TZ`). Até 400 dias.
- Uma linha por chope, agrupada por estilo, com o total de cada estilo e o total geral:
  - **Recebidos:** barris cadastrados na unidade no período (transferência recebida não conta).
  - **Utilizados** e **Litros utilizados:** barris engatados pela **primeira vez** no período. O barril engatado em 30/09 e
    esvaziado em 02/10 conta só em setembro.
  - **Esvaziados** e **Recolhidos:** retiradas e recolhimentos feitos no período.
  - **Situação agora:** em estoque, engatados, vazios aguardando recolhimento e em transferência, com a hora da consulta.
- Tudo é contado por barril (cada cadastro é um ciclo), nunca pelo código, que se repete quando o vasilhame volta.
- Clicar no nome do chope mostra os barris utilizados no período, com quem engatou e quem retirou (coluna *Funcionário*).
  *Exportar CSV* e *Imprimir* saem com o período e a unidade; o CSV termina com o bloco *Barris utilizados no período*,
  um barril por linha, com o funcionário do engate e o da retirada.
- As contas ficam no banco, nas funções `fn_relatorio_barris` e `fn_relatorio_barris_detalhe`
  (`supabase/migrations/20261023000000_relatorio_barris.sql`).

## Chopes e estilos

- O barril é cadastrado escolhendo um **chope** do catálogo (ex.: *German Pilsen · Pilsen*). Se o chope ainda não existe,
  a opção *+ Cadastrar novo chope…* cria o chope (e, se precisar, o estilo) sem sair da tela.
- Aba **Chopes** (todos): lista do catálogo e cadastro de chopes e estilos novos. Editar, desativar e reativar são do
  administrador e do gerente. Renomear atualiza os barris daquele chope/estilo; desativar só tira o chope do cadastro de barris novos
  (os barris antigos continuam com ele).
- **Apagar** (administrador e gerente), para o que foi cadastrado errado, sem perder histórico:
  - Chope: só apaga se nenhum barril usa o chope. Se algum usa, o app avisa quantos e sugere desativar ou editar o nome.
  - Estilo sem chopes: só confirma. Estilo com chopes (ativos ou não): escolha para qual estilo ativo os chopes vão.
    Os barris desses chopes passam a mostrar o estilo novo, inclusive no histórico e no Relatório de barris.
    Barris antigos cadastrados sem chope do catálogo não mudam.

## Usuários

- Aba **Usuários** (administrador): cria a conta com uma senha temporária, escolhe o cargo e as unidades de gerentes e operadores.
- **Cargo:** troca o cargo de outra pessoa (ninguém troca o próprio). Gerente e operador precisam de ao menos uma unidade.
  Vale na próxima ação da pessoa, sem precisar sair; o menu novo aparece na próxima tela que ela abrir.
- **Apagar:** para contas criadas por engano (por exemplo, com e-mail errado). Sem histórico, só confirma. Com histórico
  (engates, movimentações ou transferências), o histórico passa para a outra conta da mesma pessoa, escolhida na hora; o
  Histórico passa a mostrar o nome dela. Quem saiu da empresa deve ser **desativado**, não apagado. Tudo é feito de uma vez
  pela função `fn_usuario_apagar` (`supabase/migrations/20261027100000_cargo_gerente_apagar_usuario.sql`).
- O sistema nunca fica sem administrador ativo: o último não pode ser apagado, desativado nem perder o cargo.

## Funcionários do quiosque

Em cada loja o app fica num celular do quiosque, logado numa conta de **operador** compartilhada. Para saber quem fez
cada ação sem dar login a cada pessoa, a loja cadastra os funcionários e a pessoa toca no próprio nome antes de salvar.

- Tela **Mais > Funcionários** (administrador e gerente): lista da unidade aberta no cabeçalho, cadastro (nome e
  unidades onde trabalha), editar, desativar e reativar. O gerente só vê e cadastra nas unidades liberadas para ele.
  Funcionário não é apagado, só desativado: o histórico dele continua guardado. O nome não pode repetir (use o sobrenome).
- **"Quem está fazendo?"**: no cadastro de barril, engatar, retirar, recolher vazios e criar, confirmar ou cancelar
  transferência, a confirmação mostra uma grade de botões grandes com os funcionários ativos da unidade, em ordem
  alfabética. O último nome usado naquele aparelho nos últimos 30 minutos vem primeiro, destacado, mas ainda precisa ser
  tocado. O botão de confirmar só habilita depois da escolha. O componente é um só, `MC.escolherFuncionario(unitId)` em
  `src/renderer/js/common.js` (`MC.dialog` e `MC.confirm` aceitam `{ funcionario }`).
- Só contas de **operador** escolhem. Administrador e gerente usam conta pessoal: a ação fica no nome da conta, sem perguntar.
- Unidade **sem funcionário ativo**: a escolha não aparece (a loja não trava) e o Painel avisa o administrador e o gerente:
  *Cadastre os funcionários de &lt;unidade&gt; em Mais > Funcionários para saber quem fez cada ação.*
- O servidor confere de novo: operador numa unidade com funcionários ativos precisa mandar um funcionário ativo e
  cadastrado na unidade da ação (no recebimento de transferência, a unidade de destino).
- **Onde aparece:** a coluna *Quem fez* do Histórico, as movimentações recentes do Painel, o cartão e o histórico de
  cada torneira (*por …*, *Retirado em … por …*) e as transferências mostram o funcionário; sem funcionário, o nome da
  conta, como antes. O Histórico tem filtro por funcionário (quem cadastra vê também os desativados).
- **CSV:** o do Histórico mantém *Responsável* (a conta logada) e ganha a coluna *Funcionário*; o do estoque traz o
  funcionário da última ação; o do Relatório de barris, o do engate e o da retirada.
- Banco: tabelas `funcionarios` e `funcionario_unidades` e as colunas `funcionario_id` (movimentações),
  `engatado_func_id`/`retirado_func_id` (engates) e `solicitante_func_id`/`recebedor_func_id` (transferências), em
  `supabase/migrations/20261028000000_funcionarios_quem_fez.sql`.

## Rodar os testes

Os testes automáticos (`tests/`) sobem o servidor de verdade e usam um **Supabase local**, no seu computador. Eles apagam
todas as tabelas antes de começar, por isso só aceitam um endereço local (`127.0.0.1`/`localhost`): nunca aponte para o
banco das lojas nem para o de testes do beta. Precisa do Node.js 20 ou superior.

1. Instale o **Docker Desktop** (https://www.docker.com/products/docker-desktop) e deixe-o aberto.
2. Na pasta do projeto, instale as dependências e suba o Supabase local (a primeira vez demora, porque baixa as imagens):
   ```
   npm install --omit=dev
   npx supabase start
   ```
   Ele aplica as migrations de `supabase/migrations/` e, no fim, mostra o endereço (`API URL`, normalmente
   `http://127.0.0.1:54321`) e a chave secreta (`Secret key`, que começa com `sb_secret_`; em versões antigas aparece
   como `service_role key`).
3. Copie esses dois valores para as variáveis `TEST_SUPABASE_URL` e `TEST_SUPABASE_SECRET_KEY` e rode `npm test`.
   No PowerShell:
   ```
   $env:TEST_SUPABASE_URL="http://127.0.0.1:54321"; $env:TEST_SUPABASE_SECRET_KEY="sb_secret_..."; npm test
   ```
   No Linux/macOS: `TEST_SUPABASE_URL=http://127.0.0.1:54321 TEST_SUPABASE_SECRET_KEY=sb_secret_... npm test`

Sem as duas variáveis, os testes são pulados com um aviso. Depois de mudar alguma migration, `npx supabase db reset`
recria o banco local do zero. `npx supabase stop` desliga o Supabase local.

## Segurança

- Entrada com e-mail e senha forte (8+ caracteres, letras e números); sem senha padrão.
- 5 tentativas erradas bloqueiam a conta por 15 minutos; também há limite de tentativas por aparelho.
- A sessão expira após 15 minutos sem uso para administrador e gerente, e após 12 horas para o operador (o celular do
  quiosque fica o dia todo aberto). Os dois valores são `IDLE_MS` e `IDLE_OPERADOR_MS`, no topo de `src/server/api.js`.
  Cada aparelho tem a própria sessão (cookie protegido). As sessões ficam no banco (tabela `sessoes`, só com o hash do
  token), então atualizar o servidor não desloga ninguém. Desativar um usuário ou gerar uma senha temporária derruba as
  sessões dele (apagar também); trocar a própria senha derruba as dos outros aparelhos.
- Cada unidade é isolada: o servidor confere a permissão a cada ação. Tentativas indevidas ficam na *Auditoria*.
- O banco só é acessado pelo servidor, com a chave secreta. As tabelas têm RLS ligado e as funções SQL só podem ser
  executadas pelo servidor.
- Proteções do servidor: cabeçalhos de segurança, bloqueio de pedidos vindos de outros sites e de acesso a arquivos internos.
  A Content-Security-Policy só permite arquivos do próprio servidor (as fontes também); o único script inline aceito são
  as regras de pré-carregamento (`'inline-speculation-rules'`).
- Esqueceu a senha? O administrador gera uma senha temporária em *Usuários*.

## Estrutura

- `src/server/` — servidor e regras (`server.js`, `api.js`, `supabase.js`)
- `src/renderer/` — as telas (servidas pelo servidor)
- `src/main/` — aplicativo Windows (só abre o servidor em uma janela)
- `supabase/migrations/` — schema e mudanças do banco (`supabase/config.toml` é do Supabase local dos testes)
- `tests/` — testes automáticos (veja *Rodar os testes*)
- `deploy/` — arquivos de implantação (Linux + HTTPS)
