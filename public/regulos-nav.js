/* REGULOS_NAV_V1 */
(function(){
  if(document.getElementById('regulosSidebar'))return;
  document.body.classList.add('regulos-has-sidebar');
  const nav=[
    ['📅','Agendamentos',()=>window.openSchedulesPanel?.()],
    ['🔗','Gerenciador de Links',()=>openPanelModalByTitle('🔗 Gerenciador de links')],
    ['📤','Entregas',()=>openPanelModalByTitle('📤 Status das Entregas')],
    ['👥','Grupos',()=>window.openAllGroups?.()],
    ['📊','Monitor',()=>document.getElementById('regulosSchedulerMonitorBtn')?.click()],
    ['🩺','Diagnóstico',()=>window.openDiagnosticPanel?.()],
  ];
  const aside=document.createElement('aside');
  aside.id='regulosSidebar';aside.className='regulos-sidebar';aside.setAttribute('aria-label','Navegação RegulOS');
  aside.innerHTML='<div class="regulos-sidebar-brand"><img class="regulos-sidebar-logo" src="/regulos-login-wallpaper.svg" alt="RegulOS"><small>Central de Automação</small></div>'<div class="regulos-nav-label">Navegação</div><nav class="regulos-nav"></nav><div class="regulos-sidebar-metrics"><div><span>💬 Mensagens</span><b id="regulosSidebarToday">0</b></div><div><span>👥 Grupos</span><b id="regulosSidebarGroups">0</b></div><div><span>🔗 Links</span><b id="regulosSidebarLinks">0</b></div></div><div class="regulos-sidebar-status"><span class="dot"></span><b id="regulosSidebarStatus">Sistema online</b><div id="regulosSidebarNumber" style="margin-top:4px;color:#8fa6c5">WhatsApp verificando...</div></div>';
  const navEl=aside.querySelector('.regulos-nav');
  nav.forEach(([icon,label,fn])=>{
    const b=document.createElement('button');b.type='button';b.innerHTML='<span class="regulos-nav-icon">'+icon+'</span><span>'+label+'</span>';
    b.addEventListener('click',()=>{fn();closeNav();});navEl.appendChild(b);
  });
  const toggle=document.createElement('button');toggle.type='button';toggle.className='regulos-sidebar-toggle';toggle.id='regulosSidebarToggle';toggle.textContent='☰';toggle.setAttribute('aria-label','Abrir menu');
  toggle.addEventListener('click',()=>document.body.classList.toggle('regulos-sidebar-open'));
  const overlay=document.createElement('div');overlay.className='regulos-sidebar-overlay';overlay.addEventListener('click',closeNav);
  function closeNav(){document.body.classList.remove('regulos-sidebar-open')}
  function openPanelModalByTitle(title){
    const panel=[...document.querySelectorAll('.panel')].find(x=>String(x.querySelector('h2')?.textContent||'').includes(title));
    if(!panel)return;
    const modalId='regulosNavPanelModal';
    let modal=document.getElementById(modalId);
    if(!modal){
      modal=document.createElement('section');
      modal.id=modalId;
      modal.className='regulos-nav-modal';
      modal.innerHTML='<div class="regulos-nav-modal-card"><div class="regulos-nav-modal-head"><strong id="regulosNavModalTitle"></strong><button type="button" aria-label="Fechar">✕</button></div><div id="regulosNavModalBody" class="regulos-nav-modal-body"></div></div>';
      document.body.appendChild(modal);
      modal.querySelector('button').addEventListener('click',closePanelModal);
      modal.addEventListener('click',e=>{if(e.target===modal)closePanelModal();});
    }
    const body=modal.querySelector('#regulosNavModalBody');
    const titleEl=modal.querySelector('#regulosNavModalTitle');
    if(panel.parentElement===body)return;
    panel.__regulosNavParent=panel.parentElement;
    panel.__regulosNavNext=panel.nextSibling;
    titleEl.textContent=title;
    body.appendChild(panel);
    modal.classList.add('open');
    document.body.classList.add('regulos-nav-modal-open');
  }
  function closePanelModal(){
    const modal=document.getElementById('regulosNavPanelModal');
    const body=modal?.querySelector('#regulosNavModalBody');
    const panel=body?.querySelector('.panel');
    if(panel?.__regulosNavParent){
      const parent=panel.__regulosNavParent;
      const next=panel.__regulosNavNext;
      if(next&&next.parentNode===parent)parent.insertBefore(panel,next);else parent.appendChild(panel);
      delete panel.__regulosNavParent;
      delete panel.__regulosNavNext;
    }
    modal?.classList.remove('open');
    document.body.classList.remove('regulos-nav-modal-open');
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closePanelModal()});
  document.body.append(aside,toggle,overlay);
  async function updateSidebarStatus(){
    const statusEl=document.getElementById('regulosSidebarStatus');
    const numberEl=document.getElementById('regulosSidebarNumber');
    const dot=aside.querySelector('.regulos-sidebar-status .dot');
    if(!statusEl||!numberEl)return;
    try{
      const r=await fetch('/api/status',{cache:'no-store',credentials:'same-origin'});
      const d=await r.json();
      const connected=Boolean(d.conectado);
      const waitingQr=Boolean(d.temQR);
      statusEl.textContent=connected?'WhatsApp conectado':(waitingQr?'Aguardando QR':'WhatsApp desconectado');
      numberEl.textContent=connected&&d.numero?('Número: '+d.numero):(waitingQr?'Escaneie o QR Code':'Número: —');
      if(dot){
        dot.style.background=connected?'#22c55e':waitingQr?'#f59e0b':'#ef4444';
        dot.style.boxShadow=connected?'0 0 10px rgba(34,197,94,.7)':waitingQr?'0 0 10px rgba(245,158,11,.7)':'0 0 10px rgba(239,68,68,.55)';
      }
      const todayEl=document.getElementById('regulosSidebarToday');
      const groupsEl=document.getElementById('regulosSidebarGroups');
      const linksEl=document.getElementById('regulosSidebarLinks');
      if(todayEl) todayEl.textContent=d.mensagensHoje??d.hoje??0;
      if(groupsEl) groupsEl.textContent=d.grupos??0;
      if(linksEl) linksEl.textContent=d.links??0;
    }catch{
      statusEl.textContent='Sistema indisponível';
      numberEl.textContent='Não foi possível verificar';
      if(dot){dot.style.background='#ef4444';dot.style.boxShadow='0 0 10px rgba(239,68,68,.55)';}
    }
  }
  updateSidebarStatus();
  setInterval(updateSidebarStatus,3000);
  const style=document.createElement('style');
  style.textContent='@keyframes regulosNavGlow{0%,100%{box-shadow:0 0 0 rgba(34,211,238,0)}50%{box-shadow:0 0 30px rgba(34,211,238,.32)}}';
  document.head.appendChild(style);
})();
