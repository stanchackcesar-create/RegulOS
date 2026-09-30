from pathlib import Path
import re
import subprocess

msg = subprocess.check_output(['git', 'log', '-1', '--pretty=%B'], text=True)
if '[fix-schedule]' not in msg:
    raise SystemExit(0)

index = Path('public/index.html')
text = index.read_text(encoding='utf-8')
start = text.find('async function saveLink(){')
if start < 0:
    raise SystemExit('Função saveLink não encontrada.')
brace = text.find('{', start)
depth = 0
end = None
for i in range(brace, len(text)):
    if text[i] == '{':
        depth += 1
    elif text[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
if end is None:
    raise SystemExit('Não foi possível delimitar saveLink.')

replacement = r'''async function saveLink(){
 const get=id=>document.getElementById(id);
 const nome=(get('lnome')?.value||'').trim();
 const url=(get('lurl')?.value||'').trim();
 const data=(get('ldata')?.value||'').trim();
 const horario=(get('lhorario')?.value||'').trim();
 const repeticao=get('lrep')?.value||'uma_vez';
 const intervalo=Math.max(1,Number(get('lmin')?.value||2));
 const ativo=Boolean(get('lativo')?.checked);
 const imagemAutomatica=Boolean(get('limagem')?.checked);
 const randomEnabled=Boolean(get('lrandom')?.checked);
 const randomSelected=[...document.querySelectorAll('.rmsg:checked')].map(x=>x.value).filter(Boolean);
 const result=get('formResult');
 const fail=msg=>{if(result)result.textContent='❌ '+msg;try{toast(msg,true);}catch{}};
 if(!nome)return fail('Digite o nome de registro do link.');
 if(!url)return fail('Digite o link do produto.');
 if(!/^https?:\/\//i.test(url))return fail('O link do produto deve começar com http:// ou https://.');
 if(!data)return fail('Escolha a data do envio.');
 if(!horario)return fail('Escolha o horário do envio.');
 if(randomEnabled&&!randomSelected.length)return fail('Selecione pelo menos uma mensagem aleatória.');
 const body={
  nome,url,mensagem:(get('lmensagem')?.value||'').trim(),data,horario,repeticao,
  intervaloMin:intervalo,intervaloMax:intervalo,ativo,
  imagemAutomatica,imagemUrl:(get('limagemUrl')?.value||'').trim(),
  mensagensAleatorias:randomEnabled?randomSelected:[],
  mensagemAleatoriaAtiva:randomEnabled,
  rearmar:Boolean(window.editingFailedId)
 };
 const endpoint=window.editingId?('/api/link-agendamentos/'+encodeURIComponent(window.editingId)):'/api/link-agendamentos';
 const method=window.editingId?'PUT':'POST';
 if(result)result.textContent='⏳ Salvando agendamento...';
 try{
  const d=await jfetch(endpoint,{method,headers:{'Content-Type':'application/json','Cache-Control':'no-cache'},cache:'no-store',body:JSON.stringify(body)});
  if(!d||d.ok!==true)throw new Error(d?.msg||'O servidor não confirmou o salvamento.');
  if(result)result.textContent='✅ Agendamento salvo com sucesso.';
  try{toast(window.editingId?'Agendamento atualizado.':'Agendamento salvo com sucesso.');}catch{}
  window.editingId=null;
  window.editingFailedId=null;
  clearLinkForm();
  hideForm();
  await Promise.all([loadLinks(),loadSchedules(),loadDashboard()]);
 }catch(e){
  const msg=(typeof friendlyFetchError==='function')?friendlyFetchError(e):(e?.message||'Falha ao salvar o agendamento.');
  if(result)result.textContent='❌ '+msg;
  try{toast(msg,true);}catch{}
  console.error('Falha ao salvar agendamento:',e);
 }
}'''

text = text[:start] + replacement + text[end:]
index.write_text(text, encoding='utf-8')

# Also make the backend response explicit if persistence fails.
server = Path('src/server.js')
server_text = server.read_text(encoding='utf-8')
needle = "  linkSchedules.push(item); writeJson(FILES.schedules,linkSchedules); syncLinkQueue();\n  res.json({ok:true,agendamento:item});"
replacement_server = """  try {
    linkSchedules.push(item);
    writeJson(FILES.schedules,linkSchedules);
    syncLinkQueue();
  } catch (e) {
    linkSchedules = linkSchedules.filter(x => x.id !== item.id);
    addLog(`Falha persistindo agendamento: ${e.message}`);
    return res.status(500).json({ok:false,msg:`Não foi possível salvar o agendamento no armazenamento: ${e.message}`});
  }
  res.set('Cache-Control','no-store');
  res.json({ok:true,agendamento:item});"""
if needle in server_text:
    server_text = server_text.replace(needle, replacement_server, 1)
server.write_text(server_text, encoding='utf-8')
