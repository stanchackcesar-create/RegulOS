from pathlib import Path

server = Path('src/server.js')
text = server.read_text(encoding='utf-8')
marker = 'REGULOS_ML_IMAGE_FALLBACK_V2'
if marker in text:
    raise SystemExit(0)

helper = r'''
// REGULOS_ML_IMAGE_FALLBACK_V2
// Resolve meli.la -> item Mercado Livre -> pictures[].secure_url.
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

old=needle+'\n  try {\n    const page=await fetchText(url);'
new=needle+'''\n  try {\n    const mlImageUrl=await findMercadoLivreImageUrl(url);\n    if(mlImageUrl){\n      try{\n        const image=await downloadBuffer(mlImageUrl,url);\n        addLog(`🖼️ Imagem do Mercado Livre encontrada via API: ${mlImageUrl}`);\n        return image;\n      }catch(e){addLog(`Imagem do Mercado Livre não pôde ser baixada: ${e.message}`);}\n    }\n  }catch(e){addLog(`Fallback Mercado Livre ignorado: ${e.message}`);}\n  try {\n    const page=await fetchText(url);'''
if old not in text:
    raise SystemExit('Início de findProductImage não encontrado')
text=text.replace(old,new,1)

route="""app.get('/api/link-imagem-preview', async (req,res)=>{\n  const url=String(req.query?.url||'').trim();\n  if(!url)return res.status(400).json({ok:false,msg:'Informe um link.'});\n  try{\n    const ml=await findMercadoLivreImageUrl(url);\n    if(ml)return res.json({ok:true,imagemUrl:ml,fonte:'mercado-livre'});\n    const page=await fetchText(url);\n    const candidates=extractImageCandidates(page.data,page.finalUrl);\n    if(candidates.length)return res.json({ok:true,imagemUrl:candidates[0],fonte:'metadados',finalUrl:page.finalUrl});\n    return res.status(404).json({ok:false,msg:'Nenhuma imagem foi encontrada automaticamente.',finalUrl:page.finalUrl});\n  }catch(e){return res.status(502).json({ok:false,msg:e.message||'Não foi possível obter a imagem.'});}\n});\n\n"""
if '/api/link-imagem-preview' not in text:
    route_marker="app.post('/api/link-agendamentos',(req,res)=>{"
    if route_marker not in text:
        raise SystemExit('Rota de agendamentos não encontrada')
    text=text.replace(route_marker,route+route_marker,1)

server.write_text(text,encoding='utf-8')
print('Patch Mercado Livre aplicado.')