const { spawn } = require('child_process');

function runPreboot(script) {
  console.log('[cloud-start] executando ' + script);
  const child = require('child_process').spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    console.error('[cloud-start] preboot terminou com código ' + child.status);
    process.exit(child.status || 1);
  }
  console.log('[cloud-start] concluído: ' + script);
}

process.on('uncaughtException', (err) => {
  console.error('[cloud-start] erro não tratado:', err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[cloud-start] promessa rejeitada:', err && err.stack ? err.stack : err);
  process.exit(1);
});

try {
  console.log('[cloud-start] RegulOS iniciando...');
  console.log('[cloud-start] PORT=' + (process.env.PORT || '3000'));
  console.log('[cloud-start] HOST=' + (process.env.HOST || '0.0.0.0'));

  // Os patches precisam terminar antes do servidor ser carregado.
  runPreboot('tools/apply-mobile-ui.js');
  runPreboot('tools/preboot-regulos.js');

  console.log('[cloud-start] iniciando src/server.js...');

  // O servidor é o processo que mantém a aplicação viva no Railway.
  // spawn permite capturar claramente qualquer erro de inicialização.
  const server = spawn(process.execPath, ['src/server.js'], {
    stdio: 'inherit',
    env: process.env
  });

  server.on('error', (err) => {
    console.error('[cloud-start] não foi possível iniciar src/server.js:', err.stack || err);
    process.exit(1);
  });

  server.on('exit', (code, signal) => {
    console.error('[cloud-start] src/server.js encerrou. código=' + code + ' sinal=' + signal);
    process.exit(code === null ? 1 : code);
  });
} catch (err) {
  console.error('[cloud-start] falha fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
}
