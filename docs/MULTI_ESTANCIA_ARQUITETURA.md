# RegulOS Multi-Estância — arquitetura de desenvolvimento

## Objetivo

Permitir que qualquer pessoa crie sua própria conta no formulário de login e use o RegulOS de forma independente, conectando seu próprio WhatsApp por QR Code. O desenvolvimento ocorre nesta branch isolada; não publicar nem mesclar automaticamente.

## Fluxo de entrada

1. A primeira configuração continua criando a conta administradora em `/configurar`.
2. Depois de configurado o administrador, a tela `/login` oferece login e cadastro público.
3. O cadastro público valida nome, nome de usuário exclusivo e senha com pelo menos 8 caracteres; as senhas são armazenadas usando scrypt com salt. O cadastro fica fechado por padrão e só pode ser habilitado explicitamente com `REGULOS_PUBLIC_SIGNUP_ENABLED=true` no ambiente isolado.
4. Cada conta recebe um ID UUID permanente e um registro de conta WhatsApp próprio.
5. A sessão web é criada com cookie HttpOnly e vinculada ao ID do usuário.
6. O QR Code deve ser iniciado e consultado somente pela conta autenticada, salvo acesso administrativo explicitamente autorizado.

## Separação de dados — regra obrigatória

Toda entidade operacional precisa ter um proprietário explícito, por exemplo `userId` ou `whatsappUserId`. O servidor deve obter o usuário autenticado da sessão; não deve confiar em um ID de proprietário enviado pelo navegador sem validar a autorização.

A separação deverá cobrir, no mínimo:

- diretório de autenticação Baileys por usuário;
- conexão/socket e estado de QR por usuário;
- grupos e configurações de grupos;
- links, fila de envio e itens em processamento;
- agendamentos e execução pelo WhatsApp proprietário;
- histórico de envios, falhas e limpeza automática;
- preferências e configurações do painel.

## Estado desta primeira etapa

Implementado nesta branch:
- endpoint de cadastro público implementado, mas bloqueado por padrão; para testá-lo, habilitar `REGULOS_PUBLIC_SIGNUP_ENABLED=true` somente no ambiente local isolado;
- validação e unicidade do nome de usuário;
- limitação básica de tentativas de cadastro por IP;
- criação de ID próprio, sessão web e registro WhatsApp para a nova conta;
- formulário de cadastro na tela de login, oculto enquanto o cadastro público estiver desabilitado;
- inclusão do nome no perfil retornado pela API.

Ainda NÃO considerar a Multi-Estância pronta:
- auditar e completar o isolamento de todos os endpoints e arquivos operacionais;
- garantir que o agendador e as filas sempre usem o socket do proprietário;
- testar duas contas em paralelo com dados sintéticos;
- validar reinicialização, reconexão e persistência sem apagar dados de outras contas;
- executar testes automatizados e revisão de segurança.

## Base de código desta etapa\n\nEsta branch foi criada como experimento sobre a candidata `fix/multi-estancia-isolamento-2026-10-17`, que deriva de `feature/multi-estancia`. Ela **não é ainda uma atualização da branch atual do domínio** (`teste-restauracao-completa-2026-10-04`). Antes de qualquer implantação, será necessário reconciliar as alterações com a versão atual e preservar as funcionalidades mais recentes.\n\n## Regras de segurança e implantação

- Não conectar números reais nem enviar mensagens durante os testes iniciais.
- Usar somente contas de teste e dados sintéticos.
- Não migrar nem apagar dados legados automaticamente.
- Não alterar volumes, variáveis, domínio ou implantação do Railway Test/Production.
- Só propor implantação depois de auditoria, testes e plano de migração/retorno.
