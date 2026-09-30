const path = require('path');

// Inicializador único do RegulOS.
// No modo nuvem, uma queda momentânea do WhatsApp NÃO apaga a Programação do Bot
// nem os agendamentos. A sessão deve ser reconectada pelo Baileys enquanto os
// dados permanecem persistidos no Volume do Railway.
const ROOT = path.join(__dirname, '..');

// Primeiro corrige o destino explícito dos agendamentos e o título da oferta automática.
// Isso precisa acontecer antes do patch_scheduled_group e do boot, porque ambos carregam o server.js.
require(path.join(ROOT, 'tools', 'fix-auto-offer-schedule.js'));
require(path.join(ROOT, 'tools', 'fix-auto-offer-title.js'));

// Mantém as correções de grupos, agendamentos, imagens e reconexão.
require(path.join(ROOT, 'tools', 'patch_scheduled_group.js'));
