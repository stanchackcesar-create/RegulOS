'use strict';
const tls = require('node:tls');
const crypto = require('node:crypto');

function sendGmail({to,subject,text}) {
  const host = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!host || !pass) throw new Error('GMAIL_NOT_CONFIGURED');
  return new Promise((resolve,reject)=>{
    const socket=tls.connect(465,'smtp.gmail.com',{servername:'smtp.gmail.com'});
    let buffer='', waiting=[], failed=false;
    const cleanup=()=>{socket.removeAllListeners();try{socket.end()}catch{}};
    const fail=e=>{if(failed)return;failed=true;cleanup();reject(e instanceof Error?e:new Error(String(e)))};
    socket.setTimeout(15000,()=>fail(new Error('SMTP_TIMEOUT')));
    socket.on('error',fail);
    socket.on('data',chunk=>{
      buffer+=chunk.toString('utf8');
      const lines=buffer.split('\r\n');buffer=lines.pop();
      for(const line of lines){ if(/^\d{3} /.test(line)){const w=waiting.shift();if(w)w(line);}}
    });
    const command=(cmd,expected)=>new Promise((res,rej)=>{
      waiting.push(line=>{const code=Number(line.slice(0,3));if(expected.includes(code))res(line);else rej(new Error('SMTP_'+code));});
      if(cmd)socket.write(cmd+'\r\n');
    });
    (async()=>{
      await command(null,[220]); await command('EHLO regulos.com.br',[250]);
      await command('AUTH LOGIN',[334]);
      await command(Buffer.from(host).toString('base64'),[334]);
      await command(Buffer.from(pass).toString('base64'),[235]);
      await command('MAIL FROM:<'+host+'>',[250]);
      await command('RCPT TO:<'+to+'>',[250,251]);
      await command('DATA',[354]);
      const safeSubject=String(subject).replace(/[\r\n]/g,' ').slice(0,180);
      const body=String(text).replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');
      socket.write('From: RegulOS <'+host+'>\r\nTo: <'+to+'>\r\nSubject: '+safeSubject+'\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'+body+'\r\n.\r\n');
      await command(null,[250]); await command('QUIT',[221]); cleanup();resolve(true);
    })().catch(fail);
  });
}
module.exports={sendGmail};
