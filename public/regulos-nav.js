/* REGULOS_NAV_V1 */
(function(){
  if(document.getElementById('regulosSidebar'))return;
  document.body.classList.add('regulos-has-sidebar');
  const nav=[
    ['🏠','Dashboard',()=>closeNav()],
    ['📅','Agendamentos',()=>window.openSchedulesPanel?.()],
    ['🔗','Gerenciador de Links',()=>openPanelModalByTitle('🔗 Gerenciador de links')],
    ['📤','Entregas',()=>openPanelModalByTitle('📤 Status das Entregas')],
    ['👥','Grupos',()=>window.openAllGroups?.()],
    ['📊','Monitor',()=>document.getElementById('regulosSchedulerMonitorBtn')?.click()],
    ['🩺','Diagnóstico',()=>window.openDiagnosticPanel?.()],
  ];
  const aside=document.createElement('aside');
  aside.id='regulosSidebar';aside.className='regulos-sidebar';aside.setAttribute('aria-label','Navegação RegulOS');
  aside.innerHTML='<div class="regulos-sidebar-brand"><b>⚙️ RegulOS</b><small>Central de Automação</small></div><div class="regulos-nav-label">Navegação</div><nav class="regulos-nav"></nav><div class="regulos-sidebar-status"><span class="dot"></span><b id="regulosSidebarStatus">Sistema online</b><div id="regulosSidebarNumber" style="margin-top:4px;color:#8fa6c5">WhatsApp verificando...</div></div>';
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
  const style=document.createElement('style');
  style.textContent='@keyframes regulosNavGlow{0%,100%{box-shadow:0 0 0 rgba(34,211,238,0)}50%{box-shadow:0 0 30px rgba(34,211,238,.32)}}';
  document.head.appendChild(style);
})();
