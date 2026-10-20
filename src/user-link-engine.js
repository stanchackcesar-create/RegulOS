'use strict';

const { createUserContextFactory } = require('./user-context');
function isValidGroupJid(value) { return typeof value === 'string' && /^[0-9]+-[0-9]+@g\\.us$/.test(value) || typeof value === 'string' && /^[0-9]+@g\\.us$/.test(value); }

function createUserLinkEngine(options = {}) {
  if (!options.baseDir || !options.sessions || typeof options.prepareMessage !== 'function') {
    throw new TypeError('baseDir, sessions e prepareMessage são obrigatórios.');
  }
  const contexts = createUserContextFactory({ baseDir: options.baseDir });
  const busy = new Set();
  const timers = new Map();

  function context(userId) { return contexts.createContext(userId); }
  function read(userId, key, fallback) { return context(userId).data.readJson(key, fallback); }
  function write(userId, key, value) { return context(userId).data.writeJson(key, value); }
  function array(userId, key) { const v=read(userId,key,[]); return Array.isArray(v)?v:[]; }
  function object(userId, key) { const v=read(userId,key,{}); return v&&typeof v==='object'&&!Array.isArray(v)?v:{}; }
  function timeOf(item) { return String(item?.horario||''); }
  function localDate(date = new Date()) {
    return String(date.getFullYear()).padStart(4,'0')+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  }
  function occurrence(item, now = new Date()) {
    const rep=String(item.repeticao||'uma_vez');
    if(rep==='diariamente') return localDate(now);
    if(rep==='semanalmente') {
      const d=new Date(now); d.setDate(d.getDate()-((d.getDay()+6)%7));
      return localDate(d);
    }
    return String(item.data||localDate(now)).slice(0,10)+'T'+timeOf(item);
  }
  function due(item, now = new Date()) {
    if(item.ativo===false) return false;
    const h=timeOf(item);
    if(!/^\d{2}:\d{2}$/.test(h)) return false;
    const [hh,mm]=h.split(':').map(Number);
    if(hh>23||mm>59) return false;
    const today=localDate(now);
    const date=String(item.data||today).slice(0,10);
    const rep=String(item.repeticao||'uma_vez');
    if(rep==='uma_vez' && date!==today) return false;
    if(rep==='semanalmente') {
      const target=new Date(date+'T12:00:00');
      if(Number.isNaN(target.getTime())||target.getDay()!==now.getDay()) return false;
    }
    const target=new Date(now); target.setHours(hh,mm,0,0);
    if(now<target) return false;
    return item.lastRunKey!==occurrence(item,now);
  }
  function groupIds(item) {
    const raw=Array.isArray(item.grupoIds)?item.grupoIds:(item.grupoId?[item.grupoId]:[]);
    return [...new Set(raw.map(String))];
  }
  function addDelivery(userId, item, groupId, status, extra={}) {
    const list=array(userId,'deliveries');
    const key=[item.id,item.progressKey||occurrence(item),groupId].join(':');
    const row={key,agendamentoId:item.id,grupoId:groupId,linkId:item.id,url:item.url||'',nome:item.nome||'',status,atualizadoEm:new Date().toISOString(),...extra};
    const index=list.findIndex(x=>x.key===key);
    if(index>=0) list[index]={...list[index],...row}; else list.push(row);
    write(userId,'deliveries',list.slice(-5000));
    return row;
  }
  function addHistory(userId,item,groupId,status,error='') {
    const list=array(userId,'linkHistory');
    list.unshift({id:require('node:crypto').randomUUID(),agendamentoId:item.id,grupoId:groupId,link:item.url||'',nome:item.nome||'',status,erro:error,ocorrencia:item.progressKey||'',criadoEm:new Date().toISOString()});
    write(userId,'linkHistory',list.slice(0,2000));
  }
  function setFailure(userId,item,groupId,error) {
    const list=array(userId,'linkFailures');
    const key=String(item.id)+':'+String(groupId);
    const row={id:key,agendamentoId:item.id,grupoId,url:item.url||'',nome:item.nome||'',erro:String(error||'Falha no envio'),status:'ERRO',atualizadoEm:new Date().toISOString()};
    const i=list.findIndex(x=>String(x.id)===key);
    if(i>=0)list[i]=row;else list.unshift(row);
    write(userId,'linkFailures',list.slice(0,2000));
  }
  function clearFailure(userId,item,groupId) {
    write(userId,'linkFailures',array(userId,'linkFailures').filter(x=>String(x.id)!==String(item.id)+':'+String(groupId)));
  }
  async function sendOne(userId, itemId, {force=false}={}) {
    const lock=String(userId)+':'+String(itemId);
    if(busy.has(lock)) return {ok:false,reason:'busy'};
    const session=options.sessions.get(userId), runtime=options.sessions.getRuntime(userId);
    if(!runtime?.socket || session?.status!=='online') return {ok:false,reason:'offline'};
    const items=array(userId,'schedules');
    const item=items.find(x=>String(x.id)===String(itemId));
    if(!item) return {ok:false,reason:'not-found'};
    const bot=object(userId,'botSchedule');
    if(!force && (!bot.ativo || !windowActive(bot,new Date()))) return {ok:false,reason:'window-closed'};
    if(!force && !due(item,new Date())) return {ok:false,reason:'not-due'};
    const groups=options.sessions.get(userId)?.groups || runtime.groups.read();
    const config=object(userId,'groupConfig');
    const ids=groupIds(item);
    if(!ids.length || ids.some(id=>!isValidGroupJid(id))) {
      item.status='erro'; item.ativo=false; setFailure(userId,item,ids[0]||'', 'Grupos de envio inválidos.');
      write(userId,'schedules',items); return {ok:false,reason:'invalid-groups'};
    }
    const known=new Set(groups.map(g=>String(g.id)));
    if(ids.some(id=>!known.has(id))) return {ok:false,reason:'groups-not-refreshed'};
    const targets=ids.filter(id=>config[id]?.ativo===true);
    if(!targets.length) return {ok:false,reason:'no-enabled-groups'};
    busy.add(lock);
    try {
      const key=occurrence(item,new Date());
      item.progressKey=item.progressKey||key;
      item.progressTargets=Array.isArray(item.progressTargets)&&item.progressTargets.length?item.progressTargets:targets;
      item.progressGroupIds=Array.isArray(item.progressGroupIds)?item.progressGroupIds:[];
      item.status='enviando';
      write(userId,'schedules',items);
      const content=await options.prepareMessage(item);
      if(!content || (!content.text && !content.imageBuffer)) throw new Error('Não foi possível preparar o conteúdo da oferta.');
      let sent=0, errors=0;
      for(const id of targets) {
        if(item.progressGroupIds.includes(id)) continue;
        if(config[id]?.ativo!==true) { item.progressGroupIds.push(id); continue; }
        addDelivery(userId,item,id,'ENVIANDO');
        try {
          let ok=false, lastError;
          for(let attempt=1;attempt<=3&&!ok;attempt++) {
            try {
              if(content.imageBuffer) await runtime.socket.sendMessage(id,{image:content.imageBuffer,caption:content.text||''});
              else await runtime.socket.sendMessage(id,{text:content.text||''});
              ok=true;
            } catch(e) {
              lastError=e;
              if(attempt<3) await new Promise(resolve=>setTimeout(resolve,[1000,2500][attempt-1]));
            }
          }
          if(!ok) throw lastError||new Error('Falha no envio.');
          sent++; item.sucessos=Number(item.sucessos||0)+1; item.enviados=Number(item.enviados||0)+1;
          item.lastSentAt=new Date().toISOString();
          addDelivery(userId,item,id,'SUCESSO'); addHistory(userId,item,id,'sucesso'); clearFailure(userId,item,id);
        } catch(e) {
          errors++; item.erros=Number(item.erros||0)+1;
          addDelivery(userId,item,id,'ERRO',{erro:String(e?.message||e)}); addHistory(userId,item,id,'erro',String(e?.message||e)); setFailure(userId,item,id,e?.message||e);
        }
        item.progressGroupIds=[...new Set([...item.progressGroupIds,id])];
        write(userId,'schedules',items);
        await new Promise(resolve=>setTimeout(resolve,Math.max(700,Number(item.intervaloMin||1)*1000)));
      }
      const completed=item.progressTargets.every(id=>item.progressGroupIds.includes(id));
      if(completed) {
        item.lastRunKey=item.progressKey; item.lastRunAt=new Date().toISOString();
        item.progressKey='';item.progressTargets=[];item.progressGroupIds=[];
        if(item.repeticao==='uma_vez') {item.ativo=false;item.status=errors?'erro':'concluido';}
        else item.status='agendado';
      } else item.status='pausado';
      write(userId,'schedules',items);
      const queue=object(userId,'linkQueue'); queue.lastItemId=item.id;queue.lastRunAt=new Date().toISOString();queue.updatedAt=new Date().toISOString();write(userId,'linkQueue',queue);
      return {ok:completed,sent,errors,status:item.status};
    } catch(error) {
      item.status='erro'; item.lastError=String(error?.message||error);
      for(const id of targets) {
        addDelivery(userId,item,id,'ERRO',{erro:item.lastError});
        addHistory(userId,item,id,'erro',item.lastError);
        setFailure(userId,item,id,item.lastError);
      }
      write(userId,'schedules',items);
      return {ok:false,reason:'error',error:item.lastError};
    } finally { busy.delete(lock); }
  }
  function windowActive(schedule,now) {
    if(!schedule?.ativo) return false;
    const start=String(schedule.inicio||''),end=String(schedule.fim||'');
    if(!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)) return false;
    const minutes=now.getHours()*60+now.getMinutes();
    const toMinutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
    const a=toMinutes(start),b=toMinutes(end);
    return a<=b ? minutes>=a&&minutes<=b : minutes>=a||minutes<=b;
  }
  async function tickUser(userId) {
    const runtime=options.sessions.getRuntime(userId), session=options.sessions.get(userId);
    if(!runtime?.socket||session?.status!=='online') return;
    const bot=object(userId,'botSchedule');
    if(!windowActive(bot,new Date())) return;
    const items=array(userId,'schedules').filter(x=>x.ativo!==false);
    for(const item of items) {
      if(due(item,new Date())) { await sendOne(userId,item.id); break; }
    }
  }
  function startUser(userId) {
    const id=String(userId);
    if(timers.has(id)) return false;
    const timer=setInterval(()=>tickUser(id).catch(()=>{}),5000);
    timers.set(id,timer);
    return true;
  }
  function stopUser(userId) {
    const id=String(userId), timer=timers.get(id);
    if(!timer) return false;
    clearInterval(timer);timers.delete(id);return true;
  }
  function startAll() { for(const id of options.sessions.userIds()) startUser(id); }
  function close() { for(const id of timers.keys()) stopUser(id); }
  return Object.freeze({sendOne,tickUser,startUser,stopUser,startAll,close,windowActive});
}
module.exports = { createUserLinkEngine };
