@echo off
setlocal
cd /d "%~dp0"
title Instalar dependencias - RegulOS v12.11.0
echo Instalando dependencias do RegulOS...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo Falha na instalacao.
  pause
  exit /b 1
)
echo.
echo Dependencias instaladas com sucesso.
pause
