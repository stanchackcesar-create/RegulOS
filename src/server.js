let lastGroupRefreshAt = 0;

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
