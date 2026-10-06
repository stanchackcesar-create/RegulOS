const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = 'https://partner.shopeemobile.com';
const AUTH_HOST = 'https://open.shopee.com.br/auth';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function nowSec(){ return Math.floor(Date.now()/1000); }

function hmac(value, key){
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

function deriveKey(secret){
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(value, secret){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',deriveKey(secret),iv);
  const data=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return {iv:iv.toString('base64'),tag:tag.toString('base64'),data:data.toString('base64')};
}

function decrypt(box, secret){
  const decipher=crypto.createDecipheriv('aes-256-gcm',deriveKey(secret),Buffer.from(box.iv,'base64'));
  decipher.setAuthTag(Buffer.from(box.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data,'base64')),decipher.final()]).toString('utf8');
}

function isShopeeHost(host){
  return /^(?:www\.)?(?:shopee\.com\.br|shopee\.com|s\.shopee\.com\.br)$/i.test(String(host||''));
}

function parseShopeeIds(url){
  let u;
  try{ u=new URL(url); }catch{return {shopId:'',itemId:'',url:String(url||'')}; }
  const pathName=u.pathname;
  const itemId=
    (pathName.match(/(?:^|[/-])i\.\d+\.(\d+)(?:[/?]|$)/i)||[])[1] ||
    (pathName.match(/\/product\/(\d+)\/(\d+)/i)||[])[2] ||
    u.searchParams.get('itemId') ||
    u.searchParams.get('item_id') || '';
  const shopId=
    (pathName.match(/(?:^|[/-])i\.(\d+)\.\d+(?:[/?]|$)/i)||[])[1] ||
    (pathName.match(/\/product\/(\d+)\/(\d+)/i)||[])[1] ||
    u.searchParams.get('shopId') ||
    u.searchParams.get('shop_id') || '';
  return {shopId:String(shopId||''),itemId:String(itemId||''),url:u.toString()};
}

function readJson(file,fallback){
  try{
    if(!fs.existsSync(file)) return fallback;
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    return value;
  }catch{return fallback;}
}

function writeJson(file,value){
  const tmp=file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');
  fs.renameSync(tmp,file);
}

function extractNumbers(value,key=''){
  const out=[];
  const walk=(v,k='',depth=0)=>{
    if(depth>8 || v===null || v===undefined) return;
    if(typeof v==='number' && Number.isFinite(v)){
      if(/(?:current_price|original_price|price|sale_price|selling_price)$/i.test(k) && v>=0 && v<100000000) out.push({value:v,kind:/original|old|list|regular/i.test(k)?'original':'current'});
      return;
    }
    if(typeof v==='string'){
      const m=v.match(/(?:R\$\s*)?([0-9]{1,3}(?:\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/);
      if(m && /(?:current_price|original_price|price|sale_price|selling_price)$/i.test(k)){
        const n=Number(m[1].replace(/\./g,'').replace(',','.'));
        if(Number.isFinite(n) && n<100000000) out.push({value:n,kind:/original|old|list|regular/i.test(k)?'original':'current'});
      }
      return;
    }
    if(Array.isArray(v)){v.slice(0,100).forEach(x=>walk(x,k,depth+1));return;}
    if(typeof v==='object') for(const [kk,vv] of Object.entries(v)) walk(vv,String(kk),depth+1);
  };
  walk(value,key,0);
  return out;
}

function firstImage(item){
  const images=[];
  const walk=(v,k='',depth=0)=>{
    if(depth>7 || v===null || v===undefined) return;
    if(typeof v==='string'){
      if(/^https?:\/\//i.test(v) && /image|img|url|picture|cover/i.test(k) && !/logo|icon|sprite|favicon/i.test(v)) images.push(v);
      return;
    }
    if(Array.isArray(v)){v.slice(0,50).forEach(x=>walk(x,k,depth+1));return;}
    if(typeof v==='object') for(const [kk,vv] of Object.entries(v)) walk(vv,String(kk),depth+1);
  };
  walk(item);
  return [...new Set(images)][0] || '';
}

function formatBRL(n){
  return Number.isFinite(n) ? 'R$ '+n.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '';
}

function createShopeeIntegration({dataDir}){
  const file=path.join(dataDir,'shopee_integracao.json');
  const stateFile=path.join(dataDir,'shopee_oauth_state.json');

  function config(){
    return {
      partnerId:String(process.env.REGULOS_SHOPEE_PARTNER_ID||'').trim(),
      partnerKey:String(process.env.REGULOS_SHOPEE_PARTNER_KEY||'').trim(),
      tokenKey:String(process.env.REGULOS_SHOPEE_TOKEN_KEY||'').trim(),
      redirectUri:String(process.env.REGULOS_SHOPEE_REDIRECT_URI||'').trim(),
      apiHost:String(process.env.REGULOS_SHOPEE_API_HOST||HOST).replace(/\/$/,'')
    };
  }

  function configured(){
    const c=config();
    return Boolean(c.partnerId && c.partnerKey && c.tokenKey && c.redirectUri);
  }

  function read(){ return readJson(file,{}); }
  function save(v){ writeJson(file,v); }

  function publicStatus(){
    const c=config();
    const v=read();
    return {
      configured:Boolean(c.partnerId && c.partnerKey && c.redirectUri),
      encryptionConfigured:Boolean(c.tokenKey),
      connected:Boolean(v.connected),
      shopIds:Array.isArray(v.shopIds)?v.shopIds:[],
      connectedAt:v.connectedAt||null,
      accessTokenExpiresAt:v.accessTokenExpiresAt||null,
      redirectUri:c.redirectUri||null
    };
  }

  function authorizationUrl(){
    const c=config();
    if(!c.partnerId || !c.redirectUri) throw new Error('Configure REGULOS_SHOPEE_PARTNER_ID e REGULOS_SHOPEE_REDIRECT_URI no Railway.');
    const state=crypto.randomBytes(32).toString('hex');
    writeJson(stateFile,{state,expiresAt:Date.now()+OAUTH_STATE_TTL_MS});
    const u=new URL(AUTH_HOST);
    u.searchParams.set('partner_id',c.partnerId);
    u.searchParams.set('auth_type','seller');
    u.searchParams.set('redirect_uri',c.redirectUri);
    u.searchParams.set('response_type','code');
    u.searchParams.set('state',state);
    return u.toString();
  }

  async function exchangeCode(code){
    const c=config();
    if(!configured()) throw new Error('A integração Shopee ainda não está configurada no Railway.');
    const timestamp=nowSec();
    const apiPath='/api/v2/auth/token/get';
    const sign=hmac(c.partnerId+apiPath+timestamp,c.partnerKey);
    const u=new URL(c.apiHost+apiPath);
    u.searchParams.set('partner_id',c.partnerId);
    u.searchParams.set('timestamp',String(timestamp));
    u.searchParams.set('sign',sign);
    const response=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,partner_id:Number(c.partnerId)})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok || data.error) throw new Error(data.message||data.error||'A Shopee recusou a autorização.');
    const shopIds=(data.shop_id_list||[]).map(Number).filter(Number.isFinite);
    if(!shopIds.length && data.shop_id) shopIds.push(Number(data.shop_id));
    if(!shopIds.length) throw new Error('A Shopee autorizou, mas não retornou o shop_id.');
    const primaryShopId=shopIds[0];
    save({
      connected:true,
      shopIds,
      primaryShopId,
      accessToken:encrypt(data.access_token,c.tokenKey),
      refreshToken:encrypt(data.refresh_token,c.tokenKey),
      accessTokenExpiresAt:Date.now()+Number(data.expire_in||14400)*1000,
      connectedAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    });
    return {shopIds,primaryShopId};
  }

  async function refresh(shopId){
    const c=config();
    const v=read();
    if(!v.refreshToken) throw new Error('A integração Shopee não possui refresh token.');
    const refreshToken=decrypt(v.refreshToken,c.tokenKey);
    const timestamp=nowSec();
    const apiPath='/api/v2/auth/access_token/get';
    const sign=hmac(c.partnerId+apiPath+timestamp,c.partnerKey);
    const u=new URL(c.apiHost+apiPath);
    u.searchParams.set('partner_id',c.partnerId);
    u.searchParams.set('timestamp',String(timestamp));
    u.searchParams.set('sign',sign);
    const body={refresh_token:refreshToken,partner_id:Number(c.partnerId),shop_id:Number(shopId)};
    const response=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok || data.error) throw new Error(data.message||data.error||'Não foi possível renovar a autorização Shopee.');
    const nextShopId=Number(data.shop_id||shopId);
    save({...v,connected:true,primaryShopId:nextShopId,shopIds:Array.isArray(v.shopIds)?v.shopIds:[nextShopId],
      accessToken:encrypt(data.access_token,c.tokenKey),
      refreshToken:encrypt(data.refresh_token,c.tokenKey),
      accessTokenExpiresAt:Date.now()+Number(data.expire_in||14400)*1000,
      updatedAt:new Date().toISOString()
    });
    return data.access_token;
  }

  async function getAccessToken(shopId){
    const c=config();
    if(!configured()) throw new Error('Configure as credenciais da Shopee no Railway primeiro.');
    const v=read();
    if(!v.connected || !v.accessToken) throw new Error('Conecte a conta Shopee no RegulOS primeiro.');
    const sid=Number(shopId||v.primaryShopId||(v.shopIds||[])[0]);
    if(!sid) throw new Error('Nenhuma loja Shopee autorizada.');
    if(Number(v.accessTokenExpiresAt||0) < Date.now()+2*60*1000) return refresh(sid);
    return decrypt(v.accessToken,c.tokenKey);
  }

  async function apiGet(pathName,shopId,params={}){
    const c=config();
    const sid=Number(shopId);
    const accessToken=await getAccessToken(sid);
    const timestamp=nowSec();
    const sign=hmac(c.partnerId+pathName+timestamp+accessToken+sid,c.partnerKey);
    const u=new URL(c.apiHost+pathName);
    u.searchParams.set('partner_id',c.partnerId);
    u.searchParams.set('timestamp',String(timestamp));
    u.searchParams.set('access_token',accessToken);
    u.searchParams.set('shop_id',String(sid));
    u.searchParams.set('sign',sign);
    for(const [k,v] of Object.entries(params)) u.searchParams.set(k,String(v));
    const response=await fetch(u,{headers:{accept:'application/json'}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok || data.error) throw new Error(data.message||data.error||'A API Shopee retornou um erro.');
    return data;
  }

  async function resolveUrl(url){
    let current=String(url||'').trim();
    for(let i=0;i<3;i++){
      let u;
      try{u=new URL(current);}catch{throw new Error('Link Shopee inválido.');}
      if(!isShopeeHost(u.hostname)) throw new Error('O link informado não é da Shopee.');
      const response=await fetch(current,{method:'GET',redirect:'follow',headers:{'user-agent':'Mozilla/5.0 RegulOS/12'}});
      const finalUrl=response.url||current;
      if(response.body?.cancel) try{await response.body.cancel();}catch{}
      if(finalUrl===current) return current;
      current=finalUrl;
    }
    return current;
  }

  async function getProductByUrl(url){
    const resolved=await resolveUrl(url);
    const ids=parseShopeeIds(resolved);
    if(!ids.itemId) throw new Error('Não consegui identificar o item_id desse link Shopee.');
    const v=read();
    const shopId=Number(ids.shopId||v.primaryShopId||(v.shopIds||[])[0]);
    if(!shopId) throw new Error('Não consegui identificar a loja Shopee autorizada.');
    const data=await apiGet('/api/v2/product/get_item_base_info',shopId,{item_id_list:JSON.stringify([Number(ids.itemId)])});
    const item=(data.response?.item_list||data.item_list||[])[0];
    if(!item) throw new Error('A Shopee não retornou esse produto para a loja autorizada.');
    const numbers=extractNumbers(item);
    const current=numbers.filter(x=>x.kind==='current').map(x=>x.value).filter(Number.isFinite);
    const original=numbers.filter(x=>x.kind==='original').map(x=>x.value).filter(Number.isFinite);
    const preco=current.length?Math.min(...current):NaN;
    const precoOriginal=original.length?Math.max(...original):NaN;
    const desconto=Number.isFinite(preco)&&Number.isFinite(precoOriginal)&&precoOriginal>preco
      ? Math.round((1-preco/precoOriginal)*100)+'% OFF' : '';
    const image=firstImage(item);
    return {
      titulo:String(item.item_name||item.name||'').trim(),
      preco:formatBRL(preco),
      precoOriginal:formatBRL(precoOriginal),
      desconto,
      imagemUrl:image,
      finalUrl:resolved,
      fonte:'shopee-api',
      shopId,
      itemId:Number(ids.itemId),
      dados:item
    };
  }

  function disconnect(){
    const v=read();
    if(v.refreshToken && config().tokenKey){
      // Tokens antigos são removidos do arquivo junto com a conexão.
    }
    try{fs.rmSync(file,{force:true});}catch{}
    return true;
  }

  return {configured,publicStatus,authorizationUrl,exchangeCode,getProductByUrl,disconnect};
}

module.exports={createShopeeIntegration,isShopeeHost,parseShopeeIds};
