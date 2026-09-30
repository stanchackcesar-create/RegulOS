(() => {
  // Histórico e falhas ficam estáveis durante o polling.
  // Não mostramos "Carregando..." nem apagamos a lista sem necessidade.
  const boxes = {
    linkHistory: '🔄 Carregando histórico...',
    linkFailures: 'Carregando falhas...'
  };

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
        const response = await fetch(endpoint, {
          cache: 'no-store',
          credentials: 'same-origin'
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const value = data && Array.isArray(data[key]) ? data[key] : [];
        const signature = JSON.stringify(value);

        // Primeira carga também precisa renderizar o painel.
        if (!initialized) {
          initialized = true;
          lastSignature = signature;
          return await original.apply(this, args);
        }

        // Se nada mudou, não força uma nova renderização.
        if (signature === lastSignature) return;
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

  // Correção do botão Reconectar no celular.
  // Mantém a autenticação da sessão, evita toques duplicados e mostra
  // claramente qualquer erro HTTP em vez de parecer que o botão não fez nada.
  const installReconnectFix = () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find(b => /reconectar/i.test((b.textContent || '').trim()));
    if (!button || button.dataset.regulosReconnectFix === '1') return;
    button.dataset.regulosReconnectFix = '1';
    button.type = 'button';
    button.removeAttribute('onclick');

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      if (button.dataset.busy === '1') return;
      button.dataset.busy = '1';
      const oldText = button.textContent;
      button.disabled = true;
      button.textContent = '⏳ Reconectando...';

      const show = (message, error = false) => {
        if (typeof window.toast === 'function') window.toast(message, error);
        else console.log(message);
      };

      try {
        if (navigator.onLine === false) throw new Error('O celular está sem conexão com a internet.');
        const response = await fetch('/api/reconectar', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Accept': 'application/json' }
        });
        let data = {};
        try { data = await response.json(); } catch {}
        if (!response.ok || data.ok !== true) {
          throw new Error(data.msg || `Falha ao reconectar (HTTP ${response.status}).`);
        }
        show(data.msg || 'Reconexão iniciada. Aguarde o QR Code ou a conexão.');
        setTimeout(() => {
          if (typeof window.refreshAll === 'function') window.refreshAll();
        }, 800);
        setTimeout(() => {
          if (typeof window.refreshAll === 'function') window.refreshAll();
        }, 2500);
      } catch (error) {
        show(error?.message || 'Não foi possível iniciar a reconexão.', true);
      } finally {
        button.disabled = false;
        button.textContent = oldText;
        button.dataset.busy = '0';
      }
    });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installReconnectFix);
  else installReconnectFix();
})();
