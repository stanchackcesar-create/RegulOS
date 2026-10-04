const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'public', 'index.html');
if (!fs.existsSync(file)) process.exit(0);

let html = fs.readFileSync(file, 'utf8');

// RegulOS: os dois botões móveis de subir/descer foram removidos.
// Este script também limpa versões antigas que tenham sido injetadas
// em uma inicialização anterior do container.
html = html.replace(
  /\s*\/\* REGULOS_MOBILE_SCROLL_TABS_V1 \*\/\s*@media\(max-width:560px\)\{[\s\S]*?@media\(min-width:561px\)\{\.mobile-scroll-tabs\{display:none!important\}\}\s*/,
  '\n'
);

html = html.replace(
  /\s*<div class="mobile-scroll-tabs" aria-label="Navegação rápida no celular">[\s\S]*?<\/div>\s*/,
  '\n'
);

fs.writeFileSync(file, html, 'utf8');
console.log('[mobile-tabs] Botoes subir/descer removidos do painel mobile.');
