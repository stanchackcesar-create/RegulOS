const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
let source = fs.readFileSync(SERVER, 'utf8');
let changed = false;

// Um agendamento com grupo explícito já possui o JID de destino.
// Não devemos exigir que esse grupo esteja presente na lista/cache `groups` no
// instante do disparo. No Railway essa lista pode estar sendo atualizada, e
// esse teste fazia o agendamento cair em "pausado" mesmo com destino válido.
const oldTargetSelection = `    targets = scheduledGroupIds.length\n      ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id))\n      : activeGroups();`;
const newTargetSelection = `    targets = scheduledGroupIds.length\n      ? scheduledGroupIds\n      : activeGroups();`;

if (source.includes(oldTargetSelection)) {
  source = source.replace(oldTargetSelection, newTargetSelection);
  changed = true;
  console.log('[auto-offer-fix] destino explícito não depende mais do cache de grupos.');
}

// Reforça a mesma regra caso o arquivo tenha recebido uma variação equivalente
// de patch em uma versão anterior.
const oldTargetSelectionAlt = `    targets = scheduledGroupIds.length ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id)) : activeGroups();`;
if (source.includes(oldTargetSelectionAlt)) {
  source = source.replace(oldTargetSelectionAlt, newTargetSelection);
  changed = true;
  console.log('[auto-offer-fix] variação do filtro de destino corrigida.');
}

if (changed) fs.writeFileSync(SERVER, source, 'utf8');
console.log('[auto-offer-fix] verificação concluída.');
