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
- O botão **Mais** abre as outras telas: Chopes, Relatório de barris, Transferências, Pesagem, Vendas e
  Funcionários (administrador e gerente) e, para o administrador, Unidades e Usuários.
  Quando a tela aberta está dentro do Mais, o botão fica destacado com o nome dela. Toda tela nova entra no Mais por padrão
  (em `src/renderer/js/layout.js`, `principal: true` coloca uma tela nas abas principais).
- Clicar na logo leva ao Painel. Depois do login, o sistema abre no Painel.
- No celular e no tablet, o menu fica numa barra embaixo e o Mais vira ☰.

## Painel

O Painel tem duas versões na mesma página (`src/renderer/dashboard.html` e `js/dashboard.js`). O CSS mostra uma ou a
outra pela largura da tela, e girar o tablet ou mudar o tamanho da janela troca a versão sem recarregar.

- **Computador** (1024 px ou mais): a saudação, o botão *Relatório de barris*, os cinco cartões de estoque e as
  movimentações recentes.
- **Celular e tablet** (menos de 1024 px): uma tela de ações rápidas para o funcionário do quiosque. É igual para todos
  os cargos e **não mostra perda nem dinheiro**, porque o celular do quiosque é usado por qualquer funcionário.
  - **Faixa escura** logo abaixo do topo, com *Olá, nome* e a unidade. Quem tem mais de uma unidade troca por ali, com a
    mesma troca do topo.
  - **Quatro botões grandes** na faixa:
    - **Engatar** abre a janela de engatar da aba Torneiras, começando pela leitura da etiqueta, com a escolha da
      torneira livre embaixo (`MCBarril.janelaEngatar`, em `acoes-barril.js`);
    - **Retirar** mostra as torneiras com barril e segue a retirada de sempre (vazio ou com chope);
    - **Receber barris** abre a aba Barris com o cursor no código do cadastro (`barris.html?cadastrar=1`);
    - **Pesar** abre *Mais > Pesagem*.
  - Sem torneira livre, sem barril disponível ou sem nada engatado, aparece a mesma mensagem das outras abas. Depois de
    engatar ou retirar, os números são recarregados.
  - **Sua loja agora**: *Disponíveis*, *Engatados* e *Vazios para recolher*. Cada linha abre a aba Barris filtrada.
  - **Precisa de atenção**: os alertas do sino, na mesma ordem, cada um com uma etiqueta curta. As cores são:
    - vermelho para *Vencido* e *Sem estoque*;
    - amarelo para *Acabando*;
    - azul para *Vence hoje*, *Vence amanhã* e as transferências;
    - neutro para os vazios.

    Aparecem no máximo 5, e *e mais N* abre o sino. Sem nenhum alerta, a caixa mostra *Tudo em ordem por aqui.* A
    versão curta vem do servidor junto com o texto do sino, em `src/server/alertas.js` (campos `tipo`, `titulo`,
    `detalhe` e `etiqueta`). A tela recebe os alertas pelo próprio sino, com o evento `mc:alertas` de `layout.js`, sem
    pedir de novo ao servidor.
  - **Últimas movimentações**: as 3 mais recentes, sem as pesagens, com a etiqueta, o código, o chope, o detalhe e a hora
    (*ontem* ou o dia, se não forem de hoje). O link *Ver todas* abre o Histórico.
  - No celular (menos de 768 px), as janelas sobem da parte de baixo da tela, como na aba Torneiras.
- As duas versões usam `dashboard:get` e são atualizadas a cada minuto e quando a tela volta a ficar visível.

## Cargos e permissões

Três cargos. O dia a dia (barris, engates e retiradas, transferências, histórico e Relatório de barris) é de todos;
o resto depende da permissão do cargo:

| Permissão | Administrador | Gerente | Operador |
|---|:-:|:-:|:-:|
| `usuarios`: criar, trocar cargo, desativar e apagar usuários | ✓ | | |
| `unidades`: aba Unidades e cadastro de torneiras | ✓ | | |
| `auditoria`: aba Auditoria do sistema, no Histórico | ✓ | | |
| `exportar`: CSV de estoque, de movimentações e do Relatório de barris | ✓ | | |
| `catalogo:editar`: editar, desativar, reativar e apagar chopes; ver e mudar o custo por litro; cadastrar e desativar tamanhos de barril; editar, desativar e apagar taras dos vasilhames | ✓ | ✓ | |
| `funcionarios`: funcionários do quiosque | ✓ | ✓ | |
| `vendas`: Vendas (importar, cancelar e o de-para dos produtos; o gerente só nas unidades dele) | ✓ | ✓ | |
| `torneiras:horario`: *Lançar com horário* na aba Torneiras (engate e retirada com o horário em que aconteceram) | ✓ | ✓ | |
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
- **Confirmações de ações importantes:** transferências, recolhimento de barris, desativação de usuários/unidades/torneiras/funcionários, apagar usuário ou chope e geração de senha temporária pedem confirmação antes de alterar os dados. No celular do quiosque, o cadastro de barril também pede confirmação, junto com a escolha de quem está fazendo.
- **Painel:** os cartões de estoque abrem a lista de barris já filtrada pela situação. O sino atualiza os alertas a cada minuto e avisa quando um chope em operação tem 2 ou menos barris disponíveis na unidade.
- **Relatório de estoque:** na aba Barris, *Exportar estoque (CSV)* (só administrador) baixa os barris em operação com chope, tamanho, situação, validade, unidade, torneira e o funcionário da última ação.
- **Ordenar tabelas:** clique no título da coluna (Barris, Histórico, Transferências, Usuários e Relatório de barris). Primeiro clique ordena de forma
  crescente, o segundo decrescente, o terceiro volta à ordem original. Campos vazios ficam sempre no fim. No Histórico a ordem vale
  para as linhas carregadas (até 300), não para o banco inteiro. A ordem inicial é a do horário da movimentação, do mais
  novo para o mais antigo (um lançamento com horário entra no lugar dele, não no topo).
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
  O barril retirado vazio fica *Vazio* (aguardando recolhimento); com chope, volta para o estoque (veja *Pesagem*).
- O histórico guarda o número da torneira usado em cada operação; renumerar ou desativar uma torneira não muda o passado.
- Aba **Torneiras** (todos os usuários com acesso à unidade): um cartão por torneira ativa, com o chope engatado, desde
  quando e por quem. Cada cartão tem dois botões:
  - Torneira livre: **Engatar barril** abre a janela do engate: em cima, a leitura da etiqueta do barril (veja *Leitura
    da etiqueta*); embaixo, a lista dos barris disponíveis da unidade (o que vence primeiro fica em cima, com busca por
    código ou chope). Barril vencido pede a mesma confirmação da aba Barris.
  - Torneira ocupada: **Retirar barril**, com as mesmas perguntas e o mesmo aviso da aba Barris.
  - **Histórico**: os engates daquela torneira.
- **No celular** (menos de 768 px), cada torneira vira uma linha compacta, para caberem todas na tela: o número num círculo,
  o chope com `#código · tamanho` e *há quanto tempo*, e à direita **Engatar barril** ou **Retirar** e o botão do histórico
  (relógio). As janelas sobem da parte de baixo da tela. No computador e no tablet continua o cartão.
- O lado direito do título (`.page-head-acoes`) guarda os botões da página: hoje, *Lançar com horário* (veja abaixo).
- A tela se atualiza sozinha a cada minuto, menos enquanto uma janela estiver aberta. Se outro aparelho usou a torneira ou o
  barril nesse meio tempo, aparece o motivo e o quadro é recarregado.
- Engatar, retirar e pesar ficam num só lugar, `src/renderer/js/acoes-barril.js` (`MCBarril.engatar`, `MCBarril.retirar`,
  `MCBarril.medir` e `MCBarril.pesar`), usado pelas abas Barris, Torneiras e Pesagem.

## Lançar com horário (engate e retirada que não foram lançados na hora)

Os botões de cada torneira gravam o horário de agora. Quando uma troca de barril não foi lançada na hora, lançar depois com
o horário de agora estraga a conta de perdas, que casa as vendas com os barris e os períodos de inventário. Para isso, a
aba Torneiras tem o botão **Lançar com horário** (administrador e gerente, permissão `torneiras:horario`; o operador não vê
o botão e a rota recusa).

- **Onde fica:** no computador, à direita do título e acima do *Atualizado às ...* (contorno azul, ícone de relógio). No
  celular (menos de 768 px), vira um botão flutuante no canto de baixo, acima da barra de abas, e a lista ganha espaço
  embaixo para ele não cobrir a última torneira. A janela sobe de baixo, como as outras do celular.
- **Janela** (`src/renderer/js/lancar-horario.js`, `MCLancarHorario.abrir`):
  - *O que aconteceu*: **Troca de barril** (já vem marcada), **Só retirada** ou **Só engate**.
  - *Torneira*: as torneiras ativas da unidade com o que está nelas; vem escolhida a primeira ocupada. Retirada ou troca
    numa torneira livre, ou só engate numa ocupada, mostram um aviso e o salvar fica desativado.
  - *Retirada*: o barril que sai e quando foi engatado, o dia (até hoje) e a hora, com os atalhos Hoje, Ontem e
    Anteontem, e *Como saiu*: **Vazio** ou **Ainda tinha chope** (abre a mesma medição da retirada normal, balança ou
    estimativa, com a mesma pergunta do quase vazio).
  - *Engate*: o barril que entrou (leitura da etiqueta ou lista dos disponíveis da unidade), o dia e a hora e, na troca,
    **Usar o horário da retirada**.
  - *Quem fez*: os funcionários ativos da unidade, com *Não sei* (fica sem funcionário). O usuário logado fica gravado
    como quem lançou, com o horário real do lançamento.
  - O resumo (*Vai ficar registrado na Torneira N*) aparece antes de salvar. Erro aparece na própria janela, em vermelho,
    com o campo marcado. Ao salvar, o quadro é recarregado e aparece o aviso verde com o que foi gravado.
- **Regras** (no servidor, numa transação só; a tela repete as mesmas mensagens). Horário de `APP_TZ`
  (America/Cuiaba):
  - nada no futuro e no máximo 30 dias para trás;
  - retirada depois do engate do barril e depois do último registro dele (pesagem, inclusive de inventário, ou
    movimentação);
  - engate só de barril disponível agora na unidade, depois do último registro dele (entrada, transferência recebida,
    pesagem, retirada de outra torneira);
  - engate numa torneira livre depois da última retirada dela; na troca, no mesmo minuto da retirada ou depois.
  - Assim, um lançamento nunca fica antes de um inventário que já registrou aquele barril em outra situação.
- **Banco** (`supabase/migrations/20261126000000_lancamento_com_horario.sql`): `fn_lancamento_com_horario` usa por
  dentro `fn_barril_esgotar`, `fn_barril_retirar_com_chope` e `fn_barril_engatar` (que não mudaram) e acerta os horários
  das linhas criadas. Colunas novas: `engates.engate_lancado_por/em` e `retirada_lancada_por/em`, `movimentacoes.lancado_em`
  e `pesagens.lancado_em` (nulas = lançado na hora). Auditoria *lancamento_com_horario* com o que foi feito, os horários
  informados e o funcionário. Apagar um usuário leva também os lançamentos dele para o destino escolhido.
- **Onde aparece:** no cartão ou na linha da torneira, a etiqueta azul *horário informado* ao lado de *Engatado em ...*;
  no histórico da torneira, *Engate lançado com horário por X em ...* (e o mesmo para a retirada); na aba Histórico, a
  etiqueta *horário informado* na data; no CSV do Histórico, *(horário informado; lançado em ...)* na observação.

## Leitura da etiqueta do barril (engatar e transferir)

A etiqueta do barril é um código de barras 1D só com o código, no formato `BA5-1463` (`BA2` = 20 L, `BA3` = 30 L,
`BA5` = 50 L). O bloco de leitura (`src/renderer/js/leitor-codigo.js`, `MCLeitor`) fica no engate da aba Torneiras e no
envio da aba Transferências, com três jeitos de ler:

- **Câmera:** o botão *Ler código com a câmera* abre a câmera traseira na própria janela e lê continuamente, sem tirar
  foto. Ao ler, vibra (quando o aparelho deixa), desliga a câmera e procura o barril. Usa o `BarcodeDetector` do
  navegador quando existe (Android/Chrome); senão, a ZXing (`src/renderer/vendor/zxing-0.21.3.min.js`, versão fixa,
  licença Apache 2.0), baixada só quando precisa (iPhone). Formatos 1D comuns: Code 128, Code 39, Code 93, Codabar, ITF
  e EAN-13. O mesmo código precisa sair em dois quadros seguidos (evita leitura errada de imagem tremida); outro código de
  barras (de um produto, por exemplo) só gera um aviso e a leitura continua. A câmera desliga ao fechar a janela, ao
  trocar de aba ou com a tela apagada, e só funciona em HTTPS (o servidor manda `Permissions-Policy: camera=(self)`).
- **Pistola leitora** (USB ou Bluetooth): ela "digita" o código e manda Enter no campo *Digite ou use a pistola*. No
  computador o campo já abre com o foco; no celular, um toque nele basta. Depois de cada leitura o foco volta ao campo
  (na transferência, para bipar em sequência).
- **Digitação:** o código inteiro (`BA5-2630`, `BA52630`, `ba5 2630`) ou só os números (`2630`). Só os números com mais
  de um barril (ex.: `BA2-1810` e `BA3-1810`): a tela pergunta qual é.

O barril lido vem de `barris:porCodigo`, em qualquer situação, para a tela explicar o que houve: em outra unidade,
já engatado (e em qual torneira), em transferência (ou vindo para esta loja), vazio, recolhido ou não cadastrado (com o
link para a aba Barris). Barril de unidade sem acesso mostra só o código e o nome da unidade.

- **Engatar:** barril disponível nesta unidade aparece em destaque (*Barril encontrado*, código, chope, tamanho e
  validade) e fica marcado na lista; o botão **Engatar na Torneira N** segue o fluxo de sempre (*Quem está fazendo?*,
  aviso de vencido). Retirar não muda.
- **Transferir:** cada leitura entra em *Barris para enviar* (com contador e *Tirar*); a mesma leitura de novo avisa que
  já está na lista. *Escolher da lista* adiciona barris sem etiqueta legível. Com o destino escolhido, **Enviar N barris**
  mostra uma confirmação com todos e cria uma transferência por barril (`transfer:create`): se uma falhar, as outras
  seguem e a tela mostra quais falharam e por quê (essas continuam na lista). O recebimento no destino não mudou.

## Validade e recolhimento

- **Validade:** no cadastro do barril, a data de validade é obrigatória e começa em branco (a pessoa confere a data no
  barril; normalmente são 5 dias a partir da chegada). Não aceita data no passado. A lista de barris e a lista para
  engatar (aba Torneiras) mostram um selo amarelo quando o barril vence hoje ou amanhã e vermelho quando já venceu.
  O sino de alertas avisa os mesmos casos, com os vencidos primeiro.
- O aviso vale só para barril **disponível** ou **em transferência**. Barril **engatado** está na câmara fria sendo
  consumido e não gera aviso: o cartão da aba Torneiras mostra a data, sem selo. Vazios e recolhidos também não avisam.
- O sistema **só avisa, nunca bloqueia**: ao engatar um barril vencido, ele pede confirmação ("Engatar mesmo assim?").
  O engate confirmado fica registrado na *Auditoria* como `engate_barril_vencido`.
- **Recolhimento:** os barris vazios esperam a fábrica. Em *Barris > Registrar recolhimento*, marque os vasilhames que
  estão sendo levados (ou *Marcar todos*) e confirme. Eles passam para *Recolhido* e saem da lista (o filtro *Recolhidos*
  mostra o histórico). Se o mesmo vasilhame voltar, é um cadastro novo com o mesmo código.
- O Painel mostra quantos barris estão *Vazios para recolher*, e o sino avisa quando um vazio espera há mais de 3 dias.
- Datas "de hoje" seguem o fuso `APP_TZ` (padrão `America/Cuiaba`), nunca o horário UTC do servidor.

## Pesagem (cálculo de perdas, parte 1)

Registra quantos litros cada barril tinha quando foi engatado e quando foi retirado, pela balança ou por estimativa.
Ainda não há relatório de perda: esta parte só grava os dados.

- **Retirada:** "Retirar barril" (abas Barris e Torneiras) pergunta primeiro *Este barril está vazio ou ainda tem chope?*
  - **Vazio:** o fluxo de sempre. O barril fica *Vazio* até a fábrica recolher.
  - **Ainda tem chope:** *Pesar na balança* (peso do barril em kg e a tara do vasilhame; os litros aparecem enquanto a
    pessoa digita) ou *Sem balança, estimar* (*Cerca de 100%, 75%, 50% ou 25%*). Depois vem o *Quem está fazendo?* e a
    confirmação (*Barril #BA5-1463 volta para o estoque com 18,2 L (pesado)*). A torneira é liberada e o barril volta a
    ficar *Disponível*, com o saldo.
  - Balança: litros = (peso − tara) ÷ densidade do chope. A densidade (1,01) fica só em `DENSIDADE_CHOPE`, em
    `src/server/api.js`, e é copiada em cada pesagem. Peso menor que a tara é recusado; mais litros do que o tamanho
    do barril + 5% também (*Confira o peso e a tara*). 0,5 L ou menos: a tela pergunta se retira como vazio.
- **Saldo:** o barril que voltou com chope aparece como *Disponível · 18,2 L* (ou *≈ 37,5 L* quando estimado) na lista de
  barris, na lista do engate, no CSV do estoque e nas movimentações recentes do Painel. Engatado de novo, o engate começa
  com o saldo. Retirado vazio, o saldo zera.
- **Taras dos vasilhames (Mais > Pesagem):** peso do barril vazio por tamanho. Qualquer cargo cadastra; editar, desativar e
  apagar ficam com administrador e gerente (`catalogo:editar`). Pode haver mais de uma ativa por tamanho: a padrão é a
  ativa mais recente, e o diálogo da balança deixa trocar. Sem tara para o tamanho, a primeira pesagem pede o peso do
  vasilhame vazio e salva como tara. Tara usada em pesagem não é apagada, só desativada (a pesagem guarda uma cópia do peso).
- **Inventário (Mais > Pesagem):** *Começar inventário* lista os barris engatados (com a torneira) e os disponíveis.
  Cada engatado e cada disponível com saldo precisa ser pesado (balança ou estimativa); os disponíveis cheios entram como
  100% sem pesar. *Concluir inventário* só habilita com todos pesados. O status dos barris não muda; o disponível pesado
  passa a ter o saldo novo. Um inventário aberto por unidade.
- **Pesagem avulsa (Mais > Pesagem):** pesa um barril engatado ou disponível fora do inventário.
- Todos os cargos pesam; o operador escolhe o funcionário. Tudo vai para a *Auditoria*.
- **Histórico:** operações novas *Retirado com chope* e *Pesagem* (com filtro), com data, quem, litros e *pesado* ou
  *estimado*; também no CSV. O Painel não mostra as pesagens (um inventário encheria as movimentações recentes).
- Banco: tabelas `taras`, `pesagens` e `inventarios`, colunas `barris.saldo_l`/`saldo_estimado` (nulo = cheio),
  `engates.litros_inicio`/`inicio_estimado`/`litros_fim`/`fim_estimado` e `movimentacoes.pesagem_id`, e as funções
  `fn_barril_retirar_com_chope`, `fn_pesagem_registrar`, `fn_inventario_iniciar` e `fn_inventario_concluir`, em
  `supabase/migrations/20261118100000_pesagens_saldo.sql`. Os engates antigos ficam com `litros_inicio` = tamanho do barril
  e, os já retirados, com `litros_fim` = 0.

## Relatório de barris

- Em **Mais > Relatório de barris** (ou no botão *Relatório de barris* do Painel, que abre em *Este mês*). Todos os usuários
  abrem, cada um vê só as unidades liberadas para ele (uma unidade ou *Todas as minhas*).
- Período: atalhos *Hoje*, *Últimos 7 dias*, *Este mês* e *Mês passado*, ou as datas *De* e *Até* (os dois dias entram inteiros,
  no fuso `APP_TZ`). Até 400 dias.
- Uma linha por chope, em ordem de nome, e o total geral. Barril antigo sem chope do catálogo aparece pelo nome gravado
  nele (`barris.chope_nome` ou, sem ele, `barris.estilo`); com o mesmo nome de um chope do catálogo, cai na linha dele:
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
  (`supabase/migrations/20261023000000_relatorio_barris.sql`; a versão por chope, sem estilo, está em
  `supabase/migrations/20261118200000_chope_nome_tamanhos_custo.sql`).

## Chopes, tamanhos de barril e custo por litro

- O chope tem só o **nome** (sem estilo). O barril é cadastrado escolhendo o chope do catálogo; se ele ainda não existe,
  a opção *+ Cadastrar novo chope…* cria o chope sem sair da tela. A tabela `estilos` e a coluna `barris.estilo` continuam
  no banco: `barris.estilo` recebe o nome do chope, e o barril antigo sem chope do catálogo aparece pelo estilo gravado nele.
- Aba **Chopes** (todos): lista do catálogo e cadastro de chope novo. Editar, desativar, reativar, apagar e os preços são do
  administrador e do gerente (`catalogo:editar`). Renomear atualiza os barris daquele chope; desativar só tira o chope do
  cadastro de barris novos (os barris antigos continuam com ele).
- **Apagar** (administrador e gerente), para o que foi cadastrado errado: só apaga chope que nenhum barril usa (os preços
  dele vão junto). Se algum barril usa, o app avisa quantos e sugere desativar ou editar o nome.
- **Tamanhos de barril** (tabela `tamanhos_barril`): começam com 20, 30 e 50 L (prefixos BA2, BA3 e BA5). O campo Tamanho
  do cadastro de barril e a tara usam só os ativos. Administrador e gerente cadastram um tamanho novo pela opção
  *+ Novo tamanho…* do cadastro de barril (litros inteiros ou com uma casa; prefixo do código opcional) ou pela seção
  *Tamanhos de barril* da aba Chopes, que mostra quantos barris usam cada um. Tamanho repetido é recusado. Tamanho não é
  apagado, só desativado: some do cadastro de barril e dos campos de preço, e o servidor recusa barril com ele.
- **Custo por litro** (só administrador e gerente veem; o operador não recebe custo em nenhuma resposta):
  - Caixa desmarcada: um *Custo por litro (R$)* para qualquer tamanho. Marcada: o preço do barril de cada tamanho ativo, e o
    servidor grava `custo_litro = preço ÷ litros` (20 L a R$ 300,00 = R$ 15,00/L). Tamanho vazio fica *Sem preço*.
  - Chope novo pela aba Chopes exige o preço. O operador cria chope só com o nome (no cadastro de barril), e ele fica *Sem preço*.
  - Botão **Preços**: os valores atuais, o *Início* (hoje, editável) e o histórico. Salvar grava linhas novas em
    `custos_chope` (só o que mudou), sem apagar as antigas. Dá para trocar entre preço único e por tamanho.
  - No topo da aba Chopes, *N chopes sem preço*, contando o chope sem preço num tamanho (ex.: um tamanho novo).
  - `fn_custo_litro(chope, tamanho, data)` dá o custo que vale para um barril: as linhas do tamanho (ou as de tamanho nulo, no
    preço único), a de maior início até a data de cadastro do barril e, se não houver, a de menor início; nulo sem preço.
    Trocar entre preço único e por tamanho vale também para barris antigos (a função usa o modo atual do chope).

## Vendas (cálculo de perdas, parte 2)

Importa as vendas do relatório do sistema de caixa, com o horário de cada venda. Hoje o único formato aceito é o da
Teknisa: relatório **Vendas Realizadas no Período** (XLSX). O relatório de perda (parte 3) usa estas vendas junto com
as pesagens.

- Tela **Mais > Vendas**, do administrador e do gerente (`vendas`; o gerente só nas unidades dele).
- **Leitura** (no servidor, `src/server/teknisa.js`, com a biblioteca `exceljs`, versão fixa no `package.json`): arquivo
  .xlsx de até 10 MB. As colunas são achadas pelo nome (`Unidade | Venda | Código | Produto | Qtde. | Un. | Pr. Unit. | Desc. |
  Acrés. | Vr. Bruto | Vr. Total | Ab. Comanda`), o cabeçalho pode vir depois do título. Arquivo com outro cabeçalho é
  recusado (*Este relatório não é aceito...*). Linhas sem Unidade ou sem Produto (totais) são puladas.
  Do campo *Venda* saem só Caixa, Nr. Ven., Dt. Ven. e Modalidade (pagamento, cliente e vendedor não são guardados).
- **Horário da venda** (`vendido_em`): a abertura da comanda (*Ab. Comanda*); sem ela, a data da venda (*Dt. Ven.*). As datas
  estão no horário da loja (`APP_TZ`), menos a *Dt. Ven.* dos terminais de autoatendimento (Modalidade *Terminal de
  Autoatendimento*), que a Teknisa grava no horário de Brasília: essa é lida como `America/Sao_Paulo`. As duas datas do
  arquivo ficam gravadas (`dt_venda` e `comanda_aberta_em`).
- **Unidade**: o código antes do " - " ("0003 - LOJA ..." = 0003) é `unidades.codigo_teknisa`, o *Código no sistema de
  caixa* da tela Unidades (administrador), ou é preenchido na primeira importação daquela loja (a tela pede a unidade e
  grava o código). Um arquivo com duas lojas gera uma importação por loja.
- **Produtos** (`produtos_teknisa`, o de-para): a chave é o nome sem acento e em maiúsculas (o código muda entre relatórios).
  Produto novo vem com sugestão:
  - volume: "300 ML" ou "355 ML" num chope = 0,36 L (a caneca servida é de 360 ml); "1L"/"1 L" = 1 L (refil de growler);
    outro volume vem do número no nome ("500ML" = 0,5). Combo com duas canecas é ajustado à mão (0,72);
  - chope: nome que começa com "CHOPP"; o nome do chope é o texto entre "CHOPP" e o volume. Igual a um chope do catálogo
    (sem diferenciar maiúsculas, acentos e espaços: "HOPLAGER" = "Hop Lager"): esse. Senão, parecido (um começa com o outro,
    ou diferença de até 2 letras): se for um só, ele com o aviso *Nome parecido, confira*; se forem vários, nenhum, e os
    parecidos vêm primeiro na lista;
  - o resto (lata, garrafa, água, comida, kit e o "GROWLER PET 1 L UN", que é o vasilhame vazio) vem como *ignorar*.
  Depois da primeira importação, vale a escolha gravada (não sugere de novo).
- **Prévia**: período editável (vem com o primeiro e o último dia do arquivo; só entram vendas dentro dele), a tabela de
  produtos (chope, volume, litros; os novos marcados *Novo*), os ignorados recolhidos em *Ignorados (N)*, litros por chope,
  litros por dia e os totais do arquivo para comparar com o sistema de caixa. Item que já foi importado é pulado (*N itens já tinham
  sido importados e serão pulados.*): uma venda é unidade + caixa + número, e `linha` é a posição do item dentro dela.
- **Importar** grava as escolhas dos produtos e as importações numa transação só (`fn_vendas_importar`). Só os itens de chope
  são gravados em `vendas_itens`, com cópia do chope e do volume do produto: mudar o de-para depois não muda o que já foi
  importado. Auditoria *vendas_importadas* com a unidade, o período, os itens novos e os litros.
- **Importações**: a lista com unidade, período, itens novos, litros, valor, quem e quando. *Ver* mostra litros e valor por
  chope e por dia, com o preço de venda por litro (valor ÷ litros). *Cancelar* apaga os itens daquela importação e marca como
  cancelada (dá para importar o arquivo de novo).
- Aba **Produtos**: o de-para gravado, editável (chope, volume, ignorar). Vale para as próximas importações.
- Aba **Chopes** (administrador e gerente): ao lado do custo por litro, o preço de venda por litro das vendas importadas dos
  últimos 30 dias, nas unidades da pessoa (só leitura).
- Chope com venda importada não é apagado (como chope com barril).

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
  A câmera só pode ser usada pelas telas do próprio app (`Permissions-Policy: camera=(self)`, para ler a etiqueta do
  barril); microfone e localização ficam bloqueados.
  A Content-Security-Policy só permite arquivos do próprio servidor (as fontes também); o único script inline aceito são
  as regras de pré-carregamento (`'inline-speculation-rules'`).
- Esqueceu a senha? O administrador gera uma senha temporária em *Usuários*.

## Estrutura

- `src/server/` — servidor e regras (`server.js`, `api.js`, `supabase.js`; `teknisa.js` lê o XLSX de vendas da Teknisa;
  `alertas.js` monta os alertas do sino)
- `src/renderer/` — as telas (servidas pelo servidor)
- `src/main/` — aplicativo Windows (só abre o servidor em uma janela)
- `supabase/migrations/` — schema e mudanças do banco (`supabase/config.toml` é do Supabase local dos testes)
- `tests/` — testes automáticos (veja *Rodar os testes*); `tests/fixtures/` tem os arquivos inventados da Teknisa
- `deploy/` — arquivos de implantação (Linux + HTTPS)
