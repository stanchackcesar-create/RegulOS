# RegulOS v12.9.1 — Entrega confiável

## Objetivo

Adicionar uma camada persistente de estado de entrega para reduzir perdas e duplicações quando o servidor reinicia ou uma conexão cai.

## Estados

- `PENDENTE` — aguardando envio.
- `ENVIANDO` — envio em andamento.
- `SUCESSO` — envio confirmado pela resposta do Baileys.
- `ERRO` — falha após tentativa(s).

## Persistência

Os estados ficam em:

`entregas_links.json`

A estrutura foi criada para permitir que a fila continue sendo aprimorada sem substituir imediatamente os arquivos JSON existentes.

## Retentativas

A função `sendReliableMessage()` tenta até 3 vezes, com espera progressiva.

## Idempotência

Um item já marcado como `SUCESSO` não é reenviado pela função confiável.

## API

- `GET /api/entregas` — consulta estados do usuário autenticado.
- `DELETE /api/entregas` — administrador pode limpar os estados.

## Próxima etapa

Integrar a função confiável diretamente em cada ponto do fluxo de envio/agendamento, usando uma chave estável por `agendamento + grupo + link`, e então criar uma tela visual de fila/entrega no painel.
