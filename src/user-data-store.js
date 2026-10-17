'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lista explícita: nenhuma rota pode escolher livremente um nome de arquivo.
const USER_DATA_FILES = Object.freeze({
  groups: 'grupos.json',
  groupConfig: 'grupos_config.json',
  links: 'links.json',
  index: 'indice.txt',
  history: 'historico.json',
  schedules: 'link_agendamentos.json',
  linkHistory: 'historico_links_enviados.json',
  linkFailures: 'links_com_falha.json',
  deliveries: 'entregas_links.json',
  botSchedule: 'programacao_bot.json',
  linkQueue: 'fila_links.json'
});

function validateUserId(userId) {
  const value = String(userId ?? '');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('Identificador de usuário inválido.');
  }
  return value;
}

function createUserDataStore(options = {}) {
  if (!options.baseDir) {
    throw new TypeError('baseDir é obrigatório para o armazenamento por usuário.');
  }

  const baseDir = path.resolve(String(options.baseDir));
  const usersRoot = path.resolve(baseDir, 'users');

  function userDir(userId) {
    const safeId = validateUserId(userId);
    const resolved = path.resolve(usersRoot, safeId);
    if (!resolved.startsWith(usersRoot + path.sep)) {
      throw new TypeError('Caminho de usuário inválido.');
    }
    return resolved;
  }

  function filePath(userId, logicalName) {
    const filename = USER_DATA_FILES[logicalName];
    if (!filename) throw new TypeError('Tipo de arquivo de usuário não permitido.');
    const dir = userDir(userId);
    const resolved = path.resolve(dir, filename);
    if (!resolved.startsWith(dir + path.sep)) {
      throw new TypeError('Caminho de arquivo inválido.');
    }
    return resolved;
  }

  function readJson(userId, logicalName, fallback) {
    const target = filePath(userId, logicalName);
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  function writeJson(userId, logicalName, value) {
    const target = filePath(userId, logicalName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
    return target;
  }

  function ensureUserDir(userId) {
    const dir = userDir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  return Object.freeze({ userDir, filePath, readJson, writeJson, ensureUserDir });
}

module.exports = { createUserDataStore, USER_DATA_FILES, validateUserId };
