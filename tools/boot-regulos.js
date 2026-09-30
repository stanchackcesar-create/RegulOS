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

// A sessão do WhatsApp não deve desligar as seleções de grupos a cada reconexão.
replaceOnce(
`        // Por segurança, toda nova conexão começa com todos os grupos desligados.\n        // O envio só fica permitido depois que o usuário clicar em 🟢 Ligado.\n        for (const id of Object.keys(groupConfig)) {\n          groupConfig[id].ativo = false;\n        }\n        saveGroupsConfig();\n        await loadGroups();`,
`        // As configurações dos grupos são persistentes entre reconexões.\n        await loadGroups();`,
'persistência dos grupos'
);

// A Programação Geral é independente dos agendamentos de links.
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

// Um agendamento explícito tem um único destino: o grupo escolhido ao salvar.
patchSection(
  'async function sendScheduledLink(item) {',
  'async function processLinkSchedules() {',
  [
    [
`  } else {\n    targets = activeGroups();\n    if (!targets.length) {`,
`  } else {\n    const explicitIds = [...new Set([\n      item.reenvioGrupoId,\n      item.grupoId,\n      ...(Array.isArray(item.grupoIds) ? item.grupoIds : [])\n    ].map(v => String(v || '').trim()).filter(Boolean))];\n    targets = explicitIds.length\n      ? explicitIds.filter(id => groups.some(g => String(g.id) === id))\n      : activeGroups();\n    if (!targets.length) {`
    ],
    [
`      // Se o grupo foi desligado desde o início da ocorrência, não enviamos.\n      if (getGroupConfig(id).ativo === false) continue;`,
`      // Quando o agendamento possui grupo explícito, esse grupo é o destino\n      // do agendamento e não depende do botão global de grupos.\n      const hasExplicitTarget = Boolean(String(item.reenvioGrupoId || item.grupoId || '').trim()) || Array.isArray(item.grupoIds);\n      if (!hasExplicitTarget && getGroupConfig(id).ativo === false) continue;`
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
`        if (!productImage || !productImage.buffer) {\n          throw new Error('Imagem obrigatória não disponível; envio bloqueado.');\n        }\n        if (typeof sock.waitForSocketOpen === 'function') {\n          await sock.waitForSocketOpen();\n        }\n        await sock.sendMessage(id, { image: productImage.buffer, caption: text });`
    ],
    [
`      try {\n        // Registramos a intenção antes do envio.`,
`      try {\n        if (typeof sock.waitForSocketOpen === 'function') {\n          await sock.waitForSocketOpen();\n        }\n        // Registramos a intenção antes do envio.`
    ]
  ],
  'fluxo completo do agendamento'
);

// Reativar um agendamento pausado deve criar uma nova ocorrência limpa.
replaceOnce(
`  if(b.rearmar===true) item.lastRunKey='';\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
`  const estavaPausado = item.status === 'pausado' || item.status === 'erro';\n  if(b.rearmar===true || (b.ativo===true && estavaPausado)){\n    item.lastRunKey='';\n    item.lastSkipKey='';\n    item.progressKey='';\n    item.progressTargets=[];\n    item.progressGroupIds=[];\n    item.progressStartedAt='';\n    item.enviados=0;\n    item.sucessos=0;\n    item.erros=0;\n    item.ultimoEnvio=null;\n    item.lastSentAt=null;\n    item.motivoFalha=null;\n    item.status='agendado';\n  }\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
'reativação limpa'
);

// Reenvio de uma falha continua funcionando mesmo depois que o agendamento foi arquivado/removido.
replaceOnce(
`  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item) return res.status(404).json({ok:false,msg:'O link associado à falha não está mais no Gerenciador de Links.'});`,
`  let item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item){\n    const imagemFalhou=String(failure.erro||'').toLowerCase().startsWith('imagem:');\n    item={\n      id:String(failure.agendamentoId||('reenvio-'+failure.id)),\n      nome:failure.nome||'Reenvio de link',\n      url:String(failure.url||'').trim(),\n      mensagem:failure.mensagem||'',\n      data:failure.data||new Date().toISOString().slice(0,10),\n      horario:failure.horario||new Date().toTimeString().slice(0,5),\n      repeticao:'uma_vez',\n      intervaloMin:Number(failure.intervaloMin||1),\n      intervaloMax:Number(failure.intervaloMax||1),\n      imagemAutomatica:true,\n      imagemUrl:imagemFalhou?'':String(failure.imagemUrl||''),\n      imagemStatus:'',\n      tituloProduto:failure.tituloProduto||'',\n      grupoId:String(failure.grupoId||''),\n      reenvioGrupoId:String(failure.grupoId||''),\n      ativo:true,\n      status:'agendado'\n    };\n  }`,
'reenvio independente do agendamento original'
);

// Fallback de imagem por navegador continua disponível como última tentativa.
patchSection(
  'async function findProductImage(url) {',
  'let regulosBrowserPromise=null;',
  [[
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  return null;\n}`,
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  try {\n    const browserImage = await findProductImageWithBrowser(url);\n    if (browserImage) {\n      addLog('🖼️ Imagem encontrada pelo fallback do navegador.');\n      return browserImage;\n    }\n  } catch (e) {\n    addLog(\`Fallback de imagem pelo navegador falhou: \${e.message}\`);\n  }\n  return null;\n}`
  ]],
  'fallback final de imagem'
);

// Logs de diagnóstico para o momento exato em que um agendamento fica devido.
patchSection(
  'async function processLinkSchedules() {',
  'async function startLinkScheduler() {',
  [[
`    if (!scheduleDue(item, now)) return;`,
`    if (!scheduleDue(item, now)) return;\n    addLog(\`Agendamento "\${item.nome}" chegou ao horário; destino: \${item.grupoId || item.reenvioGrupoId || 'grupos ativos legados'}.\`);`
  ]],
  'log de destino do agendamento'
);

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[boot] Runtime consolidado de agendamento, destino, imagem e conexão aplicado.');
} else {
  console.log('[boot] Nenhuma correção de runtime pendente.');
}

require(serverPath);
