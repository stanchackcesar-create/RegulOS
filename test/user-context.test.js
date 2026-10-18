'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserContextFactory } = require('../src/user-context');

test('contextos mantêm arquivos e diretórios separados entre usuários', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-context-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const factory = createUserContextFactory({ baseDir });

  const a = factory.createContext('user-A');
  const b = factory.createContext('user-B');
  a.data.writeJson('groups', ['grupo-A']);
  b.data.writeJson('groups', ['grupo-B']);

  assert.notEqual(a.dir, b.dir);
  assert.equal(a.userId, 'user-A');
  assert.equal(b.userId, 'user-B');
  assert.deepEqual(a.data.readJson('groups', []), ['grupo-A']);
  assert.deepEqual(b.data.readJson('groups', []), ['grupo-B']);
  assert.notEqual(a.data.filePath('groups'), b.data.filePath('groups'));
});

test('contexto não permite escolher caminho ou arquivo fora da lista autorizada', (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regulos-context-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const factory = createUserContextFactory({ baseDir });

  assert.throws(() => factory.createContext('../outro'), /Identificador de usuário inválido/);
  const context = factory.createContext('user-A');
  assert.throws(() => context.data.filePath('../usuarios.json'), /Tipo de arquivo de usuário não permitido/);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.data), true);
});

test('exige diretório-base explícito', () => {
  assert.throws(() => createUserContextFactory(), /baseDir é obrigatório/);
});
