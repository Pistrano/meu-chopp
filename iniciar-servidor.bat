@echo off
rem Inicia o servidor do BarrilFacil neste computador (porta 3000).
rem Os dados ficam no Supabase (configure o arquivo .env, veja .env.example). Deixe esta janela aberta.
cd /d "%~dp0"
set PORT=3000
echo Iniciando o BarrilFacil em http://localhost:%PORT% ...
node src\server\server.js
pause
