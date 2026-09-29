@echo off
chcp 65001 >nul
netsh advfirewall firewall add rule name="RegulOS TCP 3000" dir=in action=allow protocol=TCP localport=3000 profile=private >nul 2>&1
if %errorlevel%==0 (
 echo [OK] Porta 3000 liberada no Firewall para redes privadas.
) else (
 echo [ERRO] Execute este arquivo como Administrador.
)
pause
