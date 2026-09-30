const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'public', 'index.html');
if (!fs.existsSync(file)) process.exit(0);
let html = fs.readFileSync(file, 'utf8');

if (html.includes('REGULOS_MOBILE_SCROLL_TABS_V1')) process.exit(0);

const css = `\n/* REGULOS_MOBILE_SCROLL_TABS_V1 */\n@media(max-width:560px){\n  .mobile-scroll-tabs{position:fixed;right:8px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:9999;display:flex;flex-direction:column;gap:7px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.35))}\n  .mobile-scroll-tabs button{width:44px;height:44px;min-height:44px;padding:0;border:1px solid #536684;border-radius:12px;background:#34445c;color:#fff;font-size:20px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;touch-action:manipulation}\n  .mobile-scroll-tabs button:active{transform:scale(.96)}\n  .mobile-scroll-tabs .mobile-scroll-top{background:#3d83f6}\n  .mobile-scroll-tabs .mobile-scroll-bottom{background:#34445c}\n}\n@media(min-width:561px){.mobile-scroll-tabs{display:none!important}}\n`;

const htmlBlock = `\n<div class="mobile-scroll-tabs" aria-label="Navegação rápida no celular">\n  <button type="button" class="mobile-scroll-top" aria-label="Subir para o topo" title="Subir para o topo" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>\n  <button type="button" class="mobile-scroll-bottom" aria-label="Descer para o painel" title="Descer para o painel" onclick="window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'})">↓</button>\n</div>\n`;

html = html.replace('</style>', css + '\n</style>');
html = html.replace('</body>', htmlBlock + '\n</body>');
fs.writeFileSync(file, html, 'utf8');
console.log('[mobile-tabs] Botoes subir/descer aplicados ao painel mobile.');
