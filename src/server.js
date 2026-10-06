// REGULOS_MULTI_GROUP_SCHEDULE_V1
// Cada agendamento pode apontar para um ou mais grupos selecionados no painel.
// REGULOS_IMAGE_REQUIRED_ALL_SCHEDULES_V1
// Todo agendamento de link tenta obter uma imagem válida.
// Com ou sem montagem automática de oferta, não enviamos link sem imagem.
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const http = require('http');
const os = require('os');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { createShopeeIntegration, isShopeeHost } = require('./shopee');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.REGULOS_DATA_DIR || path.join(ROOT, 'data');
const AUTH = process.env.REGULOS_AUTH_DIR || path.join(ROOT, 'auth');
const USERS_FILE = path.join(DATA, 'usuarios.json');
const SESSIONS_FILE = path.join(DATA, 'sessoes.json');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(AUTH, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
// Horários do painel usam explicitamente o fuso configurado para o RegulOS.
// Na nuvem, o padrão é Brasília para evitar que o container opere em UTC.
const REGULOS_TIMEZONE = process.env.REGULOS_TIMEZONE || 'America/Sao_Paulo';
process.env.TZ = REGULOS_TIMEZONE;

const FILES = {
  groups: path.join(DATA, 'grupos.json'),
  groupConfig: path.join(DATA, 'grupos_config.json'),
  links: path.join(DATA, 'links.json'),
  index: path.join(DATA, 'indice.txt'),
  history: path.join(DATA, 'historico.json'),
  schedules: path.join(DATA, 'link_agendamentos.json'),
  linkHistory: path.join(DATA, 'historico_links_enviados.json'),
  linkFailures: path.join(DATA, 'links_com_falha.json'),
  deliveries: path.join(DATA, 'entregas_links.json'),
  botSchedule: path.join(DATA, 'programacao_bot.json'),
  linkQueue: path.join(DATA, 'fila_links.json')
};

const app = express();
app.get('/api/programacao-dinamica', requireAuth, (req,res)=>{
  res.json({ok:true,programacao:sortDynamic(readDynamicSchedule())});
});

app.post('/api/programacao-dinamica/reorganizar', requireAuth, requireAdmin, (req,res)=>{
  const body=req.body||{};
  const item=readDynamicSchedule().find(x=>scheduleId(x)===(body.id||body.agendamentoId||body.linkId));
  if(!item) return res.status(404).json({ok:false,error:'Agendamento não encontrado.'});
  res.json({ok:true,...registrarFalhaEReorganizar(item,body.motivo||'Falha no envio')});
});

app.use(express.json({ limit: '100kb' }));

const logger = P({ level: 'silent' });

// Cabeçalhos básicos de segurança para o painel público.
app.use((req,res,next)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});

// ========================= AUTENTICAÇÃO MULTIUSUÁRIO =========================
// As contas controlam apenas o acesso ao painel. A sessão do WhatsApp e todos
// os dados do RegulOS continuam compartilhados, conforme a arquitetura escolhida.
function readUsers(){
  const v=readJson(USERS_FILE,[]);
  return Array.isArray(v)?v:[];
}
function saveUsers(v){ writeJson(USERS_FILE,v); }
function readSessions(){
  const v=readJson(SESSIONS_FILE,{});
  return v && typeof v==='object' && !Array.isArray(v) ? v : {};
}
function saveSessions(v){ writeJson(SESSIONS_FILE,v); }
function hashPassword(password,salt){
  return crypto.scryptSync(String(password),salt,64).toString('hex');
}
function verifyPassword(password,user){
  try{
    const actual=hashPassword(password,user.salt);
    return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(user.hash,'hex'));
  }catch{return false;}
}
const USER_ONLINE_WINDOW_MS = 12 * 1000;

function userHasActiveSession(userId){
  const now = Date.now();
  const sessions = readSessions();
  return Object.values(sessions).some(s =>
    s && s.userId === userId &&
    Number(s.ultimoAcesso || 0) > now - USER_ONLINE_WINDOW_MS &&
    Number(s.expiraEm || 0) > now
  );
}

function sanitizeUser(u){
  return {id:u.id,usuario:u.usuario,admin:u.admin===true,criadoEm:u.criadoEm};
}
function currentUser(req){
  const token=String(req.headers.cookie||'').match(/(?:^|;\s*)regulos_session=([^;]+)/)?.[1];
  if(!token) return null;
  const sessions=readSessions();
  const session=sessions[token];
  if(!session) return null;
  if(Date.now()>Number(session.expiraEm||0)){
    delete sessions[token]; saveSessions(sessions); return null;
  }
  const user=readUsers().find(x=>x.id===session.userId);
  if(!user) return null;
  session.ultimoAcesso=Date.now(); sessions[token]=session; saveSessions(sessions);
  return user;
}
function setSession(res,user){
  const sessions=readSessions();
  const token=crypto.randomBytes(32).toString('hex');
  sessions[token]={userId:user.id,criadoEm:Date.now(),ultimoAcesso:Date.now(),expiraEm:Date.now()+1000*60*60*24*30};
  saveSessions(sessions);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',`regulos_session=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${60*60*24*30}`);
}
function clearSession(req,res){
  const token=String(req.headers.cookie||'').match(/(?:^|;\s*)regulos_session=([^;]+)/)?.[1];
  if(token){const sessions=readSessions();delete sessions[token];saveSessions(sessions);}
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',`regulos_session=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}
function requireAuth(req,res,next){
  const user=currentUser(req);
  if(!user){
    if(req.path.startsWith('/api/')) return res.status(401).json({ok:false,authRequired:true,msg:'Faça login para acessar o RegulOS.'});
    return res.redirect('/login');
  }
  req.user=user; next();
}
function requireAdmin(req,res,next){
  if(req.user?.admin!==true) return res.status(403).json({ok:false,msg:'Acesso restrito ao administrador.'});
  next();
}

// Endpoints públicos de autenticação e saúde do servidor.
function getLanAddresses(){
  const out=[];
  for(const list of Object.values(os.networkInterfaces())) for(const n of (list||[])){
    if(n.family==='IPv4' && !n.internal) out.push(n.address);
  }
  return [...new Set(out)];
}
app.get('/api/network',(req,res)=>res.json({ok:true,host:HOST,port:PORT,lan:getLanAddresses().map(ip=>`http://${ip}:${PORT}`)}));
app.get('/api/health',(req,res)=>res.json({ok:true,version:'12.8.0-cloud',pid:process.pid,time:new Date().toISOString(),uptime:Math.floor(process.uptime()),lan:getLanAddresses().map(ip=>`http://${ip}:${PORT}`)}));
app.get('/api/auth/status',(req,res)=>{
  const users=readUsers();
  const user=currentUser(req);
  res.json({ok:true,configurado:users.length>0,autenticado:Boolean(user),usuario:user?sanitizeUser(user):null});
});
app.post('/api/auth/setup',(req,res)=>{
  if(readUsers().length>0)return res.status(409).json({ok:false,msg:'Já existe uma conta. Somente usuários cadastrados pelo administrador podem entrar.'});
  const users=readUsers();
  if(users.length) return res.status(409).json({ok:false,msg:'O RegulOS já está configurado. Entre com uma conta.'});
  const usuario=String(req.body?.usuario||'').trim().toLowerCase();
  const senha=String(req.body?.senha||'');
  if(usuario.length<3||senha.length<6) return res.status(400).json({ok:false,msg:'Informe nome de usuário e senha (mínimo de 6 caracteres).'});
  const nome=usuario;
  const salt=crypto.randomBytes(16).toString('hex');
  const user={id:crypto.randomUUID(),nome,usuario,salt,hash:hashPassword(senha,salt),admin:true,criadoEm:new Date().toISOString()};
  saveUsers([user]); saveSessions({}); setSession(res,user);
  res.json({ok:true,msg:'Conta administradora criada.',usuario:sanitizeUser(user)});
});
const loginAttempts = new Map();
function clientIp(req){ return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function loginAllowed(req){
  const key=clientIp(req), now=Date.now(), windowMs=15*60*1000;
  const a=loginAttempts.get(key);
  if(!a || now-a.startedAt>windowMs){ loginAttempts.set(key,{startedAt:now,count:0}); return true; }
  return a.count < 8;
}
function registerLoginFailure(req){
  const key=clientIp(req), now=Date.now(), windowMs=15*60*1000;
  const a=loginAttempts.get(key);
  if(!a || now-a.startedAt>windowMs) loginAttempts.set(key,{startedAt:now,count:1});
  else { a.count++; loginAttempts.set(key,a); }
}
function clearLoginFailures(req){ loginAttempts.delete(clientIp(req)); }

app.post('/api/auth/login',(req,res)=>{
  if(!loginAllowed(req)) return res.status(429).json({ok:false,msg:'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.'});
  const usuario=String(req.body?.usuario||'').trim().toLowerCase();
  const senha=String(req.body?.senha||'');
  const user=readUsers().find(x=>x.usuario===usuario);
  if(!user || !verifyPassword(senha,user)){ registerLoginFailure(req); return res.status(401).json({ok:false,msg:'Usuário ou senha incorretos.'}); }
  clearLoginFailures(req);
  setSession(res,user); res.json({ok:true,msg:'Login realizado.',usuario:sanitizeUser(user)});
});
app.post('/api/auth/logout',(req,res)=>{clearSession(req,res);res.json({ok:true});});

function recoveryKeyValid(value){
  const configured=String(process.env.REGULOS_RECOVERY_KEY||'');
  const supplied=String(value||'');
  if(!configured || !supplied) return false;
  const a=crypto.createHash('sha256').update(configured).digest();
  const b=crypto.createHash('sha256').update(supplied).digest();
  return crypto.timingSafeEqual(a,b);
}
const recoveryAttempts = new Map();
function recoveryAllowed(req){
  const key=clientIp(req), now=Date.now(), windowMs=15*60*1000;
  const a=recoveryAttempts.get(key);
  if(!a || now-a.startedAt>windowMs){ recoveryAttempts.set(key,{startedAt:now,count:0}); return true; }
  return a.count < 5;
}
function registerRecoveryFailure(req){
  const key=clientIp(req), now=Date.now(), windowMs=15*60*1000;
  const a=recoveryAttempts.get(key);
  if(!a || now-a.startedAt>windowMs) recoveryAttempts.set(key,{startedAt:now,count:1});
  else { a.count++; recoveryAttempts.set(key,a); }
}
app.post('/api/auth/recover',(req,res)=>{
  if(!recoveryAllowed(req)) return res.status(429).json({ok:false,msg:'Muitas tentativas de recuperação. Aguarde alguns minutos.'});
  const recoveryKey=String(req.body?.recoveryKey||'');
  const usuario=String(req.body?.usuario||'').trim().toLowerCase();
  const novaSenha=String(req.body?.novaSenha||'');
  if(!recoveryKeyValid(recoveryKey) || !usuario || novaSenha.length<6){
    registerRecoveryFailure(req);
    return res.status(400).json({ok:false,msg:'Dados de recuperação inválidos.'});
  }
  const users=readUsers();
  const user=users.find(x=>x.usuario===usuario);
  if(!user){
    registerRecoveryFailure(req);
    return res.status(400).json({ok:false,msg:'Não foi possível recuperar esta conta.'});
  }
  const salt=crypto.randomBytes(16).toString('hex');
  user.salt=salt;
  user.hash=hashPassword(novaSenha,salt);
  saveUsers(users);
  const sessions=readSessions();
  for(const [token,session] of Object.entries(sessions)){
    if(session?.userId===user.id) delete sessions[token];
  }
  saveSessions(sessions);
  recoveryAttempts.delete(clientIp(req));
  setSession(res,user);
  res.json({ok:true,msg:'Senha redefinida com sucesso.',usuario:sanitizeUser(user)});
});

app.get('/api/auth/me',(req,res)=>{const user=currentUser(req);if(!user)return res.status(401).json({ok:false,authRequired:true});res.json({ok:true,usuario:sanitizeUser(user)});});
app.post('/api/auth/presence-offline',(req,res)=>{
  const token=String(req.headers.cookie||'').match(/(?:^|;\s*)regulos_session=([^;]+)/)?.[1];
  if(token){
    const sessions=readSessions();
    if(sessions[token]){
      sessions[token].ultimoAcesso=0;
      saveSessions(sessions);
    }
  }
  res.json({ok:true});
});

app.post('/api/auth/heartbeat',(req,res)=>{
  const user=currentUser(req);
  if(!user) return res.status(401).json({ok:false,authRequired:true});
  res.json({ok:true,online:true});
});

app.get('/login',(req,res)=>res.sendFile(path.join(PUBLIC,'login.html')));
app.get('/configurar',(req,res)=>res.sendFile(path.join(PUBLIC,'configurar.html')));
app.get('/integracoes',(req,res)=>res.sendFile(path.join(PUBLIC,'integracoes.html')));

const shopeeIntegration = createShopeeIntegration({dataDir:DATA});

app.get('/api/integracoes/shopee/status',requireAuth,requireAdmin,(req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ok:true,...shopeeIntegration.publicStatus()});
});

app.get('/api/integracoes/shopee/authorize',requireAuth,requireAdmin,(req,res)=>{
  try{
    const url=shopeeIntegration.authorizationUrl();
    res.json({ok:true,url});
  }catch(e){res.status(400).json({ok:false,msg:e.message||'Não foi possível iniciar a autorização Shopee.'});}
});

app.get('/integracoes/shopee/callback',async(req,res)=>{
  const state=String(req.query?.state||'');
  const code=String(req.query?.code||'');
  const shopId=String(req.query?.shop_id||'');
  const stateFile=path.join(DATA,'shopee_oauth_state.json');
  let saved={};
  try{saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{}
  try{fs.rmSync(stateFile,{force:true});}catch{}
  if(!state || !saved.state || state!==saved.state || Number(saved.expiresAt||0)<Date.now()){
    return res.status(400).send('<h2>Autorização Shopee inválida ou expirada.</h2><p>Volte ao RegulOS e inicie a conexão novamente.</p>');
  }
  if(!code) return res.status(400).send('<h2>A Shopee não retornou o código de autorização.</h2>');
  try{
    await shopeeIntegration.exchangeCode(code,shopId);
    res.send('<h2>✅ Shopee conectada ao RegulOS.</h2><p>Você já pode fechar esta janela e voltar ao painel de Integrações.</p><script>setTimeout(()=>location.href="/integracoes",1200)</script>');
  }catch(e){
    res.status(502).send('<h2>Falha ao conectar a Shopee</h2><p>'+String(e.message||'Erro').replace(/[<>]/g,'')+'</p><p><a href="/integracoes">Voltar</a></p>');
  }
});

app.post('/api/integracoes/shopee/disconnect',requireAuth,requireAdmin,(req,res)=>{
  shopeeIntegration.disconnect();
  res.json({ok:true,msg:'Shopee desconectada. Os tokens salvos foram removidos.'});
});

// A partir daqui, todo o painel e todas as APIs do RegulOS exigem login.
// REGULOS_AUTO_OFFER_V1
// Busca somente dados explicitamente publicados pela página/produto.
// Nenhum preço, desconto ou preço anterior é inferido quando a fonte não o fornece.
function autoOfferDecode(value){
  return String(value||'').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
}
function autoOfferMeta(html,name){
  for(const m of String(html||'').matchAll(/<meta\b[^>]*>/gi)){
    const tag=m[0];
    const prop=(tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)||[])[1]||'';
    if(prop.toLowerCase()!==String(name).toLowerCase())continue;
    return autoOfferDecode((tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)||[])[1]||'');
  }
  return '';
}
function autoOfferPrice(value,currency){
  const v=autoOfferDecode(value);
  if(!v)return '';
  if(/^R\$\s*\d/i.test(v))return v.replace(/\s+/g,' ').trim();
  if(String(currency||'').toUpperCase()==='BRL' && /^\d+(?:[.,]\d{1,2})?$/.test(v))return 'R$ '+v.replace('.',',');
  return '';
}
function autoOfferJsonLd(html){
  const blocks=[];
  for(const m of String(html||'').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))blocks.push(m[1]);
  const visit=(v)=>{
    if(!v||typeof v!=='object')return null;
    if(Array.isArray(v)){for(const x of v){const r=visit(x);if(r)return r;}return null;}
    const types=Array.isArray(v['@type'])?v['@type']:[v['@type']];
    if(types.some(t=>/^(product|offer)$/i.test(String(t))))return v;
    for(const x of Object.values(v)){const r=visit(x);if(r)return r;}
    return null;
  };
  for(const raw of blocks){try{const value=JSON.parse(raw.trim());const found=visit(value);if(found)return found;}catch{}}
  return null;
}
function autoOfferNumber(value){
  const v=autoOfferDecode(value).replace(/\s/g,'');
  if(!v)return NaN;
  const cleaned=v.replace(/[^0-9,.-]/g,'');
  if(!cleaned)return NaN;
  const comma=cleaned.lastIndexOf(',');
  const dot=cleaned.lastIndexOf('.');
  let normalized=cleaned;
  if(comma>=0 && dot>=0) normalized=comma>dot ? cleaned.replace(/\\./g,'').replace(',','.') : cleaned.replace(/,/g,'');
  else if(comma>=0) normalized=cleaned.replace(',','.');
  else if((cleaned.match(/\./g)||[]).length>1) normalized=cleaned.replace(/\./g,'');
  const n=Number(normalized);
  return Number.isFinite(n)?n:NaN;
}
function autoOfferFormatBRL(value,currency='BRL'){
  const n=typeof value==='number'?value:autoOfferNumber(value);
  if(!Number.isFinite(n))return '';
  if(String(currency||'BRL').toUpperCase()!=='BRL')return String(n);
  return 'R$ '+n.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function autoOfferCollectPriceValues(html,product,offers){
  const values=[];
  const add=(value,kind)=>{
    const n=autoOfferNumber(value);
    if(Number.isFinite(n) && n>=0)values.push({value:n,kind});
  };
  const walk=(obj,depth=0)=>{
    if(!obj || depth>5 || typeof obj!=='object')return;
    if(Array.isArray(obj)){obj.slice(0,20).forEach(x=>walk(x,depth+1));return;}
    for(const [key,value] of Object.entries(obj)){
      const k=String(key).toLowerCase();
      if(typeof value==='string'||typeof value==='number'){
        if(/^(price|lowprice|highprice|saleprice|currentprice|sellingprice|finalprice|priceamount|amount)$/.test(k)) add(value,k);
        if(/^(oldprice|originalprice|listprice|regularprice|compareatprice|wasprice|baseprice)$/.test(k)) add(value,'original');
      }else if(value && typeof value==='object') walk(value,depth+1);
    }
  };
  walk(product); walk(offers);
  const metaNames=[
    ['product:price:amount','current'],['og:price:amount','current'],
    ['product:sale_price:amount','current'],['sale_price','current'],
    ['product:original_price:amount','original'],['original_price','original'],
    ['product:list_price:amount','original'],['list_price','original']
  ];
  for(const [name,kind] of metaNames){
    const value=autoOfferMeta(html,name);
    if(value)add(value,kind);
  }
  return values;
}
function autoOfferDiscount(html,product,offers,priceInfo){
  for(const n of ['product:discount_percentage','discount_percentage','discount','sale_discount','discount_percent']){
    const v=autoOfferMeta(html,n);
    if(v && /%/.test(v))return v.trim();
  }
  const candidates=[product?.discount,offers?.discount,offers?.discountPercentage,product?.discountPercentage];
  for(const v of candidates){if(v!==undefined && v!==null && /%/.test(String(v)))return String(v).trim();}
  const current=Number(priceInfo?.current);
  const original=Number(priceInfo?.original);
  if(Number.isFinite(current)&&Number.isFinite(original)&&original>current&&original>0){
    const pct=Math.round((1-current/original)*100);
    if(pct>0&&pct<100)return pct+'% OFF';
  }
  return '';
}
function autoOfferPriceInfo(html,product,offers,currency){
  const values=autoOfferCollectPriceValues(html,product,offers);
  const currentCandidates=values.filter(x=>x.kind!=='original').map(x=>x.value).filter(Number.isFinite);
  const originalCandidates=values.filter(x=>x.kind==='original').map(x=>x.value).filter(Number.isFinite);
  const current=currentCandidates.length?Math.min(...currentCandidates):NaN;
  const original=originalCandidates.length?Math.max(...originalCandidates):NaN;
  return {
    current,
    original,
    preco:autoOfferFormatBRL(current,currency) || autoOfferPrice(
      autoOfferMeta(html,'product:price:amount') || autoOfferMeta(html,'og:price:amount') || offers.price || '',currency
    ),
    precoOriginal:autoOfferFormatBRL(original,currency)
  };
}
async function extractUniversalOfferWithBrowser(url){
  let context=null;
  try{
    await assertSafeExternalUrl(url);
    const browser=await getRegulosBrowser();
    context=await browser.newContext({
      userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154 Safari/537.36',
      locale:'pt-BR',
      viewport:{width:1365,height:900},
      javaScriptEnabled:true,
      ignoreHTTPSErrors:true
    });
    const page=await context.newPage();

    const sourceUrl=String(url||'').trim();
    const sourceHost=new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./,'');
    const isShopee=/^(?:shopee\.com\.br|shopee\.com)$/i.test(sourceHost);
    const sourcePath=new URL(sourceUrl).pathname;

    // A URL da Shopee normalmente carrega o shopId/itemId no formato
    // /nome-do-produto-i.SHOP_ID.ITEM_ID ou /product/SHOP_ID/ITEM_ID.
    // Guardamos esses IDs para não aceitar a homepage como se fosse o produto.
    let expectedItemId='';
    if(isShopee){
      expectedItemId=
        (sourcePath.match(/(?:^|[/-])i\.\d+\.(\d+)(?:[/?]|$)/i)||[])[1] ||
        (sourcePath.match(/\/product\/\d+\/(\d+)/i)||[])[1] ||
        (new URL(sourceUrl).searchParams.get('itemId')||new URL(sourceUrl).searchParams.get('item_id')||'');
    }

    await page.goto(sourceUrl,{waitUntil:'domcontentloaded',timeout:35000});
    await page.waitForTimeout(5500);

    const data=await page.evaluate(({isShopee,expectedItemId})=>{
      const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
      const prices=[];
      const addPrice=v=>{
        const s=String(v||'').replace(/\s+/g,' ');
        const matches=s.match(/R\$\s*([0-9.]+(?:,[0-9]{2})?)/g)||[];
        for(const m of matches){
          const n=Number(m.replace(/[^0-9,]/g,'').replace(/\./g,'').replace(',','.'));
          if(Number.isFinite(n)&&n>0&&n<100000000) prices.push(n);
        }
      };

      const titleCandidates=[];
      const addTitle=v=>{
        const s=clean(v);
        if(s&&s.length>=4&&!titleCandidates.includes(s)) titleCandidates.push(s);
      };

      const imageCandidates=[];
      const addImage=v=>{
        const s=clean(v);
        if(/^https?:\/\//i.test(s)&&!imageCandidates.includes(s)) imageCandidates.push(s);
      };

      // Primeiro procura dados estruturados/embutidos, que são mais confiáveis
      // do que varrer todo o body da página.
      const structured=[];
      const addStructured=(value)=>{
        if(value===null||value===undefined)return;
        if(typeof value==='object') structured.push(value);
        else if(typeof value==='string' && value.length>20){
          try{
            const parsed=JSON.parse(value);
            if(parsed && typeof parsed==='object') structured.push(parsed);
          }catch{}
        }
      };
      document.querySelectorAll('script[type="application/ld+json"],script#__NEXT_DATA__,script').forEach(el=>{
        const raw=el.textContent||'';
        if(/product|item_id|itemId|shopid|shopId|price_before_discount|priceBeforeDiscount|model_price/i.test(raw)){
          addStructured(raw);
        }
      });

      const walk=(obj,depth=0)=>{
        if(!obj||depth>7||typeof obj!=='object')return;
        if(Array.isArray(obj)){obj.slice(0,100).forEach(x=>walk(x,depth+1));return;}
        const keys=Object.keys(obj);
        const item=String(obj.itemid??obj.itemId??obj.item_id??'');
        const title=String(obj.name??obj.title??obj.productName??'');
        const priceRaw=obj.price??obj.priceMin??obj.minPrice??obj.currentPrice??obj.salePrice;
        const originalRaw=obj.price_before_discount??obj.priceBeforeDiscount??obj.originalPrice??obj.listPrice;
        if(item && (!expectedItemId || item===expectedItemId)){
          if(title) addTitle(title);
          addPrice(typeof priceRaw==='number'?('R$ '+(priceRaw/100000).toFixed(2).replace('.',',')):priceRaw);
          addPrice(typeof originalRaw==='number'?('R$ '+(originalRaw/100000).toFixed(2).replace('.',',')):originalRaw);
          const imgs=obj.images??obj.image??obj.imageUrl??obj.image_url;
          if(Array.isArray(imgs)) imgs.slice(0,10).forEach(addImage);
          else addImage(imgs);
        }
        for(const v of Object.values(obj)) if(v&&typeof v==='object') walk(v,depth+1);
      };
      structured.forEach(x=>walk(x));

      document.querySelectorAll('h1,[data-testid*="title"],[class*="product"][class*="title"],[class*="Product"][class*="Title"],meta[property="og:title"],meta[name="twitter:title"]').forEach(el=>{
        addTitle(el.getAttribute?.('content')||el.textContent);
      });

      const priceSelectors=[
        'meta[property="product:price:amount"]','meta[property="og:price:amount"]',
        '[data-testid*="price"]','[class*="product"][class*="price"]','[class*="Product"][class*="Price"]',
        '[class*="sale"][class*="price"]','[class*="Sale"][class*="Price"]'
      ];
      for(const sel of priceSelectors){
        try{document.querySelectorAll(sel).forEach(el=>addPrice(el.getAttribute?.('content')||el.textContent));}catch{}
      }

      const discountTexts=[];
      document.querySelectorAll('[class*="discount"],[class*="Discount"],[data-testid*="discount"],[class*="percent"],[class*="Percent"]').forEach(el=>{
        const s=clean(el.textContent);
        if(s) discountTexts.push(s);
      });
      const allDiscount=(discountTexts.join(' ').match(/(?:-|off|desconto)?\s*(\d{1,3})\s*%/i)||[]);

      document.querySelectorAll('meta[property="og:image"],meta[property="og:image:url"],meta[name="twitter:image"]').forEach(el=>{
        addImage(el.getAttribute?.('content'));
      });
      // Só aceita imagens <img> quando aparentam pertencer ao conteúdo do produto.
      document.querySelectorAll('main img,[role="main"] img,[class*="product"] img,[class*="Product"] img').forEach(el=>{
        addImage(el.currentSrc||el.src);
      });

      const body=clean(document.body?.innerText||'').slice(0,50000);
      const finalUrl=location.href;
      const finalPath=location.pathname;
      const looksLikeShopeeProduct=isShopee && (
        /\/product\/\d+\/\d+/i.test(finalPath) ||
        /(?:^|[/-])i\.\d+\.\d+(?:[/?]|$)/i.test(finalPath) ||
        (expectedItemId && body.includes(expectedItemId))
      );

      return {
        finalUrl,
        finalPath,
        looksLikeShopeeProduct,
        titulo:titleCandidates.find(x=>!/^shopee(?: brasil)?(?:\s*\|.*)?$/i.test(x)&&!/^mercado livre(?:\s*\|.*)?$/i.test(x)&&!/^amazon(?:\s*\|.*)?$/i.test(x))||'',
        prices:[...new Set(prices)].sort((a,b)=>a-b),
        imagens:imageCandidates,
        desconto:allDiscount[1]?allDiscount[1]+'%':'',
        bodyText:body
      };
    },{isShopee,expectedItemId});

    // Se a Shopee mandou o navegador para a home, nunca devolvemos
    // título/logo/preço da home como se fossem dados do produto.
    if(isShopee && expectedItemId && !data.looksLikeShopeeProduct){
      return {
        titulo:'',
        preco:'',
        precoOriginal:'',
        desconto:'',
        imagemUrl:'',
        finalUrl:data.finalUrl||sourceUrl,
        fonte:'navegador-bloqueado',
        aviso:'A Shopee redirecionou ou bloqueou a página do produto para este servidor. Nenhum dado da homepage foi usado.'
      };
    }

    const prices=Array.isArray(data.prices)?data.prices.filter(Number.isFinite):[];
    let preco='';
    let precoOriginal='';
    if(prices.length===1) preco=prices[0];
    else if(prices.length>1){
      preco=Math.min(...prices);
      precoOriginal=Math.max(...prices);
    }

    let desconto=String(data.desconto||'');
    if(!desconto && preco && precoOriginal && precoOriginal>preco){
      desconto=Math.round((1-(preco/precoOriginal))*100)+'%';
    }

    let imagemUrl=Array.isArray(data.imagens)?data.imagens.find(x=>{
      const s=String(x||'').toLowerCase();
      return s && !/logo|icon|sprite|favicon|shopee\.com\.br\/.*logo/i.test(s);
    })||'':'';

    if(!imagemUrl){
      try{
        const browserImage=await findProductImageWithBrowser(data.finalUrl||sourceUrl);
        if(browserImage?.url) imagemUrl=browserImage.url;
      }catch{}
    }

    return {
      titulo:String(data.titulo||'').trim(),
      preco:preco?autoOfferFormatBRL(preco,'BRL'):'',
      precoOriginal:precoOriginal?autoOfferFormatBRL(precoOriginal,'BRL'):'',
      desconto,
      imagemUrl,
      finalUrl:data.finalUrl||sourceUrl,
      fonte:'navegador',
      ...(data.aviso?{aviso:data.aviso}:{})
    };
  }finally{
    if(context) await context.close().catch(()=>{});
  }
}
async function buildAutomaticOffer(url){
  try{
    const host=new URL(url).hostname.toLowerCase().replace(/^www\\./,'');
    if(/(?:^|\\.)(?:mercadolivre\\.com\\.br|meli\\.la)$/i.test(host)){
      try{
        const mlOffer=await getMercadoLivreOfferInfo(url);
        if(mlOffer?.titulo || mlOffer?.preco || mlOffer?.precoOriginal || mlOffer?.imagemUrl){
          return mlOffer;
        }
      }catch(e){
        addLog('Mercado Livre API oferta: '+e.message);
      }
    }
    if(isShopeeHost(host) && shopeeIntegration.publicStatus().connected){
      try{
        const apiOffer=await shopeeIntegration.getProductByUrl(url);
        if(apiOffer?.titulo || apiOffer?.preco || apiOffer?.imagemUrl){
          return apiOffer;
        }
      }catch(e){
        addLog('Shopee API: '+e.message);
      }
    }
  }catch{}
  const page=await fetchText(url);
  const html=String(page.data||'');
  const product=autoOfferJsonLd(html);
  const offers=product?.offers && (Array.isArray(product.offers)?product.offers[0]:product.offers) || {};
  const titulo=autoOfferDecode(autoOfferMeta(html,'og:title') || autoOfferMeta(html,'twitter:title') || product?.name || '');
  const currency=autoOfferMeta(html,'product:price:currency') || autoOfferMeta(html,'og:price:currency') || offers.priceCurrency || 'BRL';
  const priceInfo=autoOfferPriceInfo(html,product,offers,currency);
  const preco=priceInfo.preco;
  const precoOriginal=priceInfo.precoOriginal;
  const desconto=autoOfferDiscount(html,product,offers,priceInfo);
  let imagem=autoOfferMeta(html,'og:image') || autoOfferMeta(html,'twitter:image') || product?.image || '';
  if(Array.isArray(imagem))imagem=imagem[0]||'';
  if(imagem && !/^https?:\/\//i.test(imagem))imagem='';
  if(!imagem && typeof findMercadoLivreImageUrl==='function')imagem=await findMercadoLivreImageUrl(url).catch(()=> '');

  const base={
    titulo,preco,precoOriginal,desconto,imagemUrl:imagem,finalUrl:page.finalUrl||url
  };

  const missingTitle=!String(base.titulo||'').trim();
  const missingPrice=!String(base.preco||'').trim();
  const missingImage=!String(base.imagemUrl||'').trim();

  if(missingTitle || missingPrice || !base.desconto || missingImage){
    try{
      const browser=await extractUniversalOfferWithBrowser(url);
      return {
        titulo:browser.titulo||base.titulo,
        preco:browser.preco||base.preco,
        precoOriginal:browser.precoOriginal||base.precoOriginal,
        desconto:browser.desconto||base.desconto,
        imagemUrl:browser.imagemUrl||base.imagemUrl,
        finalUrl:browser.finalUrl||base.finalUrl,
        fonte:browser.fonte||'navegador'
      };
    }catch(e){
      addLog('Extrator universal navegador: '+e.message);
    }
  }

  return {...base,fonte:'html'};
}

app.get('/api/oferta-preview', requireAuth, async (req,res)=>{
  const url=String(req.query?.url||'').trim();
  if(!url)return res.status(400).json({ok:false,msg:'Informe o link do produto.'});
  if(!/^https?:\/\//i.test(url))return res.status(400).json({ok:false,msg:'O link deve começar com http:// ou https://.'});
  try{
    const oferta=await buildAutomaticOffer(url);
    res.set('Cache-Control','no-store');
    res.json({ok:true,...oferta});
  }catch(e){res.status(502).json({ok:false,msg:e.message||'Não foi possível consultar o link.'});}
});

app.use(requireAuth);

// Arquivos estáticos do painel (JS/CSS/imagens) são servidos somente após autenticação.
// Sem este middleware, o fallback "*" abaixo devolve index.html para arquivos .js,
// fazendo o navegador bloquear os scripts por MIME type text/html.
app.use(express.static(PUBLIC, { index: false }));

app.post('/api/auth/change-password',requireAuth,requireAdmin,(req,res)=>{
  const senhaAtual=String(req.body?.senhaAtual||'');
  const novaSenha=String(req.body?.novaSenha||'');
  const confirmarSenha=String(req.body?.confirmarSenha||'');
  if(!senhaAtual || !novaSenha || !confirmarSenha)
    return res.status(400).json({ok:false,msg:'Preencha a senha atual, a nova senha e a confirmação.'});
  if(novaSenha.length<6)
    return res.status(400).json({ok:false,msg:'A nova senha deve ter pelo menos 6 caracteres.'});
  if(novaSenha!==confirmarSenha)
    return res.status(400).json({ok:false,msg:'A confirmação da nova senha não confere.'});
  const users=readUsers();
  const user=users.find(x=>x.id===req.user.id);
  if(!user || !verifyPassword(senhaAtual,user))
    return res.status(401).json({ok:false,msg:'A senha atual está incorreta.'});
  const salt=crypto.randomBytes(16).toString('hex');
  user.salt=salt;
  user.hash=hashPassword(novaSenha,salt);
  users.splice(users.findIndex(x=>x.id===user.id),1,user);
  saveUsers(users);
  const sessions=readSessions();
  for(const [token,session] of Object.entries(sessions)){
    if(session?.userId===user.id) delete sessions[token];
  }
  saveSessions(sessions);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',`regulos_session=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
  res.json({ok:true,msg:'Senha do administrador alterada. Faça login novamente com a nova senha.'});
});

app.get('/api/usuarios',(req,res)=>{
  const usuarios=readUsers().map(u=>({...sanitizeUser(u),online:userHasActiveSession(u.id)}));
  res.json({ok:true,usuarios});
});
app.post('/api/usuarios',requireAdmin,(req,res)=>{
  const currentUsers=readUsers();
  if(currentUsers.length >= 20) return res.status(409).json({ok:false,msg:'O RegulOS permite no máximo 20 usuários.'});
  const usuario=String(req.body?.usuario||'').trim().toLowerCase();
  const senha=String(req.body?.senha||'');
  if(usuario.length<3||senha.length<6)return res.status(400).json({ok:false,msg:'Nome de usuário e senha são obrigatórios (senha mínima de 6 caracteres).'});
  const users=readUsers(); if(users.some(x=>x.usuario===usuario))return res.status(409).json({ok:false,msg:'Esse usuário já existe.'});
  const salt=crypto.randomBytes(16).toString('hex');
  const u={id:crypto.randomUUID(),nome:usuario,usuario,salt,hash:hashPassword(senha,salt),admin:false,criadoEm:new Date().toISOString()};
  users.push(u);saveUsers(users);res.json({ok:true,usuario:sanitizeUser(u)});
});
app.delete('/api/usuarios/:id',requireAdmin,(req,res)=>{
  const users=readUsers(); const target=users.find(x=>x.id===req.params.id);
  if(!target)return res.status(404).json({ok:false,msg:'Usuário não encontrado.'});
  if(target.id===req.user.id)return res.status(400).json({ok:false,msg:'A conta administradora atual não pode ser excluída por ela mesma.'});
  saveUsers(users.filter(x=>x.id!==target.id)); const sessions=readSessions(); for(const [k,v] of Object.entries(sessions))if(v.userId===target.id)delete sessions[k];saveSessions(sessions);res.json({ok:true,msg:'Usuário excluído.'});
});


let sock = null;
let qr = null;
let status = 'Iniciando...';
let online = false;
let groups = [];
let logs = [];
let connectedNumber = '';
let starting = false;
let stopping = false;
let manualDisconnected = false;
let reconnectTimer = null;
let scheduleTimer = null;
let linkScheduleTimer = null;
let lastGroupRefreshAt = 0;
let lastGroupAttemptAt = 0;
let groupRefreshInFlight = null;
let groupRateLimitUntil = 0;
let groupRateLimitLevel = 0;

function groupRefreshBackoffMs(level) {
  // Em caso de rate-limit, aumenta gradualmente o intervalo entre tentativas.
  return Math.min(5 * 60 * 1000, Math.max(30 * 1000, (2 ** Math.max(0, level - 1)) * 30 * 1000));
}

function isGroupRateLimitError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('rate-overlimit') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value;
  } catch (e) {
    addLog(`Erro lendo ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function addLog(message) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${message}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
}
function normalizePhone(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}
function formatPhone(phone) {
  const n = normalizePhone(phone);
  if (!n) return '';
  if (n.length === 13 && n.startsWith('55')) return `+${n.slice(0,2)} (${n.slice(2,4)}) ${n.slice(4,9)}-${n.slice(9)}`;
  if (n.length === 12 && n.startsWith('55')) return `+${n.slice(0,2)} (${n.slice(2,4)}) ${n.slice(4,8)}-${n.slice(8)}`;
  return `+${n}`;
}
function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
function getGroupConfig(id) {
  const cfg = groupConfig[id] ||= { ativo: false, apelido: '' };
  return cfg;
}
function saveGroupsConfig() { writeJson(FILES.groupConfig, groupConfig); }
function saveHistory() {
  history = history.slice(-2000);
  writeJson(FILES.history, history);
}

const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_RETRY_DELAYS_MS = [1000, 2000];

function deliveryId(item, occurrence, groupId) {
  return crypto.createHash('sha256')
    .update([String(item?.id || ''), String(occurrence || ''), String(groupId || '')].join('|'))
    .digest('hex')
    .slice(0, 32);
}

function deliveryGroupName(item, groupId) {
  return String(
    item?.grupoNomes?.[String(groupId)] ||
    (String(item?.grupoNome || '').trim() && String(item?.grupoNome || '').trim() !== '1 grupos' ? item.grupoNome : '') ||
    groupId ||
    ''
  ).trim();
}

function getLinkDelivery(item, occurrence, groupId) {
  const id = deliveryId(item, occurrence, groupId);
  return linkDeliveries.find(x => String(x?.id || '') === id) || null;
}

function saveLinkDeliveries() {
  // Mantemos uma janela razoável para evitar crescimento ilimitado do JSON.
  linkDeliveries = linkDeliveries.slice(-5000);
  writeJson(FILES.deliveries, linkDeliveries);
}

function ensureLinkDeliveries(item, occurrence, groupIds) {
  const ids = [...new Set((Array.isArray(groupIds) ? groupIds : []).map(String).filter(Boolean))];
  let changed = false;

  for (const groupId of ids) {
    const id = deliveryId(item, occurrence, groupId);
    if (linkDeliveries.some(x => String(x?.id || '') === id)) continue;

    linkDeliveries.push({
      id,
      agendamentoId: String(item?.id || ''),
      ocorrencia: String(occurrence || ''),
      grupoId: String(groupId),
      grupoNome: deliveryGroupName(item, groupId),
      status: 'PENDENTE',
      criadoEm: new Date().toISOString(),
      iniciadoEm: '',
      concluidoEm: '',
      erro: '',
      tentativas: 0
    });
    changed = true;
  }

  if (changed) saveLinkDeliveries();
  return changed;
}

function setLinkDeliveryStatus(item, occurrence, groupId, status, errorMessage = '') {
  const id = deliveryId(item, occurrence, groupId);
  let delivery = linkDeliveries.find(x => String(x?.id || '') === id);

  if (!delivery) {
    ensureLinkDeliveries(item, occurrence, [groupId]);
    delivery = linkDeliveries.find(x => String(x?.id || '') === id);
  }
  if (!delivery) return null;

  const now = new Date().toISOString();
  delivery.status = status;
  delivery.erro = status === 'ERRO' ? String(errorMessage || 'Falha no envio.') : '';

  if (status === 'ENVIANDO') {
    delivery.iniciadoEm = now;
    delivery.concluidoEm = '';
    delivery.tentativas = Number(delivery.tentativas || 0) + 1;
  } else if (status === 'SUCESSO' || status === 'ERRO') {
    delivery.concluidoEm = now;
  }

  saveLinkDeliveries();
  return delivery;
}

function setExistingLinkDeliveryStatus(delivery, status, errorMessage = '', occurrenceLabel = '') {
  if (!delivery) return null;
  const now = new Date().toISOString();
  delivery.status = status;
  if (occurrenceLabel) delivery.ocorrencia = String(occurrenceLabel);
  delivery.erro = status === 'ERRO' ? String(errorMessage || 'Falha no envio.') : '';
  if (status === 'ENVIANDO') {
    delivery.iniciadoEm = now;
    delivery.concluidoEm = '';
    delivery.tentativas = Number(delivery.tentativas || 0) + 1;
  } else if (status === 'SUCESSO' || status === 'ERRO') {
    delivery.concluidoEm = now;
  }
  saveLinkDeliveries();
  return delivery;
}

function addHistory(item) {
  history.push({ at: new Date().toISOString(), ...item });
  saveHistory();
}
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function timeToMinutes(v) {
  const [h,m] = String(v || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
function botWindowActive(now = new Date()) {
  if (!botSchedule.ativo) return true;
  const start = timeToMinutes(botSchedule.inicio);
  const stop = timeToMinutes(botSchedule.fim);
  // Programação ativa sem horários definidos nunca libera os envios.
  if (start == null || stop == null) return false;
  const cur = now.getHours()*60 + now.getMinutes();
  if (start === stop) return true;
  return start < stop ? cur >= start && cur < stop : cur >= start || cur < stop;
}
function botWindowLabel(now = new Date()) {
  if (!botSchedule.ativo) return 'programação desligada';
  return botWindowActive(now) ? 'dentro do horário' : 'fora do horário';
}

let links = Array.isArray(readJson(FILES.links, [])) ? readJson(FILES.links, []) : [];
let allowed = Array.isArray(readJson(FILES.groups, [])) ? readJson(FILES.groups, []) : [];
let groupConfig = readJson(FILES.groupConfig, {});
if (!groupConfig || typeof groupConfig !== 'object' || Array.isArray(groupConfig)) groupConfig = {};
let history = Array.isArray(readJson(FILES.history, [])) ? readJson(FILES.history, []) : [];
let linkSchedules = Array.isArray(readJson(FILES.schedules, [])) ? readJson(FILES.schedules, []) : [];
let linkHistory = Array.isArray(readJson(FILES.linkHistory, [])) ? readJson(FILES.linkHistory, []) : [];
let linkFailures = Array.isArray(readJson(FILES.linkFailures, [])) ? readJson(FILES.linkFailures, []) : [];
let linkDeliveries = Array.isArray(readJson(FILES.deliveries, [])) ? readJson(FILES.deliveries, []) : [];

const LINK_FAILURE_MAX_WINDOW_MS = 10 * 60 * 60 * 1000;
const linkFailureExpirationTimers = new Map();

function linkFailureRecordedAt(item){
  const values=[item?.atualizadoEm,item?.criadoEm].map(v=>Date.parse(String(v||''))).filter(Number.isFinite);
  return values.length ? Math.max(...values) : NaN;
}

function cancelLinkFailureExpiration(item){
  const timer=linkFailureExpirationTimers.get(item);
  if(timer){
    clearTimeout(timer);
    linkFailureExpirationTimers.delete(item);
  }
}

function expireLinkFailureRecord(item){
  linkFailureExpirationTimers.delete(item);
  const index=linkFailures.findIndex(x=>x===item);
  if(index<0)return false;

  linkFailures.splice(index,1);
  writeJson(FILES.linkFailures,linkFailures);
  addLog(`Limpeza automática das falhas: ${item.nome||item.id||'registro'} removido após 10h da última falha registrada.`);
  return true;
}

function scheduleLinkFailureExpiration(item){
  cancelLinkFailureExpiration(item);
  const failedAt=linkFailureRecordedAt(item);
  if(!Number.isFinite(failedAt))return;

  const expiresAt=failedAt+LINK_FAILURE_MAX_WINDOW_MS;
  const delay=Math.max(0,expiresAt-Date.now());
  const timer=setTimeout(()=>expireLinkFailureRecord(item),delay);
  if(typeof timer.unref==='function')timer.unref();
  linkFailureExpirationTimers.set(item,timer);
}

function pruneLinkFailuresByLatestFailureTime({persist=true}={}){
  if(!Array.isArray(linkFailures) || !linkFailures.length)return 0;

  const now=Date.now();
  const cutoff=now-LINK_FAILURE_MAX_WINDOW_MS;
  const before=linkFailures.length;
  const previous=linkFailures;

  linkFailures=linkFailures.filter(item=>{
    const failedAt=linkFailureRecordedAt(item);
    return !Number.isFinite(failedAt) || failedAt>=cutoff;
  });

  const kept=new Set(linkFailures);
  previous.forEach(item=>{
    if(!kept.has(item))cancelLinkFailureExpiration(item);
  });

  const removed=before-linkFailures.length;
  if(removed && persist)writeJson(FILES.linkFailures,linkFailures);
  if(removed)addLog(`Limpeza automática das falhas: ${removed} registro(s) com mais de 10h desde a última falha foram removidos.`);
  return removed;
}

function saveLinkFailures() {
  linkFailures = linkFailures.slice(-500);
  pruneLinkFailuresByLatestFailureTime({persist:false});
  linkFailures.forEach(scheduleLinkFailureExpiration);
  writeJson(FILES.linkFailures, linkFailures);
}

function clearLinkFailures() {
  linkFailureExpirationTimers.forEach(timer=>clearTimeout(timer));
  linkFailureExpirationTimers.clear();
  linkFailures = [];
  writeJson(FILES.linkFailures, linkFailures);
}

// Cada falha recebe seu próprio timer de expiração. Ao reiniciar o servidor,
// os timers são reconstruídos a partir do horário salvo no histórico de falhas.
pruneLinkFailuresByLatestFailureTime();
linkFailures.forEach(scheduleLinkFailureExpiration);
function upsertLinkFailure(item, grupoId, erro, extra={}) {
  const key = `${item.id}:${String(grupoId)}`;
  const record = {
    id: key, agendamentoId: item.id, grupoId: String(grupoId || ''), grupoNome: groupNameForId(grupoId) || item.grupoNomes?.[String(grupoId)] || item.grupoNome || '', nome: item.nome, url: item.url,
    mensagem: item.mensagem || '', data: item.data, horario: item.horario, repeticao: item.repeticao,
    intervaloMin: item.intervaloMin, intervaloMax: item.intervaloMax, ativo: false,
    imagemAutomatica: item.imagemAutomatica !== false, imagemUrl: item.imagemUrl || '',
    imagemStatus: item.imagemStatus || '', tituloProduto: item.tituloProduto || '',
    mensagensAleatorias: Array.isArray(item.mensagensAleatorias) ? [...item.mensagensAleatorias] : [],
    mensagemAleatoriaAtiva: item.mensagemAleatoriaAtiva === true, erro: String(erro || 'Falha no envio'),
    criadoEm: extra.criadoEm || new Date().toISOString(), atualizadoEm: new Date().toISOString()
  };
  const i = linkFailures.findIndex(x => String(x.id) === key);
  if(i >= 0){
    cancelLinkFailureExpiration(linkFailures[i]);
    linkFailures[i] = {...linkFailures[i], ...record};
  } else {
    linkFailures.unshift(record);
  }
  saveLinkFailures();
}
function removeLinkFailure(id) {
  const before = linkFailures.length;
  const removed=linkFailures.filter(x => String(x.id) === String(id));
  removed.forEach(cancelLinkFailureExpiration);
  linkFailures = linkFailures.filter(x => String(x.id) !== String(id));
  if(linkFailures.length !== before) saveLinkFailures();
}
function archiveSentFailureAsHistory(item, failure, grupoId) {
  const snapshot = {
    id: `${item.id}:${Date.now().toString(36)}`, nome: item.nome, url: item.url, mensagem: item.mensagem || '',
    tituloProduto: item.tituloProduto || '', repeticao: item.repeticao, data: item.data, horario: item.horario,
    intervaloMin: item.intervaloMin, intervaloMax: item.intervaloMax, imagemAutomatica: item.imagemAutomatica !== false,
    imagemUrl: item.imagemUrl || '', imagemStatus: item.imagemStatus || '', enviados: 1, sucessos: 1, erros: 0,
    grupoId: String(grupoId || failure?.grupoId || ''), grupoNome: groupNameForId(grupoId || failure?.grupoId) || item.grupoNome || groupNameForId(failure?.grupoId), lastRunAt: new Date().toISOString(),
    concluidoAt: new Date().toISOString(), motivo: 'reenvio realizado com sucesso'
  };
  linkHistory.unshift(snapshot); saveLinkHistory();
}
const LINK_HISTORY_MAX_WINDOW_MS = 10 * 60 * 60 * 1000;
const linkHistoryExpirationTimers = new Map();

function linkHistorySentAt(item){
  const values=[item?.lastRunAt,item?.concluidoAt,item?.at].map(v=>Date.parse(String(v||''))).filter(Number.isFinite);
  return values.length ? Math.max(...values) : NaN;
}

function cancelLinkHistoryExpiration(item){
  const timer=linkHistoryExpirationTimers.get(item);
  if(timer){
    clearTimeout(timer);
    linkHistoryExpirationTimers.delete(item);
  }
}

function expireLinkHistoryRecord(item){
  linkHistoryExpirationTimers.delete(item);
  const index=linkHistory.findIndex(x=>x===item);
  if(index<0)return false;

  linkHistory.splice(index,1);
  writeJson(FILES.linkHistory,linkHistory);
  addLog(`Limpeza automática do histórico: ${item.nome||item.id||'registro'} removido após 10h do envio.`);
  return true;
}

function scheduleLinkHistoryExpiration(item){
  cancelLinkHistoryExpiration(item);
  const sentAt=linkHistorySentAt(item);
  if(!Number.isFinite(sentAt))return;

  const expiresAt=sentAt+LINK_HISTORY_MAX_WINDOW_MS;
  const delay=Math.max(0,expiresAt-Date.now());
  const timer=setTimeout(()=>expireLinkHistoryRecord(item),delay);
  // O timer não deve impedir o processo do RegulOS de encerrar em um shutdown.
  if(typeof timer.unref==='function')timer.unref();
  linkHistoryExpirationTimers.set(item,timer);
}

function pruneLinkHistoryByLatestSentTime({persist=true}={}){
  if(!Array.isArray(linkHistory) || !linkHistory.length)return 0;

  const now=Date.now();
  const cutoff=now-LINK_HISTORY_MAX_WINDOW_MS;
  const before=linkHistory.length;
  const previous=linkHistory;

  linkHistory=linkHistory.filter(item=>{
    const sentAt=linkHistorySentAt(item);
    return !Number.isFinite(sentAt) || sentAt>=cutoff;
  });

  const kept=new Set(linkHistory);
  previous.forEach(item=>{
    if(!kept.has(item))cancelLinkHistoryExpiration(item);
  });

  const removed=before-linkHistory.length;
  if(removed && persist)writeJson(FILES.linkHistory,linkHistory);
  if(removed)addLog(`Limpeza automática do histórico: ${removed} registro(s) com mais de 10h desde o envio foram removidos.`);
  return removed;
}

function linkHistoryDuplicateFingerprint(item){
  if(item?.motivo !== 'envio concluído — uma vez') return '';
  const completedAt=Date.parse(String(item?.concluidoAt||''));
  if(!Number.isFinite(completedAt)) return '';

  // Arredondamos a conclusão para o segundo. Isso captura cópias criadas
  // pela mesma execução mesmo que o segundo registro tenha sido persistido
  // alguns milissegundos depois.
  const completedSecond=Math.floor(completedAt/1000);
  return JSON.stringify([
    String(item?.nome||'').trim().toLocaleLowerCase('pt-BR'),
    String(item?.url||'').trim(),
    String(item?.tituloProduto||'').trim().toLocaleLowerCase('pt-BR'),
    String(item?.data||'').trim(),
    String(item?.horario||'').trim(),
    String(item?.repeticao||'').trim(),
    Number(item?.enviados||0),
    Number(item?.sucessos||0),
    Number(item?.erros||0),
    Number(item?.lastDurationMs||0),
    completedSecond
  ]);
}

function normalizeLinkHistory(){
  if(!Array.isArray(linkHistory) || !linkHistory.length)return false;

  const seenOneTime=new Set();
  const seenFingerprints=new Set();
  const normalized=[];
  let changed=false;

  for(const item of linkHistory){
    // Execuções únicas usam o ID do agendamento como identidade estável.
    const oneTimeKey = item?.motivo === 'envio concluído — uma vez' && item?.id
      ? String(item.id)
      : '';

    if(oneTimeKey){
      if(seenOneTime.has(oneTimeKey)){
        changed=true;
        continue;
      }
      seenOneTime.add(oneTimeKey);
    }

    // Proteção para registros legados que foram gravados com IDs diferentes,
    // mas representam exatamente a mesma execução concluída.
    const fingerprint=linkHistoryDuplicateFingerprint(item);
    if(fingerprint){
      if(seenFingerprints.has(fingerprint)){
        changed=true;
        continue;
      }
      seenFingerprints.add(fingerprint);
    }

    normalized.push(item);
  }

  if(normalized.length !== linkHistory.length) changed=true;
  linkHistory=normalized;
  return changed;
}
function saveLinkHistory(){
  normalizeLinkHistory();
  // Os novos registros entram com unshift(), portanto os primeiros 500
  // são os mais recentes. slice(-500) mantinha justamente os mais antigos.
  linkHistory=linkHistory.slice(0,500);
  pruneLinkHistoryByLatestSentTime({persist:false});
  linkHistory.forEach(scheduleLinkHistoryExpiration);
  writeJson(FILES.linkHistory,linkHistory);
}

function clearLinkHistory(){
  linkHistoryExpirationTimers.forEach(timer=>clearTimeout(timer));
  linkHistoryExpirationTimers.clear();
  linkHistory=[];
  writeJson(FILES.linkHistory,linkHistory);
}

// Cada registro recebe seu próprio timer de expiração. Ao reiniciar o servidor,
// os timers são reconstruídos a partir do horário salvo no histórico.
const linkHistoryNormalizedAtStartup = normalizeLinkHistory();
if(linkHistoryNormalizedAtStartup) {
  writeJson(FILES.linkHistory, linkHistory);
  addLog('Limpeza automática do histórico: registro(s) duplicado(s) removido(s) na inicialização.');
}
pruneLinkHistoryByLatestSentTime();
linkHistory.forEach(scheduleLinkHistoryExpiration);

function archiveCompletedOneTimeLink(item) {
  const existingIndex = linkHistory.findIndex(x =>
    x?.motivo === 'envio concluído — uma vez' &&
    String(x?.id || '') === String(item.id || '')
  );

  const snapshot = {
    id: item.id, nome: item.nome, url: item.url, mensagem: item.mensagem || '',
    tituloProduto: item.tituloProduto || '', repeticao: item.repeticao,
    data: item.data, horario: item.horario, intervaloMin: item.intervaloMin, intervaloMax: item.intervaloMax,
    imagemAutomatica: item.imagemAutomatica !== false, imagemUrl: item.imagemUrl || '', imagemStatus: item.imagemStatus || '',
    mensagensAleatorias: Array.isArray(item.mensagensAleatorias) ? [...item.mensagensAleatorias] : [],
    mensagemAleatoriaAtiva: item.mensagemAleatoriaAtiva === true,
    enviados: Number(item.enviados || 0), sucessos: Number(item.sucessos || 0), erros: Number(item.erros || 0),
    lastRunAt: item.lastRunAt || new Date().toISOString(), lastDurationMs: Number(item.lastDurationMs || 0),
    concluidoAt: new Date().toISOString(), status: 'sucesso',
    agendamentoId: String(item.id || ''), motivo: 'envio concluído — uma vez'
  };

  // Um agendamento de execução única tem um único registro de histórico.
  // Se a rotina chegar aqui novamente, atualizamos o registro existente
  // em vez de criar outro cartão duplicado.
  if(existingIndex >= 0) linkHistory[existingIndex] = snapshot;
  else linkHistory.unshift(snapshot);
  saveLinkHistory();

  const idx = linkSchedules.findIndex(x => String(x.id) === String(item.id));
  if (idx >= 0) linkSchedules.splice(idx, 1);
  writeJson(FILES.schedules, linkSchedules);
  addLog(`Link "${item.nome}" saiu dos agendamentos e foi arquivado no histórico.`);
}
let index = Number(fs.existsSync(FILES.index) ? fs.readFileSync(FILES.index,'utf8') : 0) || 0;
let botSchedule = readJson(FILES.botSchedule, {
  ativo: false, inicio: '', fim: ''
});
if (!botSchedule || typeof botSchedule !== 'object') botSchedule = { ativo: false, inicio:'', fim:'' };
if (!Object.prototype.hasOwnProperty.call(botSchedule, 'inicio')) botSchedule.inicio = '';
if (!Object.prototype.hasOwnProperty.call(botSchedule, 'fim')) botSchedule.fim = '';
if (!Object.prototype.hasOwnProperty.call(botSchedule, 'ativo')) botSchedule.ativo = false;

let linkQueue = readJson(FILES.linkQueue, { cursor: 0, currentId: '', updatedAt: '' });
if (!linkQueue || typeof linkQueue !== 'object') linkQueue = { cursor: 0, currentId: '', updatedAt: '' };
function saveLinkQueue() { writeJson(FILES.linkQueue, linkQueue); }
function orderedLinks() {
  return linkSchedules
    .filter(x => x && x.ativo !== false)
    .slice()
    .sort((a,b) => {
      const ad = `${a.data||''}T${a.horario||''}`;
      const bd = `${b.data||''}T${b.horario||''}`;
      if (ad !== bd) return ad.localeCompare(bd);
      return String(a.createdAt||a.id).localeCompare(String(b.createdAt||b.id));
    });
}
function syncLinkQueue() {
  const ids = orderedLinks().map(x => String(x.id));
  if (!ids.length) { linkQueue.cursor = 0; linkQueue.currentId = ''; saveLinkQueue(); return; }
  if (linkQueue.currentId) {
    const idx = ids.indexOf(String(linkQueue.currentId));
    if (idx >= 0) { linkQueue.cursor = idx; return; }
  }
  linkQueue.cursor = Math.min(Math.max(Number(linkQueue.cursor)||0, 0), ids.length-1);
  linkQueue.currentId = ids[linkQueue.cursor];
  saveLinkQueue();
}

function saveBotSchedule() { writeJson(FILES.botSchedule, botSchedule); }


const RANDOM_MESSAGE_OPTIONS = [
  '🔥 Oferta do dia!',
  '🛍️ Achadinho do dia!',
  '💰 Preço especial!',
  '👀 Olha esse achado!',
  '⭐ Destaque do dia!',
  '🚨 Oferta imperdível!',
  '😍 Vale a pena conferir!',
  '💥 Aproveite essa oferta!'
];

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/gi, '"').replace(/&#34;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .trim();
}
function absoluteUrl(value, base) {
  try { return new URL(decodeHtmlEntities(value), base).href; } catch { return ''; }
}
function looksLikeImageUrl(url) {
  return /\.(?:jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i.test(url || '') || /(?:image|img|photo|product|media|cdn)/i.test(url || '');
}
function isPrivateIp(ip){
  const v=String(ip||'').toLowerCase();
  if(net.isIPv4(v)){
    const [a,b,c]=v.split('.').map(Number);
    return a===10 || a===127 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || a===0 || a>=224;
  }
  if(net.isIPv6(v)){
    const x=v.replace(/^\[|\]$/g,'');
    return x==='::1' || x==='::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  }
  return false;
}
async function assertSafeExternalUrl(value){
  let u; try { u=new URL(value); } catch { throw new Error('URL inválida'); }
  if(!['http:','https:'].includes(u.protocol)) throw new Error('Somente URLs HTTP/HTTPS são permitidas.');
  if(u.username || u.password) throw new Error('URL com credenciais não permitida.');
  if(u.port && !['80','443'].includes(u.port)) throw new Error('Porta externa não permitida.');
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIp(host)) throw new Error('Destino interno bloqueado por segurança.');
  try {
    const answers=await dns.lookup(host,{all:true,verbatim:true});
    if(!answers.length || answers.some(a=>isPrivateIp(a.address))) throw new Error('Destino interno bloqueado por segurança.');
  } catch(e){
    if(e?.message==='Destino interno bloqueado por segurança.') throw e;
    throw new Error('Não foi possível validar o domínio informado.');
  }
  return u;
}

async function fetchText(url, redirects=0) {
  return new Promise(async (resolve, reject) => {
    if (redirects > 7) return reject(new Error('Muitos redirecionamentos'));
    let parsed;
    try { parsed = await assertSafeExternalUrl(url); } catch(e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      }, timeout: 15000
    }, res => {
      const code = res.statusCode || 0;
      if ([301,302,303,307,308].includes(code) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).href;
        return fetchText(nextUrl, redirects + 1).then(resolve, reject);
      }
      if (code < 200 || code >= 400) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      const chunks=[]; let total=0;
      res.on('data', c => { total += c.length; if (total <= 5_000_000) chunks.push(c); });
      res.on('end', () => {
        if (total > 5_000_000) return reject(new Error('Página muito grande'));
        const raw=Buffer.concat(chunks);
        const enc=String(res.headers['content-encoding']||'').toLowerCase();
        const finish=(err, buf)=>{
          if(err) return reject(err);
          resolve({ data: buf.toString('utf8'), finalUrl: url, contentType: String(res.headers['content-type']||'') });
        };
        try {
          if (enc.includes('br')) return zlib.brotliDecompress(raw, finish);
          if (enc.includes('gzip')) return zlib.gunzip(raw, finish);
          if (enc.includes('deflate')) return zlib.inflate(raw, finish);
          finish(null, raw);
        } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado')));
    req.on('error', reject);
  });
}
function extractProductTitle(html) {
  const clean = value => String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/gi, '"').replace(/&#34;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
  const meta = [
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i,
    /<meta[^>]+(?:property|name)=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']twitter:title["'][^>]*>/i
  ];
  for (const re of meta) { const m = re.exec(html); if (m && clean(m[1])) return clean(m[1]); }

  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const x = stack.shift();
        if (!x || typeof x !== 'object') continue;
        if (typeof x.name === 'string' && clean(x.name)) return clean(x.name);
        if (x.item && typeof x.item === 'object') stack.push(x.item);
        for (const v of Object.values(x)) if (v && typeof v === 'object') stack.push(v);
      }
    } catch {}
  }

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title ? clean(title[1]) : '';
}

async function findProductTitle(url) {
  try {
    const page = await fetchText(url);
    const title = extractProductTitle(page.data);
    if (title) return { title, finalUrl: page.finalUrl };
    addLog(`Título do produto não encontrado para o link.`);
  } catch (e) {
    addLog(`Não foi possível ler o título do produto: ${e.message}`);
  }
  return { title: '', finalUrl: url };
}

function decodeJsonLdText(text) {
  return String(text || '')
    .replace(/<!--|-->/g, '')
    .trim();
}
function extractSrcset(value) {
  return String(value || '').split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean);
}
function extractImageCandidates(html, baseUrl) {
  const out=[];
  const seen=new Set();
  const add=(value, priority=50)=>{
    const raw=decodeHtmlEntities(String(value||'').trim());
    if(!raw || /^data:/i.test(raw) || raw.startsWith('#')) return;
    const u=absoluteUrl(raw, baseUrl);
    if(!u || !/^https?:/i.test(u) || seen.has(u)) return;
    seen.add(u); out.push({url:u, priority});
  };

  // Metadados normalmente apontam para a imagem principal do produto.
  const metaPatterns=[
    /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src)["'][^>]*>/gi
  ];
  let m;
  for(const re of metaPatterns) while((m=re.exec(html))) add(m[1], 1);

  // JSON-LD: Product.image, ImageObject.contentUrl/url/thumbnailUrl e listas.
  const ldRe=/<script[^>]+type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  while((m=ldRe.exec(html))) {
    try {
      const parsed=JSON.parse(decodeJsonLdText(m[1]));
      const walk=(x, key='')=>{
        if(!x) return;
        if(typeof x==='string') {
          if(/image|contentUrl|thumbnailUrl|url/i.test(key)) add(x, 2);
          return;
        }
        if(Array.isArray(x)) { x.forEach(v=>walk(v,key)); return; }
        if(typeof x==='object') for(const [k,v] of Object.entries(x)) walk(v,k);
      };
      walk(parsed);
    } catch {
      // Alguns sites usam JSON-LD com entidades HTML; tente localizar URLs de imagem mesmo assim.
      const rough=decodeHtmlEntities(m[1]);
      const urls=rough.match(/https?:[^"'\\s<>]+/gi)||[];
      urls.forEach(u=>add(u,4));
    }
  }

  // Imagens lazy-loaded, srcset e atributos usados por lojas modernas.
  const imgRe=/<img\b[^>]*>/gi;
  while((m=imgRe.exec(html)) && out.length<120) {
    const tag=m[0];
    const attrs=[
      'src','data-src','data-original','data-lazy-src','data-image','data-image-src',
      'data-zoom-image','data-large_image','data-fsrc','data-url','data-srcset','srcset'
    ];
    for(const attr of attrs){
      const re=new RegExp(attr + "\\s*=\\s*[\"\']([^\"\']+)[\"\']", "i");
      const mm=re.exec(tag); if(!mm) continue;
      const values=attr.toLowerCase().includes('srcset')?extractSrcset(mm[1]):[mm[1]];
      values.forEach(v=>add(v, attr==='src'?30:10));
    }
  }

  // CSS inline com background-image, comum em vitrines de e-commerce.
  const bgRe=/background-image\s*:\s*url\((?:["']?)([^)"']+)(?:["']?)\)/gi;
  while((m=bgRe.exec(html)) && out.length<150) add(m[1], 40);

  // Links de imagem e atributos genéricos usados por componentes de galeria.
  const attrRe=/(?:href|data-image-url|data-product-image|data-gallery-image)\s*=\s*["']([^"']+)["']/gi;
  while((m=attrRe.exec(html)) && out.length<180) {
    if(looksLikeImageUrl(m[1])) add(m[1], 60);
  }

  return out.sort((a,b)=>a.priority-b.priority).map(x=>x.url);
}
async function downloadBuffer(url, pageUrl='', redirects=0) {
  return new Promise(async (resolve,reject)=>{
    if(redirects>7) return reject(new Error('Muitos redirecionamentos de imagem'));
    let parsed; try{parsed=await assertSafeExternalUrl(url)}catch(e){return reject(new Error(e.message || 'URL de imagem inválida'))}
    const lib=parsed.protocol==='https:'?https:http;
    const headers={
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
      'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language':'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept-Encoding':'gzip, deflate, br',
      'Referer': pageUrl || `${parsed.protocol}//${parsed.host}/`,
      'Cache-Control':'no-cache'
    };
    const req=lib.get(parsed,{headers,timeout:18000},res=>{
      const code=res.statusCode||0;
      if([301,302,303,307,308].includes(code)&&res.headers.location){res.resume();const nextUrl=new URL(res.headers.location,url).href;return downloadBuffer(nextUrl,pageUrl||url,redirects+1).then(resolve,reject)}
      if(code<200||code>=400){res.resume();return reject(new Error(`Imagem HTTP ${code}`))}
      const type=String(res.headers['content-type']||'').split(';')[0].toLowerCase();
      const chunks=[];let total=0;
      res.on('data',c=>{total+=c.length;if(total<=10*1024*1024)chunks.push(c)});
      res.on('end',()=>{
        if(total>10*1024*1024)return reject(new Error('Imagem maior que 10 MB'));
        const raw=Buffer.concat(chunks);
        const finish=(err,buf)=>{
          if(err)return reject(err);
          const mime=type.startsWith('image/')?type:'image/jpeg';
          if(!/^image\//i.test(mime)) return reject(new Error('Recurso não é uma imagem'));
          if(buf.length<1000)return reject(new Error('Imagem muito pequena'));
          resolve({buffer:buf,mime,url});
        };
        const enc=String(res.headers['content-encoding']||'').toLowerCase();
        try {
          if(enc.includes('br')) return zlib.brotliDecompress(raw,finish);
          if(enc.includes('gzip')) return zlib.gunzip(raw,finish);
          if(enc.includes('deflate')) return zlib.inflate(raw,finish);
          finish(null,raw);
        } catch(e){reject(e)}
      });
    });
    req.on('timeout',()=>req.destroy(new Error('Tempo esgotado ao baixar imagem')));req.on('error',reject);
  });
}

// REGULOS_ML_IMAGE_FALLBACK_V1
// Links meli.la podem redirecionar para uma página sem og:image útil.
// Nesse caso usamos o item público da API do Mercado Livre para obter
// pictures[].secure_url, mantendo o link de afiliado original para o envio.
async function findMercadoLivreImageUrl(url) {
  try {
    const page = await fetchText(url);
    const source = `${page.finalUrl || ''}\n${page.data || ''}`;
    const ids = [];
    const seen = new Set();
    for (const m of source.matchAll(/\bMLB[-_]?\d{5,}\b/gi)) {
      const id = String(m[0]).toUpperCase().replace(/[-_]/g,'');
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    for (const id of ids.slice(0,3)) {
      try {
        const api = await fetchText(`https://api.mercadolibre.com/items/${id}`);
        const data = JSON.parse(api.data || '{}');
        const pictures = Array.isArray(data.pictures) ? data.pictures : [];
        for (const picture of pictures) {
          const image = picture?.secure_url || picture?.url;
          if (image && /^https?:\/\//i.test(image)) return image;
        }
        const thumb = data.secure_thumbnail || data.thumbnail;
        if (thumb && /^https?:\/\//i.test(thumb)) return thumb;
      } catch (e) {
        addLog(`Mercado Livre API sem imagem para ${id}: ${e.message}`);
      }
    }
  } catch (e) {
    addLog(`Fallback Mercado Livre: ${e.message}`);
  }
  return '';
}


// REGULOS_ML_IMAGE_FALLBACK_V3
async function findMercadoLivreImageUrl(url) {
  try {
    const page = await fetchText(url);
    const source = `${page.finalUrl || ''}\n${page.data || ''}`;
    const ids=[]; const seen=new Set();
    for (const m of source.matchAll(/\bMLB[-_]?\d{5,}\b/gi)) {
      const id=String(m[0]).toUpperCase().replace(/[-_]/g,'');
      if(!seen.has(id)){seen.add(id);ids.push(id);}
    }
    for(const id of ids.slice(0,3)){
      try{
        const api=await fetchText(`https://api.mercadolibre.com/items/${id}`);
        const data=JSON.parse(api.data||'{}');
        const pictures=Array.isArray(data.pictures)?data.pictures:[];
        for(const picture of pictures){
          const image=picture?.secure_url||picture?.url;
          if(image&&/^https?:\/\//i.test(image))return image;
        }
        const thumb=data.secure_thumbnail||data.thumbnail;
        if(thumb&&/^https?:\/\//i.test(thumb))return thumb;
      }catch(e){addLog(`Mercado Livre API sem imagem para ${id}: ${e.message}`);}
    }
  }catch(e){addLog(`Fallback Mercado Livre: ${e.message}`);}
  return '';
}


async function getMercadoLivreOfferInfo(url){
  try{
    const page=await fetchText(url);
    const source=`${page.finalUrl||''}\n${page.data||''}`;
    const ids=[]; const seen=new Set();
    for(const m of source.matchAll(/\bMLB[-_]?\d{5,}\b/gi)){
      const id=String(m[0]).toUpperCase().replace(/[-_]/g,'');
      if(!seen.has(id)){seen.add(id);ids.push(id);}
    }
    let best=null;
    for(const id of ids.slice(0,10)){
      try{
        const api=await fetchText(`https://api.mercadolibre.com/items/${id}`);
        const data=JSON.parse(api.data||'{}');
        if(!data?.id) continue;
        const price=Number(data.price);
        const original=Number(data.original_price);
        const basePrice=Number(data.base_price);
        const current=Number.isFinite(price)&&price>0?price:NaN;
        const originalValue=Number.isFinite(original)&&original>current
          ? original
          : (Number.isFinite(basePrice)&&basePrice>current ? basePrice : NaN);
        let desconto='';
        if(Number.isFinite(current)&&Number.isFinite(originalValue)&&originalValue>current){
          desconto=Math.round((1-current/originalValue)*100)+'%';
        }
        let imagem='';
        for(const picture of (Array.isArray(data.pictures)?data.pictures:[])){
          const image=picture?.secure_url||picture?.url;
          if(image&&/^https?:\/\//i.test(image)){imagem=image;break;}
        }
        if(!imagem){
          const thumb=data.secure_thumbnail||data.thumbnail;
          if(thumb&&/^https?:\/\//i.test(thumb))imagem=thumb;
        }
        const candidate={
          titulo:String(data.title||'').trim(),
          preco:Number.isFinite(current)?autoOfferFormatBRL(current,'BRL'):'',
          precoOriginal:Number.isFinite(originalValue)?autoOfferFormatBRL(originalValue,'BRL'):'',
          desconto,
          imagemUrl:imagem,
          finalUrl:page.finalUrl||url,
          fonte:'mercado-livre-api'
        };
        if(!best || candidate.preco || candidate.precoOriginal || candidate.imagemUrl) best=candidate;
        if(candidate.preco) return candidate;
      }catch(e){
        addLog(`Mercado Livre API sem dados para ${id}: ${e.message}`);
      }
    }
    // Fallback isolado: quando a API de /items não entrega preço,
    // primeiro tenta os dados embutidos no HTML e só depois abre o navegador.
    if(best && !best.preco){
      try{
        const html=String(page.data||'');
        const currentValues=[]; const originalValues=[];
        const addNumber=(arr,v)=>{
          const s=String(v??'').replace(/[^0-9,.-]/g,'');
          if(!s)return;
          const comma=s.lastIndexOf(','); const dot=s.lastIndexOf('.');
          let n=s;
          if(comma>=0&&dot>=0)n=comma>dot?s.replace(/\\./g,'').replace(',','.') : s.replace(/,/g,'');
          else if(comma>=0)n=s.replace(',','.');
          else if((s.match(/\\./g)||[]).length>1)n=s.replace(/\\./g,'');
          const x=Number(n);
          if(Number.isFinite(x)&&x>0&&x<100000000)arr.push(x);
        };
        const collect=(regex,arr)=>{for(const m of html.matchAll(regex))addNumber(arr,m[1]);};
        collect(/["'](?:price|current_price|sale_price|final_price|selling_price)["']\\s*[:=]\\s*["']?([0-9]+(?:[.,][0-9]+)?)/gi,currentValues);
        collect(/["'](?:original_price|old_price|list_price|regular_price|base_price|price_before_discount)["']\\s*[:=]\\s*["']?([0-9]+(?:[.,][0-9]+)?)/gi,originalValues);
        collect(/(?:product:price:amount|og:price:amount)["']?\\s*content=["']([0-9]+(?:[.,][0-9]+)?)/gi,currentValues);
        collect(/(?:product:original_price:amount|product:list_price:amount|original_price)["']?\\s*content=["']([0-9]+(?:[.,][0-9]+)?)/gi,originalValues);

        const visible=html.match(/R\\$\\s*[0-9.]+(?:,[0-9]{2})?/g)||[];
        for(const value of visible.slice(0,80))addNumber(currentValues,value);

        const discountPct=Number(String(best.desconto||'').replace(/[^0-9]/g,''));
        let current=currentValues.length?Math.min(...currentValues):NaN;
        let original=originalValues.length?Math.max(...originalValues):NaN;

        // Se o HTML trouxe apenas uma das pontas, usa o desconto já encontrado
        // para encontrar/derivar o par correto (ex.: 60% = R$49,99 -> R$19,94).
        if(Number.isFinite(discountPct)&&discountPct>0&&discountPct<100){
          if(Number.isFinite(original)){
            const derived=original*(1-discountPct/100);
            if(!Number.isFinite(current)||Math.abs(current-derived)>0.05)current=derived;
          }else if(Number.isFinite(current)){
            const derived=current/(1-discountPct/100);
            original=derived;
          }
        }

        if(Number.isFinite(current)){
          best.preco=autoOfferFormatBRL(current,'BRL');
          if(Number.isFinite(original)&&original>current)best.precoOriginal=autoOfferFormatBRL(original,'BRL');
          best.fonte='mercado-livre-html';
        }
      }catch(e){
        addLog('Mercado Livre fallback HTML ignorado: '+e.message);
      }
    }

    // Último recurso: consulta somente a página final pelo navegador.
    if(best && !best.preco){
      try{
        const browserOffer=await getMercadoLivreBrowserPriceInfo(page.finalUrl||url);
        if(browserOffer){
          best={
            ...best,
            preco:browserOffer.preco||best.preco,
            precoOriginal:browserOffer.precoOriginal||best.precoOriginal,
            desconto:browserOffer.desconto||best.desconto,
            titulo:browserOffer.titulo||best.titulo,
            imagemUrl:browserOffer.imagemUrl||best.imagemUrl,
            finalUrl:browserOffer.finalUrl||best.finalUrl,
            fonte:'mercado-livre-api+browser'
          };
        }
      }catch(e){
        addLog(`Mercado Livre fallback de preço ignorado: ${e.message}`);
      }
    }
    return best;
  }catch(e){
    addLog(`Mercado Livre oferta: ${e.message}`);
  }
  return null;
}

async function getMercadoLivreBrowserPriceInfo(url){
  let context=null;
  try{
    await assertSafeExternalUrl(url);
    const browser=await getRegulosBrowser();
    context=await browser.newContext({
      userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
      locale:'pt-BR',
      viewport:{width:1365,height:900},
      javaScriptEnabled:true,
      ignoreHTTPSErrors:true
    });
    const page=await context.newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});
    await page.waitForTimeout(3000);

    const data=await page.evaluate(()=>{
      const clean=v=>String(v??'').replace(/\s+/g,' ').trim();
      const parseMoney=v=>{
        const s=clean(v).replace(/[^0-9,.-]/g,'');
        if(!s)return NaN;
        const lastComma=s.lastIndexOf(',');
        const lastDot=s.lastIndexOf('.');
        let n=s;
        if(lastComma>=0 && lastDot>=0){
          n=lastComma>lastDot?s.replace(/\./g,'').replace(',','.'):s.replace(/,/g,'');
        }else if(lastComma>=0){
          n=s.replace(',','.');
        }else if((s.match(/\./g)||[]).length>1){
          n=s.replace(/\./g,'');
        }
        const value=Number(n);
        return Number.isFinite(value)&&value>0&&value<100000000?value:NaN;
      };
      const values=[];
      const originals=[];
      const add=(target,v)=>{
        const n=parseMoney(v);
        if(Number.isFinite(n))target.push(n);
      };

      const currentSelectors=[
        '.ui-pdp-price__second-line .andes-money-amount__fraction',
        '.ui-pdp-price .andes-money-amount__fraction',
        '.ui-pdp-price__second-line .andes-money-amount',
        '[data-testid="price-part"] .andes-money-amount__fraction',
        '[data-testid="price-part"]'
      ];
      const originalSelectors=[
        '.ui-pdp-price__original .andes-money-amount__fraction',
        '.ui-pdp-price--original .andes-money-amount__fraction',
        '.ui-pdp-price__original .andes-money-amount',
        '[class*="price"][class*="original"] .andes-money-amount__fraction'
      ];

      for(const sel of currentSelectors){
        document.querySelectorAll(sel).forEach(el=>add(values,el.textContent||el.getAttribute('content')||''));
      }
      for(const sel of originalSelectors){
        document.querySelectorAll(sel).forEach(el=>add(originals,el.textContent||el.getAttribute('content')||''));
      }

      const body=clean(document.body?.innerText||'');
      const bodyPrices=body.match(/R\$\s*[0-9.]+(?:,[0-9]{2})?/g)||[];
      for(const v of bodyPrices.slice(0,30))add(values,v);

      const title=clean(document.querySelector('h1.ui-pdp-title,h1')?.textContent||'');
      const imageEl=document.querySelector('.ui-pdp-gallery__figure img,figure.ui-pdp-gallery__figure img');
      const image=String(imageEl?.currentSrc||imageEl?.src||document.querySelector('meta[property="og:image"]')?.getAttribute('content')||'').trim();
      const current=values.length?Math.min(...values):NaN;
      const original=originals.length?Math.max(...originals):NaN;
      let desconto='';
      if(Number.isFinite(current)&&Number.isFinite(original)&&original>current){
        desconto=Math.round((1-current/original)*100)+'%';
      }
      return {finalUrl:location.href,titulo:title,current,original,desconto,imagemUrl:image};
    });

    if(!Number.isFinite(data.current)) return null;
    return {
      titulo:String(data.titulo||'').trim(),
      preco:autoOfferFormatBRL(data.current,'BRL'),
      precoOriginal:Number.isFinite(data.original)?autoOfferFormatBRL(data.original,'BRL'):'',
      desconto:String(data.desconto||''),
      imagemUrl:String(data.imagemUrl||'').trim(),
      finalUrl:data.finalUrl||url,
      fonte:'mercado-livre-browser'
    };
  }finally{
    if(context) await context.close().catch(()=>{});
  }
}


async function findProductImage(url) {
  // REGULOS_BROWSER_IMAGE_FALLBACK_V2
  // Mercado Livre continua tendo prioridade pelo método específico da API.
  const target=String(url||'').trim();
  if(!target) return null;
  try{
    try{
      const mlImageUrl=await findMercadoLivreImageUrl(target);
      if(mlImageUrl){
        try{
          const image=await downloadBuffer(mlImageUrl,target);
          addLog(`🖼️ Imagem do Mercado Livre encontrada via API: ${mlImageUrl}`);
          return image;
        }catch(e){
          addLog(`Imagem do Mercado Livre não pôde ser baixada: ${e.message}`);
        }
      }
    }catch(e){
      addLog(`Fallback Mercado Livre ignorado: ${e.message}`);
    }

    // Primeiro tenta o método HTTP/metadata existente.
    try{
      const fetched=await fetchText(target);
      const candidates=extractImageCandidates(fetched.data,fetched.finalUrl||target);
      for(const candidate of candidates.slice(0,12)){
        try{
          const image=await downloadBuffer(candidate,fetched.finalUrl||target);
          addLog(`🖼️ Imagem encontrada por metadados: ${candidate}`);
          return image;
        }catch(e){
          addLog(`Imagem candidata não pôde ser baixada: ${e.message}`);
        }
      }
    }catch(e){
      addLog(`Busca HTTP de imagem falhou: ${e.message}`);
    }

    // Fallback para lojas que montam a página/imagem somente com JavaScript.
    try{
      const browser=await getRegulosBrowser();
      const context=await browser.newContext({
        userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36',
        viewport:{width:1365,height:900}
      });
      const page=await context.newPage();
      try{
        await page.goto(target,{waitUntil:'domcontentloaded',timeout:35000});
        await page.waitForTimeout(5000);
        const browserImages=await page.evaluate(()=>{
          const out=[];
          const add=(v)=>{
            if(!v || typeof v!=='string') return;
            const s=v.trim();
            if(!/^https?:\/\//i.test(s)) return;
            if(!out.includes(s)) out.push(s);
          };
          for(const img of Array.from(document.images||[])){
            add(img.currentSrc); add(img.src);
            add(img.getAttribute('data-src'));
            add(img.getAttribute('data-lazy-src'));
            add(img.getAttribute('data-original'));
          }
          for(const el of Array.from(document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]'))){
            add(el.getAttribute('content'));
          }
          return out.slice(0,30);
        });
        for(const candidate of browserImages){
          try{
            const image=await downloadBuffer(candidate,target);
            addLog(`🖼️ Imagem encontrada pelo navegador: ${candidate}`);
            return image;
          }catch(e){
            addLog(`Imagem do navegador não pôde ser baixada: ${e.message}`);
          }
        }
      }finally{
        await context.close().catch(()=>{});
      }
    }catch(e){
      addLog(`Fallback de navegador para imagem falhou: ${e.message}`);
    }
  }catch(e){
    addLog(`Busca automática de imagem falhou: ${e.message}`);
  }
  return null;
}

let regulosBrowserPromise=null;
async function getRegulosBrowser(){
  if(!regulosBrowserPromise)regulosBrowserPromise=chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}).catch(e=>{regulosBrowserPromise=null;throw e;});
  return regulosBrowserPromise;
}
async function findProductImageWithBrowser(url){
  let context=null;
  try{
    await assertSafeExternalUrl(url);
    const browser=await getRegulosBrowser();
    context=await browser.newContext({userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/154 Safari/537.36',locale:'pt-BR',viewport:{width:1365,height:900},javaScriptEnabled:true,ignoreHTTPSErrors:true});
    const page=await context.newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForTimeout(1800);
    const candidates=await page.evaluate(()=>{
      const out=[],seen=new Set(),add=v=>{if(!v||/^data:|^blob:/i.test(v))return;try{const u=new URL(v,location.href).href;if(/^https?:/i.test(u)&&!seen.has(u)){seen.add(u);out.push(u)}}catch{}};
      document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"],meta[property="og:image:url"]').forEach(x=>add(x.content));
      document.querySelectorAll('img').forEach(img=>{add(img.currentSrc||img.src);['data-src','data-original','data-lazy-src','data-image','data-image-src','data-zoom-image','data-large_image'].forEach(k=>add(img.getAttribute(k)));});
      return out.slice(0,80);
    });
    for(const candidate of candidates){try{const image=await downloadBuffer(candidate,url);await context.close();addLog('Fallback navegador encontrou imagem: '+candidate);return image}catch{}}
    await context.close();
  }catch(e){try{if(context)await context.close()}catch{}addLog('Fallback navegador indisponível: '+e.message)}
  return null;
}
const DEFAULT_RANDOM_MESSAGES = [
  '🔥 Oferta do dia!',
  '🛍️ Achadinho do dia!',
  '💰 Preço especial!',
  '👀 Olha esse achado!',
  '⭐ Destaque do dia!',
  '🚨 Oferta imperdível!',
  '😍 Vale a pena conferir!',
  '💥 Aproveite essa oferta!'
];
function chooseRandomMessage(item) {
  const enabled = item.mensagemAleatoriaAtiva === true || (Array.isArray(item.mensagensAleatorias) && item.mensagensAleatorias.length > 0);
  if (!enabled) return '';
  let selected=Array.isArray(item.mensagensAleatorias)?item.mensagensAleatorias.filter(Boolean):[];
  // Se o modo aleatório estiver ligado mas nenhuma opção tiver sido marcada,
  // usa automaticamente o conjunto padrão em vez de enviar sem a chamada.
  if (!selected.length) selected = DEFAULT_RANDOM_MESSAGES;
  return selected[Math.floor(Math.random()*selected.length)];
}

async function loadGroups() {
  if (!sock || !online) return false;

  const now = Date.now();
  if (groupRefreshInFlight) return groupRefreshInFlight;
  if (now < groupRateLimitUntil) return false;
  if (lastGroupAttemptAt && now - lastGroupAttemptAt < 15000) return false;

  lastGroupAttemptAt = now;
  groupRefreshInFlight = (async () => {
    try {
      const all = await sock.groupFetchAllParticipating();
      groups = Object.values(all || {})
        .filter(g => g && typeof g.id === 'string' && /@g\.us$/.test(g.id))
        .map(g => {
          const id = String(g.id);
          return {
            id,
            name: g.subject || id,
            members: Array.isArray(g.participants) ? g.participants.length : 0,
            allowed: allowed.includes(id),
            config: getGroupConfig(id)
          };
        }).sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));

      lastGroupRefreshAt = Date.now();
      groupRateLimitUntil = 0;
      groupRateLimitLevel = 0;
      addLog('Grupos carregados: ' + groups.length);
      return true;
    } catch (e) {
      if (isGroupRateLimitError(e)) {
        groupRateLimitLevel = Math.min(groupRateLimitLevel + 1, 4);
        const waitMs = groupRefreshBackoffMs(groupRateLimitLevel);
        groupRateLimitUntil = Date.now() + waitMs;
        addLog('Rate-limit nos grupos; próxima tentativa em ~' + Math.ceil(waitMs / 1000) + 's.');
      } else {
        groupRateLimitUntil = Date.now() + 15000;
        addLog('Erro nos grupos: ' + e.message);
      }
      return false;
    } finally {
      groupRefreshInFlight = null;
    }
  })();

  return groupRefreshInFlight;
}

function isValidGroupJid(id) {
  const value = String(id || '').trim();
  return Boolean(value) && value !== 'undefined' && value !== 'null' && /^[^@\s]+@g\.us$/.test(value);
}
function normalizeScheduleGroupIds(itemOrIds) {
  const raw = Array.isArray(itemOrIds)
    ? itemOrIds
    : (Array.isArray(itemOrIds?.grupoIds) ? itemOrIds.grupoIds : (itemOrIds?.grupoId ? [itemOrIds.grupoId] : []));
  return [...new Set(raw.map(v => String(v || '').trim()).filter(Boolean))];
}
function groupNameForId(id) {
  const value = String(id || '').trim();
  return groups.find(g => String(g?.id || '') === value)?.name || value || '';
}
function groupNamesForIds(ids) {
  return normalizeScheduleGroupIds(ids).map(groupNameForId).filter(Boolean);
}
function activeGroups() {
  return groups
    .map(g => String(g?.id || '').trim())
    .filter(id => isValidGroupJid(id))
    .filter(id => getGroupConfig(id).ativo !== false);
}

function stopSchedulers() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
}
function armAutoLinkTimer() {
  stopSchedulers();
  if (!online || !botWindowActive() || !links.length) return;
  const delayMin = 75 + Math.floor(Math.random() * 30);
  scheduleTimer = setTimeout(sendLegacyAutoLink, delayMin * 60000);
  addLog(`Próximo envio automático legado em ~${delayMin} min.`);
}
async function sendLegacyAutoLink() {
  scheduleTimer = null;
  if (!online || !botWindowActive() || !sock || !links.length) {
    armAutoLinkTimer();
    return;
  }
  const targets = activeGroups().filter(id => allowed.includes(id));
  if (!targets.length) {
    addLog('Envio automático legado aguardando: nenhum grupo permitido e Ligado.');
    armAutoLinkTimer();
    return;
  }
  const link = links[index % links.length];
  let sent = 0;
  for (const id of targets) {
    if (!botWindowActive()) break;
    try {
      await sock.sendMessage(id, { text: link });
      sent++;
      addHistory({ grupoId:id, link, status:'sucesso', tipo:'legado' });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      addHistory({ grupoId:id, link, status:'erro', erro:e.message, tipo:'legado' });
      addLog(`Falha legado ${id}: ${e.message}`);
    }
  }
  index = links.length ? (index + 1) % links.length : 0;
  fs.writeFileSync(FILES.index, String(index));
  addLog(`Envio automático legado: ${sent}/${targets.length}`);
  armAutoLinkTimer();
}

const runningLinkSchedules = new Set();
const scheduledGroupRevalidationAt = new Map();
const SCHEDULED_GROUP_REVALIDATE_COOLDOWN_MS = 30 * 1000;

async function ensureScheduledGroupsAvailable(selectedGroupIds) {
  const ids = normalizeScheduleGroupIds(selectedGroupIds);
  if (!ids.length || !online || !sock) return false;

  // Primeiro tentamos atualizar o cache completo, respeitando o rate-limit/backoff
  // já existente em loadGroups(). Isso resolve a maioria dos casos de cache antigo.
  await loadGroups();

  let missing = ids.filter(id => !groups.some(g => String(g?.id || '') === id));
  if (!missing.length) return true;

  // Se o refresh geral ainda não encontrou um grupo específico, consultamos
  // somente esse JID diretamente. Há um cooldown para não repetir a consulta
  // a cada ciclo de 10s do scheduler.
  for (const id of missing) {
    const now = Date.now();
    const lastAttempt = Number(scheduledGroupRevalidationAt.get(id) || 0);
    if (now - lastAttempt < SCHEDULED_GROUP_REVALIDATE_COOLDOWN_MS) continue;

    scheduledGroupRevalidationAt.set(id, now);
    try {
      const meta = await sock.groupMetadata(id);
      const metaId = String(meta?.id || id).trim();
      if (metaId !== id || !isValidGroupJid(metaId)) continue;

      const refreshedGroup = {
        id: metaId,
        name: meta.subject || metaId,
        members: Array.isArray(meta.participants)
          ? meta.participants.length
          : Number(meta.size || 0),
        allowed: allowed.includes(metaId),
        config: getGroupConfig(metaId)
      };

      const existingIndex = groups.findIndex(g => String(g?.id || '') === metaId);
      if (existingIndex >= 0) {
        groups[existingIndex] = refreshedGroup;
      } else {
        groups.push(refreshedGroup);
      }
      groups.sort((a,b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'pt-BR'));
      addLog(`Grupo revalidado para o agendamento: ${metaId} — ${refreshedGroup.name}`);
    } catch (e) {
      // O grupo pode ter sido removido, a sessão pode não ter acesso a ele,
      // ou a consulta pode ter sido recusada. Neste ponto não transformamos
      // uma falha temporária de cache em falha permanente do agendamento.
      if (isGroupRateLimitError(e)) {
        addLog(`Revalidação do grupo ${id} limitada por rate-limit; aguardando nova tentativa.`);
      } else {
        addLog(`Grupo ${id} ainda não foi revalidado: ${e.message}`);
      }
    }
  }

  missing = ids.filter(id => !groups.some(g => String(g?.id || '') === id));
  return missing.length === 0;
}
function isoWeekKey(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay() || 7;
  x.setDate(x.getDate() + 4 - day);
  const yearStart = new Date(x.getFullYear(), 0, 1);
  const week = Math.ceil((((x - yearStart) / 86400000) + 1) / 7);
  return `${x.getFullYear()}-W${String(week).padStart(2,'0')}`;
}
function occurrenceKey(item, now = new Date()) {
  if (item.repeticao === 'uma_vez') return 'once';
  if (item.repeticao === 'semanalmente') return `${isoWeekKey(now)}-${new Date(`${item.data}T${item.horario}:00`).getDay()}`;
  return dateKey(now);
}
function hasPendingProgress(item) {
  return Boolean(item.progressKey && Array.isArray(item.progressGroupIds));
}
function scheduleDue(item, now) {
  if (!item.ativo || !item.data || !item.horario) return false;

  // Se uma execução começou e o processo foi reiniciado, retome exatamente
  // de onde parou. Não espere o horário original novamente.
  if (hasPendingProgress(item)) return true;

  const start = new Date(`${item.data}T${item.horario}:00`);
  if (Number.isNaN(start.getTime()) || now < start) return false;
  if (item.repeticao === 'diariamente') return item.lastRunKey !== dateKey(now);
  if (item.repeticao === 'semanalmente') {
    return now.getDay() === start.getDay() && item.lastRunKey !== occurrenceKey(item, now);
  }
  return !item.lastRunKey;
}
async function sendScheduledLink(item) {
  if (runningLinkSchedules.has(item.id) || !online || !sock || !botWindowActive()) return;

  let targets;
  const now = new Date();

  // Cada agendamento pode ter vários destinos explícitos. Nunca usamos a lista
  // global de grupos como fallback, evitando broadcast acidental e JIDs inválidos.
  const selectedGroupIds=normalizeScheduleGroupIds(item);
  if(!selectedGroupIds.length || selectedGroupIds.some(id=>!isValidGroupJid(id))){
    const erro='Grupos de envio não definidos ou inválidos. Edite o agendamento e selecione pelo menos um grupo válido.';
    item.status='erro';
    item.ativo=false;
    upsertLinkFailure(item,selectedGroupIds[0]||'',erro);
    writeJson(FILES.schedules,linkSchedules);
    addLog(`Agendamento "${item.nome}" bloqueado: ${erro}`);
    return;
  }
  const groupsAvailable = await ensureScheduledGroupsAvailable(selectedGroupIds);
  if(!groupsAvailable){
    const missing=selectedGroupIds.filter(id=>!groups.some(g=>String(g?.id||'')===id));
    item.status='aguardando_grupo';
    item.lastGroupCheckAt=new Date().toISOString();
    writeJson(FILES.schedules,linkSchedules);
    addLog(`Agendamento "${item.nome}" aguardando revalidação do grupo: ${missing.join(', ')}`);
    return;
  }

  const selectedGroups=selectedGroupIds.map(id=>groups.find(g=>String(g.id)===id)).filter(Boolean);
  item.grupoNomes=Object.fromEntries(selectedGroups.map(g=>[String(g.id),String(g.name||g.id)]));
  item.grupoNome=selectedGroupIds.length===1?item.grupoNomes[selectedGroupIds[0]]:`${selectedGroupIds.length} grupos`;

  // Mantém a mesma ocorrência entre reinícios. O progresso fica gravado em
  // disco depois de cada grupo, então o próximo processo continua do ponto
  // exato em que o anterior parou.
  if (hasPendingProgress(item)) {
    targets = Array.isArray(item.progressTargets) ? [...item.progressTargets] : [...selectedGroupIds];
  } else {
    targets = [...selectedGroupIds];
    const activeSelectedTargets = targets.filter(id => getGroupConfig(id).ativo !== false);
    if (!activeSelectedTargets.length) {
      item.status = 'pausado';
      item.lastSkipKey = dateKey(now);
      writeJson(FILES.schedules, linkSchedules);
      addLog(`Agendamento "${item.nome}" aguardando: todos os grupos selecionados estão desligados.`);
      return;
    }
    item.progressKey = occurrenceKey(item, now);
    item.progressTargets = [...selectedGroupIds];
    item.progressGroupIds = [];
    item.progressStartedAt = now.toISOString();
    item.status = 'enviando';
    ensureLinkDeliveries(item, item.progressKey, selectedGroupIds.filter(id => getGroupConfig(id).ativo !== false));
    writeJson(FILES.schedules, linkSchedules);
    addLog(`Agendamento "${item.nome}" iniciado para ${selectedGroupIds.length} grupo(s). Progresso salvo em disco.`);
  }

  // Grupos já concluídos nesta ocorrência nunca recebem a mesma execução de novo.
  const completed = new Set((item.progressGroupIds || []).map(String));
  targets = targets.map(String).filter(id => !completed.has(id));

  if (!targets.length) {
    item.lastRunKey = item.progressKey;
    item.lastRunAt = item.lastRunAt || new Date().toISOString();
    item.progressKey = '';
    item.progressTargets = [];
    item.progressGroupIds = [];
    item.progressStartedAt = '';
    item.status = item.repeticao === 'uma_vez' ? 'pausado' : 'agendado';
    if (item.repeticao === 'uma_vez') item.ativo = false;
    writeJson(FILES.schedules, linkSchedules);
    return;
  }

  runningLinkSchedules.add(item.id);
  let sent=0, errors=0;
  let productTitle = String(item.tituloProduto || '').trim();
  if (!productTitle) {
    const titleResult = await findProductTitle(String(item.url || '').trim());
    productTitle = titleResult.title || '';
    if (productTitle) {
      item.tituloProduto = productTitle;
      item.tituloUltimaTentativa = new Date().toISOString();
      writeJson(FILES.schedules, linkSchedules);
      addLog(`Título encontrado para "${item.nome}": ${productTitle}`);
    }
  }

  let productImage = null;
  if (String(item.imagemUrl || '').trim()) {
    try {
      const parsedImage = await assertSafeExternalUrl(String(item.imagemUrl).trim());
      productImage = await downloadBuffer(parsedImage.url, String(item.url || '').trim());
      item.imagemStatus = 'manual';
      item.imagemUltimaTentativa = new Date().toISOString();
      addLog(`Imagem manual usada para "${item.nome}".`);
    } catch(e) {
      item.imagemStatus = 'erro'; item.imagemUltimaTentativa = new Date().toISOString();
      addLog(`Imagem manual inválida para "${item.nome}": ${e.message}`);
      // A falha de imagem acontece antes do sendMessage(), então a entrega
      // ainda está PENDENTE. Mesmo assim, ela precisa terminar como ERRO,
      // para não ficar presa no painel indefinidamente.
      for (const id of targets) {
        const errorMsg = `Imagem: ${e.message}`;
        setLinkDeliveryStatus(item, item.progressKey, id, 'ERRO', errorMsg);
        upsertLinkFailure(item, id, errorMsg);
      }
      item.status = 'erro'; item.ativo = false;
      if (item.repeticao === 'uma_vez') {
        linkSchedules = linkSchedules.filter(x => String(x?.id || '') !== String(item.id || ''));
        syncLinkQueue();
      }
      writeJson(FILES.schedules, linkSchedules);
      return;
    }
  } else {
    productImage = await findProductImage(String(item.url||'').trim());
    item.imagemStatus = productImage ? 'encontrada' : 'não encontrada';
    item.imagemUltimaTentativa = new Date().toISOString();
    writeJson(FILES.schedules, linkSchedules);
    if (!productImage) {
      const msg = 'Não foi possível encontrar ou baixar a imagem automaticamente.';
      for (const id of targets) {
        // Falha de imagem também encerra a tentativa de entrega como uma
        // tentativa efetiva, evitando ficar com tentativas: 0 no painel.
        setLinkDeliveryStatus(item, item.progressKey, id, 'ENVIANDO');
        setLinkDeliveryStatus(item, item.progressKey, id, 'ERRO', msg);
        upsertLinkFailure(item, id, msg);
      }

      // Uma ocorrência "uma_vez" que falhou definitivamente não pode
      // permanecer na fila nem carregar progressKey para um próximo ciclo.
      item.status = 'erro';
      item.ativo = false;
      item.lastRunKey = item.progressKey || occurrenceKey(item, new Date());
      item.lastRunAt = new Date().toISOString();
      item.progressKey = '';
      item.progressTargets = [];
      item.progressGroupIds = [];
      item.progressStartedAt = '';

      if (item.repeticao === 'uma_vez') {
        linkSchedules = linkSchedules.filter(x => String(x?.id || '') !== String(item.id || ''));
        syncLinkQueue();
        writeJson(FILES.schedules, linkSchedules);
        addLog(`Agendamento "${item.nome}" removido dos agendamentos após falha de imagem; mantido em Links com Falha.`);
      } else {
        writeJson(FILES.schedules, linkSchedules);
        addLog(`Agendamento "${item.nome}" finalizou a ocorrência com falha de imagem; próxima ocorrência permanece agendada.`);
      }
      return;
    }
    addLog(`Imagem encontrada para "${item.nome}".`);
  }
  const startedAt = Date.now();
  try {
    for (const id of targets) {
      if (!botWindowActive()) {
        item.status = 'pausado';
        writeJson(FILES.schedules, linkSchedules);
        addLog(`Agendamento "${item.nome}" pausado no fim do horário. Retomará do próximo grupo.`);
        break;
      }

      // Se o grupo foi desligado desde o início da ocorrência, não enviamos.
      if (getGroupConfig(id).ativo === false) continue;

      try {
        if(!isValidGroupJid(id)){
          throw new Error('JID do grupo de destino inválido.');
        }

        // Idempotência básica: uma entrega já confirmada como SUCESSO nesta
        // ocorrência nunca é enviada novamente.
        const existingDelivery = getLinkDelivery(item, item.progressKey, id);
        if (existingDelivery?.status === 'SUCESSO') {
          item.progressGroupIds = [...new Set([...(item.progressGroupIds || []), id])];
          writeJson(FILES.schedules, linkSchedules);
          addLog(`Entrega já confirmada para "${item.nome}" no grupo ${id}; envio duplicado evitado.`);
          continue;
        }

        const randomIntro = chooseRandomMessage(item);
        const titleLine = productTitle ? `📦 ${productTitle}` : '';
        const linkUrl = String(item.url||'').trim();
        let customMessage = String(item.mensagem || '').trim();

        if (item.autoOfertaAutomatica === true && customMessage) {
          const duplicateLines = new Set([
            productTitle,
            titleLine,
            linkUrl,
            '🛒 Confira a oferta:',
            '👉 Garanta agora:'
          ].filter(Boolean));
          customMessage = customMessage
            .split(/\r?\n/)
            .filter(line => !duplicateLines.has(String(line).trim()))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        const guaranteeLine = linkUrl ? '👉 Garanta agora:' : '';
        const text = [randomIntro, titleLine, customMessage, guaranteeLine, linkUrl].filter(Boolean).join('\n\n');

        let delivered = false;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
          setLinkDeliveryStatus(item, item.progressKey, id, 'ENVIANDO');

          try {
            if (productImage) {
              await sock.sendMessage(id, { image: productImage.buffer, caption: text });
            } else {
              await sock.sendMessage(id, { text });
            }
            delivered = true;
            break;
          } catch(e) {
            lastError = e;
            setLinkDeliveryStatus(item, item.progressKey, id, 'ERRO', e.message);

            if (attempt < MAX_DELIVERY_ATTEMPTS) {
              const retryDelay = DELIVERY_RETRY_DELAYS_MS[attempt - 1] || 2000;
              addLog(`Falha na entrega "${item.nome}" para ${id} (tentativa ${attempt}/${MAX_DELIVERY_ATTEMPTS}). Nova tentativa em ${retryDelay}ms: ${e.message}`);
              await new Promise(r => setTimeout(r, retryDelay));
            }
          }
        }

        if (!delivered) {
          errors++;
          item.erros = Number(item.erros||0) + 1;
          addHistory({ grupoId:id, link:item.url, status:'erro', erro:lastError?.message||'Falha no envio.', agendamentoId:item.id, tipo:'agendado', ocorrencia:item.progressKey });
          upsertLinkFailure(item, id, lastError?.message||'Falha no envio.');
          addLog(`Falha agendamento ${item.nome}: ${lastError?.message||'Falha no envio.'} após ${MAX_DELIVERY_ATTEMPTS} tentativa(s).`);
          // A ocorrência não fica presa em retry infinito. O registro permanece ERRO para consulta no painel.
          item.progressGroupIds = [...new Set([...(item.progressGroupIds || []), id])];
          writeJson(FILES.schedules, linkSchedules);
          continue;
        }

        sent++;
        setLinkDeliveryStatus(item, item.progressKey, id, 'SUCESSO');
        item.progressGroupIds = [...new Set([...(item.progressGroupIds || []), id])];
        addHistory({ grupoId:id, link:item.url, status:'sucesso', agendamentoId:item.id, tipo:'agendado', ocorrencia:item.progressKey });
        removeLinkFailure(`${item.id}:${String(id)}`);
        item.enviados = Number(item.enviados||0) + 1;
        item.sucessos = Number(item.sucessos||0) + 1;
        item.lastSentAt = new Date().toISOString();
        writeJson(FILES.schedules, linkSchedules);
        await new Promise(r => setTimeout(r, Math.max(700, Number(item.intervaloMin||1)*1000)));
      } catch(e) {
        errors++;
        setLinkDeliveryStatus(item, item.progressKey, id, 'ERRO', e.message);
        item.progressGroupIds = (item.progressGroupIds || []).filter(x => String(x) !== String(id));
        item.erros = Number(item.erros||0) + 1;
        addHistory({ grupoId:id, link:item.url, status:'erro', erro:e.message, agendamentoId:item.id, tipo:'agendado', ocorrencia:item.progressKey });
        upsertLinkFailure(item, id, e.message);
        addLog(`Falha agendamento ${item.nome}: ${e.message}`);
        writeJson(FILES.schedules, linkSchedules);
      }
    }

    const allDone = (item.progressTargets || []).every(id => (item.progressGroupIds || []).includes(id) || getGroupConfig(id).ativo === false);
    if (allDone) {
      item.lastRunKey = item.progressKey;
      item.lastRunAt = new Date().toISOString();
      item.lastDurationMs = Date.now() - startedAt;
      item.progressKey = '';
      item.progressTargets = [];
      item.progressGroupIds = [];
      item.progressStartedAt = '';
      if (item.repeticao === 'uma_vez') {
        item.ativo = false;
        if (Number(item.erros || 0) > 0) {
          item.status = 'erro';
          linkSchedules = linkSchedules.filter(x => String(x?.id || '') !== String(item.id || ''));
          syncLinkQueue();
          writeJson(FILES.schedules, linkSchedules);
          addLog(`Link "${item.nome}" removido dos agendamentos e mantido em falhas para correção.`);
        } else {
          item.status = 'concluido';
          archiveCompletedOneTimeLink(item);
        }
      } else {
        item.status = 'agendado';
        writeJson(FILES.schedules, linkSchedules);
      }
      addLog(`Link "${item.nome}": execução concluída. ${item.sucessos || 0} sucesso(s), ${item.erros || 0} erro(s).`);
    } else {
      item.status = botWindowActive() ? 'enviando' : 'pausado';
      writeJson(FILES.schedules, linkSchedules);
      addLog(`Link "${item.nome}": progresso preservado; continuará de onde parou.`);
    }
  } finally {
    runningLinkSchedules.delete(item.id);
  }
}
async function processLinkSchedules() {
  if (!online || !botWindowActive()) return;
  syncLinkQueue();
  const queue = orderedLinks();
  if (!queue.length) return;

  // Fila contínua: apenas UM link é processado por vez.
  // Se o horário acabar depois do 15º link, o cursor permanece no 16º
  // (ou no link que estava em andamento) e o próximo período continua dali.
  for (let guard = 0; guard < queue.length; guard++) {
    if (!botWindowActive()) return;
    syncLinkQueue();
    const currentQueue = orderedLinks();
    if (!currentQueue.length) return;
    const idx = Math.min(Math.max(Number(linkQueue.cursor)||0, 0), currentQueue.length-1);
    const item = currentQueue[idx];
    linkQueue.cursor = idx;
    linkQueue.currentId = String(item.id);
    saveLinkQueue();

    const now = new Date();
    if (!scheduleDue(item, now)) return;

    const before = item.lastRunKey;
    const hadProgress = hasPendingProgress(item);
    await sendScheduledLink(item);

    // Se ainda há progresso pendente, a janela acabou ou houve falha.
    // Não avança o cursor: retomará exatamente este link.
    if (hasPendingProgress(item)) return;

    // Para repetição diária/semanal, um link concluído fica aguardando a
    // próxima ocorrência e não pode bloquear os próximos links da fila.
    // Para uma vez, o item fica inativo e também pode avançar.
    if (item.lastRunKey && item.lastRunKey !== before || (!hadProgress && item.repeticao === 'uma_vez' && !item.ativo)) {
      const ids = currentQueue.map(x => String(x.id));
      const pos = ids.indexOf(String(item.id));
      linkQueue.cursor = pos >= 0 ? (pos + 1) % Math.max(ids.length,1) : 0;
      const next = orderedLinks();
      if (next.length) {
        // Em uma fila de uma vez, removemos o link concluído da sequência
        // pelo próprio ativo=false. Em repetição, o cursor avança para o
        // próximo link apenas se ele também estiver devido.
        const nextIds = next.map(x => String(x.id));
        if (nextIds.length) {
          const nextPos = nextIds.indexOf(String(item.id));
          linkQueue.cursor = nextPos >= 0 ? (nextPos + 1) % nextIds.length : 0;
          linkQueue.currentId = nextIds[linkQueue.cursor];
        } else {
          linkQueue.cursor = 0; linkQueue.currentId = '';
        }
      } else {
        linkQueue.cursor = 0; linkQueue.currentId = '';
      }
      linkQueue.updatedAt = new Date().toISOString();
      saveLinkQueue();
      continue;
    }
    return;
  }
}
async function startLinkScheduler() {
  if (linkScheduleTimer) clearInterval(linkScheduleTimer);
  linkScheduleTimer = setInterval(() => processLinkSchedules().catch(e => addLog(`Erro agendador: ${e.message}`)), 10000);
}

async function start() {
  if (starting || online || stopping) return;
  starting = true;
  manualDisconnected = false;
  clearReconnect();
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);
    qr = null;
    status = state.creds?.registered ? 'Aguardando conexão...' : 'Aguardando QR Code...';
    addLog(state.creds?.registered ? 'Credenciais encontradas; aguardando conexão.' : 'Nenhuma sessão válida; aguardando QR Code.');
    const { version } = await fetchLatestBaileysVersion();
    const s = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['Regulos','Chrome','120'],
      printQRInTerminal: false
    });
    sock = s;
    status = 'Aguardando conexão...';
    s.ev.on('creds.update', saveCreds);
    s.ev.on('connection.update', async u => {
      if (sock !== s) return;
      if (u.qr) {
        try {
          qr = await qrcode.toDataURL(u.qr);
          online = false;
          connectedNumber = '';
          status = 'Escaneie o QR Code';
          addLog('QR Code gerado.');
        } catch (e) {
          qr = null;
          status = `Erro ao gerar QR: ${e.message}`;
          addLog(status);
        }
      }
      if (u.connection === 'open') {
        qr = null;
        online = true;
        connectedNumber = normalizePhone(s.user?.id || '');
        status = 'Conectado';
        addLog(`WhatsApp conectado${connectedNumber ? ` — ${formatPhone(connectedNumber)}` : ''}`);
        // Reconexão normal da mesma sessão não deve apagar os grupos selecionados.
        // A limpeza de allowed/groupConfig acontece somente nos fluxos explícitos
        // de troca de sessão (Desconectar / Novo QR / Deslogar).
        // Assim, uma queda 408/428 seguida de reconexão mantém a seleção do painel.
        await loadGroups();
        armAutoLinkTimer();
        processLinkSchedules().catch(e => addLog(e.message));
      }
      if (u.connection === 'close') {
        online = false;
        qr = null;
        stopSchedulers();
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null;
        groups = [];
        lastGroupRefreshAt = 0;
        if (manualDisconnected) {
          status = 'Desconectado';
          addLog('Conexão encerrada pelo usuário. Reconexão automática desativada.');
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          status = 'Sessão encerrada — gerando novo QR...';
          addLog('Sessão deslogada/credenciais inválidas. Limpando autenticação.');
          try { fs.rmSync(AUTH, { recursive:true, force:true }); } catch(e) { addLog(`Erro limpando autenticação: ${e.message}`); }
          clearReconnect();
          reconnectTimer = setTimeout(() => start(), 800);
          return;
        }
        status = 'Reconectando...';
        addLog(`Conexão fechada (${code ?? 'desconhecido'}).`);
        clearReconnect();
        reconnectTimer = setTimeout(() => start(), 3000);
      }
    });
  } catch (e) {
    sock = null; online = false; qr = null;
    status = `Erro: ${e.message}`;
    addLog(`Erro ao iniciar: ${e.message}`);
    clearReconnect();
    reconnectTimer = setTimeout(() => start(), 5000);
  } finally {
    starting = false;
  }
}

app.get('/api/status', (req,res) => res.json({
  ok:true, conectado:online, status, temQR:Boolean(qr), qr,
  numero: connectedNumber ? formatPhone(connectedNumber) : '',
  numeroBruto: connectedNumber,
  grupos:groups.length, permitidos:allowed.length,
gruposLigados:activeGroups().map(id=>{const g=groups.find(x=>String(x.id)===String(id));const c=getGroupConfig(id);return {id,nome:g?.name||c.nome||c.apelido||id};}),
  links:linkSchedules.length, filaLinks: orderedLinks().length, filaCursor: linkQueue.cursor, filaAtual: linkQueue.currentId, janela:botWindowLabel(),
  programacao:botSchedule
}));
app.get('/api/qr', (req,res) => res.json({ok:true, qr, status, conectado:online}));
app.get('/api/logs', (req,res) => res.json({ok:true, logs:[...logs].reverse()}));

app.post('/api/reconectar', requireAdmin, async (req,res) => {
  clearReconnect(); stopSchedulers(); manualDisconnected=false;
  const old=sock; sock=null; online=false; qr=null; connectedNumber='';
  status='Reconectando...'; addLog('Reconexão manual solicitada.');
  try { old?.end(); } catch {}
  setTimeout(() => start(), 300);
  res.json({ok:true,msg:'Reconexão iniciada. Aguarde.'});
})
function diagnosticoSchedulerState() {
  const ativos = Array.isArray(linkSchedules) ? linkSchedules.filter(x => x && x.ativo !== false) : [];
  const pendentes = ativos.filter(x => hasPendingProgress(x));
  const enviando = ativos.filter(x => String(x?.status || '') === 'enviando');
  return { ativos, pendentes, enviando };
}


app.get('/api/entregas', requireAuth, (req,res) => {
  try {
    const agendamentoId = String(req.query?.agendamentoId || '').trim();
    const ocorrencia = String(req.query?.ocorrencia || '').trim();
    const status = String(req.query?.status || '').trim().toUpperCase();

    let entregas = Array.isArray(linkDeliveries) ? [...linkDeliveries] : [];
    if (agendamentoId) entregas = entregas.filter(x => String(x?.agendamentoId || '') === agendamentoId);
    if (ocorrencia) entregas = entregas.filter(x => String(x?.ocorrencia || '') === ocorrencia);
    if (status) entregas = entregas.filter(x => String(x?.status || '').toUpperCase() === status);

    entregas.sort((a,b) => String(b?.criadoEm || '').localeCompare(String(a?.criadoEm || '')));
    res.set('Cache-Control','no-store');
    res.json({ok:true,total:entregas.length,entregas});
  } catch(e) {
    res.status(500).json({ok:false,msg:e.message || 'Falha ao consultar entregas.'});
  }
});

app.post('/api/assistente', requireAuth, (req,res)=>{
  try{
    const b=req.body||{}, acao=String(b.acao||'analisar').trim().toLowerCase(), periodo=Math.max(1,Math.min(90,Number(b.periodo||7)));
    const cutoff=Date.now()-periodo*24*60*60*1000;
    const agendamentos=Array.isArray(linkSchedules)?linkSchedules:[], falhas=Array.isArray(linkFailures)?linkFailures:[], entregas=Array.isArray(linkDeliveries)?linkDeliveries:[], historico=Array.isArray(linkHistory)?linkHistory:[];
    const entregasRecentes=entregas.filter(x=>Date.parse(String(x?.concluidoEm||x?.criadoEm||''))>=cutoff);
    const sucessos=entregasRecentes.filter(x=>String(x?.status||'').toUpperCase()==='SUCESSO').length;
    const erros=entregasRecentes.filter(x=>String(x?.status||'').toUpperCase()==='ERRO').length;
    const enviando=entregasRecentes.filter(x=>String(x?.status||'').toUpperCase()==='ENVIANDO').length;
    const taxa=sucessos+erros?Math.round((sucessos/(sucessos+erros))*100):0;
    const topFalhas={}; falhas.forEach(x=>{const k=String(x?.erro||'Falha não informada');topFalhas[k]=(topFalhas[k]||0)+1;});
    const principaisFalhas=Object.entries(topFalhas).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([motivo,total])=>({motivo,total}));
    const porLink={}; entregasRecentes.forEach(x=>{const k=String(x?.agendamentoId||'sem-id');porLink[k] ||= {agendamentoId:k,sucesso:0,erro:0,tentativas:0};const st=String(x?.status||'').toUpperCase();if(st==='SUCESSO')porLink[k].sucesso++;if(st==='ERRO')porLink[k].erro++;porLink[k].tentativas+=Number(x?.tentativas||0);});
    const ranking=Object.values(porLink).sort((a,b)=>(b.sucesso-b.erro)-(a.sucesso-a.erro)).slice(0,10).map(x=>({...x,nome:agendamentos.find(a=>String(a.id)===String(x.agendamentoId))?.nome||historico.find(h=>String(h.agendamentoId)===String(x.agendamentoId))?.nome||'Link'}));
    let resposta;
    if(acao==='erros') resposta=principaisFalhas.length ? 'Encontrei '+falhas.length+' falha(s) registradas. O principal motivo é "'+principaisFalhas[0].motivo+'" ('+principaisFalhas[0].total+' ocorrência(s)).' : 'Não há falhas registradas no momento.';
    else if(acao==='comparar') resposta='No período de '+periodo+' dia(s), foram '+sucessos+' sucesso(s), '+erros+' erro(s) e '+enviando+' envio(s) ainda em andamento. A taxa de sucesso das entregas finalizadas foi '+taxa+'%.';
    else if(acao==='organizar') resposta='Há '+agendamentos.length+' agendamento(s), '+falhas.length+' falha(s) e '+historico.length+' registro(s) no histórico. Recomendo revisar primeiro os links com falha e depois os agendamentos recorrentes.';
    else if(acao==='relatorio') resposta='Relatório de '+periodo+' dia(s): '+sucessos+' sucesso(s), '+erros+' erro(s), taxa de sucesso '+taxa+'%, '+agendamentos.length+' agendamento(s) atuais e '+falhas.length+' falha(s) pendentes.';
    else if(acao==='campanha') resposta='Rascunho de campanha preparado. O Assistente pode organizar links, grupos, mensagens e horários; a publicação deve ser confirmada antes de criar os agendamentos.';
    else resposta='Status do RegulOS: '+agendamentos.length+' agendamento(s), '+falhas.length+' falha(s), '+historico.length+' registro(s) no histórico. Nos últimos '+periodo+' dia(s), a taxa de sucesso foi '+taxa+'%.';
    res.set('Cache-Control','no-store'); res.json({ok:true,acao,periodo,resposta,metricas:{agendamentos:agendamentos.length,falhas:falhas.length,historico:historico.length,sucessos,erros,enviando,taxaSucesso:taxa},principaisFalhas,ranking});
  }catch(e){res.status(500).json({ok:false,msg:e.message||'Falha ao executar o Assistente.'});}
});

app.get('/api/diagnostico', (req,res) => {
  try {
    const agora = new Date();
    const sched = diagnosticoSchedulerState();
    const historicoRecente = Array.isArray(linkHistory) ? linkHistory.slice(0, 10) : [];
    const falhasRecentes = Array.isArray(linkFailures) ? linkFailures.slice(0, 10) : [];
    const ultimoHistorico = historicoRecente[0] || null;
    const ultimaFalha = falhasRecentes[0] || null;
    const selectedGroups = Array.isArray(allowed) ? allowed.filter(isValidGroupJid) : [];
    const loadedGroups = Array.isArray(groups) ? groups.filter(g => isValidGroupJid(g?.id)) : [];
    const queue = orderedLinks();
    const queueCurrent = queue.find(x => String(x.id) === String(linkQueue.currentId || '')) || null;
    const historyOk = Array.isArray(linkHistory);
    const schedulesOk = Array.isArray(linkSchedules);
    const groupsOk = Array.isArray(groups);
    const persistenceOk = [FILES.groups, FILES.groupConfig, FILES.schedules, FILES.linkHistory, FILES.linkFailures, FILES.linkQueue]
      .every(file => {
        try { return fs.existsSync(file); } catch { return false; }
      });
    const checks = [
      { key:'whatsapp', label:'WhatsApp', ok:online === true, value:online ? 'Conectado' : (qr ? 'Aguardando QR' : (status || 'Desconectado')), level:online ? 'ok' : (qr ? 'warn' : 'error') },
      { key:'groups', label:'Grupos', ok:groupsOk && loadedGroups.length > 0, value:`${loadedGroups.length} carregados`, level:groupsOk && loadedGroups.length > 0 ? 'ok' : 'error' },
      { key:'selected', label:'Grupos selecionados', ok:selectedGroups.length > 0, value:`${selectedGroups.length} selecionados`, level:selectedGroups.length > 0 ? 'ok' : 'warn' },
      { key:'scheduler', label:'Scheduler', ok:botSchedule.ativo !== false, value:botSchedule.ativo === true ? botWindowLabel() : 'Desativado', level:botSchedule.ativo === true ? 'ok' : 'warn' },
      { key:'queue', label:'Fila', ok:queue.length === 0 || !sched.pendentes.length || online, value:queue.length ? `${queue.length} ativos` : 'Vazia', level:!online && queue.length ? 'warn' : 'ok' },
      { key:'schedules', label:'Agendamentos', ok:schedulesOk, value:`${Array.isArray(linkSchedules) ? linkSchedules.length : 0} registrados`, level:schedulesOk ? 'ok' : 'error' },
      { key:'history', label:'Histórico', ok:historyOk, value:`${Array.isArray(linkHistory) ? linkHistory.length : 0} registros`, level:historyOk ? 'ok' : 'error' },
      { key:'persistence', label:'Persistência', ok:persistenceOk, value:persistenceOk ? 'Arquivos OK' : 'Verificar arquivos', level:persistenceOk ? 'ok' : 'error' }
    ];
    const errors = checks.filter(x => x.level === 'error');
    const warnings = checks.filter(x => x.level === 'warn');
    const result = errors.length ? 'erro' : (warnings.length ? 'atencao' : 'ok');
    res.set('Cache-Control','no-store');
    res.json({
      ok:true,
      resultado:result,
      resultadoLabel:result === 'ok' ? 'RegulOS operando normalmente' : (result === 'atencao' ? 'RegulOS operando com atenção' : 'RegulOS precisa de verificação'),
      executadoEm:agora.toISOString(),
      whatsapp:{conectado:online, status, qr:Boolean(qr), numero:connectedNumber ? formatPhone(connectedNumber) : '', numeroBruto:connectedNumber},
      grupos:{carregados:loadedGroups.length, selecionados:selectedGroups.length, ligados:selectedGroups.filter(id => getGroupConfig(id).ativo !== false).length},
      scheduler:{ativo:botSchedule.ativo === true, janela:botWindowLabel(), agendamentos:linkSchedules.length, fila:queue.length, filaAtual:queueCurrent?.nome || '', cursor:Number(linkQueue.cursor || 0), pendentes:sched.pendentes.length, enviando:sched.enviando.length},
      ultimoEnvio:ultimoHistorico ? {nome:ultimoHistorico.nome || '', em:ultimoHistorico.concluidoAt || ultimoHistorico.lastRunAt || ultimoHistorico.at || '', status:ultimoHistorico.status || ''} : null,
      ultimoErro:ultimaFalha ? {nome:ultimaFalha.nome || '', motivo:ultimaFalha.erro || '', em:ultimaFalha.atualizadoEm || ultimaFalha.criadoEm || ''} : null,
      persistencia:{ok:persistenceOk, arquivos:[FILES.groups,FILES.groupConfig,FILES.schedules,FILES.linkHistory,FILES.linkFailures,FILES.linkQueue].map(file => ({arquivo:path.basename(file),existe:fs.existsSync(file)}))},
      checks
    });
  } catch(e) {
    res.status(500).json({ok:false,msg:e.message || 'Falha ao executar diagnóstico.'});
  }
});
;

app.post('/api/desconectar', requireAdmin, async (req,res) => {
  // Desconectar pelo painel agora significa ENCERRAR a sessão atual e
  // preparar imediatamente um novo QR para outro número.
  // Também limpamos o cache de grupos/seleções para nunca deixar grupos
  // do número anterior aparecendo depois da troca de conta.
  clearReconnect();
  stopSchedulers();
  clearLinkHistory();
  clearLinkFailures();
  manualDisconnected=true;

  const old=sock;
  sock=null;
  online=false;
  qr=null;
  connectedNumber='';
  groups=[];
  lastGroupRefreshAt=0;
  allowed=[];

  try {
    if (old) await old.logout();
  } catch(e) {
    addLog(`Logout no desconectar: ${e.message}`);
  }
  try { old?.end(); } catch {}

  // Não reutilizar permissões dos grupos da conta anterior.
  try { writeJson(FILES.groups, []); } catch(e) {
    addLog(`Erro limpando grupos permitidos: ${e.message}`);
  }

  try { fs.rmSync(AUTH,{recursive:true,force:true}); } catch(e) {
    addLog(`Erro limpando sessão: ${e.message}`);
  }

  status='Gerando novo QR Code...';
  addLog('Conta desconectada pelo painel. Grupos antigos removidos; iniciando novo QR.');

  // O fechamento provocado pelo logout não deve disparar reconexão automática.
  // Reativamos o ciclo normal somente antes de iniciar a nova sessão.
  res.json({ok:true,msg:'WhatsApp desconectado. Os grupos antigos foram removidos. Gerando novo QR Code...'});

  setTimeout(() => {
    manualDisconnected=false;
    start();
  }, 700);
});

app.post('/api/novo-qr', requireAdmin, async (req,res) => {
  // Novo QR = nova sessão. Limpa todos os dados da sessão anterior.
  clearReconnect();
  stopSchedulers();
  clearLinkHistory();
  clearLinkFailures();
  manualDisconnected=false;
  try { linkSchedules=[]; writeJson(FILES.schedules, linkSchedules); } catch(e) { addLog(`Erro limpando agendamentos: ${e.message}`); }
  try { groups=[]; allowed=[]; writeJson(FILES.groups, []); } catch(e) { addLog(`Erro limpando grupos: ${e.message}`); }
  const old=sock;
  sock=null; online=false; qr=null; connectedNumber='';
  status='Gerando novo QR Code...';
  addLog('Novo QR solicitado pelo painel. Sessão anterior e dados associados foram limpos.');
  try { old?.end(); } catch {}
  try { fs.rmSync(AUTH,{recursive:true,force:true}); } catch(e) { addLog(`Erro limpando sessão: ${e.message}`); }
  // Responde antes de iniciar o socket para evitar corrida com o navegador.
  res.json({ok:true,msg:'Sessão limpa. O novo QR será exibido automaticamente.'});
  setTimeout(() => start(), 350);
});

app.post('/api/deslogar', requireAdmin, async (req,res) => {
  clearReconnect(); stopSchedulers(); clearLinkHistory();
  clearLinkFailures(); manualDisconnected=false;
  try { linkSchedules=[]; writeJson(FILES.schedules, linkSchedules); } catch(e) { addLog(`Erro limpando agendamentos: ${e.message}`); }
  try { groups=[]; allowed=[]; writeJson(FILES.groups, []); } catch(e) { addLog(`Erro limpando grupos: ${e.message}`); }
  const old=sock; sock=null; online=false; qr=null; connectedNumber='';
  status='Removendo sessão...';
  try { await old?.logout(); } catch(e) { addLog(`Logout: ${e.message}`); }
  try { old?.end(); } catch {}
  try { fs.rmSync(AUTH,{recursive:true,force:true}); } catch(e) { addLog(`Erro limpando sessão: ${e.message}`); }
  status='Gerando novo QR Code...';
  addLog('Sessão removida; iniciando nova autenticação.');
  res.json({ok:true,msg:'Sessão removida. O novo QR será exibido automaticamente.'});
  setTimeout(() => start(), 500);
});

app.get('/api/grupos', async (req,res) => {
  // Consulta somente o cache. A descoberta no WhatsApp ocorre na conexão
  // ou quando o usuário solicita explicitamente "Pesquisar grupos".
  res.json({
    ok:true,
    grupos:groups.map(g => ({...g,config:getGroupConfig(g.id),allowed:allowed.includes(g.id)})),
    permitidos:allowed,
    gruposCacheAt:lastGroupRefreshAt || null,
    gruposRateLimitUntil:groupRateLimitUntil || null
  });
});
app.post('/api/grupos/atualizar', async (req,res) => {
  if(!online) return res.status(503).json({ok:false,msg:'WhatsApp não conectado.'});
  const ok=await loadGroups();
  if (ok) return res.status(200).json({ok:true,msg:groups.length+' grupo(s) carregado(s).',grupos:groups,permitidos:allowed});
  const retryAfterMs=Math.max(0,groupRateLimitUntil-Date.now());
  const statusCode=retryAfterMs>0?429:500;
  return res.status(statusCode).json({
    ok:false,
    msg:retryAfterMs>0?'Atualização dos grupos em espera. Tente novamente em ~'+Math.ceil(retryAfterMs/1000)+'s.':'Não foi possível atualizar os grupos.',
    retryAfterMs,grupos:groups,permitidos:allowed
  });
});
app.post('/api/grupos/config', (req,res) => {
  const id=String(req.body?.id||'');
  if(!id) return res.status(400).json({ok:false,msg:'Grupo inválido.'});
  const c=getGroupConfig(id);
const grupoAtual=groups.find(g=>String(g.id)===id);
if(grupoAtual?.name) c.nome=grupoAtual.name;
if(typeof req.body.ativo==='boolean') {
  c.ativo=req.body.ativo;
  // Mantém "Permitidos" sincronizado com "Ligados" para evitar dois estados diferentes.
  if(c.ativo) allowed=[...new Set([...allowed,id])];
  else allowed=allowed.filter(x=>String(x)!==id);
  writeJson(FILES.groups, allowed);
}
  saveGroupsConfig();
  res.json({ok:true,config:c,permitidos:allowed,msg:c.ativo?'Envio ligado.':'Envio desligado.'});
});
app.post('/api/grupos/salvar', (req,res) => {
  if(!Array.isArray(req.body?.ids)) return res.status(400).json({ok:false,msg:'IDs inválidos.'});
  allowed=[...new Set(req.body.ids.map(String))];
  writeJson(FILES.groups,allowed);
  res.json({ok:true,msg:`${allowed.length} grupo(s) permitido(s).`});
});

app.get('/api/mensagem', (req,res)=>res.json({ok:true}));
app.post('/api/mensagem', async (req,res) => {
  const message=String(req.body?.message||'').trim();
  if(!message) return res.status(400).json({ok:false,msg:'Digite uma mensagem.'});
  if(!online || !sock) return res.status(409).json({ok:false,msg:'WhatsApp não está conectado.'});
  if(!botWindowActive()) return res.status(409).json({ok:false,msg:'O bot está fora do horário programado.'});
  const targets=activeGroups();
  if(!targets.length) return res.status(409).json({ok:false,msg:'Nenhum grupo está com o envio Ligado.'});
  let sent=0,errors=0;
  for(const jid of targets) {
    try {
      await sock.sendMessage(jid,{text:message});
      sent++;
      addHistory({grupoId:jid,link:'mensagem manual',status:'sucesso',tipo:'manual'});
      await new Promise(r=>setTimeout(r,700));
    } catch(e) {
      errors++;
      addHistory({grupoId:jid,link:'mensagem manual',status:'erro',erro:e.message,tipo:'manual'});
    }
  }
  addLog(`Mensagem manual: ${sent}/${targets.length}.`);
  res.json({ok:true,sent,errors,msg:`Enviado para ${sent} de ${targets.length} grupo(s) Ligado(s).`});
});

app.get('/api/link-agendamentos',(req,res)=>{
  try {
    const agendamentos=Array.isArray(linkSchedules)?linkSchedules:[];
    res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma','no-cache');
    res.set('Expires','0');
    return res.json({ok:true,agendamentos});
  } catch(e) {
    addLog(`Erro na API de agendamentos: ${e.message}`);
    return res.status(500).json({ok:false,msg:'Não foi possível carregar os agendamentos.'});
  }
});
app.get('/api/links',(req,res)=>{
  try {
    const agendamentos=Array.isArray(linkSchedules)?linkSchedules:[];
    res.set('Cache-Control','no-store');
    res.json({ok:true,links:agendamentos,agendamentos});
  } catch(e) { res.status(500).json({ok:false,msg:'Não foi possível carregar os links.'}); }
});

// REGULOS_ASSISTENTE_CHAT_V2_5
// Contexto conversacional + consulta real de agendamentos/recorrências.
app.post('/api/assistente/chat', requireAuth, (req,res)=>{
  try{
    const pergunta=String(req.body?.pergunta||'').trim();
    if(!pergunta) return res.status(400).json({ok:false,msg:'Digite uma pergunta.'});

    const q=pergunta.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const contexto=Array.isArray(req.body?.contexto)?req.body.contexto.slice(-6):[];
    const ultimaResposta=contexto.slice().reverse().find(x=>x&&x.role==='assistant'&&x.periodoLabel);
    const ultimaPerguntaUsuario=contexto.slice().reverse().find(x=>x&&x.role==='user'&&x.content);
    const perguntaAnterior=String(ultimaPerguntaUsuario?.content||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const continuidade=/^\s*(e|tambem|eles|elas|os que|as que|esses|essas|mesmo periodo|nesse periodo|destes|destas|desses|dessas)\b/.test(q)
      || /\b(os que|as que|esses|essas|mesmo periodo|nesse periodo|destes|destas|desses|dessas)\b/.test(q);
    const contextoEraFalha=/\b(erro|erros|falha|falhas|falhou|falharam|falhar|problema|problemas|motivo|motivos)\b/.test(perguntaAnterior);
    const contextoEraAgendamento=/\b(agendad|programad|agendamento|agendamentos|programacao|programacoes)\b/.test(perguntaAnterior);

    const now=new Date();
    const periodoSolicitado=Math.max(1,Math.min(90,Number(req.body?.periodoSolicitado||7)));
    const startOfDay=d=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
    const addDays=(ms,n)=>ms+(n*86400000);
    const localDateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const todayKey=localDateKey(now);
    const todayStart=startOfDay(now);
    let startMs=todayStart, endMs=addDays(todayStart,1), periodo=1, periodoLabel='hoje';

    const rangeMatch=q.match(/(?:de|entre)\s+(ontem|hoje)\s+(?:a|ate|para|e)\s+(ontem|hoje)/);
    const numericRange=q.match(/(?:de|entre)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?\s+(?:a|ate|para|e)\s+(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?/);
    if(rangeMatch){
      const a=rangeMatch[1],b=rangeMatch[2];
      const as=a==='ontem'?addDays(todayStart,-1):todayStart, bs=b==='ontem'?addDays(todayStart,-1):todayStart;
      startMs=Math.min(as,bs); endMs=addDays(Math.max(as,bs),1); periodo=Math.max(1,Math.round((endMs-startMs)/86400000)); periodoLabel=a+' para '+b;
    }else if(numericRange){
      const y1=Number(numericRange[3]||now.getFullYear()),y2=Number(numericRange[6]||y1);
      const d1=new Date(y1,Number(numericRange[2])-1,Number(numericRange[1])),d2=new Date(y2,Number(numericRange[5])-1,Number(numericRange[4]));
      if(!Number.isNaN(d1.getTime())&&!Number.isNaN(d2.getTime())){
        startMs=startOfDay(d1);endMs=addDays(startOfDay(d2),1);
        if(endMs<startMs){const t=startMs;startMs=endMs-86400000;endMs=t+86400000;}
        periodo=Math.max(1,Math.round((endMs-startMs)/86400000));periodoLabel=numericRange[1]+'/'+numericRange[2]+' a '+numericRange[4]+'/'+numericRange[5];
      }
    }else if(/\b(de ontem para hoje|de ontem ate hoje|de ontem a hoje|desde ontem|a partir de ontem)\b/.test(q)){
      startMs=addDays(todayStart,-1);endMs=addDays(todayStart,1);periodo=2;periodoLabel='ontem e hoje';
    }else if(/\bontem\b/.test(q)&&!/\bhoje\b/.test(q)){
      startMs=addDays(todayStart,-1);endMs=todayStart;periodo=1;periodoLabel='ontem';
    }else if(/\bhoje\b/.test(q)){
      startMs=todayStart;endMs=addDays(todayStart,1);periodo=1;periodoLabel='hoje';
    }else{
      const pm=q.match(/(?:ultimos?|ultimas?)\s+(\d+)\s+dias?/);
      if(pm){periodo=Math.max(1,Math.min(90,Number(pm[1])));startMs=addDays(todayStart,-(periodo-1));endMs=addDays(todayStart,1);periodoLabel='ultimos '+periodo+' dias';}
      else if(/7 dias|semana/.test(q)){periodo=7;startMs=addDays(todayStart,-6);endMs=addDays(todayStart,1);periodoLabel='ultimos 7 dias';}
      else if(/15 dias/.test(q)){periodo=15;startMs=addDays(todayStart,-14);endMs=addDays(todayStart,1);periodoLabel='ultimos 15 dias';}
      else if(/30 dias|mes/.test(q)){periodo=30;startMs=addDays(todayStart,-29);endMs=addDays(todayStart,1);periodoLabel='ultimos 30 dias';}
      else if(/90 dias/.test(q)){periodo=90;startMs=addDays(todayStart,-89);endMs=addDays(todayStart,1);periodoLabel='ultimos 90 dias';}
      else {periodo=periodoSolicitado;startMs=addDays(todayStart,-(periodo-1));endMs=addDays(todayStart,1);periodoLabel='ultimos '+periodo+' dias';}
    }

    if(continuidade&&ultimaResposta?.intervalo?.inicio&&ultimaResposta?.intervalo?.fim&&!/\b(hoje|ontem|ultimos?|ultimas?|dias?|semana|mes|entre|de)\b/.test(q)){
      const ci=Date.parse(ultimaResposta.intervalo.inicio), cf=Date.parse(ultimaResposta.intervalo.fim);
      if(Number.isFinite(ci)&&Number.isFinite(cf)&&cf>ci){
        startMs=ci;endMs=cf;periodo=Math.max(1,Math.round((cf-ci)/86400000));periodoLabel=String(ultimaResposta.periodoLabel);
      }
    }

    const inPeriod=v=>{const t=Date.parse(v||'');return Number.isFinite(t)&&t>=startMs&&t<endMs;};
    const deliveries=Array.isArray(linkDeliveries)?linkDeliveries.filter(x=>inPeriod(x.concluidoEm||x.criadoEm||x.at)):[];
    const failures=Array.isArray(linkFailures)?linkFailures.filter(x=>inPeriod(x.at||x.updatedAt||x.createdAt||x.data)):[];
    const schedules=Array.isArray(linkSchedules)?linkSchedules:[];
    const scheduleById=new Map(schedules.map(s=>[String(s.id),s]));
    const success=deliveries.filter(x=>String(x.status||'').toUpperCase()==='SUCESSO').length;
    const errors=deliveries.filter(x=>String(x.status||'').toUpperCase()==='ERRO').length;
    const sending=deliveries.filter(x=>String(x.status||'').toUpperCase()==='ENVIANDO').length;
    const total=success+errors+sending;
    const pct=total?Math.round(success/total*100):0;

    const names=new Map();
    deliveries.forEach(x=>{
      const id=String(x.agendamentoId||x.linkId||'');if(!id)return;
      const item=scheduleById.get(id);
      const nome=String(x.nome||item?.nome||id);
      const cur=names.get(id)||{nome,sucesso:0,erro:0,tentativas:0};
      const st=String(x.status||'').toUpperCase();
      cur.tentativas+=Number(x.tentativas||1);
      if(st==='SUCESSO')cur.sucesso++;
      if(st==='ERRO')cur.erro++;
      names.set(id,cur);
    });
    const ranking=[...names.values()].sort((a,b)=>(b.erro-a.erro)||(b.tentativas-a.tentativas)).slice(0,5);

    const topFailures={};
    failures.forEach(x=>{
      const k=String(x.erro||x.motivo||'Falha não informada').trim()||'Falha não informada';
      topFailures[k]=(topFailures[k]||0)+1;
    });
    const failureList=Object.entries(topFailures).sort((a,b)=>b[1]-a[1]).slice(0,3);

    const recomendacoes=[];
    if(errors>0){
      if(pct<70) recomendacoes.push('A taxa de sucesso está baixa; vale revisar os links que mais falharam antes de aumentar os envios.');
      else if(pct<90) recomendacoes.push('A taxa de sucesso está razoável, mas há espaço para reduzir as falhas dos links com maior recorrência.');
      else recomendacoes.push('A taxa de sucesso está alta; concentre a revisão nos poucos erros restantes.');
    }
    if(failureList.length) recomendacoes.push('A principal causa registrada é "'+failureList[0][0]+'". Recomendo verificar essa causa primeiro.');
    if(ranking[0]?.erro>0) recomendacoes.push('O link "'+ranking[0].nome+'" concentra '+ranking[0].erro+' erro(s). Recomendo revisar esse link antes de reenviar.');
    if(sending>0) recomendacoes.push('Há '+sending+' entrega(s) ainda em andamento; aguarde a conclusão antes de interpretar esse resultado como definitivo.');
    if(!total&&!failures.length) recomendacoes.push('Não há dados de entrega no período selecionado; confirme se houve envio nesse intervalo.');

    const intencaoAgendamentos=/\b(quais|qual|mostre|mostrar|liste|listar|tem|tenho|estao|esta|o que)\b/.test(q)
      && /\b(link|links|agendamento|agendamentos)\b/.test(q)
      && /\b(agendad\w*|programad\w*|programacao|programacoes|marcad\w*|previst\w*)\b/.test(q);
    const intencaoAgendamentosHoje=intencaoAgendamentos || (continuidade&&contextoEraAgendamento);
    const intencaoComparar=/\b(compar|compare|comparar|melhorou|piorou|evolucao|evoluiu)\b/.test(q);
    const intencaoAnalise=/\b(como esta|como estao|analise|analisar|desempenho|resultado|resultados|situacao)\b/.test(q);
    const intencaoRecomendacao=/\b(recomenda|recomendacao|sugestao|sugira|o que devo|que devo|o que fazer|como melhorar)\b/.test(q);
    const agendamentoContexto=ultimaResposta?.agendamentoSelecionado||null;
    const intencaoFalhas=/\b(erro|erros|falha|falhas|falhou|falharam|falhar|problema|problemas|por que|porque|motivo|motivos)\b/.test(q)
      || (continuidade&&contextoEraFalha)
      || (agendamentoContexto && /\b(problema|problemas|erro|erros|falha|falhas)\b/.test(q));

    function scheduleOccursToday(item){
      if(!item || !item.data || !item.horario) return false;
      if(item.repeticao==='diariamente') return new Date(`${item.data}T${item.horario}:00`).getTime()<=now.getTime();
      if(item.repeticao==='semanalmente'){
        const base=new Date(`${item.data}T${item.horario}:00`);
        return !Number.isNaN(base.getTime()) && now.getDay()===base.getDay() && base.getTime()<=now.getTime();
      }
      return String(item.data)===todayKey;
    }

    function scheduleGroupDetails(item){
      const ids=normalizeScheduleGroupIds(item);
      const detalhes=ids.map(id=>{
        const key=String(id);
        const nome=String(item?.grupoNomes?.[key]||groupNameForId(key)||'').trim();
        const permitido=allowed.some(x=>String(x)===key);
        const ativo=groups.find(g=>String(g?.id||'')===key)?.allowed===true || permitido;
        return {id:key,nome:nome||key,permitido,ativo};
      });
      return detalhes.filter(x=>x.id);
    }
    function scheduleGroupLabel(item){
      const detalhes=scheduleGroupDetails(item);
      if(!detalhes.length) return 'grupo não informado';
      return detalhes.map(x=>x.nome).join(', ');
    }
    function formatSchedule(item){
      const grupo=scheduleGroupLabel(item);
      const status=String(item.status|| (item.ativo===false?'pausado':'agendado')).toLowerCase();
      const statusLabel={agendado:'AGENDADO',enviando:'ENVIANDO',concluido:'CONCLUÍDO',erro:'ERRO',aguardando_grupo:'AGUARDANDO GRUPO',pausado:'PAUSADO'}[status]||status.toUpperCase();
      return '• '+String(item.nome||item.id)+' — '+String(item.horario||'sem horário')+' — '+grupo+' — '+statusLabel;
    }

    let resposta='';
    const horarioPedido=(q.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/)||[]).slice(1);
    const horarioNormalizado=horarioPedido.length?String(horarioPedido[0]).padStart(2,'0')+':'+horarioPedido[1]:null;
    const perguntaAnteriorTexto=String(ultimaPerguntaUsuario?.content||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const ultimaRespostaTexto=String(ultimaResposta?.content||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    let agendamentoSelecionado=agendamentoContexto||null;
    const horarioAnteriorMatch=(perguntaAnteriorTexto.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/)||ultimaRespostaTexto.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/));
    const horarioAnterior=agendamentoContexto?.horario|| (horarioAnteriorMatch?String(horarioAnteriorMatch[1]).padStart(2,'0')+':'+horarioAnteriorMatch[2]:null);
    const intencaoAgendamentoEspecifico=Boolean(horarioNormalizado)&&/\b(link|links|agendamento|agendamentos)\b/.test(q)
      &&/\b(qual|quais|onde|qual\s+link)\b/.test(q);
    const referenciaAgendamento=/\b(ele|ela|dele|dela|desse|dessa|esse|essa|deste|desta|o mesmo|a mesma|isso)\b/.test(q);
    const intencaoStatusAgendamento=Boolean(horarioAnterior)&&/\b(status|situacao|situação|estado)\b/.test(q)
      &&(/\b(link|agendamento|agendado|programado|ele|esse|desse)\b/.test(q)||Boolean(agendamentoContexto));
    const intencaoGrupoAgendamento=(Boolean(agendamentoContexto)||Boolean(horarioAnterior)||Boolean(horarioNormalizado))
      &&/\b(grupo|grupos|onde sera|onde vai|para onde)\b/.test(q)
      &&/\b(ver|mostrar|mostre|qual|quais|onde|desse|deste|agendamento|link|links)\b/.test(q);
    const intencaoDetalhesAgendamento=(Boolean(agendamentoContexto)||Boolean(horarioAnterior)||Boolean(horarioNormalizado))
      &&/\b(detalhes|detalhes completos|informacoes|informações|dados)\b/.test(q)
      &&(/\b(link|agendamento|agendado|programado|ele|esse|desse|deste)\b/.test(q)||Boolean(agendamentoContexto));
    const intencaoOutrosHorarios=/\b(outros|outras)\b/.test(q)
      &&/\b(horarios|horários|links|agendamentos)\b/.test(q)
      &&/\b(programados|programadas|agendados|agendadas|hoje)\b/.test(q);
    const intencaoVoltarAgendamentos=/\b(voltar|volte|voltemos)\b/.test(q)
      &&/\b(agendamento|agendamentos|programacao|programação|horarios|horários)\b/.test(q);
    const intencaoProximoAgendamento=/\b(proximo|proxima|seguinte)\b/.test(q)
      &&/\b(link|agendamento|agendamentos|envio|enviado|enviar)\b/.test(q);
    const intencaoPausados=/\b(pausad|pausados|pausadas|pausa)\w*\b/.test(q)
      &&/\b(link|links|agendamento|agendamentos)\b/.test(q);
    const intencaoRecomendacaoAgendamento=(Boolean(agendamentoContexto)||Boolean(horarioAnterior)||Boolean(horarioNormalizado))&&/\b(recomenda|recomendacao|sugestao|sugira|o que devo|o que eu deveria|que devo|o que fazer|o que eu faco|como melhorar|devo fazer)\b/.test(q)
      &&(/\b(link|agendamento|agendado|programado|ele|esse|desse)\b/.test(q)||Boolean(agendamentoContexto));
    const intencaoDiagnosticoAgendamento=(Boolean(agendamentoContexto)||Boolean(horarioAnterior)||Boolean(horarioNormalizado))
      &&/\b(problema|problemas|erro|erros|falha|falhou|falhando|nao foi enviado|não foi enviado|nao enviou|não enviou|por que|porque|o que esta acontecendo|o que está acontecendo|por qual motivo|motivo|travou|travado|pendente|parado|aguardando)\b/.test(q)
      &&(/\b(link|agendamento|agendado|programado|ele|esse|desse|dele|deste)\b/.test(q)||Boolean(agendamentoContexto));
    if(intencaoDiagnosticoAgendamento){
      const item=agendamentoContexto || (horarioNormalizado||horarioAnterior
        ? schedules.find(x=>String(x.horario||'').slice(0,5)===(horarioNormalizado||horarioAnterior))
        : null);
      if(!item){
        resposta='🔎 Não consegui identificar qual agendamento você quer diagnosticar. Selecione um agendamento primeiro.';
      }else{
        agendamentoSelecionado=item;
        const itemId=String(item.id||'');
        const itemDeliveries=deliveries.filter(d=>String(d?.agendamentoId||'')===itemId);
        const itemFailures=failures.filter(f=>String(f?.agendamentoId||'')===itemId);
        const status=String(item.status||'').toLowerCase();
        const grupos=scheduleGroupDetails(item).map(x=>x.nome+(x.permitido?' (permitido)':' (não está na lista de permitidos)'));
        const gruposTexto=grupos.length?grupos.join(', '):'nenhum grupo registrado';
        const tentativas=itemDeliveries.reduce((n,d)=>n+Number(d?.tentativas||0),0);
        const errosEntrega=itemDeliveries.filter(d=>String(d?.status||'').toUpperCase()==='ERRO').length;
        const enviando=itemDeliveries.filter(d=>String(d?.status||'').toUpperCase()==='ENVIANDO').length;
        const pendentes=itemDeliveries.filter(d=>String(d?.status||'').toUpperCase()==='PENDENTE').length;

        resposta='🔎 Diagnóstico do agendamento das '+String(item.horario||horarioNormalizado||horarioAnterior||'').slice(0,5)+':';
        resposta+='\n• Status: '+String(item.status|| (item.ativo===false?'PAUSADO':'AGENDADO')).toUpperCase();
        resposta+='\n• Grupo(s): '+gruposTexto;
        resposta+='\n• Tentativas registradas: '+tentativas;
        if(errosEntrega||Number(item.erros||0)>0) resposta+='\n• ⚠️ Falhas: '+Math.max(errosEntrega,Number(item.erros||0));
        if(enviando) resposta+='\n• ⏳ Entregas em andamento: '+enviando;
        if(pendentes) resposta+='\n• 🕐 Entregas pendentes: '+pendentes;

        if(status==='erro'||Number(item.erros||0)>0||errosEntrega||itemFailures.length){
          resposta+='\n\n🚨 Há indícios de problema neste agendamento.';
          const motivos=itemFailures.map(f=>String(f?.erro||f?.motivo||'').trim()).filter(Boolean);
          const motivoPrincipal=motivos[0]||'';
          if(motivoPrincipal) resposta+='\n• Motivo registrado: '+motivoPrincipal;
          if(status==='erro') resposta+='\n• O agendamento terminou com ERRO.';
          if(!grupos.length) resposta+='\n• O agendamento não possui grupo identificado. Revise o destino antes de reenviar.';
          else if(grupos.some(g=>g.includes('(não está na lista de permitidos)'))) resposta+='\n• O grupo identificado não está na lista de permitidos. Verifique a autorização do grupo.';

          // Cadeia de causa: transforma os dados brutos do agendamento em uma explicação operacional.
          const motivoNorm=motivoPrincipal.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
          let causa='falha na execução do envio';
          let causaDetalhe='o RegulOS registrou uma ocorrência de erro para este agendamento';
          let acao='revisar o histórico da entrega e o destino antes de reenviar';
          if(!grupos.length){
            causa='destino não identificado';
            causaDetalhe='o agendamento não possui um grupo de destino resolvido';
            acao='selecionar ou corrigir o grupo de destino e tentar novamente';
          }else if(grupos.some(g=>g.includes('(não está na lista de permitidos)'))){
            causa='grupo não autorizado';
            causaDetalhe='o grupo existe, mas não está na lista de grupos permitidos';
            acao='autorizar o grupo e depois reenviar o agendamento';
          }else if(/imagem|foto|thumbnail|midia|media|download|http|https/.test(motivoNorm)){
            causa='problema ao obter a mídia do link';
            causaDetalhe=motivoPrincipal||'a imagem/mídia não pôde ser obtida ou validada';
            acao='revisar o link ou a imagem automática e reenviar após corrigir';
          }else if(/grupo|jid|group|participante|nao encontrado|not found|disponivel|conect/.test(motivoNorm)){
            causa='problema no grupo de destino';
            causaDetalhe=motivoPrincipal||'o grupo não estava disponível para o envio';
            acao='confirmar se o grupo está carregado, permitido e conectado antes de reenviar';
          }else if(/timeout|tempo|rate.?limit|429|limite/.test(motivoNorm)){
            causa='indisponibilidade temporária';
            causaDetalhe=motivoPrincipal||'o envio encontrou uma limitação ou demora temporária';
            acao='aguardar a normalização e tentar novamente, evitando múltiplos reenvios simultâneos';
          }else if(motivoPrincipal){
            causa='erro registrado durante a entrega';
            causaDetalhe=motivoPrincipal;
            acao='corrigir a causa indicada e então reenviar';
          }
          resposta+='\n\n🧩 Causa provável: '+causa+'.';
          resposta+='\n• Explicação: '+causaDetalhe+'.';
          resposta+='\n• Fluxo: agendamento → grupo → tentativa → resultado ERRO.';
          resposta+='\n\n💡 Próxima ação recomendada: '+acao+'.';
        }else if(status==='aguardando_grupo'){
          resposta+='\n\n⚠️ O agendamento está aguardando um grupo disponível.';
          resposta+='\n💡 Próxima ação recomendada: confirme se o grupo está conectado, carregado e permitido.';
        }else if(status==='pausado'||item.ativo===false){
          resposta+='\n\n⏸️ O agendamento está pausado.';
          resposta+='\n💡 Próxima ação recomendada: reative-o somente se esse envio ainda for necessário.';
        }else if(status==='enviando'||enviando){
          resposta+='\n\n⏳ O envio está em andamento.';
          resposta+='\n💡 Próxima ação recomendada: aguarde a conclusão antes de tentar reenviar.';
        }else if(pendentes){
          resposta+='\n\n🕐 Há entrega pendente para esse agendamento.';
          resposta+='\n💡 Próxima ação recomendada: aguarde a execução; se permanecer pendente, verifique o grupo e o histórico.';
        }else{
          resposta+='\n\n✅ Não encontrei falha registrada neste agendamento.';
          resposta+='\n💡 Próxima ação recomendada: manter o agendamento ativo e acompanhar a execução.';
        }
      }
    }else if(intencaoDetalhesAgendamento){
      const horarioAlvo=horarioNormalizado||horarioAnterior;
      let encontrados=agendamentoContexto?[agendamentoContexto]:(horarioAlvo?schedules.filter(item=>String(item.horario||'').slice(0,5)===horarioAlvo):[]);
      if(!encontrados.length) resposta='🔎 Não consegui identificar o agendamento para mostrar os detalhes.';
      else{
        agendamentoSelecionado=encontrados.length===1?encontrados[0]:agendamentoSelecionado;
        resposta=encontrados.map(item=>{
          const detalhes=scheduleGroupDetails(item);
          const gruposTexto=detalhes.length?detalhes.map(x=>x.nome+(x.permitido?' (permitido)':' (não está na lista de permitidos)')).join(', '):'nenhum grupo registrado';
          return '🔎 Detalhes do agendamento:\n• Link: '+String(item.nome||item.id)+'\n• Horário: '+String(item.horario||'sem horário')+'\n• Grupo(s): '+gruposTexto+'\n• Status: '+String(item.status|| (item.ativo===false?'PAUSADO':'AGENDADO')).toUpperCase()+'\n• Ativo: '+(item.ativo===false?'NÃO':'SIM')+'\n• Repetição: '+String(item.repeticao||'uma vez');
        }).join('\n\n');
      }
    }else if(intencaoOutrosHorarios){
      const lista=schedules.filter(scheduleOccursToday).sort((a,b)=>String(a.horario||'99:99').localeCompare(String(b.horario||'99:99')));
      const selecionadoId=agendamentoContexto?.id||agendamentoSelecionado?.id;
      const outros=selecionadoId?lista.filter(item=>String(item.id)!==String(selecionadoId)):lista;
      if(!outros.length) resposta='📅 Não encontrei outros links programados para hoje.';
      else resposta='📅 Outros links programados para hoje:\n'+outros.map(formatSchedule).join('\n');
    }else if(intencaoVoltarAgendamentos){
      const lista=schedules.filter(scheduleOccursToday).sort((a,b)=>String(a.horario||'99:99').localeCompare(String(b.horario||'99:99')));
      if(!lista.length) resposta='📅 Não encontrei links programados para hoje.';
      else resposta='📅 Links programados para hoje:\n'+lista.map(formatSchedule).join('\n');
    }else if(intencaoGrupoAgendamento){
      const horarioAlvo=horarioNormalizado||horarioAnterior;
      let encontrados=[];
      if(agendamentoContexto){
        encontrados=[agendamentoContexto];
      }else if(horarioAlvo){
        encontrados=schedules.filter(item=>String(item.horario||'').slice(0,5)===horarioAlvo);
      }
      if(!encontrados.length){
        resposta='👥 Não consegui identificar o agendamento para consultar o grupo. Tente selecionar um agendamento específico primeiro.';
      }else{
        agendamentoSelecionado=encontrados.length===1?encontrados[0]:agendamentoSelecionado;
        resposta=encontrados.map(item=>{
          const detalhes=scheduleGroupDetails(item);
          if(!detalhes.length) return '👥 Grupo(s) do agendamento:\n• '+String(item.nome||item.id)+' — nenhum grupo registrado neste agendamento.';
          return '👥 Grupo(s) do agendamento:\n• '+String(item.nome||item.id)+' — '+detalhes.map(x=>x.nome+(x.permitido?' (permitido)':' (não está na lista de permitidos)')).join(', ');
        }).join('\n');
      }
    }else if(intencaoProximoAgendamento){
      const futuros=schedules.filter(item=>{
        if(item.ativo===false||!item.data||!item.horario) return false;
        const dt=new Date(String(item.data)+'T'+String(item.horario).slice(0,5)+':00');
        if(Number.isNaN(dt.getTime())) return false;
        if(item.repeticao==='diariamente') return true;
        if(item.repeticao==='semanalmente') return dt.getDay()===now.getDay();
        return dt.getTime()>=now.getTime();
      }).map(item=>{
        let dt=new Date(String(item.data)+'T'+String(item.horario).slice(0,5)+':00');
        if(item.repeticao==='diariamente'&&dt.getTime()<now.getTime()) dt=new Date(now.getFullYear(),now.getMonth(),now.getDate(),Number(String(item.horario).slice(0,2)),Number(String(item.horario).slice(3,5)));
        return {item,dt};
      }).filter(x=>x.dt.getTime()>=now.getTime()).sort((a,b)=>a.dt-b.dt);
      if(!futuros.length) resposta='📅 Não encontrei nenhum próximo link agendado.';
      else {
        const selecionadoId=agendamentoContexto?.id||agendamentoSelecionado?.id||null;
        let indice=0;
        if(selecionadoId){
          const atual=futuros.findIndex(x=>String(x.item.id)===String(selecionadoId));
          if(atual>=0) indice=atual+1;
        }
        if(indice>=futuros.length) resposta='📅 Não há outro agendamento depois do atual.';
        else {
          agendamentoSelecionado=futuros[indice].item;
          resposta=(indice>0?'⏭️ O próximo agendamento na sequência é:\n':'⏭️ O próximo link programado é:\n')+formatSchedule(futuros[indice].item);
        }
      }
    }else if(intencaoPausados){
      const pausados=schedules.filter(item=>item.ativo===false || String(item.status||'').toLowerCase()==='pausado');
      if(!pausados.length) resposta='✅ Não encontrei links ou agendamentos pausados.';
      else{
        // Quando existe apenas um pausado, ele passa a ser o agendamento selecionado.
        // Assim, perguntas como "o que eu deveria fazer com esse link?" continuam
        // apontando para o mesmo link, sem cair em outro horário por contexto anterior.
        if(pausados.length===1) agendamentoSelecionado=pausados[0];
        resposta='⏸️ Encontrei '+pausados.length+' agendamento(s) pausado(s):\n'+pausados.map(formatSchedule).join('\n');
      }
    }else if(intencaoRecomendacaoAgendamento){
      const horarioAlvo=horarioNormalizado||horarioAnterior;
      // Prioriza o agendamento que veio do contexto da conversa. Só usa o horário
      // anterior como fallback quando não existe um agendamento selecionado.
      const selecionado=agendamentoContexto||agendamentoSelecionado||null;
      const encontrados=selecionado
        ? [selecionado]
        : schedules.filter(item=>String(item.horario||'').slice(0,5)===horarioAlvo);
      if(!encontrados.length) resposta='📅 Não consegui identificar qual agendamento você quer avaliar. Selecione um agendamento primeiro.';
      else {
        agendamentoSelecionado=encontrados.length===1?encontrados[0]:agendamentoSelecionado;
        resposta='💡 Recomendação para o agendamento das '+String(encontrados[0].horario||horarioAlvo||'').slice(0,5)+':';
        encontrados.forEach(item=>{
          const st=String(item.status||'').toLowerCase();
          if(st==='erro') resposta+='\n• 🚨 O agendamento está com ERRO: revise o link, o grupo e o motivo registrado antes de reenviar.';
          else if(st==='aguardando_grupo') resposta+='\n• ⚠️ O agendamento está aguardando o grupo: confirme se o grupo está disponível e ativo.';
          else if(st==='pausado'||item.ativo===false) resposta+='\n• ⏸️ O agendamento está PAUSADO: verifique o motivo da pausa e só reative se esse envio ainda for necessário.';
          else if(st==='enviando') resposta+='\n• ⏳ O envio está EM ANDAMENTO: aguarde a conclusão antes de reenviar.';
          else resposta+='\n• ✅ Situação atual: '+String(item.status||'AGENDADO').toUpperCase()+'. Não há indicação de intervenção imediata.';
        });
      }
    }else if(intencaoAgendamentoEspecifico){
      const encontrados=schedules.filter(item=>String(item.horario||'').slice(0,5)===horarioNormalizado);
      if(!encontrados.length) resposta='📅 Não encontrei nenhum link agendado para '+horarioNormalizado+' hoje.';
      else { agendamentoSelecionado=encontrados.length===1?encontrados[0]:null; resposta='📅 Encontrei '+encontrados.length+' agendamento(s) para '+horarioNormalizado+' hoje:\n'+encontrados.map(formatSchedule).join('\n'); }
    }else if(intencaoStatusAgendamento){
      const encontrados=schedules.filter(item=>String(item.horario||'').slice(0,5)===horarioAnterior);
      if(!encontrados.length) resposta='📅 Não encontrei o agendamento das '+horarioAnterior+' para consultar o status.';
      else { agendamentoSelecionado=encontrados.length===1?encontrados[0]:agendamentoSelecionado; resposta='📌 Status do agendamento das '+horarioAnterior+':\n'+encontrados.map(formatSchedule).join('\n'); }
    }else if(intencaoAgendamentosHoje){
      const agendados=schedules.filter(scheduleOccursToday).sort((a,b)=>String(a.horario||'99:99').localeCompare(String(b.horario||'99:99')));
      if(!agendados.length){
        resposta='📅 Não encontrei links programados para hoje.';
      }else{
        resposta='📅 Encontrei '+agendados.length+' link(s) programado(s) para hoje:\n'+agendados.map(formatSchedule).join('\n');
      }
    }else if(intencaoFalhas){
      if(!failures.length&&!errors){
        resposta='Não encontrei falhas registradas em '+periodoLabel+'.';
      }else{
        resposta='Encontrei '+(failures.length||errors)+' ocorrência(s) relacionada(s) a falhas em '+periodoLabel+'.\n'+(failureList.map(x=>'• '+x[0]+' — '+x[1]+' ocorrência(s)').join('\n')||'• Há entregas com ERRO, mas sem motivo detalhado disponível.');
      }
    }else if((intencaoAnalise||intencaoRecomendacao)&&/\b(link|links)\b/.test(q)){
      const top=ranking[0];
      if(top?.erro>0){
        resposta='O link que mais precisa de atenção em '+periodoLabel+' é "'+top.nome+'", com '+top.erro+' erro(s) e '+top.tentativas+' tentativa(s).';
        if(failureList.length) resposta+='\n\n🔎 Principal causa registrada: '+failureList[0][0]+' ('+failureList[0][1]+' ocorrência(s)).';
        if(recomendacoes.length) resposta+='\n\n💡 Recomendações:\n• '+recomendacoes.join('\n• ');
      }else resposta='Não encontrei falhas suficientes em '+periodoLabel+' para apontar um link crítico. A taxa de sucesso foi '+pct+'%.';
    }else if(/\b(agendamento|agendamentos|programacao|programacoes)\b/.test(q)){
      const ativos=schedules.filter(x=>x.ativo!==false).length;
      resposta='No momento há '+ativos+' agendamento(s) ativo(s) de '+schedules.length+' cadastrado(s).';
    }else if(intencaoComparar||intencaoAnalise||intencaoRecomendacao){
      resposta='Em '+periodoLabel+', foram registrados '+total+' envio(s): '+success+' sucesso(s), '+errors+' erro(s) e '+sending+' em andamento.\nTaxa de sucesso: '+pct+'%.';
      if(failureList.length) resposta+='\n\n🔎 Principal padrão: '+failureList[0][0]+' ('+failureList[0][1]+' ocorrência(s)).';
      if(ranking[0]?.erro>0) resposta+='\n🔎 Link que mais precisa de atenção: "'+ranking[0].nome+'" ('+ranking[0].erro+' erro(s)).';
      if(recomendacoes.length) resposta+='\n\n💡 Recomendações:\n• '+recomendacoes.join('\n• ');
    }else if(/\b(sucesso|sucessos|enviado|enviados|envios|entregas)\b/.test(q)){
      resposta='Em '+periodoLabel+', encontrei '+success+' sucesso(s), '+errors+' erro(s) e '+sending+' envio(s) em andamento.\nTaxa de sucesso: '+pct+'%.';
    }else if(/\b(tentativa|tentativas)\b/.test(q)){
      const tent=deliveries.reduce((n,x)=>n+Number(x.tentativas||0),0);
      resposta='Foram registradas '+tent+' tentativa(s) de entrega em '+periodoLabel+'.';
    }else if(/\b(link|links)\b/.test(q)&&/\b(mais|maior|pior)\b/.test(q)){
      const top=ranking[0];
      resposta=top?'O link com maior número de falhas em '+periodoLabel+' é "'+top.nome+'", com '+top.erro+' erro(s) e '+top.tentativas+' tentativa(s).':'Não encontrei dados suficientes para apontar um link.';
    }else{
      resposta='Posso analisar o desempenho do RegulOS e explicar padrões de falha.\nExemplo: "Como estão meus envios nos últimos 7 dias?" ou "O que devo melhorar nos meus envios?"';
    }

    const textosContexto=contexto.filter(x=>x&&x.role==='user'&&x.content).map(x=>String(x.content).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''));
    const acoesAgendamentoRespondidas={
      status:textosContexto.some(t=>/\b(status|situacao|estado)\b/.test(t)&&/\b(link|agendamento|agendado|programado|ele|esse|desse)\b/.test(t)),
      recomendacao:textosContexto.some(t=>/\b(recomenda|recomendacao|sugestao|sugira|o que devo|o que eu deveria|que devo|o que fazer|como melhorar|devo fazer)\b/.test(t)),
      grupo:textosContexto.some(t=>/\b(grupo|grupos)\b/.test(t)&&/\b(ver|mostrar|mostre|qual|quais|onde|desse|deste|agendamento|link|links)\b/.test(t)),
      detalhes:textosContexto.some(t=>/\b(detalhes|informacoes|dados)\b/.test(t)&&/\b(link|agendamento|agendado|programado|ele|esse|desse|deste)\b/.test(t)),
      outros:textosContexto.some(t=>/\b(outros|outras)\b/.test(t)&&/\b(horarios|links|agendamentos)\b/.test(t))
    };
    let sugestoes=[];
    const respostaFoiStatus=intencaoStatusAgendamento||/\bstatus do agendamento\b|\bstatus desse link\b/.test(q);
    const respostaFoiGrupo=intencaoGrupoAgendamento||/\bver o grupo\b|\bgrupo do agendamento\b/.test(q);
    const respostaFoiDetalhes=intencaoDetalhesAgendamento;
    const respostaFoiOutros=intencaoOutrosHorarios||intencaoVoltarAgendamentos;

    const candidatosAgendamento=[];
    if(!acoesAgendamentoRespondidas.status) candidatosAgendamento.push('Qual é o status desse link?');
    if(!acoesAgendamentoRespondidas.recomendacao) candidatosAgendamento.push('O que eu deveria fazer com esse link?');
    if(!acoesAgendamentoRespondidas.grupo) candidatosAgendamento.push('Ver o grupo desse agendamento');
    if(!acoesAgendamentoRespondidas.detalhes) candidatosAgendamento.push('Ver detalhes desse link');
    if(!acoesAgendamentoRespondidas.outros) candidatosAgendamento.push('Quais outros links estão programados hoje?');

    if(agendamentoSelecionado && respostaFoiStatus){
      sugestoes=candidatosAgendamento.filter(s=>s!=='Qual é o status desse link?').slice(0,4);
    }else if(agendamentoSelecionado && (respostaFoiGrupo||respostaFoiDetalhes)){
      sugestoes=candidatosAgendamento.slice(0,4);
      if(!sugestoes.includes('Voltar aos agendamentos') && sugestoes.length<4) sugestoes.push('Voltar aos agendamentos');
    }else if(agendamentoSelecionado && respostaFoiOutros){
      sugestoes=['Qual é o próximo link a ser enviado?','Existe algum agendamento com problema?','Quais links estão pausados?','Voltar aos agendamentos'];
    }else if(agendamentoSelecionado){
      sugestoes=candidatosAgendamento.slice(0,4);
      if(!sugestoes.length) sugestoes=['Qual é o próximo link a ser enviado?','Existe algum agendamento com problema?','Quais links estão pausados?','Voltar aos agendamentos'];
    }else if(intencaoAgendamentosHoje||intencaoAgendamentoEspecifico){
      sugestoes=['Qual é o próximo link a ser enviado?','Existe algum agendamento com problema?','Quais links estão pausados?','O que você recomenda?'];
    }else if(intencaoFalhas){
      sugestoes=['Quais links falharam?','Qual teve mais erros?','Qual foi o principal motivo?','O que você recomenda fazer?'];
    }else if(intencaoAnalise||intencaoComparar||intencaoRecomendacao){
      sugestoes=['Quais links tiveram problemas?','Qual link precisa de mais atenção?','Compare com o período anterior','O que devo melhorar?'];
    }else if(/\b(sucesso|envio|entrega|tentativa)\b/.test(q)){
      sugestoes=['Quantos envios deram certo?','Quantas tentativas foram feitas?','Quais falharam?','O que você recomenda?'];
    }else{
      sugestoes=['Quais links estão programados hoje?','Quais links deram erro hoje?','Como estão meus envios nos últimos 7 dias?','O que você recomenda?'];
    }

    res.set('Cache-Control','no-store');
    res.json({
      ok:true,resposta,periodo,periodoLabel,sugestoes,agendamentoSelecionado:agendamentoSelecionado?{id:agendamentoSelecionado.id,nome:agendamentoSelecionado.nome,horario:String(agendamentoSelecionado.horario||'').slice(0,5),grupoId:agendamentoSelecionado.grupoId,grupoIds:normalizeScheduleGroupIds(agendamentoSelecionado),grupoNome:agendamentoSelecionado.grupoNome||'',grupoNomes:agendamentoSelecionado.grupoNomes||{},status:agendamentoSelecionado.status,ativo:agendamentoSelecionado.ativo}:null,
      intervalo:{inicio:new Date(startMs).toISOString(),fim:new Date(endMs).toISOString()},
      metricas:{sucessos:success,erros:errors,emAndamento:sending,total,taxaSucesso:pct},
      diagnostico:{principaisFalhas:failureList,linkMaisCritico:ranking[0]||null,recomendacoes},
      contextoResolvido:{continuidade,contextoEraFalha,contextoEraAgendamento}
    });
  }catch(e){res.status(500).json({ok:false,msg:'Não foi possível processar a pergunta: '+e.message});}
});


app.get('/api/link-historico',(req,res)=>{
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  try {
    if(!Array.isArray(linkHistory)) linkHistory=[];
    const normalized=normalizeLinkHistory();
    const beforePrune=linkHistory.length;
    pruneLinkHistoryByLatestSentTime();
    if(normalized || linkHistory.length!==beforePrune) writeJson(FILES.linkHistory,linkHistory);
    res.json({ok:true,historico:linkHistory});
  } catch(e) {
    addLog(`Erro ao carregar histórico de links: ${e.message}`);
    res.status(500).json({ok:false,msg:'Não foi possível carregar o histórico de links.'});
  }
});
app.delete('/api/link-historico',(req,res)=>{
  const total=linkHistory.length;
  clearLinkHistory();
  clearLinkFailures();
  // Limpa somente registros de entregas finalizadas; preserva as que ainda estão em andamento.
  const beforeDeliveries=linkDeliveries.length;
  linkDeliveries=linkDeliveries.filter(x=>!['SUCESSO','ERRO'].includes(String(x?.status||'').toUpperCase()));
  if(linkDeliveries.length!==beforeDeliveries) saveLinkDeliveries();
  addLog(`Histórico de links limpo pelo painel: ${total} registro(s) e ${beforeDeliveries-linkDeliveries.length} entrega(s) finalizada(s) removidos.`);
  res.json({ok:true,msg:`Histórico limpo. ${total} registro(s) removido(s).`});
});
app.delete('/api/link-historico/:id',(req,res)=>{
  const i=linkHistory.findIndex(x=>String(x.id)===String(req.params.id));
  if(i<0)return res.status(404).json({ok:false,msg:'Registro de histórico não encontrado.'});
  const [removed]=linkHistory.splice(i,1);
  cancelLinkHistoryExpiration(removed);
  saveLinkHistory();
  addLog(`Registro de histórico removido: ${removed.nome||removed.id}.`);
  res.json({ok:true,msg:'Registro removido do histórico.'});
});
app.get('/api/link-falhas',(req,res)=>{
  res.set('Cache-Control','no-store');
  res.json({ok:true, falhas:linkFailures});
});
app.post('/api/link-falhas/:id/reenviar', async (req,res)=>{
  const failure=linkFailures.find(x=>String(x.id)===String(req.params.id));
  if(!failure) return res.status(404).json({ok:false,msg:'Falha não encontrada.'});
  let item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));
  if(!item){
    item={
      id:String(failure.agendamentoId||('reenvio-'+failure.id)),
      nome:String(failure.nome||'Reenvio de link'),
      url:String(failure.url||'').trim(),
      mensagem:String(failure.mensagem||''),
      tituloProduto:String(failure.tituloProduto||''),
      imagemUrl:String(failure.imagemUrl||'').trim(),
      imagemAutomatica:true,
      data:new Date().toISOString().slice(0,10),
      horario:new Date().toTimeString().slice(0,5),
      repeticao:'uma_vez',
      intervaloMin:Number(failure.intervaloMin||1),
      intervaloMax:Number(failure.intervaloMax||1),
      grupoId:String(failure.grupoId||''),
      reenvioGrupoId:String(failure.grupoId||''),
      grupoIds:[String(failure.grupoId||'')],
      grupoNome:String(failure.grupoNome||failure.grupoId||''),
      grupoNomes:{[String(failure.grupoId||'')]:String(failure.grupoNome||failure.grupoId||'')},
      ativo:true,
      status:'agendado',
      enviados:0,
      sucessos:0,
      erros:0
    };
  }
  const target=String(failure.grupoId||'');
  if(!target) return res.status(400).json({ok:false,msg:'A falha não possui grupo de destino registrado.'});
  if(!online || !sock) return res.status(503).json({ok:false,msg:'WhatsApp não conectado.'});

  // Reenvio reutiliza o MESMO card de entrega que terminou em ERRO.
  // Não criamos uma segunda ocorrência/entrega visual.
  const resendOccurrence='reenvio:'+String(failure.id||Date.now());
  let delivery=linkDeliveries
    .filter(x=>String(x?.agendamentoId||'')===String(item.id||'') &&
      String(x?.grupoId||'')===target &&
      String(x?.status||'').toUpperCase()==='ERRO')
    .sort((a,b)=>String(b?.concluidoEm||b?.criadoEm||'').localeCompare(String(a?.concluidoEm||a?.criadoEm||'')))[0];

  if(!delivery){
    ensureLinkDeliveries(item, item.progressKey || 'once', [target]);
    delivery=linkDeliveries
      .filter(x=>String(x?.agendamentoId||'')===String(item.id||'') && String(x?.grupoId||'')===target)
      .sort((a,b)=>String(b?.criadoEm||'').localeCompare(String(a?.criadoEm||'')))[0];
  }
  try {
    setExistingLinkDeliveryStatus(delivery,'ENVIANDO','',resendOccurrence);
    addLog(`Reenvio iniciado para "${item.nome}" no grupo ${target}.`);
    const text=[chooseRandomMessage(item),item.tituloProduto?`📦 ${item.tituloProduto}`:'',String(item.mensagem||'').trim(),'👉 Garanta agora:',String(item.url||'').trim()].filter(Boolean).join('\n\n');
    let image=null;
    if(String(item.imagemUrl||'').trim()) image=await downloadBuffer(String(item.imagemUrl).trim(),String(item.url||'').trim());
    else image=await findProductImage(String(item.url||'').trim());
    if(!image) throw new Error('Não foi possível obter a imagem. Edite o link ou informe uma URL de imagem.');
    if(image) await sock.sendMessage(target,{image:image.buffer,caption:text}); else await sock.sendMessage(target,{text});
    setExistingLinkDeliveryStatus(delivery,'SUCESSO','',resendOccurrence);
    addHistory({grupoId:target,link:item.url,status:'sucesso',agendamentoId:item.id,tipo:'reenvio',at:new Date().toISOString()});
    archiveSentFailureAsHistory(item,failure,target);
    removeLinkFailure(failure.id);
    item.sucessos=Number(item.sucessos||0)+1; item.enviados=Number(item.enviados||0)+1; item.erros=Math.max(0,Number(item.erros||0)-1);
    item.status='concluido'; item.lastSentAt=new Date().toISOString();
    writeJson(FILES.schedules,linkSchedules);
    res.json({ok:true,msg:'Link reenviado com sucesso e movido para o histórico de enviados.'});
  } catch(e) {
    setExistingLinkDeliveryStatus(delivery,'ERRO',e.message,resendOccurrence);
    upsertLinkFailure(item,target,e.message);
    addLog(`Reenvio falhou para "${item.nome}" no grupo ${target}: ${e.message}`);
    res.status(500).json({ok:false,msg:`Reenvio falhou: ${e.message}`});
  }
});
app.put('/api/link-falhas/:id',(req,res)=>{
  const failure=linkFailures.find(x=>String(x.id)===String(req.params.id));
  if(!failure) return res.status(404).json({ok:false,msg:'Falha não encontrada.'});
  const b=req.body||{};
  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));
  if(!item) return res.status(404).json({ok:false,msg:'Link associado não encontrado no Gerenciador de Links.'});
  if(typeof b.imagemUrl==='string') item.imagemUrl=b.imagemUrl.trim();
  if(typeof b.imagemAutomatica==='boolean') item.imagemAutomatica=b.imagemAutomatica;
  if(typeof b.url==='string' && b.url.trim()) item.url=b.url.trim();
  if(typeof b.nome==='string' && b.nome.trim()) item.nome=b.nome.trim();
  if(typeof b.mensagem==='string') item.mensagem=b.mensagem;
  if(typeof b.data==='string' && b.data) item.data=b.data;
  if(typeof b.horario==='string' && b.horario) item.horario=b.horario;
  item.status='erro'; item.ativo=false;
  writeJson(FILES.schedules,linkSchedules);
  upsertLinkFailure(item,failure.grupoId,failure.erro);
  res.json({ok:true,agendamento:item});
});
app.delete('/api/link-falhas',(req,res)=>{
  const total=linkFailures.length;
  clearLinkFailures();

  // "Limpar falhas" também remove do Status das Entregas os registros
  // finalizados com ERRO. Sucessos e entregas ainda em andamento são preservados.
  const beforeDeliveries=linkDeliveries.length;
  linkDeliveries=linkDeliveries.filter(x=>String(x?.status||'').toUpperCase()!=='ERRO');
  const removedDeliveries=beforeDeliveries-linkDeliveries.length;
  if(removedDeliveries>0) saveLinkDeliveries();

  addLog(`Links com falha limpos pelo painel: ${total} falha(s) e ${removedDeliveries} entrega(s) com ERRO removidas.`);
  res.json({ok:true,msg:`Links com falha limpos. ${total} falha(s) e ${removedDeliveries} registro(s) de ERRO removidos.`});
});

app.get('/api/link-imagem-preview', async (req,res)=>{
  const url=String(req.query?.url||'').trim();
  if(!url)return res.status(400).json({ok:false,msg:'Informe um link.'});
  try{
    const ml=await findMercadoLivreImageUrl(url);
    if(ml)return res.json({ok:true,imagemUrl:ml,fonte:'mercado-livre'});
    const page=await fetchText(url);
    const candidates=extractImageCandidates(page.data,page.finalUrl);
    if(candidates.length)return res.json({ok:true,imagemUrl:candidates[0],fonte:'metadados',finalUrl:page.finalUrl});
    return res.status(404).json({ok:false,msg:'Nenhuma imagem foi encontrada automaticamente.',finalUrl:page.finalUrl});
  }catch(e){return res.status(502).json({ok:false,msg:e.message||'Não foi possível obter a imagem.'});}
});

app.post('/api/link-agendamentos',(req,res)=>{
  const b=req.body||{}, nome=String(b.nome||'').trim(), url=String(b.url||'').trim();
  const data=String(b.data||''), horario=String(b.horario||'');
  if(!nome||!url||!data||!horario) return res.status(400).json({ok:false,msg:'Nome, link, data e horário são obrigatórios.'});
  const min=Math.max(1,Number(b.intervaloMin||1)), max=Math.max(min,Number(b.intervaloMax||min));
  const grupoIds=normalizeScheduleGroupIds(b.grupoIds?.length ? b.grupoIds : b.grupoId ? [b.grupoId] : []);
  if(!grupoIds.length || grupoIds.some(id=>!isValidGroupJid(id))) return res.status(400).json({ok:false,msg:'Selecione pelo menos um grupo de envio válido.'});
  const gruposEncontrados=grupoIds.map(id=>groups.find(g=>String(g.id)===id));
  if(gruposEncontrados.some(g=>!g)) return res.status(400).json({ok:false,msg:'Um ou mais grupos selecionados não estão disponíveis no cache atual. Atualize a lista de grupos e tente novamente.'});
  const grupoNomes=Object.fromEntries(gruposEncontrados.map(g=>[String(g.id),String(g.name||g.id)]));
  const item={
    id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),
    nome,url,mensagem:String(b.mensagem||''),grupoIds,grupoNomes,grupoNome:grupoIds.length===1?grupoNomes[grupoIds[0]]:`${grupoIds.length} grupos`,tituloProduto:'',tituloUltimaTentativa:'',data,horario,
    repeticao:['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:'uma_vez',
    intervaloMin:min,intervaloMax:max,ativo:b.ativo!==false,status:b.ativo===false?'pausado':'agendado',
    imagemAutomatica:b.imagemAutomatica!==false, imagemUrl:String(b.imagemUrl||'').trim(),
    mensagensAleatorias:Array.isArray(b.mensagensAleatorias)?b.mensagensAleatorias.map(String).filter(Boolean):[],
    mensagemAleatoriaAtiva:b.mensagemAleatoriaAtiva===true,
    imagemStatus:'pendente',imagemUltimaTentativa:'',
    enviados:0,sucessos:0,erros:0,lastRunKey:'',createdAt:new Date().toISOString()
  };
  try {
    linkSchedules.push(item);
    writeJson(FILES.schedules,linkSchedules);
    syncLinkQueue();
  } catch (e) {
    linkSchedules = linkSchedules.filter(x => x.id !== item.id);
    addLog(`Falha persistindo agendamento: ${e.message}`);
    return res.status(500).json({ok:false,msg:`Não foi possível salvar o agendamento no armazenamento: ${e.message}`});
  }
  res.set('Cache-Control','no-store');
  res.json({ok:true,agendamento:item});
});
app.put('/api/link-agendamentos/:id',(req,res)=>{
  const item=linkSchedules.find(x=>x.id===req.params.id);
  if(!item) return res.status(404).json({ok:false,msg:'Agendamento não encontrado.'});
  const b=req.body||{};
  item.nome=String(b.nome||item.nome).trim();
  const oldUrl = item.url;
  item.url=String(b.url||item.url).trim();
  if (item.url !== oldUrl) { item.tituloProduto=''; item.tituloUltimaTentativa=''; item.imagemStatus='pendente'; }
  item.mensagem=String(b.mensagem??item.mensagem);
  if(Object.prototype.hasOwnProperty.call(b,'grupoIds') || Object.prototype.hasOwnProperty.call(b,'grupoId')){
    const novosGrupoIds=normalizeScheduleGroupIds(Array.isArray(b.grupoIds) ? b.grupoIds : [b.grupoId]);
    if(!novosGrupoIds.length || novosGrupoIds.some(id=>!isValidGroupJid(id))) return res.status(400).json({ok:false,msg:'Selecione pelo menos um grupo de envio válido.'});
    const gruposEncontrados=novosGrupoIds.map(id=>groups.find(g=>String(g.id)===id));
    if(gruposEncontrados.some(g=>!g)) return res.status(400).json({ok:false,msg:'Um ou mais grupos selecionados não estão disponíveis no cache atual. Atualize a lista de grupos e tente novamente.'});
    const gruposAnteriores=normalizeScheduleGroupIds(item);
    const mudou=JSON.stringify(gruposAnteriores)!==JSON.stringify(novosGrupoIds);
    if(mudou){
      item.progressKey='';
      item.progressTargets=[];
      item.progressGroupIds=[];
      item.progressStartedAt='';
      item.lastRunKey='';
    }
    item.grupoIds=novosGrupoIds;
    item.grupoNomes=Object.fromEntries(gruposEncontrados.map(g=>[String(g.id),String(g.name||g.id)]));
    item.grupoNome=novosGrupoIds.length===1?item.grupoNomes[novosGrupoIds[0]]:`${novosGrupoIds.length} grupos`;
    delete item.grupoId;
  }
  item.data=String(b.data||item.data);
  item.horario=String(b.horario||item.horario);
  item.repeticao=['uma_vez','diariamente','semanalmente'].includes(b.repeticao)?b.repeticao:item.repeticao;
  item.intervaloMin=Math.max(1,Number(b.intervaloMin||item.intervaloMin||1));
  item.intervaloMax=Math.max(item.intervaloMin,Number(b.intervaloMax||item.intervaloMax||item.intervaloMin));
  if(typeof b.ativo==='boolean') item.ativo=b.ativo;
  if(typeof b.imagemAutomatica==='boolean') item.imagemAutomatica=b.imagemAutomatica;
  if(typeof b.imagemUrl==='string') item.imagemUrl=b.imagemUrl.trim();
  if(Array.isArray(b.mensagensAleatorias)) item.mensagensAleatorias=b.mensagensAleatorias.map(String).filter(Boolean);
  if (Object.prototype.hasOwnProperty.call(b,'mensagemAleatoriaAtiva')) item.mensagemAleatoriaAtiva=b.mensagemAleatoriaAtiva===true;
  item.status=item.ativo?'agendado':'pausado';
  // Editar não pode reexecutar hoje por acidente.
  if(b.rearmar===true) item.lastRunKey='';
  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();
  res.json({ok:true,agendamento:item});
});
app.post('/api/link-agendamentos/:id/toggle',(req,res)=>{
  const item=linkSchedules.find(x=>x.id===req.params.id);
  if(!item) return res.status(404).json({ok:false,msg:'Agendamento não encontrado.'});
  item.ativo=!item.ativo;
  item.status=item.ativo?'agendado':'pausado';
  if(item.ativo && req.body?.rearmar===true) item.lastRunKey='';
  writeJson(FILES.schedules,linkSchedules); syncLinkQueue();
  res.json({ok:true,agendamento:item});
});
app.post('/api/link-agendamentos/:id/enviar-agora',async(req,res)=>{
  const item=linkSchedules.find(x=>x.id===req.params.id);
  if(!item) return res.status(404).json({ok:false,msg:'Agendamento não encontrado.'});
  if(!online) return res.status(503).json({ok:false,msg:'WhatsApp não conectado.'});
  if(!botWindowActive()) return res.status(409).json({ok:false,msg:'Fora do horário programado do bot.'});
  await sendScheduledLink(item);
  res.json({ok:true,msg:'Envio solicitado.'});
});
app.delete('/api/link-agendamentos/:id',(req,res)=>{
  const i=linkSchedules.findIndex(x=>x.id===req.params.id);
  if(i<0) return res.status(404).json({ok:false,msg:'Agendamento não encontrado.'});
  const removedId = linkSchedules[i].id;
  linkSchedules.splice(i,1); writeJson(FILES.schedules,linkSchedules); syncLinkQueue();
  linkFailures = linkFailures.filter(x=>String(x.agendamentoId)!==String(removedId)); saveLinkFailures();
  res.json({ok:true});
});

app.get('/api/programacao',(req,res)=>res.json({ok:true,programacao:botSchedule,janela:botWindowLabel()}));
app.post('/api/programacao',(req,res)=>{
  const inicio=String(req.body?.inicio||'').match(/^\d{2}:\d{2}$/)?.[0] || '';
  const fim=String(req.body?.fim||'').match(/^\d{2}:\d{2}$/)?.[0] || '';
  const ativo=req.body?.ativo===true;
  if(ativo && (!inicio || !fim)) return res.status(400).json({ok:false,msg:'Escolha o horário de início e o horário de parada antes de ativar a programação.'});
  botSchedule={ativo,inicio,fim};
  saveBotSchedule();
  addLog(`Programação do bot: ${botSchedule.ativo?'ativa':'desativada'} ${inicio}–${fim}.`);
  if(botWindowActive()) armAutoLinkTimer(); else stopSchedulers();
  res.json({ok:true,programacao:botSchedule,janela:botWindowLabel()});
});

app.get('/api/dashboard',(req,res)=>{
  const now=new Date(), today=dateKey(now);
  const sucesso=history.filter(x=>x.status==='sucesso');
  const erros=history.filter(x=>x.status==='erro');
  res.json({
    ok:true,hoje:sucesso.filter(x=>dateKey(new Date(x.at))===today).length,
    totalEnviadas:sucesso.length,totalErros:erros.length,
    janela:botWindowLabel(),programacao:botSchedule, filaLinks:orderedLinks().length, filaAtual:linkQueue.currentId, filaPosicao:orderedLinks().length ? linkQueue.cursor + 1 : 0
  });
});

app.get('/grupos',(req,res)=>res.sendFile(path.join(PUBLIC,'grupos.html')));
app.get('/',(req,res)=>res.sendFile(path.join(PUBLIC,'index.html')));
app.get('*',(req,res)=>res.sendFile(path.join(PUBLIC,'index.html')));

const server=app.listen(PORT,HOST,()=>{
  console.log(`RegulOS online em http://${HOST}:${PORT}`);
  addLog(`Painel disponível em http://${HOST}:${PORT}`);
  startLinkScheduler();
  start();
});
server.on('error',e=>{
  addLog(`Erro no servidor HTTP: ${e.message}`);
  if(e.code==='EADDRINUSE') { addLog(`A porta ${PORT} já está em uso. Encerrando esta instância para o supervisor verificar a instância existente.`); setTimeout(()=>process.exit(98),100); }
});
process.on('SIGINT',()=>{stopping=true;clearReconnect();stopSchedulers();try{sock?.end()}catch{}process.exit(0)});
// Programação dinâmica: quando um link falha definitivamente,
// o próximo agendamento ocupa o horário liberado.
const DYNAMIC_SCHEDULE_FILE = path.join(DATA, 'dynamic_schedule.json');

function readDynamicSchedule(){
  try{
    if(!fs.existsSync(DYNAMIC_SCHEDULE_FILE)) return [];
    const v=JSON.parse(fs.readFileSync(DYNAMIC_SCHEDULE_FILE,'utf8'));
    return Array.isArray(v)?v:[];
  }catch(e){ return []; }
}
function writeDynamicSchedule(v){
  fs.writeFileSync(DYNAMIC_SCHEDULE_FILE, JSON.stringify(v,null,2));
}
function scheduleTime(v){
  if(!v) return null;
  const m=String(v).match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h=Number(m[1]), min=Number(m[2]);
  if(h>23||min>59) return null;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}
function scheduleId(x){ return x?.id||x?.agendamentoId||x?.linkId; }
function sortDynamic(items){
  return [...items].sort((a,b)=>
    (a.horarioEfetivo||a.horarioOriginal||'99:99')
    .localeCompare(b.horarioEfetivo||b.horarioOriginal||'99:99'));
}

/*
  Exemplo:
  08:00 A (falhou)
  09:00 B
  10:00 C

  Resultado:
  08:00 B
  09:00 C

  A sai da programação ativa, mas permanece no registro de falha.
*/
function reorganizarAposFalha(failed, motivo){
  const items=sortDynamic(readDynamicSchedule());
  const idx=items.findIndex(x=>scheduleId(x)===scheduleId(failed));
  if(idx<0) return items;

  const slotFalho=failed.horarioEfetivo||failed.horarioOriginal||failed.horario;
  const before=items.slice(0,idx);
  const after=items.slice(idx+1);

  const shifted=after.map((item,i)=>({
    ...item,
    horarioOriginal:item.horarioOriginal||item.horarioEfetivo||item.horario,
    horarioEfetivo:i===0
      ? slotFalho
      : (after[i-1].horarioEfetivo||after[i-1].horarioOriginal||after[i-1].horario),
    antecipadoPorFalha:true,
    motivoAntecipacao:motivo||'Falha no envio',
    antecipadoEm:new Date().toISOString()
  }));

  const result=sortDynamic([...before,...shifted]);
  writeDynamicSchedule(result);
  return result;
}

function registrarFalhaEReorganizar(item,motivo){
  const key=deliveryKey(item.agendamentoId,item.grupoId,item.linkId);
  setDeliveryState(key,'ERRO',{
    lastError:motivo||'Falha no envio',
    originalSchedule:item.horarioOriginal||item.horarioEfetivo||item.horario,
    effectiveSchedule:item.horarioEfetivo||item.horario,
    reprogramado:true
  });

  const result=reorganizarAposFalha(item,motivo);
  return {
    falhou:{...item,status:'NAO_ENVIADO',motivoFalha:motivo||'Falha no envio'},
    programacao:result
  };
}

