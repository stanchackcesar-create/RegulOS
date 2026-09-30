# REGULOS_AUTO_OFFER_UI_TRIGGER_V2
from pathlib import Path

p = Path('public/index.html')
t = p.read_text(encoding='utf-8')
marker = '<!-- REGULOS_AUTO_OFFER_UI_V1 -->'

if marker not in t:
    needle = '<div class="two"><div><label><input id="limagem" type="checkbox" checked style="width:auto"> 🖼️ Buscar imagem automaticamente</label></div><div><label><input id="lrandom" type="checkbox" onchange="toggleRandomBox()" style="width:auto"> ✍️ Usar mensagem aleatória</label></div></div>'
    if needle not in t:
        raise SystemExit('Campo de imagem/mensagem aleatória não encontrado.')
    injection = needle + '\n' + marker + '\n<div class="notice" style="margin-top:10px"><label style="margin:0"><input id="lautoOferta" type="checkbox" onchange="toggleAutoOfferPreview()" style="width:auto"> ☑️ <b>Montar oferta automaticamente</b></label><div class="muted" style="margin-top:5px">Coloque somente o link. O RegulOS buscará título, preço, desconto e imagem somente quando esses dados estiverem publicados na página. Nenhum valor será inventado.</div></div>'
    t = t.replace(needle, injection, 1)

needle = " const random=document.getElementById('lrandom');if(random)random.checked=false;"
if "const autoOferta=document.getElementById('lautoOferta')" not in t:
    if needle not in t: raise SystemExit('Reset do formulário não encontrado.')
    t = t.replace(needle, needle + "\n const autoOferta=document.getElementById('lautoOferta');if(autoOferta)autoOferta.checked=false;", 1)

needle = " const imagemAutomatica=Boolean(get('limagem')?.checked);"
if "const montarOfertaAutomatica=Boolean(get('lautoOferta')?.checked);" not in t:
    if needle not in t: raise SystemExit('Estado da imagem automática não encontrado.')
    t = t.replace(needle, needle + "\n const montarOfertaAutomatica=Boolean(get('lautoOferta')?.checked);", 1)

t = t.replace(" if(!nome)return fail('Digite o nome de registro do link.');", " if(!nome&&!montarOfertaAutomatica)return fail('Digite o nome de registro do link ou marque Montar oferta automaticamente.');", 1)

needle = " const body={\n  nome,url,mensagem:(get('lmensagem')?.value||'').trim(),data,horario,repeticao,"
if "REGULOS_AUTO_OFFER_BUILD_V1" not in t:
    if needle not in t: raise SystemExit('Objeto body do saveLink não encontrado.')
    replacement = """ // REGULOS_AUTO_OFFER_BUILD_V1
 let nomeFinal=nome;
 let mensagemFinal=(get('lmensagem')?.value||'').trim();
 let imagemUrlFinal=(get('limagemUrl')?.value||'').trim();
 let imagemAutomaticaFinal=imagemAutomatica;
 if(montarOfertaAutomatica){
  if(result)result.textContent='🔎 Buscando dados publicados na página...';
  try{
   const preview=await jfetch('/api/oferta-preview?url='+encodeURIComponent(url),{cache:'no-store'});
   const titulo=String(preview.titulo||'').trim();
   const preco=String(preview.preco||'').trim();
   const desconto=String(preview.desconto||'').trim();
   if(titulo)nomeFinal=titulo;
   const partes=['🔥 OFERTA IMPERDÍVEL!'];
   if(titulo)partes.push('📦 '+titulo);
   if(preco)partes.push('💰 Por: '+preco);
   if(desconto)partes.push('🟢 '+desconto);
   partes.push('🛒 Confira a oferta:\\n'+url);
   if(!mensagemFinal)mensagemFinal=partes.join('\\n\\n');
   // A imagem do preview pode ser temporária/CDN. Não persistir essa URL como definitiva.
   imagemUrlFinal='';
   imagemAutomaticaFinal=true;
   if(result)result.textContent='✅ Dados encontrados. Salvando agendamento...';
  }catch(e){
   return fail('Não foi possível consultar os dados do produto: '+(e?.message||e));
  }
 }
 const body={
  nome:nomeFinal,url,mensagem:mensagemFinal,data,horario,repeticao,"""
    t = t.replace(needle, replacement, 1)

start = t.find('async function saveLink(){')
end = t.find('\n}\nfunction toggleAllRandom', start)
if start < 0 or end < 0: raise SystemExit('Limites da função saveLink não encontrados.')
block = t[start:end]
block = block.replace("imagemAutomatica,imagemUrl:(get('limagemUrl')?.value||'').trim(),", "imagemAutomatica:imagemAutomaticaFinal,imagemUrl:imagemUrlFinal,autoOfertaAutomatica:montarOfertaAutomatica,", 1)
t = t[:start] + block + t[end:]

if 'function toggleAutoOfferPreview()' not in t:
    needle = 'function toggleRandomBox(){'
    if needle not in t: raise SystemExit('toggleRandomBox não encontrado.')
    fn = """function toggleAutoOfferPreview(){
 const box=document.getElementById('lautoOferta');
 const name=document.getElementById('lnome');
 const url=document.getElementById('lurl');
 if(box?.checked){
  if(name)name.placeholder='Opcional: o título será buscado automaticamente';
  if(url)url.placeholder='Cole somente o link do produto';
 }else{
  if(name)name.placeholder='Ex.: Impressora Epson L3250';
  if(url)url.placeholder='https://...';
 }
}
"""
    t = t.replace(needle, fn + needle, 1)

p.write_text(t, encoding='utf-8')
print('Patch de oferta automática aplicado.')
