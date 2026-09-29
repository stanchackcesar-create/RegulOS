# Auditoria — Links encurtados v12.11.0

- Links encurtados conhecidos (bit.ly, meli.la, tinyurl, t.co, amzn.to, lnkd.in e similares) são reconhecidos.
- A validação segue redirecionamentos HTTP/HTTPS e usa a URL final para procurar título e imagem.
- O link original/encurtado continua sendo preservado para o envio; a URL final serve para validação e busca de imagem.
- Se o encurtador não puder ser resolvido, o painel informa que a URL precisa ser corrigida ou informada manualmente.
- Se o destino for encontrado mas a imagem automática não for encontrada, o painel pede uma URL manual de imagem.
- Se a imagem automática ou manual for encontrada, não é exibido erro de validação.
- Segurança: cada redirecionamento continua passando pela validação de URL externa, bloqueando destinos locais/privados.
- Verificações: `node --check src/server.js` e `node --check` do JavaScript inline do painel passaram sem erro de sintaxe.
