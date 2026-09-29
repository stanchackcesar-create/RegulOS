# Auditoria — Fluxo de falha, reorganização e reenvio — RegulOS v12.11.0

## Regras implementadas

1. Um agendamento de uma vez que falha sai de `link_agendamentos.json`.
2. O destino que falhou é registrado em `links_com_falha.json`.
3. O próximo agendamento ocupa o horário/data liberado pelo link que falhou.
4. Os agendamentos seguintes avançam uma posição, preservando seus slots originais para a cadeia de reorganização.
5. Se o erro for de imagem (manual inválida ou imagem automática não encontrada), o item também sai dos agendamentos e vai para falhas.
6. Erros de envio não são registrados como sucesso no histórico de links enviados.
7. Ao clicar em `Reenviar`, o link NÃO é enviado diretamente: ele é devolvido para `Agendamentos`.
8. O reenvio mantém o grupo que originalmente falhou (`reenvioGrupoId`).
9. O agendador executa o reenvio; sucesso remove a falha e arquiva no histórico de enviados.
10. Se o reenvio falhar, ele volta para `Links com Falha`.
11. Se o grupo do reenvio estiver desligado, o item permanece em Agendamentos pausado até o grupo ser ligado.

## Verificação técnica

- `node --check src/server.js`: OK.
- O painel já recarrega `loadLinkFailures()`, `loadLinks()` e `loadSchedules()` após a ação de Reenviar.
- O fluxo de edição continua separado: `Editar` devolve os dados ao Gerenciador de Links para uma nova programação.

## Exemplo

08:00 A (falhou)
09:00 B
10:00 C

Resultado:
08:00 B
09:00 C
A -> Links com Falha

Se `Reenviar A` for clicado:
A -> Agendamentos (somente o grupo que falhou)
Depois:
sucesso -> Histórico de links enviados
falha -> Links com Falha
