const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const marker = 'REGULOS_MOBILE_SCROLL_V2';

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove the previous mobile-scroll patch so V2 replaces it cleanly.
  if (html.includes('REGULOS_MOBILE_SCROLL_V1')) {
    html = html.replace(/\n\/\* REGULOS_MOBILE_SCROLL_V1 \*\/\n@media\(max-width:560px\)\{[\s\S]*?@media\(min-width:561px\)\{\.mobile-scroll-down\{display:none!important\}\}\n?/m, '\n');
    html = html.replace(/<button[^>]*class="mobile-scroll-down"[^>]*>⬇️ Descer para o painel<\/button>/m, '');
  }

  if (html.includes(marker)) process.exit(0);
  if (!html.includes('</body>')) throw new Error('Final do documento não encontrado.');

  const css = `
/* ${marker} */
@media(max-width:560px){
  .mobile-scroll-tab{
    position:fixed!important;
    right:12px!important;
    bottom:calc(14px + env(safe-area-inset-bottom))!important;
    z-index:9999!important;
    display:flex!important;
    flex-direction:column!important;
    gap:8px!important;
    padding:7px!important;
    border:1px solid #415579!important;
    border-radius:16px!important;
    background:rgba(17,27,45,.96)!important;
    box-shadow:0 8px 24px rgba(0,0,0,.45)!important;
    backdrop-filter:blur(8px)!important;
  }
  .mobile-scroll-tab button{
    width:52px!important;
    height:52px!important;
    min-height:52px!important;
    padding:0!important;
    border-radius:12px!important;
    background:#34445c!important;
    color:#eef3ff!important;
    border:1px solid #536987!important;
    font-size:25px!important;
    line-height:1!important;
    font-weight:800!important;
  }
  .mobile-scroll-tab button:active{transform:scale(.96)!important}
}
@media(min-width:561px){.mobile-scroll-tab{display:none!important}}
`;

  const controls = `
<div class="mobile-scroll-tab" aria-label="Navegação rápida">
  <button type="button" aria-label="Subir para o topo" title="Subir" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
  <button type="button" aria-label="Descer para o painel inferior" title="Descer" onclick="window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})">↓</button>
</div>`;

  html = html.replace('</style>', `${css}\n</style>`);
  html = html.replace('</body>', `${controls}\n</body>`);

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Navegação mobile V2 aplicada: aba flutuante Subir/Descer.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar navegação mobile:', err.message);
  process.exit(1);
}
