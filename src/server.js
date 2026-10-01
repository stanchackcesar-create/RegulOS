function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value;
  } catch (e) {
    addLog(`Erro lendo ${path.basename(file)}: ${e.message}`);
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
  return scheduleJsonWrite(file, value);
}

function addLog(message) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${message}`;
  logs.push(line);
  if (logs.length > 200) logs.shift();
  console.log(line);
}
