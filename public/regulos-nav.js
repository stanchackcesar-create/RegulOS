/* REGULOS_NAV_V1 */
(function(){
  if(document.getElementById('regulosSidebar'))return;
  document.body.classList.add('regulos-has-sidebar');
  const nav=[
    ['🏠','Dashboard',()=>window.scrollTo({top:0,behavior:'smooth'})],
    ['📅','Agendamentos',()=>window.openSchedulesPanel?.()],
    ['🔗','Gerenciador de Links',()=>focusPanel('🔗 Gerenciador de links')],
    ['📤','Entregas',()=>focusPanel('📤 Status das Entregas')],
    ['👥','Grupos',()=>window.openAllGroups?.()],
    ['📊','Monitor',()=>document.getElementById('regulosSchedulerMonitorBtn')?.click()],
    ['🩺','Diagnóstico',()=>window.openDiagnosticPanel?.()],
    ['📜','Logs',()=>window.openLogsPanel?.()]
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
  function focusPanel(title){
    const panels=[...document.querySelectorAll('.panel')];
    const p=panels.find(x=>String(x.querySelector('h2')?.textContent||'').includes(title));
    if(p){p.scrollIntoView({behavior:'smooth',block:'start'});p.style.animation='regulosNavGlow .9s ease';setTimeout(()=>p.style.animation='',1000)}
  }
  document.body.append(aside,toggle,overlay);
  window.regulosFocusPanel=focusPanel;
  const style=document.createElement('style');
  style.textContent='@keyframes regulosNavGlow{0%,100%{box-shadow:0 0 0 rgba(34,211,238,0)}50%{box-shadow:0 0 30px rgba(34,211,238,.32)}}';
  document.head.appendChild(style);
  const originalStatus=window.status;
  if(typeof originalStatus==='function'){
    window.status=async function(){const result=await originalStatus.apply(this,arguments);const c=document.getElementById('conn')?.textContent||'';const n=document.getElementById('number')?.textContent||'Número: —';const s=document.getElementById('regulosSidebarStatus');const nn=document.getElementById('regulosSidebarNumber');if(s){s.textContent=c.includes('Conectado')?'WhatsApp conectado':'Sistema '+(c||'verificando')}if(nn)nn.textContent=n;return result};
  }
})();