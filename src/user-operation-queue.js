'use strict';

/**
 * Serializa operações mutáveis por usuário sem bloquear usuários diferentes.
 * Útil para evitar start/stop/configurações simultâneas na mesma estância.
 * O chamador deve fornecer o ID autenticado; nunca aceite um ID arbitrário
 * vindo do corpo da requisição como autoridade.
 */
function createUserOperationQueue() {
  const pending = new Map();

  function run(userId, operation) {
    const id = String(userId ?? '');
    if (!id || typeof operation !== 'function') {
      return Promise.reject(new TypeError('userId e operation são obrigatórios.'));
    }

    const previous = pending.get(id) || Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => operation());

    // Mantém a fila até a operação terminar, mas permite que uma falha
    // não impeça as próximas operações do mesmo usuário.
    const cleanup = () => {
      if (pending.get(id) === tail) pending.delete(id);
    };
    // Não armazenar uma promise rejeitada sem tratamento: a chamada atual
    // continua recebendo seu erro, mas a fila interna sempre termina resolvida.
    const tail = current.then(cleanup, cleanup);
    pending.set(id, tail);
    return current;
  }

  function isBusy(userId) {
    return pending.has(String(userId ?? ''));
  }

  function userIds() {
    return [...pending.keys()];
  }

  return Object.freeze({ run, isBusy, userIds });
}

module.exports = { createUserOperationQueue };
