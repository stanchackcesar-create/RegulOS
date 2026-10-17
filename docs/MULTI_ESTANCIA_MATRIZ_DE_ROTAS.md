# Matriz de isolamento das rotas — RegulOS

Base de referência: `teste-restauracao-completa-2026-10-04`. Este documento é uma análise estática; não representa testes de execução.

## Ordem dos middlewares

- As rotas de autenticação são definidas antes do middleware global.
- `app.use(requireAuth)` aparece antes de servir os arquivos estáticos e antes da maior parte das rotas operacionais.
- Isso ajuda a exigir login, mas **não** isola registros: as rotas ainda leem e alteram arrays globais.
- `/api/network`, `/api/health`, endpoints de autenticação e o callback OAuth da Shopee ficam antes do middleware global. Cada exceção deve ser avaliada individualmente; não se deve mover o callback OAuth sem preservar o fluxo de autorização.

## Matriz de risco funcional

| Área | Exemplos de endpoints/funções | Estado atual observado | Alteração necessária |
|---|---|---|---|
| Sessão/QR | `/api/status`, `/api/qr`, `start()`, `/api/reconectar`, `/api/desconectar` | Socket e estado globais | Resolver a sessão a partir de `req.user.id`; estado e QR por usuário |
| Grupos | `/api/grupos`, `/api/grupos/config`, `loadGroups()`, `activeGroups()` | Lista permitida e configuração globais | Grupos pertencentes ao usuário e obtidos pela sessão dele |
| Mensagem imediata | `/api/mensagem` | Envia por `sock` global para grupos globais | Validar usuário, grupos permitidos e socket do proprietário |
| Links | `/api/links`, listas de links | Arrays globais | Armazenamento por usuário e IDs limitados ao proprietário |
| Agendamentos | `/api/link-agendamentos`, `sendScheduledLink()`, `processLinkSchedules()` | Lista global e verificação de estado global | Agendamento com proprietário; processador percorre cada contexto sem misturar sessões |
| Fila | `fila_links.json`, `syncLinkQueue()`, `orderedLinks()` | Uma fila/cursor global | Cursor, estado e bloqueio de execução por usuário |
| Falhas/reenvio | `/api/link-falhas`, subrota `reenviar` | Falha aponta para agenda global e envia por socket global | Confirmar que falha e agenda pertencem ao usuário; enviar pelo socket dele |
| Histórico/entregas | `/api/link-historico`, `/api/entregas` | Listas globais | Consultas, exclusões e gravações filtradas por proprietário |
| Programação do bot | `/api/programacao` | Um horário global | Janela e preferências independentes por usuário |
| Dashboard/diagnóstico | `/api/dashboard`, `/api/diagnostico` | Contagens e estado globais | Agregar somente dados e sessão do usuário autenticado |
| Integração Shopee | `/api/integracoes/shopee/*` | Protegida como administradora, integração global | Decidir explicitamente se é integração da plataforma ou de cada conta; não duplicar sem requisitos |

## Contratos a implementar

1. Cada endpoint operacional deriva o contexto de `req.user.id`; não aceita um ID de usuário arbitrário no corpo como autoridade.
2. Operações por ID (editar, alternar, excluir, enviar agora, reenviar) verificam o proprietário antes de agir.
3. Os workers recebem um contexto de usuário explícito. Nenhum worker de envio pode usar um `sock` global como fallback para um usuário comum.
4. Reconexão, QR e desconexão de uma sessão nunca alteram o estado de outra.
5. O formato de armazenamento legado é preservado até haver migração planejada, cópia de segurança verificada e aprovação explícita.
6. A integração Shopee requer uma decisão de escopo (global administrada ou individual por usuário) antes da implementação multiusuário.

## Sequência recomendada

- Etapa A: testes unitários do armazenamento isolado (sem rede/WhatsApp).
- Etapa B: camada de contexto por usuário e testes de propriedade dos IDs.
- Etapa C: refatorar grupos e envio manual para resolver sessão do proprietário.
- Etapa D: refatorar agendamentos, fila, falhas, histórico e entregas.
- Etapa E: QR, reconexão, desconexão, painel e diagnóstico por usuário.
- Etapa F: testes de regressão de recursos existentes e validação no ambiente de laboratório.
- Etapa G: somente com autorização explícita, conectar a branch revisada ao serviço de laboratório no Railway Test.

## Testes mínimos antes de qualquer implantação

- Usuários A e B não compartilham grupos, configuração, links, agendamentos, filas, falhas, histórico nem entregas.
- A não consegue editar/excluir/enviar/re-enviar um ID pertencente a B.
- Uma falha no socket de A não bloqueia B.
- Desconectar A não encerra B.
- Nenhuma chamada de agendador envia usando sessão diferente da proprietária do item.
- Recursos existentes (Shopee, extração de ofertas, imagens obrigatórias, interface móvel, histórico e entregas) continuam cobertos por regressão.
