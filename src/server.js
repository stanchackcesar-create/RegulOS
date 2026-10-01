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
    
    CREATE TABLE IF NOT EXISTS job_dedup (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      retries INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      ttl_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// ==== Job Deduplication & Retry ====
async function getJobDedup(jobId) {
  try {
    const db = await openSqlite();
    return await db.get('SELECT * FROM job_dedup WHERE job_id = ?', [jobId]);
  } catch (e) {
    console.error(`Erro ao buscar dedup: ${e.message}`);
    return null;
  }
}

async function recordJobDedup(jobId, jobType, payload, status = 'pending') {
  try {
    const db = await openSqlite();
    await db.run(
      `INSERT INTO job_dedup (job_id, job_type, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(job_id) DO UPDATE SET
         status = excluded.status,
         updated_at = datetime('now')`,
      [jobId, jobType, JSON.stringify(payload), status]
    );
  } catch (e) {
    console.error(`Erro ao registrar dedup: ${e.message}`);
  }
}

async function incrementJobRetry(jobId) {
  try {
    const db = await openSqlite();
    await db.run(
      'UPDATE job_dedup SET retries = retries + 1, updated_at = datetime("now") WHERE job_id = ?',
      [jobId]
    );
  } catch (e) {
    console.error(`Erro ao incrementar retry: ${e.message}`);
  }
}

// ==== Cache with TTL & Deduplication ====
async function getCacheEntry(key) {
  try {
    const db = await openSqlite();
    const row = await db.get(
      `SELECT value FROM cache_entries 
       WHERE key = ? AND datetime(ttl_expires_at) > datetime('now')`,
      [key]
    );
    if (!row) return null;
    return JSON.parse(row.value);
  } catch (e) {
    console.error(`Erro ao ler cache: ${e.message}`);
    return null;
  }
}

async function setCacheEntry(key, value, ttlSeconds = 600) {
  try {
    const db = await openSqlite();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await db.run(
      `INSERT INTO cache_entries (key, value, ttl_expires_at, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         ttl_expires_at = excluded.ttl_expires_at`,
      [key, JSON.stringify(value), expiresAt]
    );
  } catch (e) {
    console.error(`Erro ao escrever cache: ${e.message}`);
  }
}

async function clearExpiredCache() {
  try {
    const db = await openSqlite();
    await db.run(
      `DELETE FROM cache_entries WHERE datetime(ttl_expires_at) <= datetime('now')`
    );
  } catch (e) {
    console.error(`Erro ao limpar cache: ${e.message}`);
  }
}

// ==== Rate Limiting by Time Window ====
const rateLimitBuckets = new Map();

function getRateLimitKey(namespace, windowSeconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = Math.floor(now / windowSeconds);
  return `${namespace}:${windowKey}`;
}

function checkRateLimit(namespace, maxPerWindow = 100, windowSeconds = 60) {
  const key = getRateLimitKey(namespace, windowSeconds);
  const current = rateLimitBuckets.get(key) || 0;
  
  if (current >= maxPerWindow) {
    return false;
  }
  
  rateLimitBuckets.set(key, current + 1);
  return true;
}

function cleanupOldRateLimitBuckets() {
  const now = Math.floor(Date.now() / 1000);
  const cutoffWindow = Math.floor((now - 300) / 60);
  
  for (const [key] of rateLimitBuckets) {
    const window = parseInt(key.split(':')[1]);
    if (window < cutoffWindow) {
      rateLimitBuckets.delete(key);
    }
  }
}

setInterval(cleanupOldRateLimitBuckets, 60000);

// ==== Enhanced Job Scheduler with Retry & Dedup ====
const scheduleQueue = [];
let scheduleWorkerRunning = false;
const MAX_RETRIES = 3;

function enqueueScheduleJob(jobId, jobType, jobFn, payload = {}) {
  const job = {
    id: jobId,
    type: jobType,
    fn: jobFn,
    payload,
    retries: 0
  };
  
  scheduleQueue.push(job);

  if (scheduleWorkerRunning) return;

  scheduleWorkerRunning = true;

  setTimeout(async () => {
    while (scheduleQueue.length) {
      const currentJob = scheduleQueue.shift();
      
      try {
        // Check if already processed
        const existing = await getJobDedup(currentJob.id);
        if (existing && existing.status === 'completed') {
          continue;
        }

        // Rate limit check
        if (!checkRateLimit(`job:${currentJob.type}`, 50, 60)) {
          scheduleQueue.unshift(currentJob);
          continue;
        }

        // Record as pending
        await recordJobDedup(currentJob.id, currentJob.type, currentJob.payload, 'processing');

        // Execute job
        await currentJob.fn();

        // Mark as completed
        await recordJobDedup(currentJob.id, currentJob.type, currentJob.payload, 'completed');
      } catch (e) {
        console.error(`Erro no job ${currentJob.id}: ${e.message}`);

        if (currentJob.retries < MAX_RETRIES) {
          currentJob.retries++;
          await incrementJobRetry(currentJob.id);
          scheduleQueue.push(currentJob);
        } else {
          await recordJobDedup(currentJob.id, currentJob.type, currentJob.payload, 'failed');
        }
      }
    }

    scheduleWorkerRunning = false;
  }, 0);
}

async function processLinkPreview(url) {
  const jobId = `preview:${Buffer.from(url).toString('base64')}`;

  return new Promise((resolve) => {
    enqueueScheduleJob(jobId, 'preview', async () => {
      try {
        // Check cache first
        const cached = await getCacheEntry(`preview:${url}`);
        if (cached) {
          resolve({ ok: true, preview: cached, fromCache: true });
          return;
        }

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
        await setCacheEntry(`preview:${url}`, preview, 600);

        resolve({ ok: true, preview, fromCache: false });
      } catch (e) {
        console.error(`Falha ao processar preview: ${e.message}`);
        resolve({ ok: false, error: e.message });
      }
    }, { url });
  });
}

async function processLinkBatch(links) {
  const jobId = `batch:${crypto.randomUUID()}`;

  return new Promise((resolve) => {
    enqueueScheduleJob(jobId, 'batch', async () => {
      try {
        let processed = 0;
        for (const link of links) {
          const result = await processLinkPreview(link.url);
          if (result.ok) processed++;
        }
        resolve({ ok: true, processed });
      } catch (e) {
        console.error(`Falha ao processar lote: ${e.message}`);
        resolve({ ok: false, error: e.message });
      }
    }, { linksCount: links.length });
  });
}

async function recordLinkFailure(linkId, error) {
  const jobId = `failure:${linkId}`;

  return new Promise((resolve) => {
    enqueueScheduleJob(jobId, 'failure', async () => {
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
    }, { linkId, error });
  });
}

// ==== Cleanup Expired Cache on Startup ====
setInterval(async () => {
  await clearExpiredCache();
}, 300000); // Every 5 minutes
