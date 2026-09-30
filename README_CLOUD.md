# RegulOS v12.11.0 — Cloud Railway

Versão preparada para execução no Railway.

## Estrutura
- `src/server.js` — servidor principal
- `src/supervisor.js` — supervisor para uso local
- `public/` — painel web
- `Dockerfile` — imagem de produção
- `railway.json` — configuração Railway
- `package.json` — dependências e inicialização

## Inicialização Cloud
O Railway executa `node src/server.js` na porta definida por `PORT`.

## Persistência
Crie um Volume Railway montado em `/app/storage`.
O RegulOS usa:
- `/app/storage/data`
- `/app/storage/auth`

## Usuários
A primeira conta criada é administradora. O administrador pode criar no máximo mais uma conta, totalizando 2 usuários.

## WhatsApp
Os dois usuários compartilham a mesma sessão do WhatsApp no servidor.
