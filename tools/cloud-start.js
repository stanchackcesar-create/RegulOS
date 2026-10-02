const { spawnSync } = require('child_process');

function run(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// Ajustes de interface são aplicados dentro do container antes do servidor.
run('tools/apply-mobile-ui.js');
// Inicializador oficial do RegulOS: conexão, sessão e correções de runtime.
run('tools/preboot-regulos.js');
