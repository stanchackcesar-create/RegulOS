const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove ajustes mobile antigos que criavam elementos/espacos extras.
  html = html.replace(/\n?\/\* REGULOS_MOBILE_SCROLL_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?\/\* REGULOS_MOBILE_CONTROLS_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?<script id="regulos-mobile-controls-script">[\s\S]*?<\/script>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*id="mobileControlsToggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tab"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*class="mobile-scroll-toggle"[^>]*>[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/<button[^>]*class="mobile-scroll-down"[^>]*>[\s\S]*?<\/button>/g, '');

  // Remove somente a descrição abaixo do título.
  html = html.replace(/<div class="sub">Links, programação, histórico e grupos<\/div>/g, '');

  // Título: somente no celular. No PC fica oculto.
  html = html.replace(/\n?\/\* REGULOS_HEADER_TITLE_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  const css = `
/* REGULOS_HEADER_TITLE_V2 */
@media(min-width:561px){
  header .title{display:none!important}
}
@media(max-width:560px){
  header .title{display:block!important}
  header .wrap{width:100%!important;max-width:none!important;padding-left:0!important;padding-right:0!important}
  header .row{width:100%!important}
  header .actions{width:100%!important}
  header{padding-left:10px!important;padding-right:10px!important}
}
`;
  if (!html.includes('REGULOS_HEADER_TITLE_V2')) {
    html = html.replace('</style>', css + '\n</style>');
  }

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Cabeçalho ajustado: título somente no celular e controles sem espaço lateral extra.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste de cabeçalho:', err.message);
  process.exit(1);
}
