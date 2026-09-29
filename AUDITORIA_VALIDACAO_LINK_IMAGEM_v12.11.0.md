# Auditoria — Validação de link e imagem — RegulOS v12.11.0

## Regra implementada
Antes de salvar/programar um link, o painel faz uma pré-validação no servidor.

1. O RegulOS verifica se a URL do produto pode ser acessada.
2. Se a URL do produto não puder ser encontrada/acessada, o salvamento é interrompido e o painel informa para corrigir a URL.
3. Se uma URL de imagem manual for informada, o RegulOS testa essa URL.
4. Se a imagem manual não puder ser baixada, o salvamento é interrompido e o painel pede outra URL direta de imagem.
5. Se a busca automática de imagem estiver ativa e uma imagem puder ser encontrada/baixada, o link é aceito sem mensagem de erro.
6. Se a busca automática estiver ativa, mas nenhuma imagem puder ser encontrada/baixada, o painel informa que a imagem precisa ser fornecida manualmente.
7. Se a busca automática estiver desativada e não houver URL manual, o link pode ser agendado sem imagem.

## Execução posterior
A rotina de envio continua protegida pela validação existente: se uma imagem automática ou manual falhar no momento do envio, a ocorrência vai para **Links com Falha** e não é enviada somente como texto.

## Verificação de sintaxe
- `src/server.js`: `node --check` OK.
- JavaScript embutido de `public/index.html`: extraído e validado com `node --check` OK.
