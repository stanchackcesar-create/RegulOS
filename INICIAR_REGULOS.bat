@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title RegulOS v12.11.0 - Inicializador
color 0A

echo ========================================
echo       RegulOS v12.11.0
echo       Inicializacao automatica
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERRO: Node.js nao foi encontrado.
  echo Instale o Node.js e tente novamente.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERRO: npm nao foi encontrado.
  pause
  exit /b 1
)

if not exist "node_modules\@whiskeysockets\baileys\package.json" (
  echo [1/4] Dependencias do RegulOS nao encontradas.
  echo Instalando automaticamente...
  echo Isso pode levar alguns minutos na primeira vez.
  echo.
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo ERRO: nao foi possivel instalar as dependencias.
    echo Verifique a internet e tente novamente.
    pause
    exit /b 1
  )
)

if not exist "node_modules\playwright\package.json" (
  echo [2/4] Instalando suporte de leitura de links encurtados...
  call npm.cmd install playwright@^1.55.0 --no-audit --no-fund
  if errorlevel 1 (
    echo ERRO: nao foi possivel instalar o Playwright.
    pause
    exit /b 1
  )
)

echo [3/4] Verificando navegador Chromium para links encurtados...
call npx.cmd --yes playwright install chromium
if errorlevel 1 (
  echo AVISO: Chromium nao foi instalado. A leitura avancada de links encurtados podera falhar.
)

echo [4/4] Dependencias verificadas. Iniciando o Supervisor...
echo.

start "RegulOS v12.11.0" cmd /k "cd /d ""%~dp0"" && npm.cmd start"

echo Aguardando o servidor...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){$ok=$true; break} } catch {}; Start-Sleep -Seconds 1 }; if($ok){Start-Process 'http://127.0.0.1:3000'} else {Write-Host 'O servidor nao respondeu em 60 segundos.' -ForegroundColor Yellow}"

if errorlevel 1 (
  echo Nao foi possivel abrir o navegador automaticamente.
  echo Tente: http://127.0.0.1:3000
)

exit /b 0
