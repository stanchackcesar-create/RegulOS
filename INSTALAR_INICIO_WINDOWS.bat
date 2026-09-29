@echo off
setlocal
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT=%STARTUP%\RegulOS.lnk"
set "TARGET=%~dp0INICIAR_REGULOS.bat"

echo ========================================
echo   RegulOS - Inicio automatico do Windows
echo ========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut($env:SHORTCUT); $s.TargetPath=$env:TARGET; $s.WorkingDirectory=(Split-Path $env:TARGET); $s.WindowStyle=7; $s.Description='Inicia o RegulOS automaticamente'; $s.Save()"

if exist "%SHORTCUT%" (
  echo.
  echo [OK] Inicio automatico instalado.
  echo O RegulOS sera iniciado automaticamente quando voce entrar no Windows.
) else (
  echo.
  echo [ERRO] Nao foi possivel criar o atalho.
)
echo.
pause
