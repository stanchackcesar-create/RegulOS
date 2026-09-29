@echo off
setlocal
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RegulOS.lnk"
if exist "%SHORTCUT%" (
  del /q "%SHORTCUT%"
  echo [OK] Inicio automatico removido.
) else (
  echo O inicio automatico ja estava desativado.
)
pause
