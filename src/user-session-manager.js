'use strict';

const { createUserRuntimeFactory } = require('./user-runtime');
const { createUserRuntimeRegistry } = require('./user-runtime-registry');

/**
 * Gerencia ciclo de vida por usuário. A conexão é injetada pelo servidor,
 * permitindo testes sem Baileys, QR real, rede ou sessão WhatsApp.
 * Não substitui o start() global legado até a integração completa do servidor.
 */
function createUserSessionManager(options = {}) {
  if (typeof options.connect !== 'function') {
    throw new TypeError('A função connect(userId, runtime, callbacks) é obrigatória.');
  }
  const runtimeFactory = options.runtimeFactory || createUserRuntimeFactory({ baseDir: options.baseDir });
  const registry = createUserRuntimeRegistry({
    createRuntime: id => runtimeFactory.createRuntime(id),
    disposeRuntime: runtime => runtime.close()
  });
  const states = new Map();
  const connectors = new Map();

  function stateFor(userId) {
    const runtime = registry.get(userId);
    const state = states.get(String(userId));
    if (!runtime || !state) return null;
    return Object.freeze({
      userId: runtime.userId,
      status: state.status,
      qr: state.qr,
      connectedNumber: state.connectedNumber,
      groups: state.groups.map(group => ({ ...group })),
      lastError: state.lastError
    });
  }

  async function start(userId) {
    const runtime = registry.getOrCreate(userId);
    const existing = states.get(runtime.userId);
    if (existing && ['starting', 'online'].includes(existing.status)) return stateFor(runtime.userId);

    const state = {
      status: 'starting', qr: null, connectedNumber: '',
      groups: [], lastError: ''
    };
    states.set(runtime.userId, state);
    const callbacks = Object.freeze({
      onQr(value) {
        if (registry.get(runtime.userId) !== runtime || runtime.closed) return;
        state.qr = typeof value === 'string' ? value : null;
        state.status = state.qr ? 'qr' : state.status;
      },
      onOpen(info = {}) {
        if (registry.get(runtime.userId) !== runtime || runtime.closed) return;
        state.status = 'online';
        state.qr = null;
        state.connectedNumber = String(info.connectedNumber || '');
        state.lastError = '';
      },
      onGroups(groups) {
        if (registry.get(runtime.userId) !== runtime || runtime.closed) return;
        state.groups = Array.isArray(groups)
          ? groups.filter(g => g && typeof g.id === 'string' && g.id.endsWith('@g.us')).map(g => ({ ...g }))
          : [];
      },
      onClose(error) {
        if (registry.get(runtime.userId) !== runtime) return;
        state.status = 'offline';
        state.qr = null;
        state.connectedNumber = '';
        if (error) state.lastError = String(error.message || error);
      }
    });

    try {
      const connection = await options.connect(runtime.userId, runtime, callbacks);
      if (registry.get(runtime.userId) !== runtime || runtime.closed) {
        try { await connection?.close?.(); } catch {}
        return null;
      }
      if (connection && connection.socket) runtime.attachSocket(connection.socket);
      if (connection && typeof connection.close === 'function') connectors.set(runtime.userId, connection);
      return stateFor(runtime.userId);
    } catch (error) {
      state.status = 'error';
      state.lastError = String(error?.message || error);
      throw error;
    }
  }

  async function stop(userId) {
    const runtime = registry.get(userId);
    if (!runtime) return false;
    const id = runtime.userId;
    const connector = connectors.get(id);
    connectors.delete(id);
    states.delete(id);
    // O conector sempre precisa liberar seus listeners/recursos auxiliares.
    // O contrato do conector é não encerrar o socket; runtime.close() é o único
    // responsável por isso, evitando end()/logout() duplicados.
    if (connector) {
      try { await connector.close(); } catch {}
    }
    await registry.remove(id);
    return true;
  }

  function get(userId) {
    return stateFor(userId);
  }

  function updateGroups(userId, groups) {
    const runtime = registry.get(userId);
    if (!runtime || runtime.closed) throw new Error('Sessão do usuário não está ativa.');
    const state = states.get(runtime.userId);
    if (!state) throw new Error('Estado da sessão não encontrado.');
    state.groups = Array.isArray(groups)
      ? groups.filter(g => g && typeof g.id === 'string' && g.id.endsWith('@g.us')).map(g => ({ ...g }))
      : [];
    return stateFor(runtime.userId).groups;
  }

  async function closeAll() {
    const ids = registry.userIds();
    await Promise.all(ids.map(id => stop(id)));
    return { closed: ids.length };
  }

  return Object.freeze({ start, stop, get, updateGroups, userIds: () => registry.userIds(), closeAll });
}

module.exports = { createUserSessionManager };
