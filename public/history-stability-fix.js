(() => {
  // Mantém Histórico de links enviados e Links com falha estáveis durante o polling.
  // O primeiro carregamento continua usando as funções originais; nas atualizações
  // seguintes só redesenha a seção quando os dados realmente mudarem.
  const wrapStable = (name, endpoint, key) => {
    const original = window[name];
    if (typeof original !== 'function') return;

    let initialized = false;
    let lastSignature = '';
    let checking = false;

    window[name] = async function stableLoader(...args) {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(endpoint, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const value = data && Array.isArray(data[key]) ? data[key] : [];
        const signature = JSON.stringify(value);

        // Primeira carga: usa o renderer existente.
        if (!initialized) {
          initialized = true;
          lastSignature = signature;
          return await original.apply(this, args);
        }

        // Nada mudou: não toca no DOM e não mostra "Carregando...".
        if (signature === lastSignature) return;

        // Houve mudança: deixa o renderer existente atualizar os cartões uma única vez.
        lastSignature = signature;
        return await original.apply(this, args);
      } catch (error) {
        // Em erro de polling, preserva o que já está visível.
        console.warn(`[RegulOS] ${name}:`, error);
      } finally {
        checking = false;
      }
    };
  };

  wrapStable('loadLinkHistory', '/api/link-historico', 'historico');
  wrapStable('loadLinkFailures', '/api/link-falhas', 'falhas');
})();
