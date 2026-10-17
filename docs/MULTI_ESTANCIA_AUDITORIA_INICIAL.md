# Auditoria inicial — Multi-Estância do RegulOS

**Data:** 2026-10-17  
**Branch-base:** `teste-restauracao-completa-2026-10-04`  
**Branch desta auditoria:** `audit/multi-estancia-isolamento-2026-10-17`

## Escopo e segurança

Esta etapa é uma auditoria estática do código. Não conecta contas reais do WhatsApp, não executa envios, não modifica configurações do Railway e não faz deploy. Nenhum dado operacional deve ser migrado, limpo ou sobrescrito durante a preparação.

## Achados principais

### 1. Autenticação já existente, mas sem propriedade por usuário

- As contas ficam em `usuarios.json`; sessões de login em `sessoes.json`.
- As senhas são derivadas com `crypto.scryptSync` e salt individual.
- O próprio comentário em `src/server.js` declara que usuários controlam apenas o acesso ao painel e que sessão WhatsApp e dados operacionais continuam compartilhados.
- O middleware de autenticação protege as rotas do painel depois da sua instalação, mas autenticar uma pessoa não filtra os registros por proprietário.

### 2. Dados operacionais globais

A configuração `FILES` aponta para um único diretório `DATA` e usa arquivos compartilhados:

- `grupos.json` e `grupos_config.json`
- `links.json`, `indice.txt`, `historico.json`
- `link_agendamentos.json`, `historico_links_enviados.json`
- `links_com_falha.json`, `entregas_links.json`
- `programacao_bot.json`, `fila_links.json`

As listas correspondentes são carregadas em variáveis globais no processo. O isolamento exige que leitura, gravação, filas, deduplicação e histórico usem o contexto do usuário, não apenas um caminho diferente para alguns arquivos.

### 3. Um socket global de WhatsApp

Em `src/server.js`, a conexão usa variáveis globais como `sock`, `qr`, `status`, `online`, `groups`, `allowed` e `groupConfig`. O agendador e a fila enviam mensagens por esse socket.

A implementação multi-sessão existente em um branch de protótipo não resolve sozinha o problema: as rotinas de agendamento, reenvio, mensagens manuais e fila ainda precisam receber explicitamente o usuário dono e usar a sessão desse usuário.

### 4. Rotas operacionais que precisam de isolamento

A revisão identificou, entre outras, estas rotas a revisar e testar:

- Status e conexão: `/api/status`, `/api/qr`, `/api/logs`, `/api/reconectar`, `/api/desconectar`, `/api/novo-qr`, `/api/deslogar`
- Grupos e mensagens: `/api/grupos`, `/api/grupos/atualizar`, `/api/grupos/config`, `/api/grupos/salvar`, `/api/mensagem`
- Links e agenda: `/api/links`, `/api/link-agendamentos`, `/api/programacao`, `/api/dashboard`
- Histórico, falhas e reenvios: `/api/link-historico`, `/api/link-falhas` e subrotas
- Entregas e diagnóstico: `/api/entregas`, `/api/diagnostico`

A exclusão ou reinicialização de dados (por exemplo, os fluxos de novo QR/deslogar) requer atenção especial para garantir que uma operação de um usuário nunca apague dados de outro.

### 5. Recursos atuais que não podem regredir

A implementação deve preservar, e testar após cada etapa, recursos existentes na branch-base, incluindo:

- Integração Shopee e seu fluxo OAuth
- Integração e extração de ofertas, inclusive Mercado Livre
- Agendamentos com seleção de grupos, fila, progresso e reenvio de falhas
- Registro de entregas, histórico e histórico de links enviados
- Regras de imagem obrigatória e correções de interface móvel
- O processo de inicialização atual (`tools/apply-mobile-ui.js` e `tools/preboot-regulos.js`)

O protótipo de outro branch não deve ser mesclado diretamente, pois sua base diverge da branch-base e ele não contém ainda todo o isolamento operacional.

## Plano de implementação seguro

1. Criar um contexto explícito por usuário para dados, grupos, configuração, sessão e logs.
2. Definir uma camada de armazenamento por usuário, com caminhos separados e validação contra traversal; manter os arquivos atuais como legado até existir plano de migração e backup validado.
3. Refatorar os endpoints para operar apenas sobre o usuário autenticado e validar a propriedade de cada ID recebido.
4. Alterar envio manual, reenvios, agendador e fila para receber o contexto do usuário e obter o socket da sessão correta.
5. Isolar a conexão, QR, estado, reconexão e encerramento por usuário; impedir que a desconexão de um usuário afete outro.
6. Criar testes automatizados com dois usuários sintéticos e sockets simulados: grupos, agendas, filas, históricos e exclusões não podem cruzar fronteiras.
7. Executar verificações de sintaxe e testes sem WhatsApp real; documentar resultados e limitações.
8. Só então conectar esta branch ao serviço isolado do Railway Test, com configuração e volume exclusivos, depois de revisar as diferenças e receber autorização explícita para ativar/deployar.

## Critérios de aceite

- Usuário A não consegue listar, editar, excluir, reenviar nem enviar usando dados de B.
- Cada agendamento só envia pelos grupos e pela sessão do proprietário.
- QR, status, reconexão e desconexão são independentes por usuário.
- A exclusão de um usuário tem política explícita para seus dados; não apaga dados de outros usuários.
- Os recursos atuais da branch-base permanecem presentes.
- Nenhum deploy é feito sem autorização explícita.

## Estado desta auditoria

**Concluído:** inspeção estática inicial e identificação dos principais pontos globais.  
**Pendente:** implementação e testes de isolamento.  
**Não executado:** testes runtime, envio WhatsApp, migração de dados, ativação de serviço/volume staged ou deploy.
