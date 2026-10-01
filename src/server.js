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
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

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
const REGULOS_TIMEZONE = process.env.REGULOS_TIMEZONE || 'America/Sao_Paulo';
process.env.TZ = REGULOS_TIMEZONE;

const SQLITE_DB = path.join(DATA, 'regulos.db');
let sqliteDb = null;

async function openSqlite() {
  if (sqliteDb) return sqliteDb;

  sqliteDb = await open({
    filename: SQLITE_DB,
    driver: sqlite3.Database
  });

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return sqliteDb;
}

async function readState(key, fallback) {
  try {
    const db = await openSqlite();
    const row = await db.get('SELECT value FROM state WHERE key = ?', [key]);
    if (!row) return fallback;
    return JSON.parse(row.value);
  } catch (e) {
    console.error(`SQLite readState falhou para ${key}: ${e.message}`);
    return fallback;
  }
}

async function writeState(key, value) {
  try {
    const db = await openSqlite();
    await db.run(
      `INSERT INTO state (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [key, JSON.stringify(value)]
    );
  } catch (e) {
    console.error(`SQLite writeState falhou para ${key}: ${e.message}`);
  }
}

const FILES = {
  groups: path.join(DATA, 'grupos.json'),
  groupConfig: path.join(DATA, 'grupos_config.json'),
  links: path.join(DATA, 'links.json'),
  index: path.join(DATA, 'indice.txt'),
  history: path.join(DATA, 'historico.json'),
  schedules: path.join(DATA, 'agendamentos.json'),
  linkHistory: path.join(DATA, 'historico_links.json'),
  linkFailures: path.join(DATA, 'links_falhas.json'),
  botSchedule: path.join(DATA, 'programacao.json')
};

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value;
  } catch (e) {
    console.error(`Erro lendo ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

const pendingJsonWrites = new Map();
let pendingJsonWriteTimer = null;

async function flushPendingJsonWrites() {
  if (!pendingJsonWrites.size) return;

  const pending = [...pendingJsonWrites.entries()];
  pendingJsonWrites.clear();

  for (const [file, value] of pending) {
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (e) {
      console.error(`Erro persistindo ${path.basename(file)}: ${e.message}`);
      pendingJsonWrites.set(file, value);
    }
  }
}

function scheduleJsonWrite(file, value) {
  pendingJsonWrites.set(file, value);
  if (pendingJsonWriteTimer) return Promise.resolve();

  pendingJsonWriteTimer = setTimeout(async () => {
    pendingJsonWriteTimer = null;
    await flushPendingJsonWrites();
  }, 25);

  return Promise.resolve();
}

function writeJson(file, value) {
  const key = path.basename(file);
  writeState(key, value).catch(e => console.error(`Erro em writeState: ${e.message}`));
  return scheduleJsonWrite(file, value);
}

const scheduleQueue = [];
let scheduleWorkerRunning = false;

function enqueueScheduleJob(job) {
  scheduleQueue.push(job);

  if (scheduleWorkerRunning) return;

  scheduleWorkerRunning = true;

  setTimeout(async () => {
    while (scheduleQueue.length) {
      const job = scheduleQueue.shift();
      try {
        await job();
      } catch (e) {
        console.error(`Erro no job do scheduler: ${e.message}`);
      }
    }
    scheduleWorkerRunning = false;
  }, 0);
}

const pageFetchCache = new Map();
const imageDownloadCache = new Map();
const productTitleCache = new Map();
const productImageCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedValue(cache, key, value) {
  if (cache.size >= 200) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, ts: Date.now() });
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
let botSchedule = readJson(FILES.botSchedule, { ativo: false, inicio: '', fim: '' });
if (!botSchedule || typeof botSchedule !== 'object' || Array.isArray(botSchedule)) botSchedule = { ativo: false, inicio: '', fim: '' };

let logs = [];
let sock = null;
let online = false;
let qr = '';
let reconnectTimer = null;
let index = Number(readJson(FILES.index, 0)) || 0;
let users = readJson(USERS_FILE, []);
let sessions = readJson(SESSIONS_FILE, []);
let loginAttempts = new Map();

const app = express();
const logger = P({ level: 'silent' });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC));

app.get('/api/status', (req, res) => {
  const conectado = online && sock;
  const numero = sock?.user?.id ? normalizePhone(sock.user.id) : '';
  const grupos = allowed.length;
  const permitidos = allowed.filter(g => g.allowed).length;
  const gruposLigados = allowed.filter(g => g.config?.ativo !== false).map(g => ({ id: g.id, nome: g.name }));
  const linksCount = links.length + linkSchedules.length;

  res.json({
    conectado, temQR: !!qr, status: qr ? 'Escaneie o QR Code' : 'Aguardando conexão',
    numero, grupos, permitidos, gruposLigados, links: linksCount, qr,
    janela: botWindowLabel(), programacao: botSchedule
  });
});

app.post('/api/link-agendamentos', (req, res) => {
  const b = req.body || {};
  if (!b.nome && !b.url) return res.status(400).json({ ok: false, msg: 'Nome ou URL obrigatória' });

  const item = {
    id: String(b.id || crypto.randomUUID()),
    nome: String(b.nome || '').trim(),
    url: String(b.url || '').trim(),
    mensagem: String(b.mensagem || '').trim(),
    data: String(b.data || '').trim(),
    horario: String(b.horario || '').trim(),
    repeticao: String(b.repeticao || 'uma_vez'),
    intervaloMin: Number(b.intervaloMin || 2),
    intervaloMax: Number(b.intervaloMax || 2),
    ativo: b.ativo !== false,
    status: b.ativo === false ? 'pausado' : 'agendado',
    imagemAutomatica: b.imagemAutomatica !== false,
    imagemUrl: String(b.imagemUrl || '').trim(),
    mensagensAleatorias: Array.isArray(b.mensagensAleatorias) ? b.mensagensAleatorias.map(String).filter(Boolean) : [],
    mensagemAleatoriaAtiva: b.mensagemAleatoriaAtiva === true,
    imagemStatus: 'pendente',
    imagemUltimaTentativa: '',
    enviados: 0,
    sucessos: 0,
    erros: 0,
    lastRunKey: '',
    createdAt: new Date().toISOString()
  };

  try {
    linkSchedules.push(item);
    writeJson(FILES.schedules, linkSchedules);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, agendamento: item });
  } catch (e) {
    linkSchedules = linkSchedules.filter(x => x.id !== item.id);
    res.status(500).json({ ok: false, msg: `Falha ao salvar agendamento: ${e.message}` });
  }
});

app.get('/api/link-agendamentos', (req, res) => {
  res.json({ agendamentos: linkSchedules });
});

app.listen(PORT, HOST, () => {
  console.log(`RegulOS v12.11.0 rodando em ${HOST}:${PORT}`);
  openSqlite().catch(e => console.error('Erro ao abrir SQLite:', e));
});
