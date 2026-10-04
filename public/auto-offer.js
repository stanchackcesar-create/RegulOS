(() => {
  const get = id => document.getElementById(id);
  const status = () => get('autoOfferStatus');

  function installUI() {
    if (get('autoOfferWrap')) return true;
    const message = get('lmensagem');
    if (!message) return false;
    const wrap = document.createElement('label');
    wrap.id = 'autoOfferWrap';
    wrap.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin:10px 0;padding:10px 12px;border:1px solid rgba(100,160,255,.35);border-radius:10px;background:rgba(40,70,120,.12);cursor:pointer;';
    wrap.innerHTML = '<input id="lautoOferta" type="checkbox" style="margin-top:3px">' +
      '<span><strong>☑️ Montar oferta automaticamente</strong><br><small>Coloque o link e o RegulOS busca somente dados realmente encontrados na página. Nenhum preço ou desconto será inventado.</small><div id="autoOfferStatus" class="muted" style="margin-top:5px"></div></span>';
    message.parentNode.insertBefore(wrap, message);
    return true;
  }

  async function prepareAutomaticOffer() {
    const url = (get('lurl')?.value || '').trim();
    if (!url) throw new Error('Digite o link do produto antes de usar o modo automático.');
    const s = status();
    if (s) s.textContent = '🔎 Buscando dados reais da oferta...';
    const r = await fetch('/api/oferta-preview?url=' + encodeURIComponent(url), {cache:'no-store', credentials:'same-origin'});
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok !== true) throw new Error(d.msg || 'Não foi possível obter os dados da oferta.');

    const title = String(d.titulo || '').trim();
    const price = String(d.preco || '').trim();
    const discount = String(d.desconto || '').trim();
    const image = String(d.imagemUrl || '').trim();
    // No modo automático, o título e o link não entram na mensagem personalizada:
    // o servidor já acrescenta o título do produto e o link uma única vez no envio.
    // Aqui deixamos somente informações complementares que realmente foram encontradas.
    const originalMessage = String(get('lmensagem')?.value || '').trim();
    const lines = [];
    if (price) lines.push('💰 Por: ' + price);
    if (discount) lines.push('🟢 ' + discount);
    if (!lines.length && originalMessage) lines.push(originalMessage);

    get('lmensagem').value = lines.join('\n');

    // O preview pode encontrar uma URL de imagem que funciona na página,
    // mas não aceita download pelo servidor do Railway (hotlink, CDN ou
    // redirecionamento). Não gravamos essa URL como imagem definitiva.
    // O agendador fará a busca/validação da imagem no momento do envio,
    // usando o mesmo mecanismo que já funciona para o modo manual.
    if (get('limagemUrl')) get('limagemUrl').value = '';
    if (get('limagem')) get('limagem').checked = true;

    if (s) {
      const found = [title ? 'título' : '', price ? 'preço' : '', discount ? 'desconto' : ''].filter(Boolean);
      if (image) found.push('imagem encontrada para referência');
      found.push('imagem será validada/buscada no envio');
      s.textContent = found.join(', ') || 'Nenhum dado adicional foi encontrado; a mensagem não recebeu valores inventados.';
    }
  }

  function wrapSaveLink() {
    if (window.__autoOfferSaveWrapped) return true;
    if (typeof window.saveLink !== 'function') return false;
    const original = window.saveLink;
    window.saveLink = async function(...args) {
      if (get('lautoOferta')?.checked) {
        try {
          await prepareAutomaticOffer();
        } catch (e) {
          const s = status();
          if (s) s.textContent = '❌ ' + (e.message || 'Falha ao buscar a oferta.');
          try { toast(e.message || 'Falha ao buscar a oferta.', true); } catch {}
          return;
        }
      }
      return original.apply(this, args);
    };
    window.__autoOfferSaveWrapped = true;
    return true;
  }

  const boot = () => { installUI(); wrapSaveLink(); };
  boot();
  const timer = setInterval(() => { if (installUI() && wrapSaveLink()) clearInterval(timer); }, 500);
})();