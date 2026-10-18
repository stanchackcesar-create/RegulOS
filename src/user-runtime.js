'use strict';

const { createUserContextFactory } = require('./user-context');
const { createUserGroupsStore } = require('./user-groups-store');

/**
 * Cria o conjunto de recursos isolados de um usuário sem abrir conexões externas.
 * A integração com Baileys e os agendadores do servidor deve ser feita depois,
 * passando sempre este runtime explicitamente às rotas e aos workers.
 */
function createUserRuntimeFactory(options = {}) {
  const contexts = createUserContextFactory({ baseDir: options.baseDir });
  const groupsStore = createUserGroupsStore({ baseDir: options.baseDir });

  function createRuntime(userId) {
    const context = contexts.createContext(userId);
    let socket = null;
    let closed = false;

    const runtime = {
      userId: context.userId,
      context,
      groups: {
        read: () => groupsStore.readGroups({ id: context.userId }),
        write: value => groupsStore.writeGroups({ id: context.userId }, value),
        readConfig: () => groupsStore.readGroupConfig({ id: context.userId }),
        writeConfig: value => groupsStore.writeGroupConfig({ id: context.userId }, value)
      },
      get socket() { return socket; },
      get closed() { return closed; },
      attachSocket(nextSocket) {
        if (closed) throw new Error('O runtime do usuário já foi encerrado.');
        if (!nextSocket || typeof nextSocket !== 'object') {
          throw new TypeError('Socket inválido.');
        }
        if (socket && socket !== nextSocket) {
          throw new Error('Já existe um socket associado a este runtime.');
        }
        socket = nextSocket;
        return socket;
      },
      async close() {
        if (closed) return false;
        closed = true;
        const current = socket;
        socket = null;
        if (current) {
          try {
            if (typeof current.end === 'function') current.end(new Error('Runtime encerrado.'));
            else if (typeof current.logout === 'function') await current.logout();
          } catch {
            // Encerramento é best-effort; nunca deve impedir limpar o runtime.
          }
        }
        return true;
      }
    };
    return Object.freeze(runtime);
  }

  return Object.freeze({ createRuntime });
}

module.exports = { createUserRuntimeFactory };
