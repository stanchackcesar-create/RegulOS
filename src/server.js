async function fetchText(url, redirects=0) {
  const cached = getCachedValue(pageFetchCache, url);
  if (cached) return cached;

  return new Promise(async (resolve, reject) => {
    if (redirects > 7) return reject(new Error('Muitos redirecionamentos'));
    let parsed;
    try { parsed = await assertSafeExternalUrl(url); } catch(e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      }, timeout: 15000
    }, res => {
      const code = res.statusCode || 0;
      if ([301,302,303,307,308].includes(code) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).href;
        return fetchText(nextUrl, redirects + 1).then(resolve, reject);
      }
      if (code < 200 || code >= 400) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      const chunks=[]; let total=0;
      res.on('data', c => { total += c.length; if (total <= 5_000_000) chunks.push(c); });
      res.on('end', () => {
        if (total > 5_000_000) return reject(new Error('Página muito grande'));
        const raw=Buffer.concat(chunks);
        const enc=String(res.headers['content-encoding']||'').toLowerCase();
        const finish=(err, buf)=>{
          if(err) return reject(err);
          const result = { data: buf.toString('utf8'), finalUrl: url, contentType: String(res.headers['content-type']||'') };
          setCachedValue(pageFetchCache, url, result);
          resolve(result);
        };
        try {
          if (enc.includes('br')) return zlib.brotliDecompress(raw, finish);
          if (enc.includes('gzip')) return zlib.gunzip(raw, finish);
          if (enc.includes('deflate')) return zlib.inflate(raw, finish);
          finish(null, raw);
        } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado')));
    req.on('error', reject);
  });
}

async function findProductTitle(url) {
  const normalized = String(url || '').trim();
  const cached = getCachedValue(productTitleCache, normalized);
  if (cached) return cached;

  try {
    const page = await fetchText(normalized);
    const title = extractProductTitle(page.data);
    const result = title ? { title, finalUrl: page.finalUrl } : { title: '', finalUrl: normalized };
    setCachedValue(productTitleCache, normalized, result);
    if (title) return result;
    addLog(`Título do produto não encontrado para o link.`);
  } catch (e) {
    addLog(`Não foi possível ler o título do produto: ${e.message}`);
  }
  return { title: '', finalUrl: normalized };
}

async function downloadBuffer(url, pageUrl='', redirects=0) {
  const cacheKey = `${url}|${pageUrl}`;
  const cached = getCachedValue(imageDownloadCache, cacheKey);
  if (cached) return cached;

  return new Promise(async (resolve,reject)=>{
    if(redirects>7) return reject(new Error('Muitos redirecionamentos de imagem'));
    let parsed; try{parsed=await assertSafeExternalUrl(url)}catch(e){return reject(new Error(e.message || 'URL de imagem inválida'))}
    const lib=parsed.protocol==='https:'?https:http;
    const headers={
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
      'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language':'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept-Encoding':'gzip, deflate, br',
      'Referer': pageUrl || `${parsed.protocol}//${parsed.host}/`,
      'Cache-Control':'no-cache'
    };
    const req=lib.get(parsed,{headers,timeout:18000},res=>{
      const code=res.statusCode||0;
      if([301,302,303,307,308].includes(code)&&res.headers.location){res.resume();const nextUrl=new URL(res.headers.location,url).href;return downloadBuffer(nextUrl,pageUrl||url,redirects+1).then(resolve,reject)}
      if(code<200||code>=400){res.resume();return reject(new Error(`Imagem HTTP ${code}`))}
      const type=String(res.headers['content-type']||'').split(';')[0].toLowerCase();
      const chunks=[];let total=0;
      res.on('data',c=>{total+=c.length;if(total<=10*1024*1024)chunks.push(c)});
      res.on('end',()=>{
        if(total>10*1024*1024)return reject(new Error('Imagem maior que 10 MB'));
        const raw=Buffer.concat(chunks);
        const finish=(err,buf)=>{
          if(err)return reject(err);
          const mime=type.startsWith('image/')?type:'image/jpeg';
          if(!/^image\//i.test(mime)) return reject(new Error('Recurso não é uma imagem'));
          if(buf.length<1000)return reject(new Error('Imagem muito pequena'));
          const result={buffer:buf,mime,url};
          setCachedValue(imageDownloadCache, cacheKey, result);
          resolve(result);
        };
        const enc=String(res.headers['content-encoding']||'').toLowerCase();
        try {
          if(enc.includes('br')) return zlib.brotliDecompress(raw,finish);
          if(enc.includes('gzip')) return zlib.gunzip(raw,finish);
          if(enc.includes('deflate')) return zlib.inflate(raw,finish);
          finish(null,raw);
        } catch(e){reject(e)}
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Tempo esgotado ao baixar imagem')));req.on('error',reject);
  });
}
