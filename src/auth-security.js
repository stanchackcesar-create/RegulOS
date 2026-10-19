'use strict';

// Primitives criptográficas sem dependências externas. Este módulo não envia e-mails
// nem ativa autenticação por conta própria; as rotas precisam impor expiração,
// uso único, rate limiting e persistência antes de expor os fluxos ao usuário.
const crypto = require('node:crypto');

function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new TypeError('O tamanho do token deve estar entre 16 e 128 bytes.');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

function digestToken(token) {
  const value = String(token || '');
  if (!value || value.length > 2048) throw new TypeError('Token inválido.');
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function generateTotpSecret(bytes = 20) {
  if (!Number.isInteger(bytes) || bytes < 20 || bytes > 64) {
    throw new TypeError('O segredo TOTP deve ter entre 20 e 64 bytes.');
  }
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeHexSecret(secret) {
  const value = String(secret || '').replace(/\s+/g, '');
  if (!/^(?:[a-f0-9]{2}){20,64}$/i.test(value)) throw new TypeError('Segredo TOTP inválido.');
  return Buffer.from(value, 'hex');
}

function totpAt(secret, timeMs = Date.now(), stepSeconds = 30, digits = 6) {
  if (!Number.isFinite(timeMs) || !Number.isInteger(stepSeconds) || stepSeconds < 15 || stepSeconds > 120 ||
      !Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new TypeError('Parâmetros TOTP inválidos.');
  }
  const key = decodeHexSecret(secret);
  const counter = BigInt(Math.floor(timeMs / 1000 / stepSeconds));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function verifyTotp(secret, code, options = {}) {
  const supplied = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(supplied)) return false;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const window = Number.isInteger(options.window) ? options.window : 1;
  if (window < 0 || window > 2) throw new TypeError('Janela TOTP inválida.');
  for (let drift = -window; drift <= window; drift++) {
    const expected = totpAt(secret, now + drift * 30_000);
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function totpProvisioningUri(secret, account, issuer = 'RegulOS') {
  const safeAccount = String(account || '').trim();
  const safeIssuer = String(issuer || 'RegulOS').trim();
  if (!safeAccount || safeAccount.length > 254 || !safeIssuer || safeIssuer.length > 64) {
    throw new TypeError('Conta ou emissor inválido para TOTP.');
  }
  const key = base32Encode(decodeHexSecret(secret));
  const label = encodeURIComponent(safeIssuer) + ':' + encodeURIComponent(safeAccount);
  return 'otpauth://totp/' + label + '?secret=' + key + '&issuer=' +
    encodeURIComponent(safeIssuer) + '&algorithm=SHA1&digits=6&period=30';
}

function generateBackupCodes(count = 10) {
  if (!Number.isInteger(count) || count < 5 || count > 20) {
    throw new TypeError('Gere entre 5 e 20 códigos de recuperação.');
  }
  return Array.from({ length: count }, () =>
    crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'));
}

function hashBackupCode(code, pepper) {
  const normalized = String(code || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(normalized)) throw new TypeError('Código de recuperação inválido.');
  const secret = String(pepper || '');
  if (secret.length < 16) throw new TypeError('Pepper de recuperação precisa ter ao menos 16 caracteres.');
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

module.exports = {
  randomToken,
  digestToken,
  generateTotpSecret,
  totpAt,
  verifyTotp,
  totpProvisioningUri,
  generateBackupCodes,
  hashBackupCode
};
