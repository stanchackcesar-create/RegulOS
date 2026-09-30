const {spawn} = require('child_process');
const http = require('http');
const path = require('path');

const HOST = process.env.REGULOS_HOST || '0.0.0.0';
const HEALTH_HOST = process.env.REGULOS_HEALTH_HOST || '127.0.0.1';
const PORT = Number(process.env.REGULOS_PORT || 3000);
const SERVER = path.join(__dirname, 'server.js');
let child = null;
let stopping = false;
let restarting = false;

function health(timeout=900){
  return new Promise(resolve=>{
    const req=http.get({host:HEALTH_HOST,port:PORT,path:'/api/health',timeout},res=>{
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>resolve(res.statusCode===200));
    });
    req.on('error',()=>resolve(false));
    req.on('timeout',()=>{req.destroy();resolve(false)});
  });
}

function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function startServer(){
  if(stopping || restarting) return;
  if(await health()){
    console.log(`RegulOS já está online em http://${HEALTH_HOST}:${PORT}.`);
    console.log('Esta instância do supervisor não iniciou um segundo servidor.');
    return process.exit(0);
  }

  restarting=true;
  console.log(`Iniciando RegulOS em http://${HEALTH_HOST}:${PORT}...`);
  child=spawn(process.execPath,[SERVER],{
    cwd:path.resolve(__dirname,'..'),
    env:{...process.env,REGULOS_SUPERVISED:'1'},
    stdio:'inherit',
    windowsHide:false
  });
  restarting=false;

  child.on('error',err=>{
    console.error('Falha ao iniciar RegulOS:',err.message);
  });

  child.on('exit',async(code,signal)=>{
    child=null;
    if(stopping) return process.exit(0);

    // Se outro processo assumiu a porta, não crie uma segunda instância.
    if(await health()){
      console.log('Outra instância do RegulOS está atendendo a porta 3000. Supervisor encerrado.');
      return process.exit(0);
    }

    console.log(`Servidor encerrou (código ${code ?? 'null'}, sinal ${signal ?? 'nenhum'}).`);
    console.log('Reiniciando automaticamente em 2 segundos...');
    await wait(2000);
    if(!stopping) startServer();
  });
}

process.on('SIGINT',()=>{
  stopping=true;
  if(child){
    try{child.kill('SIGINT')}catch{}
    setTimeout(()=>{try{child.kill('SIGTERM')}catch{};process.exit(0)},1500);
  } else process.exit(0);
});
process.on('SIGTERM',()=>process.emit('SIGINT'));

console.log('========================================');
console.log(' RegulOS Supervisor v12.7.1');
console.log(' Reinício automático ativado');
console.log('========================================');
startServer();
