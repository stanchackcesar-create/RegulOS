from pathlib import Path

server = Path('src/server.js')
text = server.read_text(encoding='utf-8')
marker = 'REGULOS_ML_IMAGE_FALLBACK_V3'
if marker in text:
    raise SystemExit(0)

helper = r'''
// REGULOS_ML_IMAGE_FALLBACK_V3
async function findMercadoLivreImageUrl(url) {
  try {
    const page = await fetchText(url);
    const source = `${page.finalUrl || ''}\n${page.data || ''}`;
    const ids=[]; const seen=new Set();
    for (const m of source.matchAll(/\bMLB[-_]?\d{5,}\b/gi)) {
      const id=String(m[0]).toUpperCase().replace(/[-_]/g,'');
      if(!seen.has(id)){seen.add(id);ids.push(id);}
    }
    for(const id of ids.slice(0,3)){
      try{
        const api=await fetchText(`https://api.mercadolibre.com/items/${id}`);
        const data=JSON.parse(api.data||'{}');
        const pictures=Array.isArray(data.pictures)?data.pictures:[];
        for(const picture of pictures){
          const image=picture?.secure_url||picture?.url;
          if(image&&/^https?:\/\//i.test(image))return image;
        }
        const thumb=data.secure_thumbnail||data.thumbnail;
        if(thumb&&/^https?:\/\//i.test(thumb))return thumb;
      }catch(e){addLog(`Mercado Livre API sem imagem para ${id}: ${e.message}`);}
    }
  }catch(e){addLog(`Fallback Mercado Livre: ${e.message}`);}
  return '';
}
'''
needle='async function findProductImage(url) {'
if needle not in text:
    raise SystemExit('findProductImage não encontrado')
text=text.replace(needle,helper+'\n'+needle,1)

injection = r'''async function findProductImage(url) {
  try {
    const mlImageUrl=await findMercadoLivreImageUrl(url);
    if(mlImageUrl){
      try{
        const image=await downloadBuffer(mlImageUrl,url);
        addLog(`🖼️ Imagem do Mercado Livre encontrada via API: ${mlImageUrl}`);
        return image;
      }catch(e){addLog(`Imagem do Mercado Livre não pôde ser baixada: ${e.message}`);}
    }
  }catch(e){addLog(`Fallback Mercado Livre ignorado: ${e.message}`);}
'''
text=text.replace(needle+'\n',injection,1)

route_marker="app.post('/api/link-agendamentos',(req,res)=>{"
if '/api/link-imagem-preview' not in text:
    route=r'''app.get('/api/link-imagem-preview', async (req,res)=>{
  const url=String(req.query?.url||'').trim();
  if(!url)return res.status(400).json({ok:false,msg:'Informe um link.'});
  try{
    const ml=await findMercadoLivreImageUrl(url);
    if(ml)return res.json({ok:true,imagemUrl:ml,fonte:'mercado-livre'});
    const page=await fetchText(url);
    const candidates=extractImageCandidates(page.data,page.finalUrl);
    if(candidates.length)return res.json({ok:true,imagemUrl:candidates[0],fonte:'metadados',finalUrl:page.finalUrl});
    return res.status(404).json({ok:false,msg:'Nenhuma imagem foi encontrada automaticamente.',finalUrl:page.finalUrl});
  }catch(e){return res.status(502).json({ok:false,msg:e.message||'Não foi possível obter a imagem.'});}
});

'''
    if route_marker not in text:
        raise SystemExit('Rota de agendamentos não encontrada')
    text=text.replace(route_marker,route+route_marker,1)

server.write_text(text,encoding='utf-8')
print('Patch Mercado Livre V3 aplicado.')