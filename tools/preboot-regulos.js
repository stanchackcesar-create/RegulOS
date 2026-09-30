const fs = require('fs');
const path = require('path');

// Pré-inicialização: garante que a Programação do Bot seja resetada
// sempre que o WhatsApp emitir connection === 'close'.
// O patch é idempotente e fica dentro do server.js em execução.
const ROOT = path.join(__dirname, '..');
const serverPath = path.join(ROOT, 'src', 'server.js');
const MARKER = 'REGULOS_RESET_BOT_SCHEDULE_ON_DISCONNECT_V1';

let source = fs.readFileSync(serverPath, 'utf8');

if (!source.includes(MARKER)) {
  const oldText = `      if (u.connection === 'close') {\n        online = false;`;
  const newText = `      if (u.connection === 'close') {\n        // ${MARKER}\n        // Ao perder a conexão do WhatsApp, a janela geral volta ao estado\n        // inicial. Os agendamentos de links continuam independentes dela.\n        botSchedule = { ativo: false, inicio: '', fim: '' };\n        saveBotSchedule();\n        addLog('📴 WhatsApp desconectado: programação do bot resetada.');\n        online = false;`;

  if (!source.includes(oldText)) {
    throw new Error('[preboot] Não encontrei o bloco connection === close para aplicar o reset da programação.');
  }

  source = source.replace(oldText, newText);
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[preboot] Reset da programação do bot ao desconectar aplicado.');
} else {
  console.log('[preboot] Reset da programação do bot já está aplicado.');
}

// Mantém o inicializador já usado pelo RegulOS, incluindo as correções
// de grupos, agendamentos, imagens e reconexão.
require(path.join(ROOT, 'tools', 'patch_scheduled_group.js'));
