const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'index.html');

let source = fs.readFileSync(INDEX, 'utf8');
let changed = false;

// Quando a oferta automática busca o título, ele já vira o nome do agendamento.
// Não devemos inserir o mesmo título novamente na mensagem gerada.
const oldBlock = `   const desconto=String(preview.desconto||'').trim();\n   if(titulo)nomeFinal=titulo;\n   const partes=['🔥 OFERTA IMPERDÍVEL!'];\n   if(titulo)partes.push('📦 '+titulo);`;
const newBlock = `   const desconto=String(preview.desconto||'').trim();\n   const nomeFoiInformado=Boolean(nomeFinal);\n   if(titulo&&!nomeFoiInformado)nomeFinal=titulo;\n   const partes=['🔥 OFERTA IMPERDÍVEL!'];\n   // Se o nome foi informado manualmente, o título encontrado pode aparecer na mensagem.\n   // Se o nome veio automaticamente da página, ele já é o nome do agendamento e não\n   // deve ser criado novamente na mensagem.\n   if(titulo&&nomeFoiInformado)partes.push('📦 '+titulo);`;

if (source.includes(newBlock)) {
  console.log('[auto-offer-title] correção já aplicada.');
} else if (source.includes(oldBlock)) {
  source = source.replace(oldBlock, newBlock);
  changed = true;
  fs.writeFileSync(INDEX, source, 'utf8');
  console.log('[auto-offer-title] título duplicado corrigido.');
} else {
  console.log('[auto-offer-title] bloco da oferta automática não encontrado; nenhuma alteração feita.');
}

module.exports = { changed };
