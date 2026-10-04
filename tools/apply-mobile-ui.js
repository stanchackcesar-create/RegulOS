const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove ajustes antigos de navegação/controles mobile que criavam conteúdo
  // extra entre o cabeçalho e o primeiro painel.
  html = html.replace(/\n?\/\* REGULOS_MOBILE_CONTROLS_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?<script id="regulos-mobile-controls-script">[\s\S]*?<\/script>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*id="mobileControlsToggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tabs"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tab"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*class="mobile-scroll-toggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/<button[^>]*class="mobile-scroll-down"[^>]*>[\s\S]*?<\/button>/g, '');

  // Ajuste somente no celular: os controles terminam e o conteúdo começa
  // imediatamente, sem espaço vertical artificial. Desktop permanece igual.
  const css = `
/* REGULOS_MOBILE_SPACING_V1 */
@media(max-width:560px){
  header .actions{margin-bottom:0!important}
  main.wrap{margin-top:0!important;padding-top:0!important}
  main.wrap>.cards:first-child{margin-top:0!important;padding-top:0!important}
}
`;
  if (!html.includes('REGULOS_MOBILE_SPACING_V1')) {
    html = html.replace('</style>', css + '\n</style>');
  }

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Espaçamento mobile corrigido: conteúdo começa imediatamente após os controles.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste mobile:', err.message);
  process.exit(1);
}
