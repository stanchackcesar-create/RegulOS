const path = require('path');

// Inicializador único do RegulOS.
// No modo nuvem, uma queda momentânea do WhatsApp NÃO apaga a Programação do Bot
// nem os agendamentos. A sessão deve ser reconectada pelo Baileys enquanto os
// dados permanecem persistidos no Volume do Railway.
const ROOT = path.join(__dirname, '..');

// Corrige a interface de contas antes de qualquer patch que possa reconstruir o painel.
require(path.join(ROOT, 'tools', 'patch-account-user-form.js'));

// Primeiro corrige o destino explícito dos agendamentos, o título da oferta automática
// e a imagem temporária retornada pelo preview. Isso acontece antes do carregamento do servidor.
require(path.join(ROOT, 'tools', 'fix-auto-offer-schedule.js'));
require(path.join(ROOT, 'tools', 'fix-auto-offer-title.js'));
require(path.join(ROOT, 'tools', 'fix-auto-offer-image.js'));

// A lógica atual de agendamento por múltiplos grupos já está integrada em
// server.js/index.html. Não executar patch experimental de Mercado Livre no boot.

// O boot moderno não usa o patch legado de grupo único, mas ainda precisa
// executar o inicializador/runtime consolidado para manter o servidor ativo.
require(path.join(ROOT, 'tools', 'boot-regulos.js'));
