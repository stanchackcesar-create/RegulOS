'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  randomToken, digestToken, generateTotpSecret, totpAt, verifyTotp,
  totpProvisioningUri, generateBackupCodes, hashBackupCode
} = require('../src/auth-security');

test('tokens are random and stored as digests rather than plaintext', () => {
  const token = randomToken();
  assert.ok(token.length >= 40);
  assert.notEqual(digestToken(token), token);
  assert.equal(digestToken(token), digestToken(token));
  assert.notEqual(digestToken(token), digestToken(randomToken()));
});

test('TOTP validates current time and rejects invalid codes', () => {
  const secret = '0123456789ABCDEF0123456789ABCDEF01234567';
  const now = 1_700_000_000_000;
  const code = totpAt(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, { now, window: 0 }), true);
  assert.equal(verifyTotp(secret, '00000', { now }), false);
  assert.equal(verifyTotp(secret, 'abcdef', { now }), false);
  assert.equal(verifyTotp(secret, code, { now: now + 180_000, window: 0 }), false);
});

test('TOTP provisioning URI contains issuer, account and Base32 secret', () => {
  const secret = generateTotpSecret();
  const uri = totpProvisioningUri(secret, 'usuario@example.com');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=RegulOS/);
  assert.match(uri, /secret=[A-Z2-7]+/);
});

test('backup codes are unique, formatted and HMAC-hashed', () => {
  const codes = generateBackupCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every(code => /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(code)));
  const pepper = 'a-long-secret-pepper-for-tests';
  assert.notEqual(hashBackupCode(codes[0], pepper), codes[0]);
  assert.equal(hashBackupCode(codes[0], pepper), hashBackupCode(codes[0], pepper));
  assert.notEqual(hashBackupCode(codes[0], pepper), hashBackupCode(codes[1], pepper));
});

test('rejects weak parameters and malformed secrets', () => {
  assert.throws(() => randomToken(4));
  assert.throws(() => generateTotpSecret(8));
  assert.throws(() => totpAt('bad'));
  assert.throws(() => generateBackupCodes(2));
  assert.throws(() => hashBackupCode('bad', 'short'));
});
