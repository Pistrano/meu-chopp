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
2. Na pasta do projeto, copie `.env.example` para `.env` e preencha `SUPABASE_URL` e `SUPABASE_SECRET_KEY`
   (Supabase > *Project Settings* > *API Keys* > *Secret keys*). O `.env` nunca vai para o repositório.
3. Rode:
   ```
   npm install --omit=dev
   npm run server
   ```
   (no Windows você também pode dar dois cliques em `iniciar-servidor.bat`)
4. Abra **http://localhost:3000**. Se o banco ainda não tem usuários, aparece a *Configuração inicial*: crie o administrador.

### Variáveis do `.env`

| Variável | Para que serve |
|---|---|
| `SUPABASE_URL` | Endereço do projeto no Supabase (sem `/rest/v1`). |
| `SUPABASE_SECRET_KEY` | Chave secreta do Supabase. Só o servidor usa. |
| `APP_TZ` | Fuso da operação (padrão `America/Cuiaba`). Usado para mostrar data e hora e para as datas "de hoje". |
| `NOME_FORNECEDOR` | Quem entrega os barris; aparece como origem das entradas no histórico (padrão "Fornecedor"). |

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
- **PC ou tablet Windows:** use o aplicativo `BarrilFacil Setup.exe` (gere com `npm run dist`). Na primeira abertura ele
  pede o endereço do servidor. Marque *Abrir em tela cheia* para deixar a tela da unidade travada no sistema (F11 alterna;
  tecla Alt abre o menu com *Alterar servidor*). Também funciona só pelo navegador.

Sem internet o sistema não abre dados (aparece o aviso *Sem conexão* e ele tenta de novo sozinho). Nada se perde: o que já foi
registrado está no banco.

## 4) Dados

- Todos os dados ficam no **Supabase** (o projeto configurado no `.env`). O servidor não guarda nada em disco.
- O schema do banco está em `supabase/migrations/`. Cada mudança de banco vem num arquivo novo nessa pasta, que é rodado
  à mão no *SQL Editor* do Supabase antes do merge do PR que depende dele.

## Menu

- Abas principais, sempre visíveis: **Barris**, **Torneiras**, **Chopes** e **Histórico**.
- O botão **Mais** abre as outras telas: Painel, Transferências e, para o administrador, Unidades e Usuários.
  Quando a tela aberta está dentro do Mais, o botão fica destacado com o nome dela. Toda tela nova entra no Mais por padrão
  (em `src/renderer/js/layout.js`, `principal: true` coloca uma tela nas abas principais).
- Clicar na logo leva ao Painel. Depois do login, o sistema abre no Painel.
- No celular e no tablet, o menu fica numa barra embaixo e o Mais vira ☰.

## Unidades e torneiras

- Aba **Unidades** (administrador): cadastro com nome, CNPJ (numérico ou alfanumérico, com validação) e localização,
  e o cadastro das torneiras de cada loja. As unidades que já existiam ficam marcadas como *A preencher* até alguém
  informar o CNPJ e o endereço reais em *Editar*.
- **Engate:** em *Barris > Engatar na torneira*, o funcionário escolhe uma torneira livre da unidade do barril.
  Sem torneira livre, o engate não é feito.
- **Retirada:** em *Barris > Retirar barril*, o sistema usa a torneira registrada no engate e a libera.
  Pela regra atual, o barril retirado passa para *Chopp Esgotado*.
- O histórico guarda o número da torneira usado em cada operação; renumerar ou desativar uma torneira não muda o passado.
- Aba **Torneiras** (todos os usuários): um cartão por torneira ativa da unidade, com o chope engatado, desde quando e por
  quem. Tocar no cartão mostra o histórico de engates daquela torneira. A tela se atualiza sozinha a cada minuto.

## Chopes e estilos

- O barril é cadastrado escolhendo um **chope** do catálogo (ex.: *German Pilsen · Pilsen*). Se o chope ainda não existe,
  a opção *+ Cadastrar novo chope…* cria o chope (e, se precisar, o estilo) sem sair da tela.
- Aba **Chopes** (todos): lista do catálogo e cadastro de chopes e estilos novos. Editar, desativar e reativar são só do
  administrador. Renomear atualiza os barris daquele chope/estilo; desativar só tira o chope do cadastro de barris novos
  (os barris antigos continuam com ele).

## Testes

Os testes automáticos de `tests/` ainda são da época do banco local e não funcionam com o Supabase. Enquanto não forem
refeitos, cada PR traz um roteiro de teste manual.

## Segurança

- Entrada com e-mail e senha forte (8+ caracteres, letras e números); sem senha padrão.
- 5 tentativas erradas bloqueiam a conta por 15 minutos; também há limite de tentativas por aparelho.
- A sessão expira após 15 minutos sem uso. Cada aparelho tem a própria sessão (cookie protegido).
- Cada unidade é isolada: o servidor confere a permissão a cada ação. Tentativas indevidas ficam na *Auditoria*.
- O banco só é acessado pelo servidor, com a chave secreta. As tabelas têm RLS ligado e as funções SQL só podem ser
  executadas pelo servidor.
- Proteções do servidor: cabeçalhos de segurança, bloqueio de pedidos vindos de outros sites e de acesso a arquivos internos.
- Esqueceu a senha? O administrador gera uma senha temporária em *Usuários*.

## Estrutura

- `src/server/` — servidor e regras (`server.js`, `api.js`, `supabase.js`)
- `src/renderer/` — as telas (servidas pelo servidor)
- `src/main/` — aplicativo Windows (só abre o servidor em uma janela)
- `supabase/migrations/` — schema e mudanças do banco
- `deploy/` — arquivos de implantação (Linux + HTTPS)
