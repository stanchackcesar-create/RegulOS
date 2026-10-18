'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserSessionManager } = require('../src/user-session-manager');

test('mantém QR, conexão, grupos e encerramento separados por usuário', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-session-manager-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const callbacks = new Map();
  const closed = [];
  const cleaned = [];
  const manager = createUserSessionManager({
    baseDir,
    async connect(userId) {
      const socket = { end() { closed.push(userId); } };
      return { socket, close() { cleaned.push(userId); } };
    },
  });

  await manager.start('user-A');
  await manager.start('user-B');
  // O conector pode fornecer callbacks no contrato abaixo, sem depender de Baileys.
  assert.deepEqual(manager.userIds().sort(), ['user-A', 'user-B']);
  assert.equal(manager.get('user-A').status, 'starting');
  assert.equal(manager.get('user-B').status, 'starting');

  manager.updateGroups('user-A', [{ id: 'A@g.us', name: 'A' }, { id: 'not-a-group' }]);
  manager.updateGroups('user-B', [{ id: 'B@g.us', name: 'B' }]);
  assert.deepEqual(manager.get('user-A').groups.map(g => g.id), ['A@g.us']);
  assert.deepEqual(manager.get('user-B').groups.map(g => g.id), ['B@g.us']);

  assert.equal(await manager.stop('user-A'), true);
  assert.equal(manager.get('user-A'), null);
  assert.equal(manager.get('user-B').status, 'starting');
  assert.deepEqual(closed, ['user-A']);
  assert.deepEqual(cleaned, ['user-A']);
  assert.equal(await manager.stop('user-A'), false);
  await manager.closeAll();
  assert.deepEqual(closed, ['user-A', 'user-B']);
  assert.deepEqual(cleaned, ['user-A', 'user-B']);
});

test('callbacks de sessão não são compartilhados entre usuários', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-session-callbacks-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const callbacks = new Map();
  const manager = createUserSessionManager({
    baseDir,
    async connect(userId, runtime, handlers) {
      callbacks.set(userId, handlers);
      return { socket: { end() {} }, close() {} };
    }
  });
  await manager.start('alpha');
  await manager.start('beta');
  callbacks.get('alpha').onQr('QR_ALPHA');
  callbacks.get('beta').onOpen({ connectedNumber: '5511999999999' });
  assert.equal(manager.get('alpha').qr, 'QR_ALPHA');
  assert.equal(manager.get('alpha').status, 'qr');
  assert.equal(manager.get('beta').qr, null);
  assert.equal(manager.get('beta').status, 'online');
  assert.equal(manager.get('beta').connectedNumber, '5511999999999');
  await manager.closeAll();
});

test('exige conector explícito para impedir conexão real acidental nos testes', () => {
  assert.throws(() => createUserSessionManager({ baseDir: '/tmp/test' }), /connect.*obrigatória/);
});

test('reiniciar uma sessão offline substitui o runtime anterior', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-session-restart-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const sockets = [];
  let callbacks;
  let connections = 0;
  const manager = createUserSessionManager({
    baseDir,
    async connect(userId, runtime, handlers) {
      callbacks = handlers;
      connections++;
      const socket = { end() { sockets.push(userId); } };
      return { socket, close() {} };
    }
  });
  await manager.start('restart-user');
  callbacks.onClose(new Error('conexão encerrada'));
  assert.equal(manager.get('restart-user').status, 'offline');
  await manager.start('restart-user');
  assert.equal(connections, 2);
  assert.equal(manager.get('restart-user').status, 'starting');
  await manager.closeAll();
  assert.deepEqual(sockets, ['restart-user', 'restart-user']);
});
