const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');

try {
  let html = fs.readFileSync(file, 'utf8');

  // Limpa somente elementos/ajustes antigos que eram exclusivos do mobile.
  html = html.replace(/\n?\/\* REGULOS_MOBILE_SCROLL_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?\/\* REGULOS_MOBILE_CONTROLS_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?<script id="regulos-mobile-controls-script">[\s\S]*?<\/script>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*id="mobileControlsToggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tab"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*class="mobile-scroll-toggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/<button[^>]*class="mobile-scroll-down"[^>]*>[\s\S]*?<\/button>/g, '');

  // Remove versões anteriores deste ajuste de cabeçalho, sem alterar o desktop.
  html = html.replace(/\n?\/\* REGULOS_HEADER_TITLE_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');

  const css = `
/* REGULOS_MOBILE_ONLY_HEADER_V1 */
@media(max-width:560px){
  /* Nenhuma regra abaixo altera o layout do PC. */
  header .wrap{width:100%!important;max-width:none!important;padding-left:0!important;padding-right:0!important}
  header .row{width:100%!important}
  header .actions{width:100%!important}
  header{padding-left:10px!important;padding-right:10px!important}
  header .sub{display:none!important}
}
`;

  if (!html.includes('REGULOS_MOBILE_ONLY_HEADER_V1')) {
    html = html.replace('</style>', css + '\n</style>');
  }

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Layout desktop preservado; ajustes limitados ao mobile.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste mobile:', err.message);
  process.exit(1);
}
