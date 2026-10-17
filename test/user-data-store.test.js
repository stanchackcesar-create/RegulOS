'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUserDataStore } = require('../src/user-data-store');

test('grava e lê dados isolados por usuário', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-user-store-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserDataStore({ baseDir });

  store.writeJson('user-A', 'groups', ['grupo-A']);
  store.writeJson('user-B', 'groups', ['grupo-B']);

  assert.deepEqual(store.readJson('user-A', 'groups', []), ['grupo-A']);
  assert.deepEqual(store.readJson('user-B', 'groups', []), ['grupo-B']);
  assert.notEqual(store.filePath('user-A', 'groups'), store.filePath('user-B', 'groups'));
});

test('usa fallback para arquivo inexistente ou JSON inválido', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-user-store-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserDataStore({ baseDir });

  assert.deepEqual(store.readJson('user-A', 'schedules', []), []);
  const file = store.filePath('user-A', 'schedules');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ JSON inválido', 'utf8');
  assert.deepEqual(store.readJson('user-A', 'schedules', []), []);
});

test('rejeita IDs com traversal e nomes de arquivo não autorizados', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-user-store-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const store = createUserDataStore({ baseDir });

  assert.throws(() => store.userDir('../outro'), /Identificador de usuário inválido/);
  assert.throws(() => store.filePath('user-A', '../usuarios.json'), /Tipo de arquivo de usuário não permitido/);
  assert.throws(() => store.filePath('user-A', 'unknown'), /Tipo de arquivo de usuário não permitido/);
});

test('recusa inicialização sem diretório-base explícito', () => {
  assert.throws(() => createUserDataStore(), /baseDir é obrigatório/);
});
