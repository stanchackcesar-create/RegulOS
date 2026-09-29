# Auditoria — Falha sem pausa (RegulOS v12.11.0)

## Regra implementada
Quando um link agendado falhar no envio, a falha é registrada em **Links com Falha** e o agendamento de uma vez não deve ser marcado como `pausado` por causa dessa falha.

- Falha de imagem: registrada como falha e o agendamento é retirado da programação.
- Falha de envio para um grupo: registrada para aquele grupo; o processo continua avaliando os demais destinos.
- Quando todos os destinos da ocorrência terminam, um agendamento de uma vez com erro é finalizado como falha e removido dos agendamentos.
- O botão Reenviar continua sendo o caminho para uma nova tentativa.
- `pausado` continua reservado para situações de janela de envio/condição operacional, não para uma falha de envio.

## Verificação
`node --check src/server.js`: OK.
