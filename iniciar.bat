@echo off
cd /d "%~dp0"

if "%ACCESS_PIN%"=="" set "ACCESS_PIN=12345678"
if "%AUTH_SECRET%"=="" set "AUTH_SECRET=leo-local-troque-este-segredo"
if "%PORT%"=="" set "PORT=3000"

echo.
echo Iniciando "O Leo esta trabalhando?" na porta %PORT%...
echo Painel:     http://localhost:%PORT%
echo Transmissao: http://localhost:%PORT%/host
echo PIN:        %ACCESS_PIN%
echo.

start "" "http://localhost:%PORT%/host"
node server.mjs
pause
