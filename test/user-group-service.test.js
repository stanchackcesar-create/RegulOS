'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserRuntimeFactory } = require('../src/user-runtime');
const { createUserGroupService } = require('../src/user-group-service');

test('lista e configura grupos somente no runtime fornecido', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-group-service-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const runtimes = createUserRuntimeFactory({ baseDir });
  const service = createUserGroupService();
  const a = runtimes.createRuntime('user-A');
  const b = runtimes.createRuntime('user-B');
  const catalogA = [{ id: 'grupo-A@g.us', name: 'Grupo A' }];
  const catalogB = [{ id: 'grupo-B@g.us', name: 'Grupo B' }];

  service.setAllowed(a, ['grupo-A@g.us'], catalogA);
  service.updateConfig(a, 'grupo-A@g.us', { ativo: true, apelido: 'Meu grupo' }, catalogA);

  assert.deepEqual(service.list(a, catalogA).map(g => [g.id, g.allowed, g.config.apelido]), [
    ['grupo-A@g.us', true, 'Meu grupo']
  ]);
  assert.deepEqual(service.list(b, catalogB).map(g => [g.id, g.allowed]), [
    ['grupo-B@g.us', false]
  ]);
  assert.deepEqual(b.groups.read(), []);
  assert.deepEqual(b.groups.readConfig(), {});
});

test('recusa IDs que não pertencem ao catálogo da sessão', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-group-service-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const runtime = createUserRuntimeFactory({ baseDir }).createRuntime('user-A');
  const service = createUserGroupService();
  const catalog = [{ id: 'grupo-A@g.us', name: 'Grupo A' }];

  assert.throws(
    () => service.setAllowed(runtime, ['grupo-B@g.us'], catalog),
    { code: 'GROUP_NOT_IN_USER_CATALOG' }
  );
  assert.throws(
    () => service.updateConfig(runtime, 'grupo-B@g.us', { ativo: true }, catalog),
    { code: 'GROUP_NOT_IN_USER_CATALOG' }
  );
  assert.deepEqual(runtime.groups.read(), []);
});

test('recusa runtime ausente ou encerrado', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-group-service-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const runtime = createUserRuntimeFactory({ baseDir }).createRuntime('user-A');
  const service = createUserGroupService();

  assert.throws(() => service.list(null, []), { code: 'USER_RUNTIME_REQUIRED' });
  runtime.close();
  assert.throws(() => service.list(runtime, []), { code: 'USER_RUNTIME_REQUIRED' });
});
