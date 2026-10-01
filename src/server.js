const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const crypto = require('crypto');

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

    CREATE TABLE IF NOT EXISTS scheduler_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      retries INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
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

// ==== Scheduler History ====
async function pushSchedulerEvent(type, status, durationMs, retries = 0) {
  try {
    const db = await openSqlite();
    await db.run(
      `INSERT INTO scheduler_history (type, status, duration_ms, retries)
       VALUES (?, ?, ?, ?)`,
      [type, status, durationMs, retries]
    );
    // Cleanup old history (keep last 2000 entries)
    await db.run(`DELETE FROM scheduler_history WHERE id NOT IN (SELECT id FROM scheduler_history ORDER BY id DESC LIMIT 2000)`);
  } catch (e) {
    console.error(`Erro ao registrar evento do scheduler: ${e.message}`);
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

// ==== Priority-based Scheduler with Multiple Workers ====
const JOB_PRIORITY = {
  send: 1,
  history: 2,
  preview: 3,
  failure: 4,
  batch: 5,
};

const schedulerMetrics = {
  total: 0,
  processed: 0,
  failed: 0,
  retries: 0,
  byType: {},
  byTypeFailed: {},
  latency: {},
};

function recordSchedulerMetric(type, durationMs, ok) {
  schedulerMetrics.total += 1;
  schedulerMetrics.byType[type] = (schedulerMetrics.byType[type] || 0) + 1;
  schedulerMetrics.latency[type] = schedulerMetrics.latency[type] || { count: 0, total: 0 };
  schedulerMetrics.latency[type].count += 1;
  schedulerMetrics.latency[type].total += durationMs;

  if (!ok) {
    schedulerMetrics.failed += 1;
    schedulerMetrics.byTypeFailed[type] = (schedulerMetrics.byTypeFailed[type] || 0) + 1;
  } else {
    schedulerMetrics.processed += 1;
  }
}

const schedulerWorkers = {
  send: [],
  history: [],
  preview: [],
  failure: [],
  batch: [],
};

const schedulerQueue = {
  send: [],
  history: [],
  preview: [],
  failure: [],
  batch: [],
};

const schedulerState = {
  running: { send: false, history: false, preview: false, failure: false, batch: false },
};

function enqueueJob(type, jobId, jobFn, payload = {}, priority = JOB_PRIORITY[type] || 99) {
  const item = { id: jobId, type, fn: jobFn, payload, priority, retries: 0, createdAt: Date.now() };
  schedulerQueue[type].push(item);
  schedulerQueue[type].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  if (!schedulerState.running[type]) {
    schedulerState.running[type] = true;
    startSchedulerWorker(type);
  }
}

function getBackoffDelay(retries) {
  return Math.min(1000 * Math.pow(2, retries), 20000);
}

function startSchedulerWorker(type) {
  const worker = async () => {
    while (schedulerQueue[type].length) {
      const job = schedulerQueue[type].shift();
      if (!job) continue;

      try {
        const existing = await getJobDedup(job.id);
        if (existing && existing.status === 'completed') continue;

        if (!checkRateLimit(`job:${type}`, 50, 60)) {
          schedulerQueue[type].push(job);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        await recordJobDedup(job.id, type, job.payload, 'processing');
        const start = Date.now();
        await job.fn();
        const duration = Date.now() - start;
 
        await recordJobDedup(job.id, type, job.payload, 'completed');
        recordSchedulerMetric(type, duration, true);
        await pushSchedulerEvent(type, 'completed', duration, job.retries);
      } catch (e) {
        const duration = Date.now() - job.createdAt;
        recordSchedulerMetric(type, duration, false);

        if (job.retries < 3) {
          job.retries += 1;
          schedulerMetrics.retries += 1;
          await incrementJobRetry(job.id);
          await pushSchedulerEvent(type, 'retry', duration, job.retries);
          await new Promise(r => setTimeout(r, getBackoffDelay(job.retries)));
          schedulerQueue[type].push(job);
        } else {
          await recordJobDedup(job.id, type, job.payload, 'failed');
          await pushSchedulerEvent(type, 'failed', duration, job.retries);
        }
      }
    }

    schedulerState.running[type] = false;

    if (schedulerQueue[type].length && !schedulerState.running[type]) {
      schedulerState.running[type] = true;
      setTimeout(worker, 0);
    }
  };

  schedulerWorkers[type].push(worker);
  setTimeout(worker, 0);
}

app.get('/api/scheduler-metrics', (req, res) => {
  const latencySnapshot = {};
  for (const [type, entry] of Object.entries(schedulerMetrics.latency || {})) {
    latencySnapshot[type] = {
      count: entry.count,
      avgMs: entry.count ? Math.round(entry.total / entry.count) : 0,
    };
  }

  res.json({
    total: schedulerMetrics.total,
    processed: schedulerMetrics.processed,
    failed: schedulerMetrics.failed,
    retries: schedulerMetrics.retries,
    byType: schedulerMetrics.byType,
    byTypeFailed: schedulerMetrics.byTypeFailed,
    latency: latencySnapshot,
    queue: {
      send: schedulerQueue.send.length,
      history: schedulerQueue.history.length,
      preview: schedulerQueue.preview.length,
      failure: schedulerQueue.failure.length,
      batch: schedulerQueue.batch.length,
    }
  });
});

app.get('/api/scheduler-history', async (req, res) => {
  try {
    const { type = 'all', hours = '24' } = req.query;
    const hoursNum = Math.max(1, Math.min(Number(hours) || 24, 168));
    const cutoffMinutes = hoursNum * 60;

    const db = await openSqlite();
    let query = `SELECT * FROM scheduler_history WHERE datetime(timestamp) > datetime('now', '-${cutoffMinutes} minutes') ORDER BY id DESC LIMIT 500`;
    const params = [];

    if (type && type !== 'all') {
      query = `SELECT * FROM scheduler_history WHERE type = ? AND datetime(timestamp) > datetime('now', '-${cutoffMinutes} minutes') ORDER BY id DESC LIMIT 500`;
      params.push(type);
    }

    const history = await db.all(query, params);

    res.json({
      windowHours: hoursNum,
      type: type === 'all' ? null : type,
      items: history || [],
      total: history ? history.length : 0
    });
  } catch (e) {
    console.error(`Erro ao buscar histórico: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

async function processLinkPreview(url) {
  const jobId = `preview:${Buffer.from(url).toString('base64')}`;

  return new Promise((resolve) => {
    enqueueJob('preview', jobId, async () => {
      try {
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
    enqueueJob('batch', jobId, async () => {
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
    enqueueJob('failure', jobId, async () => {
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
