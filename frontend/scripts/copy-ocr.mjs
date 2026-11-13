// Copies the OCR engine (tesseract.js worker + wasm core + English model) and the PDF.js worker into
// public/ so the app can OCR and read PDFs fully offline (no CDN). Runs before dev/build.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
const out = 'public/ocr';
mkdirSync(out, { recursive: true });
cpSync('node_modules/tesseract.js/dist/worker.min.js', `${out}/worker.min.js`);
for (const f of readdirSync('node_modules/tesseract.js-core')) {
  if (f.startsWith('tesseract-core') && (f.endsWith('.wasm') || f.endsWith('.js'))) cpSync(`node_modules/tesseract.js-core/${f}`, `${out}/${f}`);
}
cpSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', `${out}/eng.traineddata.gz`);
cpSync('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', `${out}/pdf.worker.min.mjs`);
console.log('OCR assets copied to', out);
