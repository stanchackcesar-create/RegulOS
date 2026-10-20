'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUserContextFactory } = require('../src/user-context');
const { createUserLinkEngine } = require('../src/user-link-engine');

test('motor envia apenas pelo socket e pelos dados do proprietário', async t => {
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'regulos-user-engine-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  const contexts=createUserContextFactory({baseDir});
  const sentA=[],sentB=[];
  const runtimeA={socket:{async sendMessage(id,msg){sentA.push({id,msg});}},groups:{read:()=>[{id:'12345-678@g.us',name:'Grupo A'}]}};
  const runtimeB={socket:{async sendMessage(id,msg){sentB.push({id,msg});}},groups:{read:()=>[{id:'98765-432@g.us',name:'Grupo B'}]}};
  const sessions={
    get:id=>({status:'online',groups:id==='user-A'?[{id:'12345-678@g.us',name:'Grupo A'}]:[{id:'98765-432@g.us',name:'Grupo B'}]}),
    getRuntime:id=>id==='user-A'?runtimeA:runtimeB,
    userIds:()=>['user-A','user-B']
  };
  const a=contexts.createContext('user-A').data, b=contexts.createContext('user-B').data;
  a.writeJson('schedules',[{id:'offer-A',nome:'A',url:'https://example.com/a',grupoIds:['12345-678@g.us'],ativo:true,repeticao:'uma_vez',intervaloMin:0}]);
  a.writeJson('groupConfig',{'12345-678@g.us':{ativo:true}});
  b.writeJson('schedules',[{id:'offer-B',nome:'B',url:'https://example.com/b',grupoIds:['98765-432@g.us'],ativo:true,repeticao:'uma_vez',intervaloMin:0}]);
  b.writeJson('groupConfig',{'98765-432@g.us':{ativo:true}});
  const engine=createUserLinkEngine({baseDir,sessions,prepareMessage:async item=>({text:item.url,imageBuffer:Buffer.from('image')})});
  const result=await engine.sendOne('user-A','offer-A',{force:true});
  assert.equal(result.ok,true);
  assert.equal(sentA.length,1);
  assert.equal(sentA[0].id,'12345-678@g.us');
  assert.equal(sentB.length,0);
  assert.equal(a.readJson('linkHistory',[]).length,1);
  assert.equal(a.readJson('deliveries',[])[0].status,'SUCESSO');
  assert.equal(b.readJson('linkHistory',[]).length,0);
  assert.equal(b.readJson('deliveries',[]).length,0);
});

test('não envia se o grupo não estiver explicitamente ligado', async t => {
  const baseDir=fs.mkdtempSync(path.join(os.tmpdir(),'regulos-user-engine-off-'));
  t.after(()=>fs.rmSync(baseDir,{recursive:true,force:true}));
  const contexts=createUserContextFactory({baseDir}), data=contexts.createContext('user-A').data;
  data.writeJson('schedules',[{id:'offer-A',url:'https://example.com/a',grupoIds:['12345-678@g.us'],ativo:true,repeticao:'uma_vez'}]);
  const sent=[];
  const sessions={get:()=>({status:'online',groups:[{id:'12345-678@g.us'}]}),getRuntime:()=>({socket:{async sendMessage(...args){sent.push(args);}},groups:{read:()=>[]}}),userIds:()=>[]};
  const engine=createUserLinkEngine({baseDir,sessions,prepareMessage:async()=>({text:'x',imageBuffer:Buffer.from('x')})});
  const result=await engine.sendOne('user-A','offer-A',{force:true});
  assert.equal(result.reason,'no-enabled-groups');
  assert.equal(sent.length,0);
});
