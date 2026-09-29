@echo off
chcp 65001 >nul
setlocal

echo.
echo ================================================
echo RegulOS - acesso pelo celular
echo ================================================
echo.

for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-NetIPConfiguration ^| Where-Object { $_.NetAdapter.Status -eq ''Up'' -and $_.IPv4DefaultGateway -ne $null -and $_.IPv4Address }; $c= $c ^| Sort-Object @{Expression={if($_.InterfaceAlias -match ''Wi-Fi^|WLAN^|Wireless''){0}else{1}}}; if($c){$c[0].IPv4Address.IPAddress}"') do set "IP=%%A"

if not defined IP (
  echo [ERRO] Nao foi encontrado um endereco IPv4 de rede com gateway.
  echo Verifique se o PC esta conectado ao Wi-Fi.
  echo.
  pause
  exit /b 1
)

echo No celular, conectado ao MESMO Wi-Fi do computador, abra:
echo.
echo    http://%IP%:3000
echo.
echo IP escolhido: %IP%
echo.
echo Se o celular nao abrir:
echo 1. Execute LIBERAR_PORTA_3000_FIREWALL.bat como Administrador.
echo 2. Confirme que PC e celular estao na mesma rede Wi-Fi.
echo 3. Execute VERIFICAR_REGULOS.bat para confirmar que o servidor esta ativo.
echo.
pause
