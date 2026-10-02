const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const file = path.join(ROOT, 'public', 'index.html');
let source = fs.readFileSync(file, 'utf8');

const oldLine = "  document.getElementById('accountPanel').innerHTML=html;";
const newBlock = `  // Preserva os campos de criação de usuário durante atualizações/polling do painel.
  // Sem isso, a reconstrução de accountPanel apagava o nome enquanto o administrador
  // ainda estava digitando a senha.
  const __newUserLoginValue = document.getElementById('newUserLogin')?.value || '';
  const __newUserPassValue = document.getElementById('newUserPass')?.value || '';
  const __adminCurrentPassValue = document.getElementById('adminCurrentPass')?.value || '';
  const __adminNewPassValue = document.getElementById('adminNewPass')?.value || '';
  const __adminConfirmPassValue = document.getElementById('adminConfirmPass')?.value || '';
  const __accountPanel = document.getElementById('accountPanel');
  __accountPanel.innerHTML=html;
  const __restoreNewUserFields = () => {
    const __login = document.getElementById('newUserLogin');
    const __pass = document.getElementById('newUserPass');
    const __current = document.getElementById('adminCurrentPass');
    const __adminNew = document.getElementById('adminNewPass');
    const __adminConfirm = document.getElementById('adminConfirmPass');
    if(__login && __newUserLoginValue) __login.value = __newUserLoginValue;
    if(__pass && __newUserPassValue) __pass.value = __newUserPassValue;
    if(__current && __adminCurrentPassValue) __current.value = __adminCurrentPassValue;
    if(__adminNew && __adminNewPassValue) __adminNew.value = __adminNewPassValue;
    if(__adminConfirm && __adminConfirmPassValue) __adminConfirm.value = __adminConfirmPassValue;
  };
  __restoreNewUserFields();
  requestAnimationFrame(__restoreNewUserFields);`;

if (!source.includes(newBlock)) {
  if (!source.includes(oldLine)) throw new Error('Linha de renderização de accountPanel não encontrada.');
  source = source.replace(oldLine, newBlock, 1);
  fs.writeFileSync(file, source, 'utf8');
  console.log('[account-user-form] preservação dos campos aplicada.');
} else {
  console.log('[account-user-form] correção já aplicada.');
}
