'use strict';

const { createUserContextFactory } = require('./user-context');

/**
 * Acesso isolado aos grupos e às configurações de grupo.
 * O userId deve vir exclusivamente de req.user.id após requireAuth.
 * Não use IDs de usuário fornecidos pelo navegador como autoridade.
 */
function createUserGroupsStore(options = {}) {
  const contexts = createUserContextFactory({ baseDir: options.baseDir });

  function contextForAuthenticatedUser(user) {
    if (!user || typeof user !== 'object' || typeof user.id !== 'string' || !user.id) {
      const error = new Error('Usuário autenticado obrigatório para acessar grupos.');
      error.code = 'AUTHENTICATED_USER_REQUIRED';
      throw error;
    }
    return contexts.createContext(user.id);
  }

  function readGroups(user) {
    const context = contextForAuthenticatedUser(user);
    const value = context.data.readJson('groups', []);
    return Array.isArray(value) ? value : [];
  }

  function writeGroups(user, groups) {
    if (!Array.isArray(groups)) throw new TypeError('A lista de grupos deve ser um array.');
    const context = contextForAuthenticatedUser(user);
    context.data.writeJson('groups', groups);
    return groups;
  }

  function readGroupConfig(user) {
    const context = contextForAuthenticatedUser(user);
    const value = context.data.readJson('groupConfig', {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function writeGroupConfig(user, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new TypeError('A configuração dos grupos deve ser um objeto.');
    }
    const context = contextForAuthenticatedUser(user);
    context.data.writeJson('groupConfig', config);
    return config;
  }

  return Object.freeze({ readGroups, writeGroups, readGroupConfig, writeGroupConfig });
}

module.exports = { createUserGroupsStore };
