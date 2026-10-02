const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const P = require('pino');
const fs = require('fs');

function createWhatsAppSessionManager({ onUpdate, onLog } = {}) {
  const sessions = new Map();
  const logger = P({ level: 'silent' });

  const notify = (id, patch = {}) => {
    try { onUpdate?.(id, patch); } catch (e) { onLog?.(`Falha atualizando conta WhatsApp: ${e.message}`); }
  };

  const snapshot = (id) => {
    const s = sessions.get(String(id));
    if (!s) return {
      id: String(id), connected: false, status: 'Não iniciado',
      qr: null, numero: '', temQR: false, starting: false
    };
    return {
      id: String(id),
      connected: s.online === true,
      status: s.status || 'Não conectado',
      qr: s.qr || null,
      numero: s.number || '',
      temQR: Boolean(s.qr),
      starting: s.starting === true
    };
  };

  async function start(account, options = {}) {
    const id = String(account.id);
    let s = sessions.get(id);
    if (s?.starting || s?.online) return snapshot(id);

    if (s?.reconnectTimer) clearTimeout(s.reconnectTimer);
    s = {
      id,
      userId: String(account.userId || id),
      authDir: account.authDir,
      sock: null,
      qr: null,
      online: false,
      number: '',
      status: 'Iniciando...',
      starting: true,
      manualDisconnected: false,
      reconnectTimer: null
    };
    sessions.set(id, s);
    fs.mkdirSync(s.authDir, { recursive: true });

    try {
      const { state, saveCreds } = await useMultiFileAuthState(s.authDir);
      if (options.clearAuth) {
        try { fs.rmSync(s.authDir, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(s.authDir, { recursive: true });
        const fresh = await useMultiFileAuthState(s.authDir);
        s.state = fresh.state;
        s.saveCreds = fresh.saveCreds;
      } else {
        s.state = state;
        s.saveCreds = saveCreds;
      }

      s.qr = null;
      s.status = s.state.creds?.registered ? 'Aguardando conexão...' : 'Aguardando QR Code...';
      notify(id, { status: s.status, connected: false, numero: '' });

      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version,
        auth: s.state,
        logger,
        browser: ['Regulos','Chrome','120'],
        printQRInTerminal: false
      });
      s.sock = sock;

      sock.ev.on('creds.update', s.saveCreds);
      sock.ev.on('connection.update', async (u) => {
        if (sessions.get(id) !== s || s.sock !== sock) return;

        if (u.qr) {
          try {
            s.qr = await qrcode.toDataURL(u.qr);
            s.online = false;
            s.number = '';
            s.status = 'Escaneie o QR Code';
            notify(id, { status: s.status, connected: false, numero: '' });
            onLog?.(`WhatsApp conta ${id}: QR Code gerado.`);
          } catch (e) {
            s.qr = null;
            s.status = `Erro ao gerar QR: ${e.message}`;
            notify(id, { status: s.status, connected: false, numero: '' });
          }
        }

        if (u.connection === 'open') {
          s.qr = null;
          s.online = true;
          s.number = String(sock.user?.id || '').split(':')[0].replace(/\D/g, '');
          s.status = 'Conectado';
          notify(id, { status: s.status, connected: true, numero: s.number });
          onLog?.(`WhatsApp conta ${id} conectada${s.number ? ` — ${s.number}` : ''}.`);
        }

        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          s.online = false;
          s.qr = null;
          s.sock = null;
          s.number = '';
          if (s.manualDisconnected) {
            s.status = 'Desconectado';
            s.starting = false;
            notify(id, { status: s.status, connected: false, numero: '' });
            return;
          }
          if (code === DisconnectReason.loggedOut) {
            s.status = 'Sessão encerrada — novo QR necessário.';
            s.starting = false;
            try { fs.rmSync(s.authDir, { recursive: true, force: true }); } catch {}
            notify(id, { status: s.status, connected: false, numero: '' });
            return;
          }
          s.status = 'Reconectando...';
          s.starting = false;
          notify(id, { status: s.status, connected: false, numero: '' });
          if (!s.manualDisconnected) {
            s.reconnectTimer = setTimeout(() => {
              s.reconnectTimer = null;
              start(account).catch(() => {});
            }, 3000);
          }
        }
      });
    } catch (e) {
      s.sock = null;
      s.online = false;
      s.qr = null;
      s.status = `Erro: ${e.message}`;
      s.starting = false;
      notify(id, { status: s.status, connected: false, numero: '' });
      onLog?.(`WhatsApp conta ${id}: erro ao iniciar: ${e.message}`);
      if (!options.noRetry) {
        s.reconnectTimer = setTimeout(() => {
          s.reconnectTimer = null;
          start(account).catch(() => {});
        }, 5000);
      }
    } finally {
      s.starting = false;
    }
    return snapshot(id);
  }

  async function stop(account, options = {}) {
    const id = String(account.id);
    const s = sessions.get(id);
    if (!s) {
      if (options.clearAuth) {
        try { fs.rmSync(account.authDir, { recursive: true, force: true }); } catch {}
      }
      notify(id, { status: 'Desconectado', connected: false, numero: '' });
      return snapshot(id);
    }
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
    s.manualDisconnected = true;
    s.online = false;
    s.qr = null;
    s.status = 'Desconectando...';
    notify(id, { status: s.status, connected: false, numero: '' });
    try {
      if (options.logout && s.sock) await s.sock.logout();
    } catch (e) { onLog?.(`WhatsApp conta ${id}: logout: ${e.message}`); }
    try { s.sock?.end(); } catch {}
    s.sock = null;
    s.status = 'Desconectado';
    s.starting = false;
    notify(id, { status: s.status, connected: false, numero: '' });
    if (options.clearAuth) {
      try { fs.rmSync(account.authDir, { recursive: true, force: true }); } catch {}
    }
    if (options.newQr) {
      s.manualDisconnected = false;
      sessions.delete(id);
      return start(account, { noRetry: true });
    }
    return snapshot(id);
  }

  return {
    start,
    stop,
    status: snapshot,
    has: (id) => sessions.has(String(id))
  };
}

module.exports = { createWhatsAppSessionManager };
