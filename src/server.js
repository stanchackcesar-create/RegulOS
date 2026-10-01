const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.REGULOS_DATA_DIR || path.join(ROOT, 'data');
const AUTH = process.env.REGULOS_AUTH_DIR || path.join(ROOT, 'auth');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(AUTH, { recursive: true });

const SQLITE_DB = path.join(DATA, 'regulos.db');
let sqliteDb = null;

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

// ==== SQLite Persistence Layer ====
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

// ==== Async JSON persistence with fallback ====
async function readJson(file, fallback) {
  try {
    const key = path.basename(file);
    const sqliteValue = await readState(key, null);
    if (sqliteValue !== null && sqliteValue !== undefined) return sqliteValue;
  } catch (e) {
    console.error(`Leitura sqlite fallthrough para ${path.basename(file)}: ${e.message}`);
  }

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

async function writeJson(file, value) {
  const key = path.basename(file);
  await writeState(key, value);
  return scheduleJsonWrite(file, value);
}

// ==== Async Job Scheduler Queue ====
const scheduleQueue = [];
let scheduleWorkerRunning = false;

function enqueueScheduleJob(job) {
  scheduleQueue.push(job);

  if (scheduleWorkerRunning) return;

  scheduleWorkerRunning = true;

  setTimeout(async () => {
    while (scheduleQueue.length) {
      const currentJob = scheduleQueue.shift();
      try {
        await currentJob();
      } catch (e) {
        console.error(`Erro no job do scheduler: ${e.message}`);
      }
    }

    scheduleWorkerRunning = false;
  }, 0);
}

// ==== Data initialization ====
let links = Array.isArray(readJson(FILES.links, [])) ? readJson(FILES.links, []) : [];
let allowed = Array.isArray(readJson(FILES.groups, [])) ? readJson(FILES.groups, []) : [];
let groupConfig = readJson(FILES.groupConfig, {});
let history = Array.isArray(readJson(FILES.history, [])) ? readJson(FILES.history, []) : [];
let linkSchedules = Array.isArray(readJson(FILES.schedules, [])) ? readJson(FILES.schedules, []) : [];
let linkHistory = Array.isArray(readJson(FILES.linkHistory, [])) ? readJson(FILES.linkHistory, []) : [];
let linkFailures = Array.isArray(readJson(FILES.linkFailures, [])) ? readJson(FILES.linkFailures, []) : [];
let botSchedule = readJson(FILES.botSchedule, { ativo: false, inicio: '', fim: '' });

let logs = [];

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC));

// ==== API Endpoints ====

app.post('/api/link-agendamentos', (req, res) => {
  const b = req.body || {};
  if (!b.nome && !b.url) {
    return res.status(400).json({ ok: false, msg: 'Nome ou URL obrigatória' });
  }

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
    mensagensAleatorias: Array.isArray(b.mensagensAleatorias)
      ? b.mensagensAleatorias.map(String).filter(Boolean)
      : [],
    mensagemAleatoriaAtiva: b.mensagemAleatoriaAtiva === true,
    imagemStatus: 'pendente',
    imagemUltimaTentativa: '',
    enviados: 0,
    sucessos: 0,
    erros: 0,
    lastRunKey: '',
    createdAt: new Date().toISOString()
  };

  linkSchedules.push(item);

  // ==== Move persistence to async queue ====
  enqueueScheduleJob(async () => {
    try {
      await writeJson(FILES.schedules, linkSchedules);
      item.status = 'agendado';
      item.imagemStatus = 'pendente';
    } catch (e) {
      item.status = 'erro';
      item.erros = (item.erros || 0) + 1;
      console.error(`Falha ao persistir agendamento: ${e.message}`);
    }
  });

  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, agendamento: item });
});

app.get('/api/link-agendamentos', (req, res) => {
  res.json({ agendamentos: linkSchedules });
});

app.get('/api/status', (req, res) => {
  const status = {
    conectado: false,
    temQR: false,
    status: 'Aguardando conexão',
    numero: '',
    grupos: allowed.length,
    permitidos: allowed.filter(g => g.allowed).length,
    linksCount: links.length + linkSchedules.length,
    logs: logs.slice(-50)
  };
  res.json(status);
});

// ==== Heavy job processing with queue ====
async function processLinkPreview(url) {
  return new Promise((resolve) => {
    enqueueScheduleJob(async () => {
      try {
        const preview = {
          url: url,
          title: 'Link Preview',
          image: '',
          description: '',
          processedAt: new Date().toISOString()
        };

        linkHistory.push(preview);
        if (linkHistory.length > 1000) linkHistory.shift();

        await writeJson(FILES.linkHistory, linkHistory);
        resolve({ ok: true, preview });
      } catch (e) {
        console.error(`Falha ao processar preview: ${e.message}`);
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

async function processLinkBatch(links) {
  return new Promise((resolve) => {
    enqueueScheduleJob(async () => {
      try {
        for (const link of links) {
          await processLinkPreview(link.url);
        }
        resolve({ ok: true, processed: links.length });
      } catch (e) {
        console.error(`Falha ao processar lote: ${e.message}`);
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

async function recordLinkFailure(linkId, error) {
  return new Promise((resolve) => {
    enqueueScheduleJob(async () => {
      try {
        const failure = {
          linkId,
          error,
          timestamp: new Date().toISOString()
        };

        linkFailures.push(failure);
        if (linkFailures.length > 500) linkFailures.shift();

        await writeJson(FILES.linkFailures, linkFailures);
        resolve({ ok: true });
      } catch (e) {
        console.error(`Falha ao registrar erro de link: ${e.message}`);
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

// ==== Initialize server ====
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`RegulOS rodando em ${HOST}:${PORT}`);
  openSqlite().catch(e => console.error('Erro ao abrir SQLite:', e));
});

module.exports = {
  app,
  readJson,
  writeJson,
  enqueueScheduleJob,
  processLinkPreview,
  processLinkBatch,
  recordLinkFailure
};
