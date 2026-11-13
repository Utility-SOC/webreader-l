// On-device manual-layout document for a photo: one "page", OCR'd once (with word positions) so boxes preview instantly.
import { fingerprint } from './pageCache';
import { layoutApi } from './layoutStore';
import { toCanvas, ocrCanvasWords, toWords, tidy } from './extract';

const rel = (b, W, H) => (b.relative ? { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H } : { x: b.x, y: b.y, w: b.w, h: b.h });

function wordsToText(words) {
  let out = '', prev = null;
  for (const w of words) {
    if (prev) out += w.para !== prev.para ? '\n\n' : w.line !== prev.line ? '\n' : ' ';
    out += w.text; prev = w;
  }
  return out;
}

export async function openLocalImage(file) {
  const canvas = await toCanvas(file);
  const fp = await fingerprint(file, new Uint8Array(await file.arrayBuffer()));
  let ocr = null, url = null, status = null;
  const ensure = (onStatus) => { if (onStatus) status = onStatus; return (ocr ||= ocrCanvasWords(canvas, (m) => status?.(m))); };
  const inBox = (words, box) => { const r = rel(box, canvas.width, canvas.height); return words.filter((w) => w.cx >= r.x && w.cx <= r.x + r.w && w.cy >= r.y && w.cy <= r.y + r.h); };

  return {
    pageCount: 1,
    layout: layoutApi(fp),
    prefetch: (onStatus) => ensure(onStatus).catch(() => {}),
    async pageUrl() {
      if (!url) {
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
        url = URL.createObjectURL(blob);
      }
      return url;
    },
    diagText: () => `photo ${canvas.width}x${canvas.height}`,
    async boxText(_page, box) {
      const { words } = await ensure();
      const toks = toWords(tidy(wordsToText(inBox(words, box)))).filter((w) => w !== '\n\n');
      return { word_count: toks.length, first: toks.slice(0, 5).join(' '), last: toks.slice(-5).join(' ') };
    },
    async extract(boxesMap, _start, onStatus) {
      const { words, text } = await ensure(onStatus);
      const boxes = boxesMap['0'];
      const images = [];
      let out = '';
      if (!boxes || !boxes.length) out = text;
      else for (const b of boxes) {
        if (b.type === 'image') {
          const r = rel(b, canvas.width, canvas.height);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
          c.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
          const name = `Photo_Image_${Math.round(b.x * 1000)}_${Math.round(b.y * 1000)}`;
          images.push({ name, src: c.toDataURL('image/png'), caption: '' });
          out += `\n\n@@FIG:${name}@@\n\n`;
        } else out += wordsToText(inBox(words, b)) + '\n\n';
      }
      const toks = toWords(tidy(out)).map((w) => (/^@@FIG:.+@@$/.test(w) ? `[FIGURE:${w.slice(6, -2)}]` : w));
      return { words: toks, images };
    },
  };
}
