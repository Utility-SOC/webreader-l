// Page-picture cache in IndexedDB: LRU by last use, capped by page count and bytes, entries expire after a while.
// Everything here is best-effort: if storage is unavailable or cleared (iOS may do that), callers just render again.
const DB = 'webreader-pages', STORE = 'pages';
export const LIMITS = { maxPages: 80, maxBytes: 150 * 1024 * 1024, maxAgeMs: 30 * 24 * 3600 * 1000 };

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const run = async (mode, fn) => {
  const d = await db();
  return new Promise((res, rej) => { const tx = d.transaction(STORE, mode); const out = fn(tx.objectStore(STORE)); tx.oncomplete = () => res(out?.result ?? out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
};
const safe = async (fn, dflt) => { try { return await fn(); } catch { return dflt; } };

export const cacheGet = (key) => safe(async () => {
  const row = await run('readonly', (s) => s.get(key));
  if (!row) return null;
  safe(() => run('readwrite', (s) => s.put({ ...row, t: Date.now() })));   // touch (LRU)
  return row.blob;
}, null);

export const cachePut = (key, blob) => safe(async () => { await run('readwrite', (s) => s.put({ key, blob, bytes: blob.size, t: Date.now() })); await evict(); }, null);

export const cacheKeys = (prefix) => safe(async () => (await run('readonly', (s) => s.getAllKeys())).filter((k) => k.startsWith(prefix)), []);

export const cacheClear = () => safe(() => run('readwrite', (s) => s.clear()), null);

async function evict() {
  const rows = await run('readonly', (s) => s.getAll());
  const now = Date.now();
  rows.sort((a, b) => a.t - b.t);   // oldest use first
  let bytes = rows.reduce((n, r) => n + r.bytes, 0), count = rows.length;
  const drop = [];
  for (const r of rows) {
    if (now - r.t > LIMITS.maxAgeMs || count > LIMITS.maxPages || bytes > LIMITS.maxBytes) { drop.push(r.key); count--; bytes -= r.bytes; }
  }
  if (drop.length) await run('readwrite', (s) => { drop.forEach((k) => s.delete(k)); });
}

// Identify a file without reading all of it: size + name + a hash of its first 256 KB.
export async function fingerprint(file, bytes) {
  let h = '';
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes.slice(0, 262144));
    h = [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { /* no SubtleCrypto: fall back to metadata only */ }
  return `${file.size}-${h || file.name}`;
}
