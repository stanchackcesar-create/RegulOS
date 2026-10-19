'use strict';

// Fluxo puro e testável para tokens de verificação de e-mail.
// A camada HTTP deve persistir o registro antes de enviar o e-mail e salvar
// consumedAt antes de considerar o token utilizado. Este módulo não envia e-mail.
const { randomToken, digestToken } = require('./auth-security');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || /[\s<>(),;:\\"]/.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return false;
  if (domain.length > 253 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  const labels = domain.split('.');
  return labels.every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

function createEmailVerification(email, options = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) throw new TypeError('Endereço de e-mail inválido.');
  const now = options.now === undefined ? Date.now() : options.now;
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isFinite(now) || now < 0) throw new TypeError('Data de criação inválida.');
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_TTL_MS) {
    throw new TypeError('A validade do token deve ficar entre 1 minuto e 24 horas.');
  }
  const token = randomToken();
  return {
    token,
    record: {
      email: normalizedEmail,
      tokenDigest: digestToken(token),
      createdAt: now,
      expiresAt: now + ttlMs,
      consumedAt: null
    }
  };
}

function consumeEmailVerification(record, token, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isFinite(now) || now < 0) throw new TypeError('Data de validação inválida.');
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'invalid_record' };
  }
  if (record.consumedAt !== null && record.consumedAt !== undefined) {
    return { ok: false, reason: 'already_used' };
  }
  if (!Number.isFinite(record.expiresAt) || now >= record.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  let suppliedDigest;
  try {
    suppliedDigest = digestToken(token);
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  const expected = String(record.tokenDigest || '');
  if (!/^[a-f0-9]{64}$/i.test(expected)) return { ok: false, reason: 'invalid_record' };
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(suppliedDigest, 'hex');
  if (a.length !== b.length || !require('node:crypto').timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_token' };
  }
  return {
    ok: true,
    record: { ...record, consumedAt: now }
  };
}

module.exports = {
  DEFAULT_TTL_MS,
  normalizeEmail,
  isValidEmail,
  createEmailVerification,
  consumeEmailVerification
};
