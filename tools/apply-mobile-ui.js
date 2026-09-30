const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const marker = 'REGULOS_MOBILE_SCROLL_V1';

try {
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes(marker)) process.exit(0);

  const css = `
/* ${marker} */
@media(max-width:560px){
  header{position:relative!important;top:auto!important}
  .actions{position:relative}
  .mobile-scroll-down{display:block!important;width:100%;margin-top:4px;min-height:40px!important;background:#243653!important;border:1px solid #415579!important;color:#eef3ff!important;font-size:14px!important}
  .mobile-scroll-down:active{transform:translateY(1px)}
  .actions button[onclick*="/api/desconectar"]{margin-top:4px}
}
@media(min-width:561px){.mobile-scroll-down{display:none!important}}
`;

  const button = `<button type="button" class="mobile-scroll-down" onclick="document.querySelector('main')?.scrollIntoView({behavior:'smooth',block:'start'})">⬇️ Descer para o painel</button>`;

  if (!html.includes('class="actions"')) throw new Error('Bloco de ações não encontrado.');
  html = html.replace('<div class="actions">', `<div class="actions">${button}`);
  html = html.replace('</style>', `${css}\n</style>`);
  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Ajuste mobile aplicado: botão Descer para o painel.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste mobile:', err.message);
  process.exit(1);
}
