'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBaileysUserConnector } = require('../src/baileys-user-connector');

test('cria autenticação separada e encaminha QR, conexão e grupos', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-baileys-adapter-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sockets = [];
  const authDirs = [];
  let credsSaved = 0;
  const connector = createBaileysUserConnector({
    async useMultiFileAuthState(dir) {
      authDirs.push(dir);
      return { state: { creds: {} }, async saveCreds() { credsSaved++; } };
    },
    async fetchLatestBaileysVersion() { return { version: [2, 3000, 1] }; },
    makeWASocket(config) {
      const socket = {
        config,
        user: { id: sockets.length ? '5511888888888:3@s.whatsapp.net' : '5511999999999:2@s.whatsapp.net' },
        ev: new EventEmitter(),
        async groupFetchAllParticipating() {
          return { 'group-1@g.us': { subject: 'Grupo 1' }, 'direct@s.whatsapp.net': { subject: 'Não é grupo' } };
        }
      };
      sockets.push(socket);
      return socket;
    },
    async toDataURL(value) { return 'data:qr,' + value; },
    logger: {}
  });
  const callbacks = () => ({ qrs: [], opens: [], groups: [], closes: [], onQr(v) { this.qrs.push(v); }, onOpen(v) { this.opens.push(v); }, onGroups(v) { this.groups.push(v); }, onClose(v) { this.closes.push(v); } });
  const runtimeA = { userId: 'user-A', context: { dir: path.join(base, 'user-A') }, closed: false };
  const runtimeB = { userId: 'user-B', context: { dir: path.join(base, 'user-B') }, closed: false };
  fs.mkdirSync(runtimeA.context.dir, { recursive: true });
  fs.mkdirSync(runtimeB.context.dir, { recursive: true });
  const a = callbacks(), b = callbacks();
  const connectionA = await connector.connect('user-A', runtimeA, a);
  const connectionB = await connector.connect('user-B', runtimeB, b);

  assert.notEqual(connectionA.authDir, connectionB.authDir);
  assert.deepEqual(authDirs, [connectionA.authDir, connectionB.authDir]);
  assert.ok(fs.existsSync(connectionA.authDir));
  assert.ok(fs.existsSync(connectionB.authDir));

  sockets[0].ev.emit('connection.update', { qr: 'QR_A' });
  sockets[1].ev.emit('connection.update', { connection: 'open' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(a.qrs, ['data:qr,QR_A']);
  assert.equal(a.opens.length, 0);
  assert.equal(b.opens[0].connectedNumber, '5511888888888');
  assert.deepEqual(b.groups[0].map(g => g.id), ['group-1@g.us']);

  sockets[0].ev.emit('creds.update');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(credsSaved, 1);
  assert.equal(await connectionA.close(), true);
  assert.equal(sockets[0].ev.listenerCount('connection.update'), 0);
  assert.equal(sockets[0].ev.listenerCount('creds.update'), 0);
  assert.equal(await connectionA.close(), false);
  await connectionB.close();
});

test('rejeita runtime que não pertence ao usuário solicitado', async () => {
  const connector = createBaileysUserConnector({
    useMultiFileAuthState: async () => { throw new Error('não deveria ser chamado'); },
    fetchLatestBaileysVersion: async () => ({ version: [] }),
    makeWASocket: () => ({}),
    toDataURL: async value => value,
    logger: {}
  });
  await assert.rejects(
    connector.connect('user-A', { userId: 'user-B', closed: false, context: { dir: '/tmp' } }, {}),
    /Runtime incompatível/
  );
});
