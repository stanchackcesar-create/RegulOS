'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserSessionManager } = require('../src/user-session-manager');
const { createUserGroupApi } = require('../src/user-group-api');

test('opera grupos no runtime do usuário autenticado, não no userId enviado pelo cliente', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-group-api-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const manager = createUserSessionManager({
    baseDir,
    async connect(userId, runtime, callbacks) {
      callbacks.onGroups([{ id: userId + '-group@g.us', name: userId }]);
      return { socket: { end() {} }, close() {} };
    }
  });
  await manager.start('user-A');
  await manager.start('user-B');
  const api = createUserGroupApi({ sessionManager: manager });
  const reqA = { user: { id: 'user-A' }, body: { userId: 'user-B' } };
  const reqB = { user: { id: 'user-B' } };

  assert.deepEqual(api.list(reqA).map(g => g.id), ['user-A-group@g.us']);
  assert.deepEqual(api.list(reqB).map(g => g.id), ['user-B-group@g.us']);
  api.setAllowed(reqA, ['user-A-group@g.us']);
  assert.deepEqual(manager.getRuntime('user-A').groups.read(), ['user-A-group@g.us']);
  assert.deepEqual(manager.getRuntime('user-B').groups.read(), []);
  assert.throws(() => api.setAllowed(reqA, ['user-B-group@g.us']), { code: 'GROUP_NOT_IN_USER_CATALOG' });
  await manager.closeAll();
});

test('recusa operação sem sessão autenticada ou sem sessão do usuário', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-group-api-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const manager = createUserSessionManager({
    baseDir,
    async connect() { return { socket: { end() {} }, close() {} }; }
  });
  const api = createUserGroupApi({ sessionManager: manager });
  assert.throws(() => api.list({ body: { userId: 'user-A' } }), { code: 'AUTHENTICATED_USER_REQUIRED' });
  assert.throws(() => api.list({ user: { id: 'user-A' } }), { code: 'USER_RUNTIME_NOT_FOUND' });
});
