// On-device stand-in for the backend's manual-layout endpoints (page render, box preview, box extraction).
// Boxes use the same shape as the server: {x,y,w,h,type,relative}, fractions of the page when relative.
import { pdfjs, ocrCanvas, toWords, tidy, safeScale, PDF_OPTS } from './extract';

const RENDER_SCALE = 1.6;      // editor page image
const OCR_SCALE = 2.5;         // crops sent to OCR

// pdf.js options, tried in order if a page comes out blank (WebKit/iOS differences in fonts, OffscreenCanvas, ImageDecoder).
// Force one with ?pdfmode=0|1|2 on the page address.
const SAFE = { disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false };
const VARIANTS = [{ doc: {}, intent: 'display' }, { doc: SAFE, intent: 'display' }, { doc: { ...SAFE, useWasm: false }, intent: 'print' }];

function looksBlank(canvas) {
  const s = document.createElement('canvas');
  s.width = 64; s.height = Math.max(1, Math.round((64 * canvas.height) / canvas.width));
  const ctx = s.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) return false;
  return true;
}

export async function openLocalPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const forced = Number(new URLSearchParams(location.search).get('pdfmode'));
  let variant = forced >= 0 && forced < VARIANTS.length && new URLSearchParams(location.search).has('pdfmode') ? forced : 0;
  let pdf = null;
  const diag = { blank: false, ms: 0, err: '' };

  async function open(v) {
    if (pdf) { try { await pdf.destroy(); } catch { /* already gone */ } }
    pdf = await pdfjs.getDocument({ data: bytes.slice(), ...PDF_OPTS, ...VARIANTS[v].doc }).promise;
    variant = v;
  }
  await open(variant);
  const urls = new Map();       // pageIdx -> blob URL of the editor image

  async function renderOnce(pageIdx, scale) {
    const page = await pdf.getPage(pageIdx + 1);
    const vp = page.getViewport({ scale: safeScale(page, scale) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: VARIANTS[variant].intent }).promise;
    return { page, vp, canvas };
  }

  // Render; if the result is blank or throws, step through the fallback option sets. A page that is blank in every
  // mode is probably really blank: report it and go back to the default mode for the next page.
  async function render(pageIdx, scale) {
    const t0 = performance.now(), start = variant;
    diag.err = '';
    for (;;) {
      let r = null;
      try { r = await renderOnce(pageIdx, scale); } catch (e) { diag.err = String(e?.message || e); }
      const blank = r ? looksBlank(r.canvas) : true;
      if (r && !blank) { diag.blank = false; diag.ms = Math.round(performance.now() - t0); return r; }
      if (variant < VARIANTS.length - 1) { await open(variant + 1); continue; }
      diag.blank = true; diag.ms = Math.round(performance.now() - t0);
      const last = r; await open(start);
      if (!last) throw new Error(diag.err || 'render failed');
      return last;
    }
  }

  const rel = (b, W, H) => (b.relative ? { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H } : { x: b.x, y: b.y, w: b.w, h: b.h });

  async function cropCanvas(pageIdx, box) {
    const { canvas } = await render(pageIdx, OCR_SCALE);
    const r = rel(box, canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
    c.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return c;
  }

  // Text-layer items whose centre lies inside the box, in the PDF's own reading order.
  async function textInBox(pageIdx, box) {
    const page = await pdf.getPage(pageIdx + 1);
    const vp = page.getViewport({ scale: 1 });
    const r = rel(box, vp.width, vp.height);
    const tc = await page.getTextContent();
    let out = '';
    for (const it of tc.items) {
      if (!it.str && !it.hasEOL) continue;
      const m = pdfjs.Util.transform(vp.transform, it.transform);
      const cx = m[4] + (it.width || 0) / 2, cy = m[5] - (it.height || 0) / 2;
      if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) out += it.str + (it.hasEOL ? '\n' : ' ');
    }
    return out;
  }

  async function boxText(pageIdx, box, onStatus) {
    let txt = await textInBox(pageIdx, box);
    if (txt.replace(/\s/g, '').length < 2) txt = await ocrCanvas(await cropCanvas(pageIdx, box), onStatus);
    const words = toWords(tidy(txt)).filter((w) => w !== '\n\n');
    return { word_count: words.length, first: words.slice(0, 5).join(' '), last: words.slice(-5).join(' ') };
  }

  async function pageAuto(pageIdx, onStatus) {
    let txt = await textInBox(pageIdx, { x: 0, y: 0, w: 1, h: 1, relative: true });
    if (txt.replace(/\s/g, '').length < 20) txt = await ocrCanvas((await render(pageIdx, 2)).canvas, onStatus);
    return txt;
  }

  return {
    pageCount: pdf.numPages,
    diagText: () => `pdf.js ${pdfjs.version} · mode ${variant} · ${diag.blank ? 'PAGE BLANK' : 'ok'} · ${diag.ms}ms${diag.err ? ' · ' + diag.err : ''} · Offscreen:${typeof OffscreenCanvas} ImageDecoder:${typeof ImageDecoder}`,
    async pageUrl(pageIdx) {
      if (urls.has(pageIdx)) return urls.get(pageIdx);
      const { canvas } = await render(pageIdx, RENDER_SCALE);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      const u = URL.createObjectURL(blob);
      urls.set(pageIdx, u);
      return u;
    },
    boxText,
    // Same contract as /process_pdf: boxed pages use their boxes, other pages are read automatically.
    async extract(boxesMap, startPage = 1, onStatus) {
      let text = ''; const images = [];
      for (let i = startPage - 1; i < pdf.numPages; i++) {
        onStatus?.(`Page ${i + 1} of ${pdf.numPages}…`);
        const boxes = boxesMap[String(i)];
        if (!boxes || !boxes.length) { text += (await pageAuto(i, onStatus)) + '\n\n'; continue; }
        for (const b of boxes) {
          if (b.type === 'image') {
            const c = await cropCanvas(i, b);
            const name = `Page_${i + 1}_Image_${Math.round(b.x * 1000)}_${Math.round(b.y * 1000)}`;
            images.push({ name, src: c.toDataURL('image/png'), caption: '' });
            text += `\n\n@@FIG:${name}@@\n\n`;
          } else {
            let t = await textInBox(i, b);
            if (t.replace(/\s/g, '').length < 2) t = await ocrCanvas(await cropCanvas(i, b), (s) => onStatus?.(`Page ${i + 1}: ${s}`));
            text += t + '\n';
          }
        }
        text += '\n';
      }
      const words = toWords(tidy(text)).map((w) => (/^@@FIG:.+@@$/.test(w) ? `[FIGURE:${w.slice(6, -2)}]` : w));
      return { words, images };
    },
  };
}
