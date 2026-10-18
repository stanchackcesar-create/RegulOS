# Plano seguro de migração para Multi-Estância

## Objetivo

Separar os dados operacionais e a sessão WhatsApp de cada usuário sem remover funcionalidades atuais nem misturar dados entre contas.

## Regra de segurança

Este plano não autoriza deploy, ativação de serviços Railway, conexão de contas WhatsApp reais, alteração de domínio/variáveis/volumes existentes, nem migração ou exclusão de dados. Cada etapa precisa de validação própria antes da seguinte.

## Fase 1 — Inventário e contratos

- [x] Registrar os arquivos operacionais globais e as principais rotas.
- [x] Criar um protótipo de armazenamento por usuário.
- [x] Criar um protótipo de registro de runtime por usuário.
- [x] Criar gerenciador de ciclo de vida de sessões por usuário com conector injetável.
- [x] Criar adaptador Baileys com pasta de autenticação por usuário e limpeza de listeners.
- [ ] Executar e confirmar os testes a partir do checkout da branch.
- [ ] Revisar todos os consumidores de FILES, sock, groups, allowed, groupConfig e timers.

## Fase 2 — Contexto operacional por usuário

Cada contexto deverá ter, no mínimo:
- userId validado a partir da sessão autenticada no servidor (nunca confiar em userId enviado pelo navegador);
- diretório de dados dedicado;
- runtime/socket WhatsApp dedicado;
- grupos e configurações de grupo dedicados;
- links, agendamentos, fila, histórico, falhas e entregas dedicados;
- timers e tarefas em execução associados ao mesmo contexto;
- função de encerramento que cancele timers e feche apenas o socket daquele usuário.

## Fase 3 — Integração incremental

Ordem proposta:
1. Inicializar contexto autenticado e diretório por usuário, sem mudar ainda os envios.
2. Migrar leitura/gravação de grupos e configurações; validar A/B.
3. Migrar links, fila e agendamentos.
4. Migrar histórico, falhas, entregas e rotas de diagnóstico.
5. Integrar o adaptador Baileys e o gerenciador às rotas de sessão por usuário, com reconexão/desconexão isoladas.
6. Refatorar processadores e agendadores para receber contexto explicitamente, eliminando dependência de globais.
7. Auditar todas as rotas e tarefas de fundo contra acesso cruzado.

Não avançar de fase se os testes de isolamento da fase anterior falharem.

## Fase 4 — Dados legados e compatibilidade

- Não copiar automaticamente os arquivos globais para cada usuário.
- Antes de qualquer migração, gerar cópia de segurança e definir explicitamente qual conta é proprietária dos dados legados.
- Validar contagens e hashes antes/depois em ambiente isolado.
- Não apagar os arquivos antigos durante a primeira execução; manter plano de rollback.
- A migração só poderá ocorrer após aprovação explícita.

## Fase 5 — Critérios de aceitação

- Usuário A não lê, altera, envia nem agenda dados do usuário B.
- Desconectar/remover A não afeta a sessão B.
- Tarefas de A nunca enviam mensagens pela sessão B.
- Reiniciar o processo restaura cada sessão e seus dados no diretório correto.
- Shopee/extração de ofertas, exigência de imagem, fila, tentativas, entregas, histórico, UI móvel e funcionalidades existentes continuam cobertas por testes de regressão.
- Testes automatizados passam; depois, teste manual em laboratório com contas de teste e sem atingir grupos reais.
- Teste e Produção continuam separados; nenhum deploy de produção faz parte desta implementação.

## Estado atual

O armazenamento, o registro de runtimes, o gerenciador de sessões, o adaptador Baileys, o resolvedor de contexto HTTP autenticado, a fachada de domínio para operações de grupos e uma fila de operações mutáveis por usuário já existem como módulos separados. A fachada usa somente `req.user.id`, exige sessão/runtime do proprietário e valida os IDs de grupo contra o catálogo da própria sessão. A fila serializa operações da mesma conta, permite concorrência entre contas diferentes e permite continuar após falhas; seus testes foram adicionados ao script `test:multi-estancia`. Esses módulos ainda não estão integrados a `src/server.js`; as rotas e os processadores principais continuam usando estado global. A aplicação completa, portanto, ainda não oferece isolamento Multi-Estância. A execução da suíte nesta branch ainda precisa ser confirmada antes de avançar para integração de rotas.
