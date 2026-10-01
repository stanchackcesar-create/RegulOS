const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

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

async function processLinkPreview(url) {
  return new Promise((resolve) => {
    enqueueScheduleJob(async () => {
      try {
        const preview = {
          url,
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
