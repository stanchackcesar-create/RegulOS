'use strict';

const { createUserDataStore, validateUserId } = require('./user-data-store');

/**
 * Cria um contexto operacional isolado para um usuário autenticado.
 * Este módulo é infraestrutura de teste e ainda não é conectado às rotas
 * do servidor. O chamador deve obter userId da sessão validada no servidor.
 */
function createUserContextFactory(options = {}) {
  const store = createUserDataStore({ baseDir: options.baseDir });

  function createContext(userId) {
    const id = validateUserId(userId);
    const dir = store.ensureUserDir(id);

    return Object.freeze({
      userId: id,
      dir,
      data: Object.freeze({
        readJson: (name, fallback) => store.readJson(id, name, fallback),
        writeJson: (name, value) => store.writeJson(id, name, value),
        filePath: name => store.filePath(id, name)
      })
    });
  }

  return Object.freeze({ createContext });
}

module.exports = { createUserContextFactory };
