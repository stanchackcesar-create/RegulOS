from pathlib import Path

server = Path('src/server.js')
text = server.read_text(encoding='utf-8')
marker = 'REGULOS_ML_PRICE_V2'
if marker in text:
    print('Patch Mercado Livre preço já aplicado.')
    raise SystemExit(0)

start = text.find('async function getMercadoLivreOfferInfo(url){')
end = text.find('\n\n\nasync function findProductImage(url) {', start)
if start < 0 or end < 0:
    raise SystemExit('Bloco getMercadoLivreOfferInfo não encontrado.')

helper = r'''// REGULOS_ML_PRICE_V2
// A API pública de /items/{id} pode responder 403 para integrações sem
// autorização. Nesse caso, usamos a página real do produto via Playwright.
// O extrator não inventa preço: só aceita valores presentes no DOM.
async function getMercadoLivreOfferInfo(url){
  let best=null;
  try{
    const page=await fetchText(url);
    const source=`${page.finalUrl||''}\n${page.data||''}`;
    const ids=[]; const seen=new Set();
    for(const m of source.matchAll(/\bMLB[-_]?\d{5,}\b/gi)){
      const id=String(m[0]).toUpperCase().replace(/[-_]/g,'');
      if(!seen.has(id)){seen.add(id);ids.push(id);}
    }

    // Primeiro tenta a API pública. Se houver 403/ausência de preço,
    // não encerramos o fluxo: o navegador continua a análise.
    for(const id of ids.slice(0,10)){
      try{
        const api=await fetchText(`https://api.mercadolibre.com/items/${id}`);
        const data=JSON.parse(api.data||'{}');
        if(!data?.id) continue;

        const price=Number(data.price);
        const original=Number(data.original_price);
        const basePrice=Number(data.base_price);
        const current=Number.isFinite(price)&&price>0?price:NaN;
        const originalValue=Number.isFinite(original)&&original>current
          ? original
          : (Number.isFinite(basePrice)&&basePrice>current ? basePrice : NaN);

        let desconto='';
        if(Number.isFinite(current)&&Number.isFinite(originalValue)&&originalValue>current){
          desconto=Math.round((1-current/originalValue)*100)+'%';
        }

        let imagem='';
        for(const picture of (Array.isArray(data.pictures)?data.pictures:[])){
          const image=picture?.secure_url||picture?.url;
          if(image&&/^https?:\/\//i.test(image)){imagem=image;break;}
        }
        if(!imagem){
          const thumb=data.secure_thumbnail||data.thumbnail;
          if(thumb&&/^https?:\/\//i.test(thumb))imagem=thumb;
        }

        const candidate={
          titulo:String(data.title||'').trim(),
          preco:Number.isFinite(current)?autoOfferFormatBRL(current,'BRL'):'',
          precoOriginal:Number.isFinite(originalValue)?autoOfferFormatBRL(originalValue,'BRL'):'',
          desconto,
          imagemUrl:imagem,
          finalUrl:page.finalUrl||url,
          fonte:'mercado-livre-api'
        };

        if(!best || candidate.preco || candidate.precoOriginal || candidate.imagemUrl) best=candidate;
        if(candidate.preco) return candidate;
      }catch(e){
        addLog(`Mercado Livre API sem acesso ao item ${id}: ${e.message}`);
      }
    }

    // Fallback real: lê o preço renderizado no produto.
    const browser=await getRegulosBrowser();
    const context=await browser.newContext({
      userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
      locale:'pt-BR',
      viewport:{width:1365,height:900},
      javaScriptEnabled:true,
      ignoreHTTPSErrors:true
    });
    const browserPage=await context.newPage();

    try{
      await browserPage.goto(page.finalUrl||url,{waitUntil:'domcontentloaded',timeout:35000});
      await browserPage.waitForTimeout(1800);

      const extracted=await browserPage.evaluate(()=>{
        const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
        const parseMoney=s=>{
          const m=normalize(s).match(/R\$\s*([0-9.]+(?:,[0-9]{1,2})?)/i);
          if(!m)return NaN;
          const n=Number(m[1].replace(/\./g,'').replace(',','.'));
          return Number.isFinite(n)&&n>0?n:NaN;
        };

        const current=[];
        const original=[];
        const add=(arr,value)=>{
          const n=parseMoney(value);
          if(Number.isFinite(n)&&!arr.includes(n))arr.push(n);
        };

        const selectors=[
          '.ui-pdp-price__second-line .andes-money-amount',
          '.ui-pdp-price .andes-money-amount',
          '[data-testid*="price"] .andes-money-amount',
          '.poly-price__current .andes-money-amount',
          '.andes-money-amount'
        ];

        for(const selector of selectors){
          for(const el of document.querySelectorAll(selector)){
            const text=normalize(el.innerText||el.textContent||'');
            if(!/R\$/i.test(text))continue;
            const cls=String(el.className||'').toLowerCase();
            const parentCls=String(el.parentElement?.className||'').toLowerCase();
            if(/previous|old|original|before|strike|s-price/.test(cls+' '+parentCls)) add(original,text);
            else add(current,text);
          }
          if(current.length) break;
        }

        // Preço antigo costuma ficar em <s> / classe de previous.
        for(const el of document.querySelectorAll('s .andes-money-amount,.andes-money-amount--previous,.ui-pdp-price__original .andes-money-amount')){
          add(original,el.innerText||el.textContent||'');
        }

        // Último recurso: metadados explícitos da página.
        for(const el of document.querySelectorAll('meta[property="product:price:amount"],meta[property="og:price:amount"]')){
          add(current,el.getAttribute('content')||'');
        }

        const title=normalize(
          document.querySelector('h1.ui-pdp-title,h1')?.innerText ||
          document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''
        );

        const image=
          document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
          document.querySelector('.ui-pdp-gallery img')?.currentSrc ||
          document.querySelector('.ui-pdp-gallery img')?.src || '';

        const discountText=normalize(document.body?.innerText||'');
        const discountMatch=discountText.match(/(?:-|desconto|off)?\s*(\d{1,3})\s*%\s*OFF/i);

        return {
          title,
          current:[...new Set(current)].sort((a,b)=>a-b),
          original:[...new Set(original)].sort((a,b)=>b-a),
          image,
          discount:discountMatch?.[1]?discountMatch[1]+'%':''
        };
      });

      if(extracted.current?.length){
        const current=extracted.current[0];
        const original=extracted.original?.find(n=>n>current) || NaN;
        const merged={
          ...(best||{}),
          titulo:String(extracted.title||best?.titulo||'').trim(),
          preco:autoOfferFormatBRL(current,'BRL'),
          precoOriginal:Number.isFinite(original)?autoOfferFormatBRL(original,'BRL'):(best?.precoOriginal||''),
          desconto:extracted.discount || best?.desconto || '',
          imagemUrl:extracted.image || best?.imagemUrl || '',
          finalUrl:page.finalUrl||url,
          fonte:'mercado-livre-browser'
        };
        if(!merged.desconto && Number.isFinite(original) && original>current){
          merged.desconto=Math.round((1-current/original)*100)+'%';
        }
        return merged;
      }

      if(best?.preco || best?.precoOriginal) return best;
      return null;
    }finally{
      await context.close().catch(()=>{});
    }
  }catch(e){
    addLog(`Mercado Livre oferta: ${e.message}`);
  }
  return best?.preco || best?.precoOriginal ? best : null;
}
'''
text = text[:start] + helper + text[end:]
server.write_text(text, encoding='utf-8')
print('Patch Mercado Livre preço aplicado.')
