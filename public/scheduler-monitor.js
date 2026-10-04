(() => {
  const ID = 'regulosSchedulerMonitor';
  const css = [
    '#'+ID+'Btn{position:fixed;right:18px;bottom:18px;z-index:1250;background:#3d83f6;color:#fff;border:0;border-radius:999px;padding:12px 16px;font-weight:800;box-shadow:0 8px 28px rgba(0,0,0,.35)}',
    '#'+ID+'{position:fixed;inset:0;z-index:1300;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;padding:16px}',
    '#'+ID+'.open{display:flex}',
    '#'+ID+' .sm-card{width:min(1100px,96vw);max-height:92vh;overflow:hidden;background:#111b2d;border:1px solid #34445c;border-radius:16px}',
    '#'+ID+' .sm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid #263653}',
    '#'+ID+' .sm-body{padding:14px 18px;overflow:auto;max-height:80vh}',
    '#'+ID+' .sm-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0}',
    '#'+ID+' .sm-metric{background:#0b1423;border:1px solid #263653;border-radius:12px;padding:12px}',
    '#'+ID+' .sm-metric small{display:block;color:#9eb0ca}',
    '#'+ID+' .sm-metric b{display:block;font-size:24px;margin-top:5px}',
    '#'+ID+' .sm-normal{border-color:#17643a}','#'+ID+' .sm-warn{border-color:#8a6415}','#'+ID+' .sm-critical{border-color:#8b2b32}',
    '#'+ID+' .sm-toolbar{display:grid;grid-template-columns:1.4fr 1fr 1fr auto;gap:8px;margin:12px 0}',
    '#'+ID+' table{width:100%;border-collapse:collapse;font-size:13px}',
    '#'+ID+' th,#'+ID+' td{padding:9px;border-bottom:1px solid #263653;text-align:left;vertical-align:top}',
    '#'+ID+' .sm-pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#34445c;font-weight:800;font-size:11px}',
    '#'+ID+' .sm-good{background:#125d34}','#'+ID+' .sm-bad{background:#64252a}','#'+ID+' .sm-attn{background:#6b5218}',
    '@media(max-width:700px){#'+ID+' .sm-grid{grid-template-columns:1fr 1fr}#'+ID+' .sm-toolbar{grid-template-columns:1fr 1fr}#'+ID+' .sm-head{align-items:flex-start}}',
    '@media(max-width:500px){#'+ID+' .sm-grid{grid-template-columns:1fr 1fr}#'+ID+' .sm-body{padding:10px}#'+ID+' .sm-card{max-height:95vh}#'+ID+'Btn{right:10px;bottom:10px}}'
  ].join('');
  const style=document.createElement('style'); style.textContent=css; document.head.appendChild(style);

  const btn=document.createElement('button');
  btn.id=ID+'Btn'; btn.textContent='📊 Monitor do Scheduler'; btn.title='Abrir monitor do scheduler';
  document.body.appendChild(btn);

  const modal=document.createElement('div'); modal.id=ID;
  modal.innerHTML='<div class="sm-card"><div class="sm-head"><div><h2 style="margin:0">📊 Monitor do Scheduler</h2><div id="'+ID+'Sub" class="muted">Carregando estado...</div></div><div class="row"><button id="'+ID+'Refresh">🔄 Atualizar</button><button id="'+ID+'Close">Fechar</button></div></div><div class="sm-body"><div id="'+ID+'Alert" class="notice">Carregando diagnóstico...</div><div class="sm-grid" id="'+ID+'Metrics"></div><div class="panel" style="margin:10px 0"><h3 style="margin:0 0 8px">🔎 Filtros</h3><div class="sm-toolbar"><input id="'+ID+'Search" placeholder="Pesquisar link, grupo ou erro"><select id="'+ID+'Type"><option value="todos">Todos os tipos</option><option value="agendado">Agendado</option><option value="pausado">Pausado</option><option value="erro">Erro</option><option value="concluido">Concluído</option></select><select id="'+ID+'Period"><option value="hoje">Hoje</option><option value="24h">Últimas 24h</option><option value="7d">7 dias</option><option value="30d">30 dias</option><option value="todos">Todos</option></select><button id="'+ID+'Clear">Limpar</button></div></div><div class="panel" style="margin:10px 0"><h3 style="margin:0 0 8px">📦 Fila</h3><div style="overflow:auto"><table><thead><tr><th>Link</th><th>Data/hora</th><th>Status</th><th>Envios</th><th>Erros</th></tr></thead><tbody id="'+ID+'Queue"></tbody></table></div></div><div class="panel" style="margin:10px 0"><h3 style="margin:0 0 8px">⚠️ Falhas e retries</h3><div id="'+ID+'Failures"></div></div></div></div>';
  document.body.appendChild(modal);

  const $=s=>document.getElementById(ID+s);
  let data={};

  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function dateValue(s){const d=new Date(String(s||''));return Number.isFinite(d.getTime())?d:null;}
  function withinPeriod(item,period){
    if(period==='todos') return true;
    const raw=item.lastRunAt||item.createdAt||item.data||'';
    const d=dateValue(raw);
    if(!d)return period==='todos';
    const now=Date.now(), diff=now-d.getTime();
    if(period==='hoje') return d.toLocaleDateString('pt-BR')===new Date().toLocaleDateString('pt-BR');
    if(period==='24h') return diff>=0&&diff<=86400000;
    if(period==='7d') return diff>=0&&diff<=604800000;
    if(period==='30d') return diff>=0&&diff<=2592000000;
    return true;
  }
  function render(){
    const m=data.metrics||{}, s=data.scheduler||{}, diag=data.diagnosis||{};
    $('Sub').textContent='Estado: '+(s.online?'🟢 conectado':'🔴 desconectado')+' · '+(s.janela||'');
    const level=diag.nivel||'normal';
    const alert=$('Alert');
    alert.className='notice '+(level==='critico'?'error':level==='atencao'?'':'success');
    alert.innerHTML='<b>'+ (level==='critico'?'🔴 Atenção crítica':level==='atencao'?'🟡 Atenção':'🟢 Operação normal')+'</b> '+esc((diag.criticos||[]).join(' · ')||'Nenhum problema crítico detectado.')+(diag.gargalos&&diag.gargalos.length?'<div style="margin-top:6px"><b>Gargalos:</b> '+esc(diag.gargalos.join(' · '))+'</div>':'');
    const cards=[
      ['Estado',s.online?'ONLINE':'OFFLINE',s.online?'sm-normal':'sm-critical'],
      ['Na fila',m.fila||0,''],
      ['Vencidos',m.vencidos||0,m.vencidos?'sm-warn':''],
      ['Falhas / retries',m.falhasPendentes||0,m.falhasPendentes?'sm-warn':''],
      ['Erros hoje',m.errosHoje||0,m.errosHoje?'sm-warn':''],
      ['Sucessos hoje',m.sucessoHoje||0,''],
      ['Enviados hoje',m.enviadosHoje||0,''],
      ['Pausados',m.pausados||0,'']
    ];
    $('Metrics').innerHTML=cards.map(c=>'<div class="sm-metric '+c[2]+'"><small>'+c[0]+'</small><b>'+c[1]+'</b></div>').join('');
    const q=data.queue||[], search=String($('Search').value||'').toLocaleLowerCase('pt-BR'), type=$('Type').value, period=$('Period').value;
    const filtered=q.filter(x=>{
      const hay=(x.nome+' '+x.status+' '+(x.motivoFalha||'')).toLocaleLowerCase('pt-BR');
      return (!search||hay.includes(search)) && (type==='todos'||x.status===type) && withinPeriod(x,period);
    });
    $('Queue').innerHTML=filtered.length?filtered.map(x=>'<tr><td><b>'+esc(x.nome)+'</b></td><td>'+esc(x.data)+' '+esc(x.horario)+'</td><td><span class="sm-pill '+(x.status==='erro'?'sm-bad':x.status==='pausado'?'sm-attn':'sm-good')+'">'+esc(x.status)+'</span></td><td>'+x.enviados+' / '+x.sucessos+'</td><td>'+x.erros+'</td></tr>').join(''):'<tr><td colspan="5" class="muted">Nenhum item corresponde aos filtros.</td></tr>';
    const f=data.failures||[];
    $('Failures').innerHTML=f.length?f.map(x=>'<div class="link"><b>⚠️ '+esc(x.nome)+'</b><div class="stats">Grupo: '+esc(x.grupoId||'—')+' · '+esc(x.createdAt||'')+'</div><div class="stats">Motivo: '+esc(x.erro)+'</div><span class="sm-pill sm-bad">retry pendente</span></div>').join(''):'<div class="muted">Nenhuma falha pendente.</div>';
  }
  async function load(){
    try{
      const [dash,sched,fail,qr,logs]=await Promise.all([
        jfetch('/api/dashboard'),jfetch('/api/link-agendamentos'),jfetch('/api/link-falhas'),jfetch('/api/qr'),jfetch('/api/logs')
      ]);
      const ag=Array.isArray(sched.agendamentos)?sched.agendamentos:[];
      const failures=Array.isArray(fail.falhas)?fail.falhas:[];
      const now=new Date();
      const active=ag.filter(x=>x.ativo!==false);
      const due=active.filter(x=>{if(!x.data||!x.horario)return false; const d=new Date(x.data+'T'+x.horario+':00'); return Number.isFinite(d.getTime())&&d<=now;});
      const erros=ag.filter(x=>x.status==='erro');
      const logsArr=Array.isArray(logs.logs)?logs.logs:[];
      const todayStr=now.toLocaleDateString('pt-BR');
      const successToday=logsArr.filter(x=>x.includes(todayStr)&&/sucesso|enviado/i.test(x)).length;
      const errorToday=logsArr.filter(x=>x.includes(todayStr)&&/erro|falha/i.test(x)).length;
      const sentToday=Number(dash.hoje||0);
      data={
        scheduler:{online:qr.conectado===true,socket:qr.conectado===true,status:qr.status||'',janela:dash.janela||'',proximoEnvio:null},
        metrics:{fila:active.length,pausados:ag.length-active.length,vencidos:due.length,errosAgendados:erros.length,falhasPendentes:failures.length,retries:failures.length,sucessoHoje:successToday,errosHoje:errorToday,enviadosHoje:sentToday},
        diagnosis:{nivel:(!qr.conectado?'critico':(due.length||failures.length||erros.length?'atencao':'normal')),criticos:(!qr.conectado?['WhatsApp desconectado']:[]),gargalos:[...(due.length?[due.length+' agendamento(s) vencido(s)']:[]),...(failures.length?[failures.length+' falha(s) aguardando tratamento']:[]),...(erros.length?[erros.length+' agendamento(s) em erro']:[])]},
        queue:ag,
        failures:failures
      };
      render();
    }catch(e){
      $('Alert').className='notice error'; $('Alert').textContent='Não foi possível atualizar o monitor: '+(e.message||e);
    }
  }
  btn.onclick=()=>{modal.classList.add('open');load();};
  jfetch('/api/auth/me').then(d=>{if(d?.usuario?.admin!==true){btn.style.display='none';const menuBtn=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('📊 Monitor'));if(menuBtn)menuBtn.style.display='none';}}).catch(()=>{});
  $('Close').onclick=()=>modal.classList.remove('open');
  $('Refresh').onclick=load;
  $('Search').oninput=render; $('Type').onchange=render; $('Period').onchange=render;
  $('Clear').onclick=()=>{$('Search').value='';$('Type').value='todos';$('Period').value='hoje';render();};
  modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open');});
  setInterval(()=>{if(modal.classList.contains('open'))load();},10000);
})();