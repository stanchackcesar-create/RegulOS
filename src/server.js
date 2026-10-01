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
    addLog(`SQLite readState falhou para ${key}: ${e.message}`);
    return fallback;
  }
}

async function writeState(key, value) {
  try {
    const db = await openSqlite();
    const payload = JSON.stringify(value);
    await db.run(
      `INSERT INTO state (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, payload]
    );
  } catch (e) {
    addLog(`SQLite writeState falhou para ${key}: ${e.message}`);
  }
}

async function readJson(file, fallback) {
  try {
    const key = path.basename(file);
    const sqliteValue = await readState(key, null);
    if (sqliteValue !== null && sqliteValue !== undefined) return sqliteValue;
  } catch (e) {
    addLog(`Leitura sqlite fallthrough para ${path.basename(file)}: ${e.message}`);
  }

  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value;
  } catch (e) {
    addLog(`Erro lendo ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

async function writeJson(file, value) {
  const key = path.basename(file);
  await writeState(key, value);
  return scheduleJsonWrite(file, value);
}
