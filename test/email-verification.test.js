'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TTL_MS, normalizeEmail, isValidEmail,
  createEmailVerification, consumeEmailVerification
} = require('../src/email-verification');

test('normaliza e valida endereços de e-mail', () => {
  assert.equal(normalizeEmail('  Pessoa@Exemplo.COM '), 'pessoa@exemplo.com');
  assert.equal(isValidEmail('Pessoa+teste@sub.exemplo.com'), true);
  for (const email of ['', 'sem-arroba.com', 'a@@exemplo.com', 'a..b@exemplo.com', 'a@localhost', 'a@-exemplo.com', 'a b@exemplo.com']) {
    assert.equal(isValidEmail(email), false, email);
  }
});

test('cria token aleatório com digest e prazo, sem guardar token em texto puro', () => {
  const { token, record } = createEmailVerification('Pessoa@Exemplo.com', { now: 1000 });
  assert.ok(token.length >= 40);
  assert.equal(record.email, 'pessoa@exemplo.com');
  assert.notEqual(record.tokenDigest, token);
  assert.equal(record.expiresAt, 1000 + DEFAULT_TTL_MS);
  assert.equal(record.consumedAt, null);
});

test('token correto é consumido uma vez e token incorreto não altera registro', () => {
  const { token, record } = createEmailVerification('pessoa@exemplo.com', { now: 10_000 });
  const wrong = consumeEmailVerification(record, 'token-errado', { now: 11_000 });
  assert.deepEqual(wrong, { ok: false, reason: 'invalid_token' });
  assert.equal(record.consumedAt, null);

  const used = consumeEmailVerification(record, token, { now: 12_000 });
  assert.equal(used.ok, true);
  assert.equal(used.record.consumedAt, 12_000);
  assert.equal(record.consumedAt, null, 'a função é pura e não altera o registro recebido');
  assert.deepEqual(consumeEmailVerification(used.record, token, { now: 13_000 }), { ok: false, reason: 'already_used' });
});

test('recusa tokens expirados e registros malformados', () => {
  const { token, record } = createEmailVerification('pessoa@exemplo.com', { now: 1000, ttlMs: 60_000 });
  assert.deepEqual(consumeEmailVerification(record, token, { now: 61_000 }), { ok: false, reason: 'expired' });
  assert.deepEqual(consumeEmailVerification(null, token), { ok: false, reason: 'invalid_record' });
});

test('recusa e-mails e prazos inválidos', () => {
  assert.throws(() => createEmailVerification('invalido'), /e-mail inválido/i);
  assert.throws(() => createEmailVerification('a@exemplo.com', { ttlMs: 1000 }), /validade/i);
  assert.throws(() => createEmailVerification('a@exemplo.com', { ttlMs: 25 * 60 * 60 * 1000 }), /validade/i);
});
