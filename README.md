# RegulOS v12.7.5 — Painel responsivo para celular

Esta versão mantém as funções do RegulOS v12.7.x e melhora a experiência no navegador do celular pela rede Wi-Fi.

## Acesso

1. Execute `npm.cmd start` no computador.
2. Descubra o IPv4 do Wi-Fi com `ipconfig`.
3. No celular, conectado à mesma rede, abra `http://IP_DO_PC:3000`.

Exemplo: `http://10.0.0.122:3000`

## Melhorias
- Layout responsivo para telas pequenas.
- Botões e campos maiores para toque.
- Gerenciador de links, grupos, agendamentos, programação, histórico e contas continuam disponíveis.
- Polling reduzido para diminuir consumo no celular.
- Reconexão/aviso quando a rede cai e volta.
- QR Code adaptado à tela.
- A aba de todos os grupos continua separada.

## Importante
O RegulOS precisa continuar rodando no computador. O celular é o painel de controle. A sessão do WhatsApp continua no computador e compartilhada entre as contas autorizadas.


## Contas e presença — v12.7.5
- Cadastro de usuários usa somente nome de usuário e senha.
- A lista de usuários mostra 🟢 Conectado ou 🔴 Desconectado.
- A presença é baseada em heartbeat da sessão; ao fechar o navegador, o usuário passa para desconectado após o período de expiração de presença.
- Sair remove somente a sessão daquele usuário; não desconecta o WhatsApp compartilhado.


## Acesso pelo celular — v12.7.8
- O servidor escuta em `0.0.0.0:3000`, permitindo acesso pela rede local.
- `ABRIR_NO_CELULAR.bat` agora prioriza a interface Wi-Fi/WLAN com gateway e evita escolher por engano adaptadores virtuais como Hyper-V Default Switch.
- PC e celular precisam estar na mesma rede local.
- A porta TCP 3000 precisa estar liberada no Firewall do Windows para a rede privada.


## RegulOS 12.8.0
- Nuvem preparada para America/Sao_Paulo.
- Proteção básica contra SSRF nas URLs externas.
- Login com limitação de tentativas.
- Operações críticas do WhatsApp restritas ao administrador.
- Supervisor automático no comando de início.
- `ABRIR_REGULOS.vbs` para inicialização sem terminal visível.

<!-- cloud-source-restore-trigger -->
