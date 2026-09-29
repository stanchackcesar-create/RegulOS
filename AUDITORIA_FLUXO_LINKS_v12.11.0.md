# Auditoria do fluxo de links — RegulOS v12.11.0

## Fluxo definido
1. O usuário cadastra o link no Gerenciador de Links.
2. Ao salvar, o link não permanece na lista principal do Gerenciador; ele aparece em **Agendamentos**.
3. Enquanto aguarda a data/hora, permanece em Agendamentos.
4. Quando chegar a hora, o servidor tenta executar o envio.
5. Se for uma programação **Uma vez** e todos os envios forem concluídos sem erro, o agendamento é removido e o registro é arquivado em **Histórico de links enviados**.
6. Se houver erro de envio ou a imagem obrigatória não puder ser obtida, o agendamento é removido e o registro vai para **Links com falha**.
7. Em Links com falha, **Reenviar** tenta o envio novamente sem exigir que o agendamento original ainda exista.
8. **Editar** uma falha abre o Gerenciador de Links preenchido. Ao salvar, é criado um novo agendamento e a falha é removida.
9. Se o reenvio for bem-sucedido, a falha é removida e o registro vai para o histórico de enviados.
10. Se o reenvio falhar novamente, a falha permanece no painel.

## Verificações executadas
- `node --check src/server.js`: OK.
- JavaScript inline de `public/index.html` com `node --check`: OK.
- Rotas presentes para histórico, falhas, reenvio, edição e exclusão de falha.
- Arquivos JSON continuam sendo persistidos no diretório de dados do RegulOS.
- URL de imagem manual continua disponível.
- Busca automática de imagem continua disponível.
- Gerenciador de grupos não foi removido.

## Observação
Links com repetição diária/semanal continuam em Agendamentos para a próxima ocorrência. A regra de mover para histórico/falhas após a execução é aplicada integralmente às programações de **Uma vez**, que são as que saem definitivamente da fila após a ocorrência.
