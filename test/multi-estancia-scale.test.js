'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserContextFactory } = require('../src/user-context');
const { createUserSessionManager } = require('../src/user-session-manager');
const { createUserLinkEngine } = require('../src/user-link-engine');

test('20 contas mantêm sessões, grupos, agendamentos e envios isolados em paralelo', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-multi-scale-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const contexts = createUserContextFactory({ baseDir });
  const sentByUser = new Map();
  const manager = createUserSessionManager({
    baseDir,
    async connect(userId, runtime, callbacks) {
      sentByUser.set(userId, []);
      const socket = {
        async sendMessage(groupId, message) {
          sentByUser.get(userId).push({ groupId, message });
        },
        end() {}
      };
      callbacks.onOpen({ connectedNumber: userId });
      callbacks.onGroups([{ id: String(Number(userId.replace('user-', '')) + 10000) + '-123@g.us', name: userId }]);
      return { socket, close() {} };
    }
  });
  const engine = createUserLinkEngine({
    baseDir,
    sessions: manager,
    prepareMessage: async item => ({ text: item.url, imageBuffer: Buffer.from('test-image') })
  });

  const ids = Array.from({ length: 20 }, (_, i) => 'user-' + String(i + 1));
  await Promise.all(ids.map(id => manager.start(id)));

  for (const id of ids) {
    const n = Number(id.replace('user-', ''));
    const groupId = String(n + 10000) + '-123@g.us';
    const data = contexts.createContext(id).data;
    data.writeJson('schedules', [{
      id: 'offer-' + id, nome: id, url: 'https://example.com/' + id,
      grupoIds: [groupId], ativo: true, repeticao: 'uma_vez', intervaloMin: 0
    }]);
    data.writeJson('groupConfig', { [groupId]: { ativo: true } });
    manager.updateGroups(id, [{ id: groupId, name: id }]);
  }

  const results = await Promise.all(ids.map(id => engine.sendOne(id, 'offer-' + id, { force: true })));
  assert.equal(results.filter(x => x.ok).length, 20);
  for (const id of ids) {
    const own = sentByUser.get(id);
    assert.equal(own.length, 1, id + ' deve enviar uma única vez');
    assert.equal(own[0].message.caption, 'https://example.com/' + id);
    const otherGroups = ids.filter(other => other !== id).map(other => String(Number(other.replace('user-', '')) + 10000) + '-123@g.us');
    assert.equal(otherGroups.includes(own[0].groupId), false, id + ' não pode enviar a grupo alheio');
    assert.equal(contexts.createContext(id).data.readJson('linkHistory', []).length, 1);
  }
  await manager.closeAll();
  engine.close();
});
