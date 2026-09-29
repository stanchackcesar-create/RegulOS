# RegulOS Cloud — Railway

Esta versão mantém o front-end e o back-end do RegulOS juntos em um único serviço Node.js no Railway.


## Modo nuvem desta revisão

O container foi ajustado para executar o `src/server.js` diretamente no Railway. O `src/supervisor.js` continua disponível para a execução local no Windows, mas não fica no caminho do processo principal da nuvem. Isso simplifica sinais de parada/reinício e deixa o Railway responsável pelo ciclo de vida do serviço.

### Configuração obrigatória no Railway

- Serviço com o Dockerfile deste pacote.
- Volume persistente montado em `/app/storage`.
- Domínio HTTPS público.
- `REGULOS_SESSION_SECRET` definido com um valor forte (variável reservada para evolução de sessões; mantenha-a configurada desde já).
- `REGULOS_TIMEZONE=America/Sao_Paulo`.
- Uma única instância do serviço enquanto a sessão do WhatsApp estiver sendo mantida dentro deste processo.

### O que permanece na nuvem

Painel, login, grupos, sessão WhatsApp/Baileys, fila, agendamentos, histórico, falhas/reenvio e busca de título/imagem continuam no mesmo serviço. O PC pode ficar desligado; o navegador do celular ou computador acessa o domínio HTTPS do Railway.

## O que muda
- O painel HTML é servido pelo próprio Node.js.
- Baileys roda no servidor continuamente.
- A sessão do WhatsApp fica persistida em um Volume do Railway.
- Dados, usuários, agendamentos e histórico ficam persistidos no mesmo Volume.
- Login por usuário e senha.
- Primeiro acesso cria a conta administradora.
- O administrador pode criar usuários adicionais dentro do painel.
- Todos os usuários autorizados usam a mesma instância do WhatsApp.

## Deploy recomendado
1. Crie um projeto no Railway.
2. Faça deploy deste diretório/repositório usando o Dockerfile.
3. Gere um domínio público em Networking.
4. Crie um Volume para o serviço e monte em `/app/storage`.
5. Aguarde o deploy ficar saudável.
6. Abra o domínio público. No primeiro acesso, crie o usuário administrador.
7. Entre no painel e conecte o WhatsApp pelo QR Code.
8. Crie os demais usuários dentro do painel pelo bloco de contas.

## Persistência
O código usa:
- `/app/storage/data` para dados do RegulOS.
- `/app/storage/auth` para as credenciais da sessão do WhatsApp.

O Volume `/app/storage` é obrigatório se você quiser que a sessão do WhatsApp e os dados sobrevivam a reinícios/deploys.

## Importante
Não é necessário deixar o navegador aberto para o agendador funcionar. O agendador e a conexão com o WhatsApp são processos do servidor.

## v12.8.0 — endurecimento cloud
- Horário padrão da nuvem: `America/Sao_Paulo`, configurável por `REGULOS_TIMEZONE`.
- O servidor bloqueia destinos internos na busca de título/imagem para reduzir risco de SSRF.
- Há limite básico de tentativas de login por endereço de origem.
- Operações críticas da sessão WhatsApp (`Reconectar`, `Desconectar`, `Novo QR` e `Deslogar`) ficam restritas ao administrador.
- O script `start` usa o supervisor automático, que reinicia o servidor se ele cair.
- `ABRIR_REGULOS.vbs` permite iniciar no Windows sem abrir manualmente PowerShell/CMD.

## Dependências
O pacote enviado não contém `package-lock.json`. Para produção, gere o lockfile em um ambiente com acesso ao npm e depois troque o Dockerfile para `npm ci --omit=dev`. Nesta revisão não foi inventado um lockfile, porque o ambiente de revisão não conseguiu baixá-lo do registry.

## Imagem/título
A extração HTTP continua sendo a primeira tentativa. Sites que dependem de JavaScript para renderizar produto/imagem ainda podem exigir a futura etapa com navegador automatizado.
