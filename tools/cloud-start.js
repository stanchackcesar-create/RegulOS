const { spawnSync } = require('child_process');

function run(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Ajustes de interface são aplicados dentro do container antes do servidor.
run('tools/apply-mobile-ui.js');

// Inicializador oficial do RegulOS: aplica correções de runtime antes de
// iniciar o servidor HTTP. Esses scripts precisam terminar antes do boot.
run('tools/preboot-regulos.js');

// Mantém o processo principal vivo no Railway.
// O servidor HTTP é o processo que deve permanecer escutando a porta PORT.
// O Volume continua sendo usado pelo próprio src/server.js para dados e sessão.
const server = spawnSync(process.execPath, ['src/server.js'], { stdio: 'inherit' });

if (server.error) throw server.error;
process.exit(server.status === null ? 1 : server.status);
