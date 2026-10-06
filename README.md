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
3. Primeiro acesso: usuário `admin`, senha `admin123` (troque em *menu do usuário > Alterar minha senha*).

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
