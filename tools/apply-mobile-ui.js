const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const marker = 'REGULOS_MOBILE_CONTROLS_V4';

try {
  let html = fs.readFileSync(file, 'utf8');

  // Remove as versões anteriores da navegação flutuante para celular.
  html = html.replace(/\n?\/\* REGULOS_MOBILE_SCROLL_V[0-9]+ \*\/[\s\S]*?(?=<\/style>)/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-tab"[\s\S]*?<\/div>\s*/g, '\n');
  html = html.replace(/\n?<button[^>]*class="mobile-scroll-toggle"[\s\S]*?<\/button>\s*/g, '\n');
  html = html.replace(/\n?<div class="mobile-scroll-toggle"[\s\S]*?<\/div>\s*/g, '\n');

  // Remove versões antigas do botão "Descer para o painel".
  html = html.replace(/<button[^>]*class="mobile-scroll-down"[\s\S]*?<\/button>/g, '');


  // Carrega o Design System Neon do RegulOS sem alterar a lógica da aplicação.
  if (!html.includes('REGULOS_NEON_LINK_V1')) {
    const neonLink = '<!-- REGULOS_NEON_LINK_V1 --><link rel="stylesheet" href="/regulos-neon.css">';
    html = html.replace('</head>', neonLink + '</head>');
  }


  if (!html.includes('REGULOS_NAV_LINK_V1')) {
    const navLinks = '<!-- REGULOS_NAV_LINK_V1 --><link rel="stylesheet" href="/regulos-nav.css"><script src="/regulos-nav.js" defer></script>';
    html = html.replace('</head>', navLinks + '</head>');
  }

  if (html.includes(marker)) {
    fs.writeFileSync(file, html, 'utf8');
    process.exit(0);
  }

  if (!html.includes('<div class="actions">')) throw new Error('Bloco de ações não encontrado.');

  const css = `
/* ${marker} */
@media(max-width:560px){
  .mobile-controls-toggle{
    display:flex!important;
    width:100%!important;
    min-height:40px!important;
    margin-top:8px!important;
    padding:9px 12px!important;
    align-items:center!important;
    justify-content:center!important;
    border:1px solid #536987!important;
    border-radius:10px!important;
    background:#243653!important;
    color:#eef3ff!important;
    font-size:14px!important;
    font-weight:800!important;
    touch-action:manipulation!important;
  }
  .mobile-controls-toggle:active{transform:translateY(1px)!important}
  .actions.mobile-controls-collapsed{display:none!important}
  .actions.mobile-controls-expanded{display:flex!important}
  .mobile-controls-toggle.is-collapsed{background:#1b2a43!important}
}
@media(min-width:561px){.mobile-controls-toggle{display:none!important}}
`;

  const toggle = `<button type="button" id="mobileControlsToggle" class="mobile-controls-toggle" aria-expanded="true" aria-controls="regulosActions" onclick="toggleMobileControls()">✕ Ocultar controles</button>`;

  html = html.replace('<div class="actions">', '<div id="regulosActions" class="actions mobile-controls-expanded">');
  html = html.replace('</div>\n</div></header>', '</div>\n' + toggle + '\n</div></header>');
  html = html.replace('</style>', `${css}\n</style>`);

  const js = `
<script id="regulos-mobile-controls-script">
function toggleMobileControls(){
  const actions = document.getElementById('regulosActions');
  const button = document.getElementById('mobileControlsToggle');
  if(!actions || !button) return;
  const collapsed = actions.classList.toggle('mobile-controls-collapsed');
  actions.classList.toggle('mobile-controls-expanded', !collapsed);
  button.classList.toggle('is-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.textContent = collapsed ? '☰ Mostrar controles' : '✕ Ocultar controles';
}
</script>
`;
  html = html.replace('</body>', js + '</body>');

  fs.writeFileSync(file, html, 'utf8');
  console.log('[RegulOS] Mobile: controles Atualizar/Reconectar/Desconectar/Grupos/Novo QR agora podem ser recolhidos.');
} catch (err) {
  console.error('[RegulOS] Falha ao aplicar ajuste mobile:', err.message);
  process.exit(1);
}
