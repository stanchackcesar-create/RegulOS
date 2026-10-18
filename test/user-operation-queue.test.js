'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUserOperationQueue } = require('../src/user-operation-queue');

test('serializa operações do mesmo usuário', async () => {
  const queue = createUserOperationQueue();
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const first = queue.run('user-a', async () => {
    order.push('a1-start');
    await gate;
    order.push('a1-end');
  });
  const second = queue.run('user-a', async () => {
    order.push('a2');
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['a1-start']);
  assert.equal(queue.isBusy('user-a'), true);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1-start', 'a1-end', 'a2']);
  assert.equal(queue.isBusy('user-a'), false);
});

test('usuários diferentes podem executar em paralelo', async () => {
  const queue = createUserOperationQueue();
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const order = [];

  const first = queue.run('user-a', async () => {
    order.push('a-start');
    await gateA;
    order.push('a-end');
  });
  await Promise.resolve();
  const second = queue.run('user-b', async () => { order.push('b'); });
  await second;
  assert.deepEqual(order, ['a-start', 'b']);
  releaseA();
  await first;
  assert.deepEqual(order, ['a-start', 'b', 'a-end']);
});

test('falha em uma operação não bloqueia a fila seguinte', async () => {
  const queue = createUserOperationQueue();
  await assert.rejects(queue.run('user-a', async () => { throw new Error('falha esperada'); }), /falha esperada/);
  const result = await queue.run('user-a', async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(queue.isBusy('user-a'), false);
});

test('rejeita chamadas sem identificador ou operação', async () => {
  const queue = createUserOperationQueue();
  await assert.rejects(queue.run('', async () => {}), /obrigatórios/);
  await assert.rejects(queue.run('user-a', null), /obrigatórios/);
});
