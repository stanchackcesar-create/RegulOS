'use strict';

/**
 * Resolve o runtime operacional exclusivamente a partir da identidade autenticada.
 * Este adaptador não inicia sessões automaticamente e não lê userId do body/query.
 * A integração HTTP pode usar resolveAuthenticatedRuntime(req, manager) após requireAuth.
 */
function authenticatedUserId(req) {
  const id = req && req.user && req.user.id;
  if (typeof id !== 'string' || !id.trim()) {
    const error = new Error('Usuário autenticado obrigatório.');
    error.code = 'AUTHENTICATED_USER_REQUIRED';
    throw error;
  }
  return id;
}

function resolveAuthenticatedRuntime(req, sessionManager) {
  const userId = authenticatedUserId(req);
  if (!sessionManager || typeof sessionManager.get !== 'function') {
    throw new TypeError('Gerenciador de sessões inválido.');
  }
  const runtime = sessionManager.get(userId);
  if (!runtime) {
    const error = new Error('Não existe runtime para o usuário autenticado.');
    error.code = 'USER_RUNTIME_NOT_FOUND';
    throw error;
  }
  if (runtime.userId !== userId) {
    const error = new Error('O runtime resolvido não pertence ao usuário autenticado.');
    error.code = 'USER_RUNTIME_OWNERSHIP_MISMATCH';
    throw error;
  }
  return runtime;
}

function createUserApiContext(sessionManager) {
  return Object.freeze({
    userId: req => authenticatedUserId(req),
    runtime: req => resolveAuthenticatedRuntime(req, sessionManager)
  });
}

module.exports = { authenticatedUserId, resolveAuthenticatedRuntime, createUserApiContext };
