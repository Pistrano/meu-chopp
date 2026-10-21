# MeuChopp — controle de barris de chopp dos quiosques

## Como funciona

```
 Tablet / tela / PC do quiosque A ─┐
 Tablet / tela / PC do quiosque B ─┼──►  SERVIDOR (1 só, com o banco de dados)
 Celular / PC do administrador   ─┘
```

Os dados ficam **no servidor**, não nos aparelhos. Por isso as transferências entre quiosques, o histórico e o painel
do administrador funcionam para todos ao mesmo tempo. Cada aparelho só precisa abrir o endereço do servidor.

Cada quiosque só enxerga o próprio estoque. O administrador libera quais quiosques cada pessoa pode acessar.

## 1) Testar o servidor no seu computador

1. Instale o **Node.js 18 ou superior** (https://nodejs.org).
2. Na pasta do projeto:
   ```
   npm install --omit=dev
   npm run server
   ```
   (no Windows você também pode dar dois cliques em `iniciar-servidor.bat`)
3. Abra **http://localhost:3000**. Na primeira vez aparece a *Configuração inicial*: crie o administrador.

## 2) Colocar o servidor no ar (para os quiosques usarem)

O servidor precisa ficar **ligado o tempo todo** e acessível pela internet, com **HTTPS** (cadeado). Caminho recomendado:
um servidor virtual pequeno (VPS, Ubuntu) com um domínio, por exemplo `chopp.suaempresa.com.br`.

```
sudo apt update && sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo useradd --system --home /opt/meu-chopp meuchopp
sudo mkdir -p /opt/meu-chopp /var/lib/meuchopp
# copie a pasta do projeto para /opt/meu-chopp (scp, git clone, etc.) e então:
cd /opt/meu-chopp && sudo npm install --omit=dev
sudo chown -R meuchopp:meuchopp /opt/meu-chopp /var/lib/meuchopp
sudo cp deploy/meuchopp.service /etc/systemd/system/
sudo systemctl enable --now meuchopp
```

HTTPS com **Caddy** (certificado automático): instale conforme https://caddyserver.com/docs/install, coloque o conteúdo de
`deploy/Caddyfile` em `/etc/caddy/Caddyfile` (com o seu domínio) e rode `sudo systemctl reload caddy`.
O DNS do domínio precisa apontar para o IP do servidor.

Para atualizar depois: copie os arquivos novos e rode `sudo systemctl restart meuchopp`.

**Importante:** sem HTTPS o sistema funciona, mas as senhas viajam sem proteção e o tablet não permite "instalar" o app.
Não coloque na internet sem HTTPS.

## 3) Instalar nos aparelhos dos quiosques

- **Tablet Android / celular:** abra o endereço no Chrome > menu ⋮ > *Instalar app* (ou *Adicionar à tela inicial*).
- **iPad / iPhone:** abra no Safari > Compartilhar > *Adicionar à Tela de Início*.
- **PC ou tablet Windows:** use o aplicativo `MeuChopp Setup.exe` (gere com `npm run dist`). Na primeira abertura, informe o
  endereço do servidor. Marque *Abrir em tela cheia* para deixar a tela do quiosque travada no sistema (F11 alterna;
  tecla Alt abre o menu com *Alterar servidor*). Também funciona só pelo navegador.

Sem internet o sistema não abre dados (aparece o aviso *Sem conexão* e ele tenta de novo sozinho). Nada se perde: o que já foi
registrado está no servidor.

## 4) Dados, backup e migração

- O banco é o arquivo `meuchopp.db` na pasta `data/` (ou em `DATA_DIR`). **Faça cópia dele periodicamente para outro lugar.**
- O servidor também guarda uma cópia por dia em `data/backups/` (as 14 mais recentes). Elas ficam na mesma máquina; copie para fora.
- **Já usava a versão antiga (um banco por aparelho)?** Copie o `meuchopp.db` dela (em `%APPDATA%\meu-chopp\`) para a pasta
  `data/` do servidor **antes** de ligar o servidor pela primeira vez. Ele é atualizado automaticamente.

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
- Na primeira vez que a versão nova liga sobre um banco antigo, ele é atualizado automaticamente (sem apagar nada)
  e uma cópia do banco antigo fica em `data/backups/meuchopp-antes-da-v3-....db`.

## Chopes e estilos

- O barril é cadastrado escolhendo um **chope** do catálogo (ex.: *German Pilsen · Pilsen*). Se o chope ainda não existe,
  a opção *+ Cadastrar novo chope…* cria o chope (e, se precisar, o estilo) sem sair da tela.
- Aba **Chopes e estilos** (administrador): editar, desativar e reativar. Renomear atualiza os barris daquele chope/estilo;
  desativar só tira o chope do cadastro de barris novos (os barris antigos continuam com ele).
- Mudanças de banco ficam em `supabase/migrations/` e são rodadas à mão no SQL Editor do Supabase antes de publicar.

## Testes

Com o Node.js instalado, na pasta do projeto: `npm test`. Os testes sobem o servidor numa pasta temporária
(não mexem no seu `data/`) e conferem cadastro de unidades, torneiras, engate, retirada, histórico, permissões e migração.

## Segurança

- Entrada com e-mail e senha forte (8+ caracteres, letras e números); sem senha padrão.
- 5 tentativas erradas bloqueiam a conta por 15 minutos; também há limite de tentativas por aparelho.
- A sessão expira após 15 minutos sem uso. Cada aparelho tem a própria sessão (cookie protegido).
- Cada quiosque é isolado: o servidor confere a permissão a cada ação. Tentativas indevidas ficam na *Auditoria*.
- Proteções do servidor: cabeçalhos de segurança, bloqueio de pedidos vindos de outros sites e de acesso a arquivos internos.
- Esqueceu a senha? O administrador gera uma senha temporária em *Usuários*.

## Estrutura

- `src/server/` — servidor, regras, banco (`server.js`, `api.js`, `db.js`)
- `src/renderer/` — as telas (servidas pelo servidor)
- `src/main/` — aplicativo Windows (só abre o servidor em uma janela)
- `deploy/` — arquivos de implantação (Linux + HTTPS)
