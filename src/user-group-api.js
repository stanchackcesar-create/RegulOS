'use strict';

const { createUserApiContext } = require('./user-api-context');
const { createUserGroupService } = require('./user-group-service');

/**
 * Fachada de domínio para futuras rotas HTTP de grupos.
 * Não depende de Express e não aceita proprietário vindo do cliente.
 */
function createUserGroupApi(options = {}) {
  if (!options.sessionManager || typeof options.sessionManager.get !== 'function') {
    throw new TypeError('sessionManager é obrigatório.');
  }
  const context = createUserApiContext(options.sessionManager);
  const service = options.groupService || createUserGroupService();

  function catalogFor(req) {
    const userId = context.userId(req);
    const state = options.sessionManager.get(userId);
    if (!state) {
      const error = new Error('Sessão do usuário não encontrada.');
      error.code = 'USER_SESSION_NOT_FOUND';
      throw error;
    }
    return Array.isArray(state.groups) ? state.groups : [];
  }

  function list(req) {
    const runtime = context.runtime(req);
    return service.list(runtime, catalogFor(req));
  }

  function setAllowed(req, ids) {
    const runtime = context.runtime(req);
    return service.setAllowed(runtime, ids, catalogFor(req));
  }

  function updateConfig(req, groupId, patch) {
    const runtime = context.runtime(req);
    return service.updateConfig(runtime, groupId, patch, catalogFor(req));
  }

  return Object.freeze({ list, setAllowed, updateConfig });
}

module.exports = { createUserGroupApi };
