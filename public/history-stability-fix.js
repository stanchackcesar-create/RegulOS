(() => {
  // Histórico e falhas ficam estáveis durante o polling.
  // Não mostramos "Carregando..." e não apagamos a lista durante atualizações.
  const boxes = {
    linkHistory: '🔄 Carregando histórico...',
    linkFailures: 'Carregando falhas...'
  };

  // O renderer original usa innerHTML='' antes de reconstruir os cartões.
  // Ignoramos essas duas operações somente nos dois painéis, evitando o pisca.
  const originalSetter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.set;
  const originalGetter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')?.get;
  if (originalSetter && originalGetter) {
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      get: function(){ return originalGetter.call(this); },
      set: function(value){
        const id = this.id;
        if (id === 'linkHistory' || id === 'linkFailures') {
          const text = String(value ?? '').trim();
          if (text === '' || text === boxes[id]) return;
        }
        originalSetter.call(this, value);
      }
    });
  }

  // Retira o placeholder inicial imediatamente. A primeira carga continua sendo
  // feita pela rotina existente, mas sem exibir a mensagem de carregamento.
  ['linkHistory','linkFailures'].forEach(id => {
    const box = document.getElementById(id);
    if (box) box.textContent = '';
  });

  const wrapStable = (name, endpoint, key, boxId) => {
    const original = window[name];
    if (typeof original !== 'function') return;

    let lastSignature = '';
    let initialized = false;
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

        if (!initialized) {
          initialized = true;
          lastSignature = signature;
          // A primeira execução pode ter começado antes deste wrapper ser instalado.
          // Não chamamos novamente: a rotina original já está carregando os dados.
          return;
        }

        if (signature === lastSignature) return;

        // Só houve mudança: limpa uma vez, sem mensagem de carregamento,
        // e deixa o renderer existente criar os cartões atualizados.
        lastSignature = signature;
        const box = document.getElementById(boxId);
        if (box) box.replaceChildren();
        return await original.apply(this, args);
      } catch (error) {
        console.warn(`[RegulOS] ${name}:`, error);
      } finally {
        checking = false;
      }
    };
  };

  wrapStable('loadLinkHistory', '/api/link-historico', 'historico', 'linkHistory');
  wrapStable('loadLinkFailures', '/api/link-falhas', 'falhas', 'linkFailures');
})();
