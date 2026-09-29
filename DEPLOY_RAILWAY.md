# RegulOS v12.11.0 — Cloud / Railway

Este pacote preserva o código real do RegulOS v12.11.0 e foi preparado para execução direta no Railway.

## Estrutura obrigatória
- `src/server.js` — servidor principal e APIs do RegulOS
- `src/supervisor.js` — supervisor para execução local; não é usado pelo Railway
- `public/index.html` — painel principal
- `public/login.html` — login
- `public/configurar.html` — configuração inicial
- `public/grupos.html` — gerenciamento de grupos
- `Dockerfile` — imagem de produção
- `railway.json` — configuração do deploy
- `package.json` — dependências e scripts

## Railway
1. Conecte o repositório GitHub ao Railway.
2. O Railway detectará o `Dockerfile`.
3. Configure um Volume persistente montado em `/app/storage`.
4. Variáveis recomendadas:
   - `NODE_ENV=production`
   - `TZ=America/Sao_Paulo`
   - `REGULOS_TIMEZONE=America/Sao_Paulo`
   - `REGULOS_DATA_DIR=/app/storage/data`
   - `REGULOS_AUTH_DIR=/app/storage/auth`
5. O comando de produção é `npm start`, que executa `node src/server.js`.
6. O healthcheck é `/api/health`.

## Usuários simultâneos
Esta versão limita o cadastro e o uso simultâneo a 2 usuários. As contas do painel são independentes, enquanto a sessão do WhatsApp e os dados do RegulOS continuam compartilhados.

## Execução local
Para usar o supervisor local:
`npm run start:local`
