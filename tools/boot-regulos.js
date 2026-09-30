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

function patchSection(startText, endText, replacements, label) {
  const start = source.indexOf(startText);
  if (start < 0) {
    console.log(`[boot] ${label}: início não encontrado.`);
    return;
  }
  const end = source.indexOf(endText, start);
  if (end < 0) {
    console.log(`[boot] ${label}: fim não encontrado.`);
    return;
  }
  let section = source.slice(start, end);
  let sectionChanged = false;
  for (const [oldText, newText] of replacements) {
    if (section.includes(newText)) continue;
    if (!section.includes(oldText)) continue;
    section = section.replace(oldText, newText);
    sectionChanged = true;
  }
  if (sectionChanged) {
    source = source.slice(0, start) + section + source.slice(end);
    changed = true;
    console.log(`[boot] ${label}: corrigido.`);
  }
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

// 6) Reaplica as regras diretamente dentro das funções críticas, mesmo que o
// server.js tenha recebido uma versão intermediária diferente.
patchSection(
  'async function sendScheduledLink(item) {',
  'async function processLinkSchedules() {',
  [
    [`if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;`, `if (runningLinkSchedules.has(item.id) || !online || !sock) return;`],
    [`if (!botWindowActive()) {`, `if (!online || !sock) {`],
    [`item.status = botWindowActive() ? 'enviando' : 'pausado';`, `item.status = online && sock ? 'enviando' : 'pausado';`]
  ],
  'endurecimento do envio agendado'
);

patchSection(
  'async function processLinkSchedules() {',
  'async function startLinkScheduler() {',
  [
    [`if (!online || !botWindowActive()) return;`, `if (!online || !sock) return;`],
    [`if (!botWindowActive()) return;`, `if (!online || !sock) return;`],
    [`    if (!scheduleDue(item, now)) return;`, `    if (!scheduleDue(item, now)) return;\n    addLog(\`Agendamento "\${item.nome}" chegou ao horário; iniciando tentativa de envio.\`);`]
  ],
  'diagnóstico do processador de agendamentos'
);

// 7) Reenvio de uma falha não pode depender do agendamento original.
// O envio de uma vez é removido de Agendamentos quando falha, portanto o
// endpoint de Reenviar precisa reconstruir o item a partir do registro de falha.
replaceOnce(
`  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item) return res.status(404).json({ok:false,msg:'O link associado à falha não está mais no Gerenciador de Links.'});`,
`  let item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item){\n    const imagemFalhou=String(failure.erro||'').toLowerCase().startsWith('imagem:');\n    item={\n      id:String(failure.agendamentoId||('reenvio-'+failure.id)),\n      nome:failure.nome||'Reenvio de link',\n      url:String(failure.url||'').trim(),\n      mensagem:failure.mensagem||'',\n      data:failure.data||new Date().toISOString().slice(0,10),\n      horario:failure.horario||new Date().toTimeString().slice(0,5),\n      repeticao:'uma_vez',\n      intervaloMin:Number(failure.intervaloMin||1),\n      intervaloMax:Number(failure.intervaloMax||1),\n      imagemAutomatica:true,\n      imagemUrl:imagemFalhou?'':String(failure.imagemUrl||''),\n      imagemStatus:'',\n      tituloProduto:failure.tituloProduto||'',\n      grupoId:String(failure.grupoId||''),\n      reenvioGrupoId:String(failure.grupoId||''),\n      ativo:true,\n      status:'agendado'\n    };\n    addLog(\`Reenvio: reconstruindo "\${item.nome}" a partir da falha \${failure.id}.\`);\n  }`,
'reenvio independente do agendamento original'
);

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[boot] Correções de agendamento aplicadas ao runtime.');
} else {
  console.log('[boot] Nenhuma correção de agendamento pendente.');
}

require(serverPath);
