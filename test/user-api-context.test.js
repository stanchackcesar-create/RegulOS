'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticatedUserId, resolveAuthenticatedRuntime, createUserApiContext } = require('../src/user-api-context');

test('usa apenas a identidade autenticada, ignorando IDs do body e query', () => {
  const req = { user: { id: 'owner-A' }, body: { userId: 'owner-B' }, query: { userId: 'owner-C' } };
  assert.equal(authenticatedUserId(req), 'owner-A');
});

test('rejeita requisição sem identidade autenticada', () => {
  assert.throws(() => authenticatedUserId({ body: { userId: 'spoofed' } }), { code: 'AUTHENTICATED_USER_REQUIRED' });
  assert.throws(() => authenticatedUserId({ user: { id: '' } }), { code: 'AUTHENTICATED_USER_REQUIRED' });
});

test('resolve somente o runtime da identidade autenticada', () => {
  const a = { userId: 'owner-A', marker: 'A' };
  const b = { userId: 'owner-B', marker: 'B' };
  const manager = { getRuntime: id => ({ 'owner-A': a, 'owner-B': b })[id] || null };
  const context = createUserApiContext(manager);
  assert.equal(context.runtime({ user: { id: 'owner-A' }, body: { userId: 'owner-B' } }), a);
  assert.equal(resolveAuthenticatedRuntime({ user: { id: 'owner-B' } }, manager), b);
  assert.throws(() => context.runtime({ user: { id: 'owner-C' } }), { code: 'USER_RUNTIME_NOT_FOUND' });
});

test('rejeita runtime que não corresponde ao usuário autenticado', () => {
  const manager = { getRuntime: () => ({ userId: 'another-user' }) };
  assert.throws(
    () => resolveAuthenticatedRuntime({ user: { id: 'owner-A' } }, manager),
    { code: 'USER_RUNTIME_OWNERSHIP_MISMATCH' }
  );
});

test('rejeita gerenciador ausente ou inválido', () => {
  assert.throws(() => resolveAuthenticatedRuntime({ user: { id: 'owner-A' } }, null), /Gerenciador de sessões inválido/);
});
