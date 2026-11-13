// Remembers a document's manual boxes (as page fractions) in localStorage, keyed by a fingerprint of the file.
// Keeps the most recent MAX documents. Best-effort: if storage is unavailable nothing breaks, you just redo the boxes.
const IDX = 'webreader:layouts:index', PREFIX = 'webreader:layout:', MAX = 40;

export function loadLayout(fp) {
  try { const raw = localStorage.getItem(PREFIX + fp); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function forgetLayout(fp) {
  try {
    localStorage.removeItem(PREFIX + fp);
    const idx = JSON.parse(localStorage.getItem(IDX) || '[]').filter((k) => k !== fp);
    localStorage.setItem(IDX, JSON.stringify(idx));
  } catch { /* storage unavailable */ }
}

export function saveLayout(fp, data) {
  try {
    if (!Object.keys(data.boxes || {}).length) { forgetLayout(fp); return; }
    localStorage.setItem(PREFIX + fp, JSON.stringify({ ...data, t: Date.now() }));
    const idx = JSON.parse(localStorage.getItem(IDX) || '[]').filter((k) => k !== fp);
    idx.push(fp);
    while (idx.length > MAX) localStorage.removeItem(PREFIX + idx.shift());
    localStorage.setItem(IDX, JSON.stringify(idx));
  } catch { /* storage full or unavailable */ }
}

export const layoutApi = (fp) => ({ load: () => loadLayout(fp), save: (d) => saveLayout(fp, d), forget: () => forgetLayout(fp) });
