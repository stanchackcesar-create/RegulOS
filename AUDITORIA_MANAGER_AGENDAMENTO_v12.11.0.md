# Auditoria — Gerenciador x Agendamentos — RegulOS v12.11.0

## Regra implementada
O Gerenciador de Links é apenas a área para criar/editar uma programação.

Depois que um link é salvo:
- ele não é exibido como cartão dentro do Gerenciador;
- ele fica exclusivamente em **Agendamentos** enquanto aguarda a execução;
- quando uma ocorrência única é concluída com sucesso, sai de Agendamentos e vai para o Histórico de Links Enviados;
- quando uma ocorrência única falha, sai de Agendamentos e vai para Links com Falha;
- links recorrentes continuam em Agendamentos para a próxima ocorrência.

## Correção adicional
Foi adicionada política `Cache-Control: no-store` para páginas HTML, evitando que o navegador mantenha uma versão antiga do painel e volte a mostrar cartões no Gerenciador.

## Validações
- `node --check src/server.js`: OK
- `node --check src/supervisor.js`: OK
- JavaScript embutido de `public/index.html`: OK
