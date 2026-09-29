# Auditoria RegulOS v12.11.0 — consolidação do Gerenciador de Links

## Base
Base usada: RegulOS v12.11.0 com Gerenciador de Grupos recolhido.

## Alterações consolidadas
- Gerenciador de grupos continua recolhido e abre somente pelo botão.
- Grupos começam desligados e somente grupos Ligados recebem os envios.
- Gerenciador de Links mantém data, horário, repetição, ativação, pausa, envio imediato e exclusão.
- Campo de URL da imagem manual adicionado.
- Opção de imagem automática mantida.
- Mensagem personalizada disponível no Gerenciador.
- Falha de obtenção/baixamento da imagem, quando a imagem está sendo usada, não é convertida silenciosamente em envio somente texto: vira falha de envio.
- Novo painel "Links com falha".
- Falhas ficam registradas por link/grupo e possuem Reenviar e Editar.
- Reenviar usa o grupo que apresentou a falha.
- Reenvio bem-sucedido remove o registro de falha e registra o envio no histórico.
- Reenvio que falhar continua no painel de falhas.
- Editar falha abre o Gerenciador de Links já preenchido e rearma a programação.
- Excluir um agendamento também remove suas falhas associadas.
- Botão de limpar histórico de enviados continua funcionando.
- Botão de limpar falhas foi adicionado.
- Desconectar/Novo QR/Deslogar limpam histórico e falhas, mantendo a regra de nova sessão limpa.
- Novo QR também limpa grupos e agendamentos da sessão anterior, conforme a base.

## Verificações realizadas
- `node --check src/server.js` — OK.
- JavaScript embutido em `public/index.html` extraído e validado com `node --check` — OK.
- Rotas de histórico, falhas, reenvio, edição, agendamentos e exclusão revisadas.
- Fluxo de sucesso/falha/reenvio revisado.
- Fluxo de imagem automática/manual revisado.
- Fluxo de grupos recolhidos e seleção Ligado/Desligado preservado.
- Inicializador `INICIAR_REGULOS.bat` já instala dependências ausentes e abre `http://127.0.0.1:3000` após o servidor responder.

## Limitação do teste
A validação feita neste pacote é estática/de código. O ZIP não inclui `node_modules`, portanto o envio real pelo WhatsApp e a captura real de QR dependem da instalação das dependências e de uma sessão WhatsApp conectada. O `INICIAR_REGULOS.bat` instala as dependências automaticamente quando necessário.
