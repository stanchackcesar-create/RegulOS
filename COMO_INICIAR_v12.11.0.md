# RegulOS v12.11.0 — inicialização corrigida

## Para usar
1. Extraia esta pasta.
2. Dê duplo clique em `INICIAR_REGULOS.bat`.
3. Na primeira execução, o arquivo instala automaticamente as dependências se `node_modules` ainda não existir.
4. O Supervisor é aberto e o navegador é aberto quando `/api/health` responder.
5. Se o navegador não abrir, use `http://127.0.0.1:3000`.

## Novo QR
Gerar um novo QR inicia uma nova sessão e limpa:
- histórico de links;
- falhas de links (registros de erro no histórico);
- grupos;
- agendamentos/programações;
- sessão de autenticação anterior.

Um simples reinício do RegulOS NÃO deve apagar esses dados.
