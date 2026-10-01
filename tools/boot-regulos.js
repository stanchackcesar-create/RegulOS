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
  if (start < 0) { console.log(`[boot] ${label}: início não encontrado.`); return; }
  const end = source.indexOf(endText, start);
  if (end < 0) { console.log(`[boot] ${label}: fim não encontrado.`); return; }
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

replaceOnce(
`        // Por segurança, toda nova conexão começa com todos os grupos desligados.\n        // O envio só fica permitido depois que o usuário clicar em 🟢 Ligado.\n        for (const id of Object.keys(groupConfig)) {\n          groupConfig[id].ativo = false;\n        }\n        saveGroupsConfig();\n        await loadGroups();`,
`        // As configurações dos grupos são persistentes entre reconexões.\n        await loadGroups();`,
'persistência dos grupos'
);

replaceOnce(
`  if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;`,
`  if (runningLinkSchedules.has(item.id) || !online || !sock) return;`,
'agendamento independente da programação geral'
);
replaceOnce(
`async function processLinkSchedules() {\n  if (!online || !botWindowActive()) return;`,
`async function processLinkSchedules() {\n  if (!online || !sock) return;`,
'processador independente da programação geral'
);
replaceOnce(
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!botWindowActive()) return;`,
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!online || !sock) return;`,
'fila independente da programação geral'
);

patchSection(
  'async function sendScheduledLink(item) {',
  'async function processLinkSchedules() {',
  [
    [
`  } else {\n    targets = activeGroups();\n    if (!targets.length) {`,
`  } else {\n    const explicitIds = [...new Set([\n      item.reenvioGrupoId,\n      item.grupoId,\n      ...(Array.isArray(item.grupoIds) ? item.grupoIds : [])\n    ].map(v => String(v || '').trim()).filter(Boolean))];\n    targets = explicitIds.length ? explicitIds : activeGroups();\n    if (!targets.length) {\n      item.status = 'agendado';\n      item.lastSkipKey = dateKey(now);\n      writeJson(FILES.schedules, linkSchedules);\n      addLog(\`Agendamento "\${item.nome}" aguardando destino/grupos disponíveis; tentará novamente.\`);\n      return;\n    }`
    ],
    [
`      // Se o grupo foi desligado desde o início da ocorrência, não enviamos.\n      if (getGroupConfig(id).ativo === false) continue;`,
`      // Grupo explícito do agendamento é o destino e não depende do botão global.\n      const hasExplicitTarget = Boolean(String(item.reenvioGrupoId || item.grupoId || '').trim()) || Array.isArray(item.grupoIds);\n      if (!hasExplicitTarget && getGroupConfig(id).ativo === false) continue;`
    ],
    [
`      if (!botWindowActive()) {\n        item.status = 'pausado';\n        writeJson(FILES.schedules, linkSchedules);\n        addLog(\`Agendamento "\${item.nome}" pausado no fim do horário. Retomará do próximo grupo.\`);\n        break;\n      }`,
`      if (!online || !sock) {\n        item.status = 'pausado';\n        writeJson(FILES.schedules, linkSchedules);\n        addLog(\`Agendamento "\${item.nome}" pausado porque o WhatsApp ficou desconectado. Retomará quando reconectar.\`);\n        break;\n      }`
    ],
    [
`      item.status = botWindowActive() ? 'enviando' : 'pausado';\n      writeJson(FILES.schedules, linkSchedules);`,
`      item.status = online && sock ? 'enviando' : 'pausado';\n      writeJson(FILES.schedules, linkSchedules);`
    ],
    [
`    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id) || getGroupConfig(id).ativo === false);`,
`    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id));`
    ],
    [
`    item.status = item.repeticao === 'uma_vez' ? 'pausado' : 'agendado';`,
`    item.status = item.repeticao === 'uma_vez' ? 'concluido' : 'agendado';`
    ],
    [
`        if (productImage) {\n          await sock.sendMessage(id, { image: productImage.buffer, caption: text });\n        } else {\n          await sock.sendMessage(id, { text });\n        }`,
`        if (!productImage || !productImage.buffer) {\n          throw new Error('Imagem obrigatória não disponível; envio bloqueado.');\n        }\n        if (typeof sock.waitForSocketOpen === 'function') await sock.waitForSocketOpen();\n        await sock.sendMessage(id, { image: productImage.buffer, caption: text });`
    ],
    [
`      try {\n        // Registramos a intenção antes do envio.`,
`      try {\n        if (typeof sock.waitForSocketOpen === 'function') await sock.waitForSocketOpen();\n        // Registramos a intenção antes do envio.`
    ]
  ],
  'fluxo completo do agendamento'
);

// Oferta automática: a imagem retornada pelo preview pode ser uma URL temporária.
// Nesse modo, sempre refaça a busca/validação da imagem no momento do envio.
replaceOnce(
`    if(String(item.imagemUrl||'').trim()) image=await downloadBuffer(String(item.imagemUrl).trim(),String(item.url||'').trim());\n    else image=await findProductImage(String(item.url||'').trim());`,
`    if(!item.autoOfertaAutomatica && String(item.imagemUrl||'').trim()) image=await downloadBuffer(String(item.imagemUrl).trim(),String(item.url||'').trim());\n    else image=await findProductImage(String(item.url||'').trim());`,
'oferta automática: ignorar URL de preview'
);

replaceOnce(
`  if(b.rearmar===true) item.lastRunKey='';\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
`  const estavaPausado = item.status === 'pausado' || item.status === 'erro';\n  if(b.rearmar===true || (b.ativo===true && estavaPausado)){\n    item.lastRunKey=''; item.lastSkipKey=''; item.progressKey='';\n    item.progressTargets=[]; item.progressGroupIds=[]; item.progressStartedAt='';\n    item.enviados=0; item.sucessos=0; item.erros=0;\n    item.ultimoEnvio=null; item.lastSentAt=null; item.motivoFalha=null;\n    item.status='agendado';\n  }\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
'reativação limpa'
);

replaceOnce(
`  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item) return res.status(404).json({ok:false,msg:'O link associado à falha não está mais no Gerenciador de Links.'});`,
`  let item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item){\n    const imagemFalhou=String(failure.erro||'').toLowerCase().startsWith('imagem:');\n    item={id:String(failure.agendamentoId||('reenvio-'+failure.id)),nome:failure.nome||'Reenvio de link',url:String(failure.url||'').trim(),mensagem:failure.mensagem||'',data:failure.data||new Date().toISOString().slice(0,10),horario:failure.horario||new Date().toTimeString().slice(0,5),repeticao:'uma_vez',intervaloMin:Number(failure.intervaloMin||1),intervaloMax:Number(failure.intervaloMax||1),imagemAutomatica:true,imagemUrl:imagemFalhou?'':String(failure.imagemUrl||''),imagemStatus:'',tituloProduto:failure.tituloProduto||'',grupoId:String(failure.grupoId||''),reenvioGrupoId:String(failure.grupoId||''),ativo:true,status:'agendado'};\n  }`,
'reenvio independente do agendamento original'
);

patchSection(
  'async function findProductImage(url) {',
  'let regulosBrowserPromise=null;',
  [[
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  return null;\n}`,
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  try {\n    const browserImage = await findProductImageWithBrowser(url);\n    if (browserImage) { addLog('🖼️ Imagem encontrada pelo fallback do navegador.'); return browserImage; }\n  } catch (e) { addLog(\`Fallback de imagem pelo navegador falhou: \${e.message}\`); }\n  return null;\n}`
  ]],
  'fallback final de imagem'
);

patchSection(
  'async function processLinkSchedules() {',
  'async function startLinkScheduler() {',
  [[
`    if (!scheduleDue(item, now)) return;`,
`    if (!scheduleDue(item, now)) return;\n    addLog(\`Agendamento "\${item.nome}" chegou ao horário; destino: \${item.grupoId || item.reenvioGrupoId || 'grupos ativos legados'}.\`);`
  ]],
  'log de destino do agendamento'
);


// v12.11.0 — correção final do fluxo da fila de agendamentos
// Falha de envio/imagem encerra somente a ocorrência e libera os próximos links.
function patchSchedulerFlowV11() {
  const before = source;

  source = source.replace(
    'async function sendScheduledLink(item) {\n  if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;',
    'async function sendScheduledLink(item) {\n  if (runningLinkSchedules.has(item.id) || !online || !sock) return;'
  );

  source = source.replace(
    "      item.status = 'erro'; item.ativo = false; writeJson(FILES.schedules, linkSchedules);\n      return;",
    "      item.status = 'erro'; item.ativo = false; item.lastRunKey = item.progressKey || occurrenceKey(item, new Date()); item.progressKey = ''; item.progressTargets = []; item.progressGroupIds = []; item.progressStartedAt = ''; writeJson(FILES.schedules, linkSchedules);\n      addLog(`Agendamento \\\"${item.nome}\\\" movido para Links com falha; fila liberada.`);\n      return;"
  );

  const failureNeedle = "    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id));\n    if (allDone) {";
  const failureInsert = [
    "    const connectionLost = !online || !sock;",
    "    const executionFailed = Number(errors || 0) > 0;",
    "    if (connectionLost && (item.progressTargets || []).some(id => !(item.progressGroupIds || []).includes(id))) {",
    "      item.status = 'pausado';",
    "      writeJson(FILES.schedules, linkSchedules);",
    "      addLog(`Agendamento \\\"${item.nome}\\\" pausado por desconexão; progresso preservado.`);",
    "      return;",
    "    }",
    "    if (executionFailed) {",
    "      item.lastRunKey = item.progressKey || occurrenceKey(item, new Date());",
    "      item.lastRunAt = new Date().toISOString();",
    "      item.progressKey = '';",
    "      item.progressTargets = [];",
    "      item.progressGroupIds = [];",
    "      item.progressStartedAt = '';",
    "      if (item.repeticao === 'uma_vez') { item.ativo = false; item.status = 'erro'; }",
    "      else { item.status = 'agendado'; }",
    "      writeJson(FILES.schedules, linkSchedules);",
    "      addLog(`Agendamento \\\"${item.nome}\\\" falhou nesta ocorrência; fila liberada para o próximo link.`);",
    "      return;",
    "    }",
    failureNeedle
  ].join("\n");
  if (source.includes(failureNeedle) && !source.includes('executionFailed = Number(errors || 0)')) {
    source = source.replace(failureNeedle, failureInsert);
  }

  source = source.replace(
    'async function processLinkSchedules() {\n  if (!online || !botWindowActive()) return;',
    'async function processLinkSchedules() {\n  if (!online || !sock) return;'
  );

  source = source.replace(
    '  for (let guard = 0; guard < queue.length; guard++) {\n    if (!botWindowActive()) return;',
    '  for (let guard = 0; guard < queue.length; guard++) {\n    if (!online || !sock) return;'
  );

  source = source.replace(
    '    const item = currentQueue[idx];',
    '    let item = currentQueue[idx];'
  );

  const dueNeedle = '    const now = new Date();\n    if (!scheduleDue(item, now)) return;';
  const dueReplacement = [
    '    const now = new Date();',
    '    if (!scheduleDue(item, now)) {',
    '      const due = currentQueue.filter(x => scheduleDue(x, now));',
    '      if (!due.length) return;',
    '      item = due[0];',
    '      linkQueue.currentId = String(item.id);',
    '      linkQueue.cursor = Math.max(0, currentQueue.findIndex(x => String(x.id) === String(item.id)));',
    '      saveLinkQueue();',
    '    }',
    '    const before = item.lastRunKey;'
  ].join("\n");
  if (source.includes(dueNeedle)) {
    source = source.replace(dueNeedle, dueReplacement);
  }

  if (source !== before) {
    changed = true;
    console.log('[boot] Fluxo do agendador corrigido: falhas liberam a fila e itens devidos não ficam bloqueados por horário futuro.');
  }
}
patchSchedulerFlowV11();

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[boot] Runtime consolidado de agendamento, destino, imagem e conexão aplicado.');
} else {
  console.log('[boot] Nenhuma correção de runtime pendente.');
}

require(serverPath);
