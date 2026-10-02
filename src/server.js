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
  botSchedule: path.join(DATA, 'programacao_bot.json'),
  linkQueue: path.join(DATA, 'fila_links.json'),
  whatsappAccounts: path.join(DATA, 'whatsapp_contas.json')
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
function readWhatsAppAccounts(){
  const v=readJson(FILES.whatsappAccounts,{});
  return v && typeof v==='object' && !Array.isArray(v) ? v : {};
}
function saveWhatsAppAccounts(v){ writeJson(FILES.whatsappAccounts,v); }
function ensureWhatsAppAccount(user){
  if(!user?.id) return null;
  const accounts=readWhatsAppAccounts();
  const existing=accounts[user.id];
  if(existing) return existing;
  const account={
    id:user.id,
    userId:user.id,
    usuario:user.usuario,
    numero:'',
    status:'Não conectado',
    connected:false,
    authDir:path.join(AUTH,'users',String(user.id)),
    criadoEm:new Date().toISOString(),
    atualizadoEm:new Date().toISOString()
  };
  accounts[user.id]=account;
  saveWhatsAppAccounts(accounts);
  return account;
}
function sanitizeWhatsAppAccount(account){
  if(!account) return null;
  return {
    id:account.id,
    userId:account.userId,
    usuario:account.usuario,
    numero:account.numero||'',
    status:account.status||'Não conectado',
    connected:account.connected===true,
    criadoEm:account.criadoEm,
    atualizadoEm:account.atualizadoEm
  };
}
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
  saveUsers([user]); saveSessions({}); ensureWhatsAppAccount(user); setSession(res,user);
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
function autoOfferDiscount(html,product,offers){
  for(const n of ['product:discount_percentage','discount_percentage','discount']){
    const v=autoOfferMeta(html,n);
    if(v && /%/.test(v))return v.trim();
  }
  const candidates=[product?.discount,offers?.discount,offers?.discountPercentage,product?.discountPercentage];
  for(const v of candidates){if(v!==undefined && v!==null && /%/.test(String(v)))return String(v).trim();}
  return '';
}
async function buildAutomaticOffer(url){
  const page=await fetchText(url);
  const html=String(page.data||'');
  const product=autoOfferJsonLd(html);
  const offers=product?.offers && (Array.isArray(product.offers)?product.offers[0]:product.offers) || {};
  const titulo=autoOfferDecode(autoOfferMeta(html,'og:title') || autoOfferMeta(html,'twitter:title') || product?.name || '');
  const currency=autoOfferMeta(html,'product:price:currency') || autoOfferMeta(html,'og:price:currency') || offers.priceCurrency || '';
  const rawPrice=autoOfferMeta(html,'product:price:amount') || autoOfferMeta(html,'og:price:amount') || offers.price || '';
  const preco=autoOfferPrice(rawPrice,currency);
  const desconto=autoOfferDiscount(html,product,offers);
  let imagem=autoOfferMeta(html,'og:image') || autoOfferMeta(html,'twitter:image') || product?.image || '';
  if(Array.isArray(imagem))imagem=imagem[0]||'';
  if(imagem && !/^https?:\/\//i.test(imagem))imagem='';
  if(!imagem && typeof findMercadoLivreImageUrl==='function')imagem=await findMercadoLivreImageUrl(url).catch(()=> '');
  return {titulo,preco,desconto,imagemUrl:imagem,finalUrl:page.finalUrl||url};
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

app.get('/api/whatsapp-contas',(req,res)=>{
  const accounts=readWhatsAppAccounts();
  const users=readUsers();
  if(req.user?.admin===true){
    users.forEach(ensureWhatsAppAccount);
    const current=readWhatsAppAccounts();
    return res.json({ok:true,contas:Object.values(current).map(sanitizeWhatsAppAccount)});
  }
  const account=ensureWhatsAppAccount(req.user);
  return res.json({ok:true,contas:account?[sanitizeWhatsAppAccount(account)]:[]});
});

app.get('/api/whatsapp-contas/:userId',(req,res)=>{
  if(req.user?.admin!==true && req.user?.id!==req.params.userId)
    return res.status(403).json({ok:false,msg:'Acesso restrito ao administrador ou ao próprio usuário.'});
  const user=readUsers().find(x=>x.id===req.params.userId);
  if(!user)return res.status(404).json({ok:false,msg:'Usuário não encontrado.'});
  const account=ensureWhatsAppAccount(user);
  res.json({ok:true,conta:sanitizeWhatsAppAccount(account)});
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
  users.push(u);saveUsers(users); ensureWhatsAppAccount(u); res.json({ok:true,usuario:sanitizeUser(u)});
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
function saveLinkFailures() { linkFailures = linkFailures.slice(-500); writeJson(FILES.linkFailures, linkFailures); }
function clearLinkFailures() { linkFailures = []; writeJson(FILES.linkFailures, linkFailures); }
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
  if(i >= 0) linkFailures[i] = {...linkFailures[i], ...record}; else linkFailures.unshift(record);
  saveLinkFailures();
}
function removeLinkFailure(id) {
  const before = linkFailures.length;
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
function saveLinkHistory() {
  linkHistory = linkHistory.slice(-500);
  writeJson(FILES.linkHistory, linkHistory);
}
function clearLinkHistory() {
  linkHistory = [];
  writeJson(FILES.linkHistory, linkHistory);
}
function archiveCompletedOneTimeLink(item) {
  const snapshot = {
    id: item.id, nome: item.nome, url: item.url, mensagem: item.mensagem || '',
    tituloProduto: item.tituloProduto || '', repeticao: item.repeticao,
    data: item.data, horario: item.horario, intervaloMin: item.intervaloMin, intervaloMax: item.intervaloMax,
    imagemAutomatica: item.imagemAutomatica !== false, imagemUrl: item.imagemUrl || '', imagemStatus: item.imagemStatus || '',
    mensagensAleatorias: Array.isArray(item.mensagensAleatorias) ? [...item.mensagensAleatorias] : [],
    mensagemAleatoriaAtiva: item.mensagemAleatoriaAtiva === true,
    enviados: Number(item.enviados || 0), sucessos: Number(item.sucessos || 0), erros: Number(item.erros || 0),
    lastRunAt: item.lastRunAt || new Date().toISOString(), lastDurationMs: Number(item.lastDurationMs || 0),
    concluidoAt: new Date().toISOString(), motivo: 'envio concluído — uma vez'
  };
  linkHistory.unshift(snapshot);
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
  const selectedGroups=selectedGroupIds.map(id=>groups.find(g=>String(g.id)===id));
  if(selectedGroups.some(g=>!g)){
    const missing=selectedGroupIds.filter(id=>!groups.some(g=>String(g.id)===id));
    const erro=`Grupo(s) de envio não estão no cache atual: ${missing.join(', ')}. Atualize os grupos antes de executar.`;
    item.status='erro';
    item.ativo=false;
    upsertLinkFailure(item,missing[0]||selectedGroupIds[0],erro);
    writeJson(FILES.schedules,linkSchedules);
    addLog(`Agendamento "${item.nome}" bloqueado: ${erro}`);
    return;
  }
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
      // A falha de imagem é uma falha real do envio: não enviamos somente texto.
      for (const id of targets) upsertLinkFailure(item, id, `Imagem: ${e.message}`);
      item.status = 'erro'; item.ativo = false; writeJson(FILES.schedules, linkSchedules);
      return;
    }
  } else {
    productImage = await findProductImage(String(item.url||'').trim());
    item.imagemStatus = productImage ? 'encontrada' : 'não encontrada';
    item.imagemUltimaTentativa = new Date().toISOString();
    writeJson(FILES.schedules, linkSchedules);
    if (!productImage) {
      const msg = 'Não foi possível encontrar ou baixar a imagem automaticamente.';
      for (const id of targets) upsertLinkFailure(item, id, msg);
      item.status = 'erro'; item.ativo = false; writeJson(FILES.schedules, linkSchedules);
      addLog(`Falha agendamento ${item.nome}: ${msg}`);
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
        // Registramos a intenção antes do envio. Isso privilegia a regra do
        // RegulOS de nunca duplicar um envio após uma queda/reinício.
        // Em caso de erro, removemos a marca para permitir nova tentativa.
        item.progressGroupIds = [...new Set([...(item.progressGroupIds || []), id])];
        writeJson(FILES.schedules, linkSchedules);

        const randomIntro = chooseRandomMessage(item);
        const titleLine = productTitle ? `📦 ${productTitle}` : '';
        const customMessage = String(item.mensagem || '').trim();
        const linkUrl = String(item.url||'').trim();
        const guaranteeLine = linkUrl ? '👉 Garanta agora:' : '';
        const text = [randomIntro, titleLine, customMessage, guaranteeLine, linkUrl].filter(Boolean).join('\n\n');
        if (productImage) {
          await sock.sendMessage(id, { image: productImage.buffer, caption: text });
        } else {
          await sock.sendMessage(id, { text });
        }
        sent++;
        addHistory({ grupoId:id, link:item.url, status:'sucesso', agendamentoId:item.id, tipo:'agendado', ocorrencia:item.progressKey });
        removeLinkFailure(`${item.id}:${String(id)}`);
        item.enviados = Number(item.enviados||0) + 1;
        item.sucessos = Number(item.sucessos||0) + 1;
        item.lastSentAt = new Date().toISOString();
        writeJson(FILES.schedules, linkSchedules);
        await new Promise(r => setTimeout(r, Math.max(700, Number(item.intervaloMin||1)*1000)));
      } catch(e) {
        errors++;
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
          writeJson(FILES.schedules, linkSchedules);
          addLog(`Link "${item.nome}" concluído parcialmente e mantido em falhas para correção.`);
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
        // Por segurança, toda nova conexão começa com todos os grupos desligados.
        // O envio só fica permitido depois que o usuário clicar em 🟢 Ligado.
        for (const id of Object.keys(groupConfig)) {
          groupConfig[id].ativo = false;
        }
        // "Ligado" é a única seleção operacional do grupo.
        // Ao iniciar uma nova conexão, nenhum grupo fica selecionado.
        allowed = [];
        writeJson(FILES.groups, allowed);
        saveGroupsConfig();
        // A descoberta dos grupos acontece uma vez por conexão.
        // Depois disso, o painel trabalha com o cache até uma pesquisa explícita.
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
});

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
app.get('/api/link-historico',(req,res)=>{
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  try {
    if(!Array.isArray(linkHistory)) linkHistory=[];
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
  addLog(`Histórico de links limpo pelo painel: ${total} registro(s) removido(s).`);
  res.json({ok:true,msg:`Histórico limpo. ${total} registro(s) removido(s).`});
});
app.delete('/api/link-historico/:id',(req,res)=>{
  const i=linkHistory.findIndex(x=>String(x.id)===String(req.params.id));
  if(i<0) return res.status(404).json({ok:false,msg:'Registro de histórico não encontrado.'});
  const [removed]=linkHistory.splice(i,1);
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
  const item=linkSchedules.find(x=>String(x.id)===String(failure.agendamentoId));
  if(!item) return res.status(404).json({ok:false,msg:'O link associado à falha não está mais no Gerenciador de Links.'});
  if(!online || !sock) return res.status(503).json({ok:false,msg:'WhatsApp não conectado.'});
  const target=String(failure.grupoId||'');
  if(!target) return res.status(400).json({ok:false,msg:'A falha não possui grupo de destino registrado.'});
  try {
    const text=[chooseRandomMessage(item),item.tituloProduto?`📦 ${item.tituloProduto}`:'',String(item.mensagem||'').trim(),'👉 Garanta agora:',String(item.url||'').trim()].filter(Boolean).join('\n\n');
    let image=null;
    if(String(item.imagemUrl||'').trim()) image=await downloadBuffer(String(item.imagemUrl).trim(),String(item.url||'').trim());
    else image=await findProductImage(String(item.url||'').trim());
    if(!image) throw new Error('Não foi possível obter a imagem. Edite o link ou informe uma URL de imagem.');
    if(image) await sock.sendMessage(target,{image:image.buffer,caption:text}); else await sock.sendMessage(target,{text});
    addHistory({grupoId:target,link:item.url,status:'sucesso',agendamentoId:item.id,tipo:'reenvio',at:new Date().toISOString()});
    archiveSentFailureAsHistory(item,failure,target);
    removeLinkFailure(failure.id);
    item.sucessos=Number(item.sucessos||0)+1; item.enviados=Number(item.enviados||0)+1; item.erros=Math.max(0,Number(item.erros||0)-1);
    item.status='concluido'; item.lastSentAt=new Date().toISOString();
    writeJson(FILES.schedules,linkSchedules);
    res.json({ok:true,msg:'Link reenviado com sucesso e movido para o histórico de enviados.'});
  } catch(e) {
    upsertLinkFailure(item,target,e.message);
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
app.delete('/api/link-falhas',(req,res)=>{ const total=linkFailures.length; clearLinkFailures(); res.json({ok:true,msg:`Links com falha limpos. ${total} registro(s) removido(s).`}); });

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

