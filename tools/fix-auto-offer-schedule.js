const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const SCHEDULE_PATCH = path.join(ROOT, 'tools', 'patch_scheduled_group.js');

function replaceOnce(file, oldText, newText, label) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(newText)) return false;
  if (!source.includes(oldText)) return false;
  source = source.replace(oldText, newText);
  fs.writeFileSync(file, source, 'utf8');
  console.log(`[auto-offer-fix] ${label}`);
  return true;
}

// O patch de grupo é executado antes do boot e estava filtrando o JID escolhido
// pela lista/cache `groups`. Em nuvem essa lista pode estar vazia ou atrasada no
// instante do disparo, fazendo um destino válido virar "pausado".
const oldPatchTarget = `    targets = scheduledGroupIds.length\n      ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id))\n      : activeGroups();`;
const newPatchTarget = `    targets = scheduledGroupIds.length\n      ? scheduledGroupIds\n      : activeGroups();`;
replaceOnce(SCHEDULE_PATCH, oldPatchTarget, newPatchTarget, 'patch de grupo: destino explícito não depende do cache');

// Reforço para versões que tenham recebido o bloco em uma única linha.
const oldPatchTargetAlt = `    targets = scheduledGroupIds.length ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id)) : activeGroups();`;
replaceOnce(SCHEDULE_PATCH, oldPatchTargetAlt, newPatchTarget, 'patch de grupo: variação do filtro corrigida');

// Também corrige uma cópia do bloco caso o server.js já tenha sido materializado
// por um deploy anterior antes desta correção.
const oldServerTarget = `    targets = scheduledGroupIds.length\n      ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id))\n      : activeGroups();`;
replaceOnce(SERVER, oldServerTarget, newPatchTarget, 'server: destino explícito não depende do cache');

const oldServerTargetAlt = `    targets = scheduledGroupIds.length ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id)) : activeGroups();`;
replaceOnce(SERVER, oldServerTargetAlt, newPatchTarget, 'server: variação do filtro corrigida');

console.log('[auto-offer-fix] verificação concluída.');
