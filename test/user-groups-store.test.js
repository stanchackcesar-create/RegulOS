'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserGroupsStore } = require('../src/user-groups-store');

test('grupos e configurações ficam isolados por usuário', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-groups-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserGroupsStore({ baseDir });
  const userA = { id: 'user-A' };
  const userB = { id: 'user-B' };

  store.writeGroups(userA, ['grupo-A']);
  store.writeGroups(userB, ['grupo-B']);
  store.writeGroupConfig(userA, { 'grupo-A': { permitido: true } });
  store.writeGroupConfig(userB, { 'grupo-B': { permitido: false } });

  assert.deepEqual(store.readGroups(userA), ['grupo-A']);
  assert.deepEqual(store.readGroups(userB), ['grupo-B']);
  assert.deepEqual(store.readGroupConfig(userA), { 'grupo-A': { permitido: true } });
  assert.deepEqual(store.readGroupConfig(userB), { 'grupo-B': { permitido: false } });
});

test('recusa acesso sem usuário autenticado válido', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-groups-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserGroupsStore({ baseDir });

  assert.throws(() => store.readGroups(null), { code: 'AUTHENTICATED_USER_REQUIRED' });
  assert.throws(() => store.readGroupConfig({}), { code: 'AUTHENTICATED_USER_REQUIRED' });
  assert.throws(() => store.writeGroups({ id: 'user-A' }, 'não é array'), /deve ser um array/);
  assert.throws(() => store.writeGroupConfig({ id: 'user-A' }, []), /deve ser um objeto/);
});

test('não aceita IDs de usuário com traversal', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-groups-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserGroupsStore({ baseDir });

  assert.throws(() => store.readGroups({ id: '../outro' }), /Identificador de usuário inválido/);
});
