const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const marker = 'REGULOS_MOBILE_SCROLL_V3';

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove patches anteriores para evitar controles duplicados após novos deploys.
  html = html.replace(/\n\/\* REGULOS_MOBILE_SCROLL_V1 \*\/\n@media\(max-width:560px\)\{[\s\S]*?@media\(min-width:561px\)\{\.mobile-scroll-down\{display:none!important\}\}\n?/m, '\n');
  html = html.replace(/\n\/\* REGULOS_MOBILE_SCROLL_V2 \*\/\n@media\(max-width:560px\)\{[\s\S]*?@media\(min-width:561px\)\{\.mobile-scroll-tab\{display:none!important\}\}\n?/m, '\n');
  html = html.replace(/\n<div class="mobile-scroll-tab"[\s\S]*?<\/div>\n?/m, '\n');
  html = html.replace(/\n<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\n?/m, '\n');

  if (html.includes(marker)) process.exit(0);
  if (!html.includes('</body>')) throw new Error('Final do documento não encontrado.');

  const css = `
/* ${marker} */
@media(max-width:560px){
  .mobile-scroll-tab{
    position:fixed!important;
    right:10px!important;
    bottom:calc(14px + env(safe-area-inset-bottom))!important;
    z-index:9999!important;
    display:flex!important;
    flex-direction:column!important;
    gap:7px!important;
    padding:7px!important;
    border:1px solid #415579!important;
    border-radius:16px!important;
    background:rgba(17,27,45,.96)!important;
    box-shadow:0 8px 24px rgba(0,0,0,.45)!important;
    backdrop-filter:blur(8px)!important;
  }
  .mobile-scroll-tab.is-hidden{display:none!important}
  .mobile-scroll-tab button{
    width:50px!important;
    height:50px!important;
    min-height:50px!important;
    padding:0!important;
    border-radius:12px!important;
    background:#34445c!important;
    color:#eef3ff!important;
    border:1px solid #536987!important;
    font-size:24px!important;
    line-height:1!important;
    font-weight:800!important;
  }
  .mobile-scroll-tab .mobile-scroll-close{
    background:#27354b!important;
    font-size:22px!important;
  }
  .mobile-scroll-tab button:active{transform:scale(.96)!important}
  .mobile-scroll-toggle{
    position:fixed!important;
    right:10px!important;
    bottom:calc(14px + env(safe-area-inset-bottom))!important;
    z-index:10000!important;
    width:50px!important;
    height:50px!important;
    min-height:50px!important;
    padding:0!important;
    border-radius:15px!important;
    background:#34445c!important;
    color:#eef3ff!important;
    border:1px solid #536987!important;
    box-shadow:0 8px 24px rgba(0,0,0,.45)!important;
    font-size:23px!important;
    font-weight:800!important;
  }
  .mobile-scroll-toggle.is-open{display:none!important}
}
@media(min-width:561px){
  .mobile-scroll-tab,.mobile-scroll-toggle{display:none!important}
}
`;

  const controls = `
<div class="mobile-scroll-tab" id="regulos-mobile-scroll-tab" aria-label="Navegação rápida">
  <button type="button" aria-label="Subir para o topo" title="Subir" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>
  <button type="button" aria-label="Descer para o final" title="Descer" onclick="window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})">↓</button>
  <button type="button" class="mobile-scroll-close" aria-label="Esconder navegação" title="Esconder" onclick="regulosToggleScrollNav(false)">×</button>
</div>
<button type="button" class="mobile-scroll-toggle is-open" id="regulos-mobile-scroll-toggle" aria-label="Mostrar navegação Subir e Descer" title="Mostrar Subir/Descer" onclick="regulosToggleScrollNav(true)">↕</button>
<script>
function regulosToggleScrollNav(show){
  const panel=document.getElementById('regulos-mobile-scroll-tab');
  const toggle=document.getElementById('regulos-mobile-scroll-toggle');
  if(!panel || !toggle) return;
  panel.classList.toggle('is-hidden', !show);
  toggle.classList.toggle('is-open', show);
}
</script>`;

  html = html.replace('</style>', `${css}\n</style>`);
  html = html.replace('</body>', `${controls}\n</body>`);

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Navegação mobile V3 aplicada: aba pode ser escondida e reaberta.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar navegação mobile:', err.message);
  process.exit(1);
}
