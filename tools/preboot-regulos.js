const path = require('path');

// Inicializador único do RegulOS.
// Importante para o modo nuvem: a perda momentânea do WhatsApp NÃO apaga
// a Programação do Bot nem os agendamentos. A sessão deve ser reconectada
// pelo Baileys enquanto os dados permanecem persistidos.
const ROOT = path.join(__dirname, '..');

// Mantém as correções de grupos, agendamentos, imagens e reconexão.
require(path.join(ROOT, 'tools', 'patch_scheduled_group.js'));
