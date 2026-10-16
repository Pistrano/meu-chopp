@echo off
rem Inicia o servidor do MeuChopp neste computador (porta 3000).
rem Os dados ficam na pasta "data" ao lado deste arquivo. Deixe esta janela aberta.
cd /d "%~dp0"
set PORT=3000
echo Iniciando o MeuChopp em http://localhost:%PORT% ...
node src\server\server.js
pause
