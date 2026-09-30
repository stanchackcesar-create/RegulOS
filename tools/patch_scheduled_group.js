const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const INDEX = path.join(ROOT, 'public', 'index.html');

function patchFile(file, replacements, label) {
  let source = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const [oldText, newText] of replacements) {
    if (source.includes(newText)) continue;
    if (!source.includes(oldText)) {
      console.log(`[scheduled-group] ${label}: bloco não encontrado.`);
      continue;
    }
    source = source.replace(oldText, newText);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, source, 'utf8');
  return changed;
}

// Backend: cada agendamento pode guardar seu próprio grupo de destino.
patchFile(SERVER, [
  [
`    imagemAutomatica:b.imagemAutomatica!==false, imagemUrl:String(b.imagemUrl||'').trim(),\n    mensagensAleatorias:Array.isArray(b.mensagensAleatorias)?b.mensagensAleatorias.map(String).filter(Boolean):[],`,
`    imagemAutomatica:b.imagemAutomatica!==false, imagemUrl:String(b.imagemUrl||'').trim(),\n    grupoId:String(b.grupoId||'').trim(),\n    mensagensAleatorias:Array.isArray(b.mensagensAleatorias)?b.mensagensAleatorias.map(String).filter(Boolean):[],`
  ],
  [
`  if(typeof b.imagemUrl==='string') item.imagemUrl=b.imagemUrl.trim();\n  if(Array.isArray(b.mensagensAleatorias))`,
`  if(typeof b.imagemUrl==='string') item.imagemUrl=b.imagemUrl.trim();\n  if(typeof b.grupoId==='string') item.grupoId=b.grupoId.trim();\n  if(Array.isArray(b.mensagensAleatorias))`
  ],
  [
`  } else {\n    targets = activeGroups();\n    if (!targets.length) {`,
`  } else {\n    const scheduledGroupIds = [...new Set([\n      item.reenvioGrupoId,\n      item.grupoId,\n      ...(Array.isArray(item.grupoIds) ? item.grupoIds : [])\n    ].map(String).map(x=>x.trim()).filter(Boolean))];\n    // Se o agendamento tem grupo definido, envia somente para esse grupo.\n    // Caso contrário, preserva o comportamento antigo usando os grupos ligados.\n    targets = scheduledGroupIds.length\n      ? scheduledGroupIds.filter(id => groups.some(g => String(g.id) === id))\n      : activeGroups();\n    if (!targets.length) {`
  ],
  [
`      // Se o grupo foi desligado desde o início da ocorrência, não enviamos.\n      if (getGroupConfig(id).ativo === false) continue;`,
`      // Agendamento com grupo explícito é independente do botão global de grupos:\n      // o próprio agendamento já define o destino. Para agendamentos antigos,\n      // mantém-se a regra de usar somente grupos ligados.\n      const hasExplicitScheduledGroup = Boolean(String(item.reenvioGrupoId || item.grupoId || '').trim()) || Array.isArray(item.grupoIds);\n      if (!hasExplicitScheduledGroup && getGroupConfig(id).ativo === false) continue;`
  ]
], 'server');

// Frontend: adiciona seletor de grupo e envia o ID escolhido junto do agendamento.
patchFile(INDEX, [
  [
`<label>Link do produto</label><input id="lurl" placeholder="https://...">\n<label>URL da imagem`,
`<label>Link do produto</label><input id="lurl" placeholder="https://...">\n<label>Grupo de envio</label><select id="lgrupo"><option value="">Selecione o grupo de destino...</option></select>\n<div class="muted">O link agendado será enviado somente para este grupo.</div>\n<label>URL da imagem`
  ],
  [
`  mensagensAleatorias:randomEnabled?randomSelected:[],\n  mensagemAleatoriaAtiva:randomEnabled,\n  rearmar:Boolean(window.editingFailedId)`,
`  mensagensAleatorias:randomEnabled?randomSelected:[],\n  mensagemAleatoriaAtiva:randomEnabled,\n  grupoId:(get('lgrupo')?.value||'').trim(),\n  rearmar:Boolean(window.editingFailedId)`
  ],
  [
`function showForm(){\n const form=document.getElementById('linkForm');\n form.classList.remove('hidden');`,
`async function loadScheduleGroups(selected=''){\n const sel=document.getElementById('lgrupo');\n if(!sel)return;\n try{\n  const d=await jfetch('/api/grupos?refresh=1',{cache:'no-store'});\n  const grupos=Array.isArray(d?.grupos)?d.grupos:[];\n  sel.innerHTML='<option value="">Selecione o grupo de destino...</option>'+grupos.map(g=>{\n   const id=String(g.id||''); const nome=String(g.name||g.id||'');\n   return '<option value="'+esc(id)+'">'+esc(nome)+'</option>';\n  }).join('');\n  if(selected)sel.value=selected;\n }catch(e){\n  sel.innerHTML='<option value="">Não foi possível carregar os grupos</option>';\n }\n}\nfunction showForm(selectedGroup=''){\n const form=document.getElementById('linkForm');\n form.classList.remove('hidden');\n loadScheduleGroups(selectedGroup);`
  ],
  [
` const random=document.getElementById('lrandom');if(random)random.checked=false;`,
` const random=document.getElementById('lrandom');if(random)random.checked=false;\n const grupo=document.getElementById('lgrupo');if(grupo)grupo.value='';`
  ],
  [
`lnome.value=x.nome||'';lurl.value=x.url||'';limagemUrl.value=x.imagemUrl||'';`,
`lnome.value=x.nome||'';lurl.value=x.url||'';showForm(x.grupoId||'');limagemUrl.value=x.imagemUrl||'';`
  ],
  [
`editingId=id;showForm();lnome.value=f.nome||'';`,
`editingId=id;showForm(f.grupoId||'');lnome.value=f.nome||'';`
  ]
], 'index');

console.log('[scheduled-group] patch aplicado.');
require(path.join(ROOT, 'tools', 'boot-regulos.js'));
