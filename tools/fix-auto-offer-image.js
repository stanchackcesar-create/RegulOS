const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'public', 'index.html');

let source = fs.readFileSync(INDEX, 'utf8');
let changed = false;

// A oferta automática pode receber uma imagem de preview que é apenas uma URL
// temporária/CDN. Não devemos gravá-la como imagem definitiva do agendamento.
// O servidor deve fazer a busca/validação da imagem no momento do envio.
const oldLine = "if(!imagemUrlFinal && preview.imagemUrl)imagemUrlFinal=String(preview.imagemUrl);";
const newLine = "// A imagem do preview não é persistida como URL definitiva; o envio buscará/validará a imagem novamente.";

if (source.includes(oldLine) && !source.includes(newLine)) {
  source = source.replace(oldLine, newLine);
  changed = true;
}

// Marca explicitamente que o agendamento foi criado pelo modo de oferta automática.
const oldBody = "imagemAutomatica:imagemAutomaticaFinal,imagemUrl:imagemUrlFinal,";
const newBody = "imagemAutomatica:imagemAutomaticaFinal,imagemUrl:imagemUrlFinal,autoOfertaAutomatica:montarOfertaAutomatica,";
if (source.includes(oldBody) && !source.includes(newBody)) {
  source = source.replace(oldBody, newBody);
  changed = true;
}

if (changed) {
  fs.writeFileSync(INDEX, source, 'utf8');
  console.log('[auto-offer-image-fix] correção aplicada no formulário de agendamento.');
} else {
  console.log('[auto-offer-image-fix] nenhuma alteração pendente.');
}
