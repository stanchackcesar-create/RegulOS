'use strict';

const { validateUserId } = require('./user-data-store');

/**
 * Registro em memória para runtimes WhatsApp independentes por usuário.
 * Este módulo não conecta o WhatsApp por conta própria e não é integrado ao
 * servidor até que rotas, agendadores e armazenamento usem o mesmo contexto.
 */
function createUserRuntimeRegistry(options = {}) {
  if (typeof options.createRuntime !== 'function') {
    throw new TypeError('createRuntime é obrigatório.');
  }

  const disposeRuntime = typeof options.disposeRuntime === 'function'
    ? options.disposeRuntime
    : async () => {};
  const runtimes = new Map();

  function get(userId) {
    return runtimes.get(validateUserId(userId)) || null;
  }

  function getOrCreate(userId) {
    const id = validateUserId(userId);
    if (runtimes.has(id)) return runtimes.get(id);

    const runtime = options.createRuntime(id);
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      throw new TypeError('createRuntime deve retornar um objeto de runtime.');
    }
    runtimes.set(id, runtime);
    return runtime;
  }

  async function remove(userId) {
    const id = validateUserId(userId);
    if (!runtimes.has(id)) return false;
    const runtime = runtimes.get(id);
    runtimes.delete(id);
    await disposeRuntime(runtime, id);
    return true;
  }

  async function closeAll() {
    const entries = [...runtimes.entries()];
    runtimes.clear();
    const results = await Promise.allSettled(
      entries.map(([id, runtime]) => disposeRuntime(runtime, id))
    );
    return {
      closed: entries.length,
      errors: results.filter(result => result.status === 'rejected').length
    };
  }

  return Object.freeze({
    get,
    getOrCreate,
    has: userId => runtimes.has(validateUserId(userId)),
    userIds: () => [...runtimes.keys()],
    remove,
    closeAll
  });
}

module.exports = { createUserRuntimeRegistry };
