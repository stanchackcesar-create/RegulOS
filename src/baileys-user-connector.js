'use strict';

const fs = require('node:fs');
const path = require('node:path');
const baileys = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');

function normalizePhone(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\\D/g, '');
}

/**
 * Adapter Baileys por usuário. Cada runtime usa sua própria pasta de autenticação
 * dentro de data/users/<id>/auth. O adapter administra listeners e credenciais;
 * o runtime é o único responsável por encerrar o socket.
 */
function createBaileysUserConnector(options = {}) {
  const makeSocket = options.makeWASocket || baileys.default;
  const useAuthState = options.useMultiFileAuthState || baileys.useMultiFileAuthState;
  const fetchVersion = options.fetchLatestBaileysVersion || baileys.fetchLatestBaileysVersion;
  const renderQr = options.toDataURL || qrcode.toDataURL;
  const logger = options.logger || pino({ level: 'silent' });

  if (typeof makeSocket !== 'function' ||
      typeof useAuthState !== 'function' ||
      typeof fetchVersion !== 'function' ||
      typeof renderQr !== 'function') {
    throw new TypeError('Dependências Baileys inválidas para o conector.');
  }

  async function connect(userId, runtime, callbacks) {
    if (!runtime || runtime.userId !== userId || runtime.closed) {
      throw new Error('Runtime incompatível com a sessão solicitada.');
    }
    const authDir = path.join(runtime.context.dir, 'auth');
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

    const auth = await useAuthState(authDir);
    const versionResult = await fetchVersion();
    const socket = makeSocket({
      version: versionResult.version,
      auth: auth.state,
      logger,
      browser: ['Regulos', 'Chrome', '120'],
      printQRInTerminal: false
    });

    let closed = false;
    let qrWork = Promise.resolve();
    const onCredsUpdate = () => {
      Promise.resolve(auth.saveCreds()).catch(() => {});
    };
    const onConnectionUpdate = update => {
      if (closed || runtime.closed) return;
      if (update?.qr) {
        qrWork = qrWork.then(async () => {
          if (closed || runtime.closed) return;
          try {
            callbacks.onQr(await renderQr(update.qr));
          } catch (error) {
            callbacks.onClose(new Error('Falha ao gerar QR Code: ' + (error?.message || error)));
          }
        });
      }
      if (update?.connection === 'open') {
        callbacks.onOpen({ connectedNumber: normalizePhone(socket.user?.id || '') });
        Promise.resolve(socket.groupFetchAllParticipating?.())
          .then(raw => {
            if (closed || runtime.closed || !raw || typeof raw !== 'object') return;
            const groups = Object.entries(raw)
              .filter(([id]) => id.endsWith('@g.us'))
              .map(([id, group]) => ({
                id,
                name: String(group?.subject || group?.name || id),
                subject: String(group?.subject || group?.name || '')
              }));
            callbacks.onGroups(groups);
          })
          .catch(error => callbacks.onClose(new Error('Falha ao carregar grupos: ' + (error?.message || error))));
      }
      if (update?.connection === 'close') {
        callbacks.onClose(update.lastDisconnect?.error || new Error('Conexão WhatsApp encerrada.'));
      }
    };

    socket.ev.on('creds.update', onCredsUpdate);
    socket.ev.on('connection.update', onConnectionUpdate);

    return Object.freeze({
      socket,
      authDir,
      async close() {
        if (closed) return false;
        closed = true;
        socket.ev.off?.('creds.update', onCredsUpdate);
        socket.ev.off?.('connection.update', onConnectionUpdate);
        // Não chama socket.end() aqui: o runtime possui e encerra o socket.
        return true;
      }
    });
  }

  return Object.freeze({ connect });
}

module.exports = { createBaileysUserConnector, normalizePhone };
