const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'src', 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');
let changed = false;

function replaceOnce(oldText, newText, label) {
  if (source.includes(newText)) return;
  if (!source.includes(oldText)) {
    console.log(`[boot] ${label}: bloco não encontrado (talvez já corrigido).`);
    return;
  }
  source = source.replace(oldText, newText);
  changed = true;
  console.log(`[boot] ${label}: corrigido.`);
}

// 1) Uma reconexão não pode desligar novamente os grupos que o usuário já ligou.
replaceOnce(
`        // Por segurança, toda nova conexão começa com todos os grupos desligados.\n        // O envio só fica permitido depois que o usuário clicar em 🟢 Ligado.\n        for (const id of Object.keys(groupConfig)) {\n          groupConfig[id].ativo = false;\n        }\n        saveGroupsConfig();\n        await loadGroups();`,
`        // As configurações de grupos são persistentes. Uma reconexão do WhatsApp\n        // não deve desligar os grupos que o usuário já selecionou.\n        await loadGroups();`,
'persistência dos grupos'
);

// 2) Se nenhum grupo estiver ligado no instante do horário, o agendamento continua ativo.
replaceOnce(
`    if (!targets.length) {\n      item.status = 'pausado';\n      item.lastSkipKey = dateKey(now);\n      writeJson(FILES.schedules, linkSchedules);\n      addLog(\`Agendamento "\${item.nome}" aguardando: nenhum grupo Ligado.\`);\n      return;\n    }`,
`    if (!targets.length) {\n      item.status = 'agendado';\n      item.lastSkipKey = dateKey(now);\n      writeJson(FILES.schedules, linkSchedules);\n      addLog(\`Agendamento "\${item.nome}" aguardando: nenhum grupo Ligado. Tentará novamente.\`);\n      return;\n    }`,
'agendamento sem grupo ativo'
);

// 3) Grupo desligado não conta como envio concluído.
replaceOnce(
`    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id) || getGroupConfig(id).ativo === false);`,
`    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id));`,
'conclusão por grupo'
);

// 4) Agendamentos de links são independentes da programação geral do bot.
// O painel já informa que a programação geral é separada; um horário salvo em
// Agendamentos deve disparar no horário escolhido, sem ser pausado por uma
// janela geral do bot.
replaceOnce(
`  if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;`,
`  if (runningLinkSchedules.has(item.id) || !online || !sock) return;`,
'agendamento independente da programação geral'
);
replaceOnce(
`      if (!botWindowActive()) {\n        item.status = 'pausado';\n        writeJson(FILES.schedules, linkSchedules);\n        addLog(\`Agendamento "\${item.nome}" pausado no fim do horário. Retomará do próximo grupo.\`);\n        break;\n      }`,
`      if (!online || !sock) {\n        item.status = 'pausado';\n        writeJson(FILES.schedules, linkSchedules);\n        addLog(\`Agendamento "\${item.nome}" pausado porque o WhatsApp ficou desconectado. Retomará do próximo grupo.\`);\n        break;\n      }`,
'agendamento não pausado pela janela geral'
);
replaceOnce(
`      item.status = botWindowActive() ? 'enviando' : 'pausado';\n      writeJson(FILES.schedules, linkSchedules);`,
`      item.status = online && sock ? 'enviando' : 'pausado';\n      writeJson(FILES.schedules, linkSchedules);`,
'status do agendamento após pausa'
);

// 5) O processador dos agendamentos também não pode ser bloqueado pela janela geral.
replaceOnce(
`async function processLinkSchedules() {\n  if (!online || !botWindowActive()) return;`,
`async function processLinkSchedules() {\n  if (!online) return;`,
'processador de agendamentos independente'
);
replaceOnce(
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!botWindowActive()) return;`,
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!online || !sock) return;`,
'fila de agendamentos independente'
);

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[boot] Correções de agendamento aplicadas ao runtime.');
} else {
  console.log('[boot] Nenhuma correção de agendamento pendente.');
}

require(serverPath);
