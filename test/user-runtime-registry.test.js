'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserRuntimeRegistry } = require('../src/user-runtime-registry');

test('mantém um runtime distinto por usuário e reutiliza o runtime do mesmo usuário', () => {
  let created = 0;
  const registry = createUserRuntimeRegistry({
    createRuntime: userId => ({ userId, socket: { id: ++created }, groups: [] })
  });

  const a1 = registry.getOrCreate('user-A');
  const a2 = registry.getOrCreate('user-A');
  const b = registry.getOrCreate('user-B');

  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1.socket, b.socket);
  assert.deepEqual(registry.userIds().sort(), ['user-A', 'user-B']);
  assert.equal(registry.get('user-C'), null);
});

test('remove apenas o runtime solicitado e chama o descarte correspondente', async () => {
  const disposed = [];
  const registry = createUserRuntimeRegistry({
    createRuntime: userId => ({ userId }),
    disposeRuntime: async (runtime, userId) => disposed.push([runtime.userId, userId])
  });
  registry.getOrCreate('user-A');
  registry.getOrCreate('user-B');

  assert.equal(await registry.remove('user-A'), true);
  assert.equal(await registry.remove('user-A'), false);
  assert.equal(registry.has('user-A'), false);
  assert.equal(registry.has('user-B'), true);
  assert.deepEqual(disposed, [['user-A', 'user-A']]);
});

test('fecha todos os runtimes mesmo quando um descarte falha', async () => {
  const registry = createUserRuntimeRegistry({
    createRuntime: userId => ({ userId }),
    disposeRuntime: async runtime => {
      if (runtime.userId === 'user-A') throw new Error('falha simulada');
    }
  });
  registry.getOrCreate('user-A');
  registry.getOrCreate('user-B');

  assert.deepEqual(await registry.closeAll(), { closed: 2, errors: 1 });
  assert.deepEqual(registry.userIds(), []);
});

test('rejeita ID inválido e runtime inválido', () => {
  const registry = createUserRuntimeRegistry({ createRuntime: () => null });
  assert.throws(() => registry.getOrCreate('../outro'), /Identificador de usuário inválido/);
  assert.throws(() => registry.getOrCreate('user-A'), /deve retornar um objeto/);
  assert.throws(() => createUserRuntimeRegistry(), /createRuntime é obrigatório/);
});
