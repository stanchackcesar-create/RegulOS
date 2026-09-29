@echo off
cd /d "%~dp0"
echo Verificando RegulOS em http://127.0.0.1:3000 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 3; Write-Host ('OK - RegulOS online: ' + $r.Content) -ForegroundColor Green } catch { Write-Host 'RegulOS nao respondeu na porta 3000.' -ForegroundColor Red; Write-Host 'Execute INICIAR_REGULOS.bat.' -ForegroundColor Yellow }"
pause
