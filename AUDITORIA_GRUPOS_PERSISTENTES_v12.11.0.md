# Auditoria — Persistência dos grupos selecionados — RegulOS v12.11.0

## Regra implementada

Quando o usuário liga um grupo no Gerenciador de Grupos, a configuração `ativo: true` fica persistida em `grupos_config.json`.

Ao salvar/agendar um link, o RegulOS **não altera** essa configuração.

Uma reconexão normal também **não desliga** os grupos.

## Quando os grupos são limpos

A limpeza permanece somente nos fluxos que representam uma nova sessão:

- Novo QR Code
- Desconectar
- Deslogar

Nesses casos, os grupos/seleções da sessão anterior são apagados conforme a regra definida para troca de número/sessão.

## Verificação técnica

- `src/server.js`: sintaxe validada com `node --check`.
- `activeGroups()` continua usando `getGroupConfig(id).ativo`.
- O agendador usa os grupos ativos sem alterar suas configurações.
- O endpoint `/api/grupos/config` continua sendo responsável por ligar/desligar manualmente.
- O fluxo de Novo QR continua limpando grupos e agendamentos.

## Resultado esperado

Exemplo:

1. Usuário liga Grupo A.
2. Usuário agenda Link 1.
3. Grupo A continua ligado.
4. Link 1 é enviado para Grupo A no horário programado.
5. Depois do envio, Grupo A continua ligado para os próximos agendamentos.
6. Somente Novo QR/Desconectar/Deslogar inicia a limpeza da sessão anterior.
