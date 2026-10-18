'use strict';

/**
 * Regras de domínio para grupos por usuário.
 * O chamador deve fornecer o runtime já resolvido a partir de req.user.id.
 * Este serviço não consulta socket/global state e não confia em userId do body.
 */
function createUserGroupService() {
  function requireRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object' || !runtime.userId || runtime.closed) {
      const error = new Error('Runtime ativo do usuário obrigatório.');
      error.code = 'USER_RUNTIME_REQUIRED';
      throw error;
    }
    if (!runtime.groups ||
        typeof runtime.groups.read !== 'function' ||
        typeof runtime.groups.write !== 'function' ||
        typeof runtime.groups.readConfig !== 'function' ||
        typeof runtime.groups.writeConfig !== 'function') {
      throw new TypeError('Runtime sem armazenamento de grupos compatível.');
    }
    return runtime;
  }

  function normalizeCatalog(catalog) {
    if (!Array.isArray(catalog)) throw new TypeError('Catálogo de grupos inválido.');
    const ids = new Set();
    return catalog.filter(group => {
      if (!group || typeof group.id !== 'string' || !group.id.endsWith('@g.us')) return false;
      if (ids.has(group.id)) return false;
      ids.add(group.id);
      return true;
    });
  }

  function list(runtime, catalog) {
    const owner = requireRuntime(runtime);
    const groups = normalizeCatalog(catalog);
    const allowed = new Set(owner.groups.read());
    const config = owner.groups.readConfig();
    return groups.map(group => ({
      ...group,
      allowed: allowed.has(group.id),
      config: config[group.id] && typeof config[group.id] === 'object' ? config[group.id] : { ativo: false, apelido: '' }
    }));
  }

  function setAllowed(runtime, requestedIds, catalog) {
    const owner = requireRuntime(runtime);
    if (!Array.isArray(requestedIds) || requestedIds.some(id => typeof id !== 'string')) {
      throw new TypeError('IDs de grupos inválidos.');
    }
    const groups = normalizeCatalog(catalog);
    const ownedIds = new Set(groups.map(group => group.id));
    const uniqueIds = [...new Set(requestedIds)];
    if (uniqueIds.some(id => !ownedIds.has(id))) {
      const error = new Error('Um ou mais grupos não pertencem ao catálogo desta sessão.');
      error.code = 'GROUP_NOT_IN_USER_CATALOG';
      throw error;
    }
    owner.groups.write(uniqueIds);
    return uniqueIds;
  }

  function updateConfig(runtime, groupId, patch, catalog) {
    const owner = requireRuntime(runtime);
    if (typeof groupId !== 'string' || !groupId.endsWith('@g.us')) {
      throw new TypeError('ID de grupo inválido.');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Configuração de grupo inválida.');
    }
    const groups = normalizeCatalog(catalog);
    if (!groups.some(group => group.id === groupId)) {
      const error = new Error('Grupo não encontrado na sessão deste usuário.');
      error.code = 'GROUP_NOT_IN_USER_CATALOG';
      throw error;
    }
    const all = owner.groups.readConfig();
    const previous = all[groupId] && typeof all[groupId] === 'object' ? all[groupId] : { ativo: false, apelido: '' };
    const next = { ...previous };
    if (typeof patch.ativo === 'boolean') next.ativo = patch.ativo;
    if (typeof patch.apelido === 'string') next.apelido = patch.apelido.slice(0, 120);
    all[groupId] = next;
    owner.groups.writeConfig(all);
    const allowed = new Set(owner.groups.read());
    if (next.ativo) allowed.add(groupId);
    else allowed.delete(groupId);
    owner.groups.write([...allowed]);
    return { config: next, allowed: [...allowed] };
  }

  return Object.freeze({ list, setAllowed, updateConfig });
}

module.exports = { createUserGroupService };
