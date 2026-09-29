# RegulOS v12.8.1

## Melhorias desta rodada

- Timezone padrão do container definido como `America/Sao_Paulo`.
- Exemplo de ambiente criado em `.env.example`.
- Proteção de URLs externas contra destinos locais/privados e redirecionamentos suspeitos.
- Endpoint autenticado `/api/diagnostico` para verificar estado básico do serviço.
- Helper de retry para envio WhatsApp em falhas transitórias.
- Inicializador Windows `ABRIR_REGULOS.vbs` para iniciar sem janela de CMD.
- Versão atualizada para 12.8.1.

## Próxima rodada recomendada

- Gerar e versionar `package-lock.json` em ambiente com acesso ao npm.
- Adicionar Playwright/Chromium como fallback somente quando a extração HTTP não encontrar imagem/título.
- Migrar persistência operacional de JSON para PostgreSQL.
- Implementar estados de entrega PENDENTE/ENVIANDO/SUCESSO/ERRO.
- Criar permissões detalhadas e auditoria.
