// On-device document extraction: no server. Images -> OCR; PDFs -> embedded text, with OCR for scanned
// pages; TXT -> as is. Output matches the backend's `words` array (including "\n\n" paragraph tokens).
import { createWorker } from 'tesseract.js';
import * as pdfjs from 'pdfjs-dist';

export const LOCAL_MODE = import.meta.env.VITE_LOCAL === '1';

const BASE = import.meta.env.BASE_URL;
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}ocr/pdf.worker.min.mjs`;

let workerPromise = null;
function getOcr(onProgress) {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      workerPath: `${BASE}ocr/worker.min.js`,
      corePath: `${BASE}ocr`,
      langPath: `${BASE}ocr`,
      gzip: true,
      logger: (m) => workerPromise && window.__ocrProgress?.(m),
    });
  }
  window.__ocrProgress = onProgress;
  return workerPromise;
}

// Same rules as backend process_text: paragraph breaks become "\n\n" tokens, everything else splits on whitespace.
export { pdfjs };
export function toWords(text) {
  const words = [];
  for (const part of text.replace(/\r/g, '').split(/(\n\s*\n)/)) {
    if (/^\n\s*\n$/.test(part)) { if (words.length && words[words.length - 1] !== '\n\n') words.push('\n\n'); }
    else words.push(...part.split(/\s+/).filter(Boolean));
  }
  return words;
}

// Repair words hyphenated across line breaks, and join soft-wrapped lines inside a paragraph.
export function tidy(text) {
  return text.replace(/(\w)-\n(\w)/g, '$1$2').replace(/([^\n])\n(?!\n)/g, '$1 ');
}

// Phone photos are huge; downscale so OCR is fast and memory-safe on iOS (canvas limit ~16MP).
async function toCanvas(source, maxSide = 2400) {
  const bmp = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.25)';   // helps on uneven phone lighting
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

export async function ocrCanvas(canvas, onStatus) {
  const w = await getOcr((m) => { if (m.status === 'recognizing text') onStatus?.(`Reading text… ${Math.round(m.progress * 100)}%`); else if (m.status) onStatus?.(`Preparing OCR (${m.status})…`); });
  const { data } = await w.recognize(canvas);
  return data.text;
}

async function fromPdf(file, onStatus) {
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    onStatus?.(`Page ${p} of ${pdf.numPages}…`);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let text = tc.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('');
    if (text.replace(/\s/g, '').length < 20) {          // scanned page: render and OCR it
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      text = await ocrCanvas(canvas, (s) => onStatus?.(`Page ${p}/${pdf.numPages}: ${s}`));
    }
    pages.push(text);
  }
  return pages.join('\n\n');
}

export async function extractLocal(file, onStatus) {
  const name = file.name.toLowerCase();
  let text;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') text = await fromPdf(file, onStatus);
  else if (name.endsWith('.txt') || file.type === 'text/plain') text = await file.text();
  else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic)$/.test(name)) text = await ocrCanvas(await toCanvas(file), onStatus);
  else throw new Error('On this device you can open PDFs, text files, and photos. DOCX/PPTX need the server version.');
  const words = toWords(tidy(text));
  if (!words.length) throw new Error('No text found. Try a sharper, better-lit photo.');
  return { words };
}
