# Auditoria — Rolagem interna de Agendamentos — RegulOS v12.11.0

Alteração:
- O painel `📅 Agendamentos` agora possui rolagem interna.
- Limite em telas maiores: 520px de altura.
- Em telas menores: 60vh.
- A página principal deixa de crescer indefinidamente por causa da lista de agendamentos.
- A rolagem é somente da lista, mantendo o cabeçalho e os demais painéis fora dela.
- Scrollbar estilizada e `overscroll-behavior: contain` para evitar propagação desnecessária.

Validações:
- `public/index.html`: JavaScript verificado com `node --check`.
- `src/server.js`: verificado com `node --check`.
