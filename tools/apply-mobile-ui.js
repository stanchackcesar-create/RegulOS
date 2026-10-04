const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove navegação/controles mobile antigos que ocupavam espaço desnecessário.
  html = html.replace(/\n?\/\* REGULOS_MOBILE_SCROLL_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?\/\* REGULOS_MOBILE_CONTROLS_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?<script id="regulos-mobile-controls-script">[\s\S]*?<\/script>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*id="mobileControlsToggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tab"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*class="mobile-scroll-toggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/<button[^>]*class="mobile-scroll-down"[^>]*>[\s\S]*?<\/button>/g, '');

  // Mantém o Design System Neon e a navegação existente.
  if (!html.includes('REGULOS_NEON_LINK_V1')) {
    const neonLink = '<!-- REGULOS_NEON_LINK_V1 --><link rel="stylesheet" href="/regulos-neon.css">';
    html = html.replace('</head>', neonLink + '</head>');
  }
  if (!html.includes('REGULOS_NAV_LINK_V1')) {
    const navLinks = '<!-- REGULOS_NAV_LINK_V1 --><link rel="stylesheet" href="/regulos-nav.css"><script src="/regulos-nav.js" defer></script>';
    html = html.replace('</head>', navLinks + '</head>');
  }

  // No celular, o conteúdo deve começar logo após os controles.
  const css = `
/* REGULOS_MOBILE_SPACING_V2 */
@media(max-width:560px){
  header .actions{margin-bottom:0!important}
  header .mobile-controls-toggle{display:none!important}
  main.wrap{margin-top:0!important;padding-top:0!important}
  main.wrap>.cards:first-child{margin-top:8px!important;padding-top:0!important}
}
`;
  html = html.replace(/\n?\/\* REGULOS_MOBILE_SPACING_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  if (!html.includes('REGULOS_MOBILE_SPACING_V2')) {
    html = html.replace('</style>', css + '\n</style>');
  }

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Mobile corrigido: removido o botão Ocultar controles e eliminado o espaço vertical extra.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste mobile:', err.message);
  process.exit(1);
}
