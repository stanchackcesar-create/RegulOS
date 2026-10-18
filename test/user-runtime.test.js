'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserRuntimeFactory } = require('../src/user-runtime');

test('runtime reúne dados e grupos isolados por usuário', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-runtime-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const factory = createUserRuntimeFactory({ baseDir });
  const a = factory.createRuntime('user-A');
  const b = factory.createRuntime('user-B');

  a.groups.write(['grupo-A']);
  b.groups.write(['grupo-B']);
  a.groups.writeConfig({ 'grupo-A': { ativo: true } });
  b.groups.writeConfig({ 'grupo-B': { ativo: false } });

  assert.notEqual(a, b);
  assert.notEqual(a.context.dir, b.context.dir);
  assert.deepEqual(a.groups.read(), ['grupo-A']);
  assert.deepEqual(b.groups.read(), ['grupo-B']);
  assert.deepEqual(a.groups.readConfig(), { 'grupo-A': { ativo: true } });
  assert.deepEqual(b.groups.readConfig(), { 'grupo-B': { ativo: false } });
});

test('runtime associa apenas um socket e fecha apenas o seu próprio socket', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-runtime-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const factory = createUserRuntimeFactory({ baseDir });
  const a = factory.createRuntime('user-A');
  const b = factory.createRuntime('user-B');
  let endedA = 0;
  let endedB = 0;
  const socketA = { end: () => { endedA++; } };
  const socketB = { end: () => { endedB++; } };

  a.attachSocket(socketA);
  b.attachSocket(socketB);
  assert.throws(() => a.attachSocket({ end() {} }), /Já existe um socket/);
  assert.equal(await a.close(), true);
  assert.equal(await a.close(), false);
  assert.equal(a.socket, null);
  assert.equal(b.socket, socketB);
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  assert.deepEqual([endedA, endedB], [1, 0]);
  assert.throws(() => a.attachSocket({ end() {} }), /já foi encerrado/);
});

test('runtime rejeita identificador inválido', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-runtime-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const factory = createUserRuntimeFactory({ baseDir });
  assert.throws(() => factory.createRuntime('../other'), /Identificador de usuário inválido/);
});
