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

// 1) Reconexão não desliga grupos já selecionados.
replaceOnce(
`        // Por segurança, toda nova conexão começa com todos os grupos desligados.\n        // O envio só fica permitido depois que o usuário clicar em 🟢 Ligado.\n        for (const id of Object.keys(groupConfig)) {\n          groupConfig[id].ativo = false;\n        }\n        saveGroupsConfig();\n        await loadGroups();`,
`        // Configurações de grupos são persistentes entre reconexões.\n        await loadGroups();`,
'persistência dos grupos'
);

// 2) Agendamento não fica pausado só porque nenhum grupo genérico está ligado.
replaceOnce(
`    if (!targets.length) {\n      item.status = 'pausado';\n      item.lastSkipKey = dateKey(now);\n      writeJson(FILES.schedules, linkSchedules);\n      addLog(\`Agendamento "\${item.nome}" aguardando: nenhum grupo Ligado.\`);\n      return;\n    }`,
`    if (!targets.length) {\n      item.status = 'agendado';\n      item.lastSkipKey = dateKey(now);\n      writeJson(FILES.schedules, linkSchedules);\n      addLog(\`Agendamento "\${item.nome}" aguardando: nenhum grupo Ligado. Tentará novamente.\`);\n      return;\n    }`,
'agendamento sem grupo ativo'
);

// 3) Um grupo desligado não conta como concluído.
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

// 5) O processador dos agendamentos também não depende da janela geral.
replaceOnce(
`async function processLinkSchedules() {\n  if (!online || !botWindowActive()) return;`,
`async function processLinkSchedules() {\n  if (!online || !sock) return;`,
'processador de agendamentos independente'
);
replaceOnce(
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!botWindowActive()) return;`,
`  for (let guard = 0; guard < queue.length; guard++) {\n    if (!online || !sock) return;`,
'fila de agendamentos independente'
);

// 6) Reenvio de falha não depende do agendamento original.
replaceOnce(
`  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item) return res.status(404).json({ok:false,msg:'O link associado à falha não está mais no Gerenciador de Links.'});`,
`  let item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));\n  if(!item){\n    const imagemFalhou=String(failure.erro||'').toLowerCase().startsWith('imagem:');\n    item={id:String(failure.agendamentoId||('reenvio-'+failure.id)),nome:failure.nome||'Reenvio de link',url:String(failure.url||'').trim(),mensagem:failure.mensagem||'',data:failure.data||new Date().toISOString().slice(0,10),horario:failure.horario||new Date().toTimeString().slice(0,5),repeticao:'uma_vez',intervaloMin:Number(failure.intervaloMin||1),intervaloMax:Number(failure.intervaloMax||1),imagemAutomatica:true,imagemUrl:imagemFalhou?'':String(failure.imagemUrl||''),imagemStatus:'',tituloProduto:failure.tituloProduto||'',grupoId:String(failure.grupoId||''),reenvioGrupoId:String(failure.grupoId||''),ativo:true,status:'agendado'};\n  }`,
'reenvio independente do agendamento original'
);

// 7) Reativação limpa o estado antigo.
replaceOnce(
`  if(b.rearmar===true) item.lastRunKey='';\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
`  const estavaPausado = item.status === 'pausado';\n  if(b.rearmar===true || (b.ativo===true && estavaPausado)){ item.lastRunKey=''; item.lastSkipKey=''; item.status='agendado'; item.progressGroupIds=[]; item.progressTargets=[]; item.progressKey=''; }\n  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();`,
'reativação de agendamento pausado'
);

// 8) O destino explícito do agendamento é preservado. O patch de grupo aplicado
// antes deste arquivo já substitui o alvo genérico por grupoId quando disponível.
patchSection(
  'async function sendScheduledLink(item) {',
  'async function processLinkSchedules() {',
  [
    [`if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;`, `if (runningLinkSchedules.has(item.id) || !online || !sock) return;`],
    [`if (runningLinkSchedules.has(item.id) || !online || !sock) return;`, `if (runningLinkSchedules.has(item.id) || !online || !sock) return;`],
    [`if (!botWindowActive()) {`, `if (!online || !sock) {`],
    [`item.status = botWindowActive() ? 'enviando' : 'pausado';`, `item.status = online && sock ? 'enviando' : 'pausado';`],
    [`item.status = item.repeticao === 'uma_vez' ? 'pausado' : 'agendado';`, `item.status = item.repeticao === 'uma_vez' ? 'concluido' : 'agendado';`]
  ],
  'envio no grupo escolhido'
);

// 9) Se o servidor ainda não tiver o campo grupoId, passa a persistir o grupo escolhido.
replaceOnce(
`    repeticao:['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:'uma_vez',`,
`    repeticao:['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:'uma_vez',\n    grupoId:String(b.grupoId||b.grupo||'').trim(),`,
'persistência do grupo no agendamento'
);
replaceOnce(
`  item.repeticao=['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:item.repeticao;`,
`  item.repeticao=['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:item.repeticao;\n  if(typeof b.grupoId==='string') item.grupoId=b.grupoId.trim();`,
'edição do grupo do agendamento'
);

// 10) Fallback final de imagem usando Playwright para páginas dinâmicas.
patchSection(
  'async function findProductImage(url) {',
  'let regulosBrowserPromise=null;',
  [
    [
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  return null;\n}`,
`  } catch (e) { addLog(\`Não foi possível ler a página para buscar imagem: \${e.message}\`); }\n  try {\n    const browserImage = await findProductImageWithBrowser(url);\n    if (browserImage) {\n      addLog('🖼️ Imagem encontrada pelo fallback do navegador.');\n      return browserImage;\n    }\n  } catch (e) {\n    addLog(\`Fallback de imagem pelo navegador falhou: \${e.message}\`);\n  }\n  return null;\n}`
    ]
  ],
  'fallback final de imagem'
);

if (changed) {
  fs.writeFileSync(serverPath, source, 'utf8');
  console.log('[boot] Correções de agendamento e imagem aplicadas ao runtime.');
} else {
  console.log('[boot] Nenhuma correção de runtime pendente.');
}

require(serverPath);
