# MeuChopp — aplicativo de desktop

Sistema de controle de barris de chopp (Electron + SQLite em WebAssembly). Funciona sem internet:
os dados ficam em um arquivo `meuchopp.db` no computador.

## Como rodar
1. Instale o **Node.js 20 ou superior** (https://nodejs.org).
2. Coloque a pasta em um lugar simples, como `C:\MeuChopp` (evite Downloads), apague a pasta `node_modules` se ela existir e, na pasta do projeto:
   ```
   npm install
   npm start
   ```
3. Na primeira vez, o app abre a tela **Configuração inicial**: crie o administrador com o seu e-mail e uma senha.
   Não existe usuário nem senha padrão.

## Quiosques e acesso exclusivo
- Cada quiosque tem **estoque, histórico, transferências e relatórios próprios**.
- O **administrador** vê e gerencia todos os quiosques e cadastra novos na aba *Quiosques*.
- O **operador** só enxerga os quiosques que um administrador liberou para ele (um ou vários), em *Usuários > Quiosques*.
  A permissão é conferida no sistema a cada ação, não só na tela, e vale na hora.
- Uma transferência só é confirmada por quem tem acesso ao quiosque de destino, e só é cancelada por quem tem acesso ao de origem.
- Tentativas de acessar um quiosque sem permissão ficam registradas em *Histórico > Auditoria do sistema* (`acesso negado`).
- Um quiosque só pode ser desativado quando não tem barris em estoque nem transferências a receber.

## Segurança do login
- Entrada com **e-mail** e senha. Senha com no mínimo 8 caracteres, com letras e números, sem senhas comuns.
- **5 tentativas erradas bloqueiam o acesso por 15 minutos** (o administrador pode desbloquear).
- A sessão **expira após 15 minutos sem uso**.
- O administrador cria usuários e redefine senhas gerando uma **senha temporária aleatória**; a pessoa é obrigada
  a criar a própria senha no primeiro acesso.
- Toda entrada, falha, bloqueio e troca de senha fica na aba *Histórico > Auditoria do sistema*.
- Esqueceu a senha? Peça a um administrador para gerar uma senha temporária (Usuários > Gerar senha temporária).

## Gerar o instalador (.exe)
```
npm run dist
```
O instalador aparece na pasta `dist/`.

## Estrutura
- `src/main/db.js` — tabelas do banco e dados iniciais (unidades e admin)
- `src/main/ipc.js` — regras de negócio, permissões, histórico e auditoria
- `src/main/main.js` / `preload.js` — janela do aplicativo e ponte segura
- `src/renderer/` — telas (login, dashboard, barris, transferências, histórico, usuários)

## Onde ficam os dados
Windows: `%APPDATA%\meu-chopp\meuchopp.db` (faça backup copiando esse arquivo).

## Se a instalação falhar
- `EPERM` ao apagar/instalar: feche o VS Code e outros programas que usam a pasta e rode `rmdir /s /q node_modules` antes de instalar de novo.
- Erro de certificado (`self-signed certificate`): sua rede/antivírus intercepta HTTPS. Peça ao TI o certificado e use `set NODE_EXTRA_CA_CERTS=C:\caminho\certificado.pem` antes do `npm install`.
- O banco não usa módulos nativos (sql.js), então não precisa de Python nem de compilador C++.
