// Camera vision helpers for the Scan page: what's inside the on-screen frame, is this frame good enough to read,
// image prep for the basic reader, and barcode reading. No UI here; app.js drives the flow.

// ---------- the scan frame in video pixels ----------
// Mirrors the CSS: the reticle is min(58% width, 64% height) square, centred, nudged up (translate -50%, -56%),
// and the video fills the frame with object-fit: cover (so part of the camera image is cropped off-screen).
export function reticleRect(video, frame, margin = 0) {
  const W = frame.clientWidth, H = frame.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(W / vw, H / vh), ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const s = Math.min(W * 0.58, H * 0.64), side = s * (1 + margin * 2);      // margin = extra room on each side, as a share of the frame
  const left = W / 2 - s / 2 - s * margin, top = H / 2 - s * 0.56 - s * margin;
  const sx = Math.max(0, (left - ox) / scale), sy = Math.max(0, (top - oy) / scale);
  return { sx, sy, sw: Math.min(vw - sx, side / scale), sh: Math.min(vh - sy, side / scale) };
}
// The frame's contents as a canvas, longest side ≤ maxSide (and ≥ minSide for small text, when upscaling helps OCR).
export function grabFrame(video, frame, { margin = 0, maxSide = 1280, minSide = 0 } = {}) {
  const r = reticleRect(video, frame, margin);
  const k = Math.min(maxSide / Math.max(r.sw, r.sh), Math.max(1, minSide / Math.max(r.sw, r.sh)));
  const c = document.createElement('canvas');
  c.width = Math.round(r.sw * k); c.height = Math.round(r.sh * k);
  c.getContext('2d').drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
  return c;
}
// A whole image (uploaded photo), longest side ≤ maxSide.
export function imageToCanvas(img, maxSide = 1600) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const c = document.createElement('canvas');
  c.width = Math.round((img.naturalWidth || img.width) * k); c.height = Math.round((img.naturalHeight || img.height) * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// ---------- quality gate ----------
// Measured on a 160 px copy of the frame. Thresholds are starting points: tune them with the demo webcam
// (turn on localStorage "pp-scandebug" = "1" to see live numbers in the status pill).
export const GATE = { dark: 55, sharp: 35, autoSharp: 55, glare: 0.12 };
const small = document.createElement('canvas');
export function frameQuality(src) {
  const w = 160, h = Math.max(1, Math.round(160 * src.height / src.width));
  small.width = w; small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  let sum = 0, bright = 0;
  for (let i = 0; i < w * h; i++) {
    const y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    g[i] = y; sum += y; if (y >= 252) bright++; // clipped highlights only, so a bright white label isn't 'glare'
  }
  // Variance of the Laplacian: lots of sharp edges (printed text in focus) → high; blur or a blank wall → low.
  let n = 0, m = 0, m2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
    n++; const dl = l - m; m += dl / n; m2 += dl * (l - m);
  }
  return { brightness: sum / (w * h), sharpness: n ? m2 / n : 0, glare: bright / (w * h), thumb: g, w, h };
}
// What to tell the user, or null when the frame looks readable.
export function judge(q) {
  if (q.brightness < GATE.dark) return { key: 'dark', text: 'More light, please', speak: 'More light, please.' };
  if (q.glare > GATE.glare) return { key: 'glare', text: 'Glare on the label. Tilt the bottle a little', speak: 'Tilt the bottle a little.' };
  if (q.sharpness < GATE.sharp) return { key: 'blurry', text: 'Hold still, or move a little closer', speak: 'Hold still.' };
  return null;
}
// How different two thumbnails are (mean absolute difference, 0–255). Used so auto-scan doesn't re-read the same view.
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

// ---------- image prep for the basic reader (Tesseract) ----------
// Tesseract's own advice: ~300 dpi-sized text, adaptive (local) thresholding for uneven light, a small white border.
export function prepForOcr(src, target = 1200) {
  const k = target / Math.max(src.width, src.height); // 1200 px reads labels as well as 1800 px in about half the time
  const w = Math.round(src.width * k), h = Math.round(src.height * k), pad = 12;
  const c = document.createElement('canvas');
  c.width = w + pad * 2; c.height = h + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, src.width, src.height, pad, pad, w, h);
  const img = ctx.getImageData(pad, pad, w, h), d = img.data;
  // Bradley adaptive threshold: a pixel is ink when it's 15% darker than the mean of its ~1/16-width neighbourhood.
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) { let row = 0; for (let x = 1; x <= w; x++) { row += gray[(y - 1) * w + x - 1]; integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + row; } }
  const r = Math.max(8, Math.round(w / 32));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x1 = Math.max(0, x - r), x2 = Math.min(w, x + r + 1), y1 = Math.max(0, y - r), y2 = Math.min(h, y + r + 1);
    const area = (x2 - x1) * (y2 - y1), s = integ[y2 * (w + 1) + x2] - integ[y1 * (w + 1) + x2] - integ[y2 * (w + 1) + x1] + integ[y1 * (w + 1) + x1];
    const v = gray[y * w + x] * area < s * 0.85 ? 0 : 255, i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, pad, pad);
  return c;
}

// ---------- barcodes ----------
// Native BarcodeDetector where the browser has it (Android, macOS, ChromeOS); otherwise the bundled ZXing reader.
const FORMATS = ['upc_a', 'ean_13', 'data_matrix'];
let detector = null, loading = null;
export function barcodeReader() {
  return loading ||= (async () => {
    try {
      if ('BarcodeDetector' in globalThis) {
        const ok = (await globalThis.BarcodeDetector.getSupportedFormats()).filter(f => FORMATS.includes(f));
        if (ok.length === FORMATS.length) return (detector = new globalThis.BarcodeDetector({ formats: ok }));
      }
    } catch { /* fall through to the bundled reader */ }
    try {
      const { BarcodeDetector } = await import('/vendor/barcode-detector.js');
      return (detector = new BarcodeDetector({ formats: FORMATS }));
    } catch { return null; }
  })();
}
// Raw barcode values found in an image/canvas/video ([] when none or no reader).
export async function readBarcodes(src) {
  const d = detector || await barcodeReader();
  if (!d) return [];
  try { return (await d.detect(src)).map(b => ({ format: b.format, raw: b.rawValue })); } catch { return []; }
}
// Same rules as the server's ndcFromBarcode (logic.js): UPC-A "3"+NDC, EAN-13 "03"+NDC, GS1 Data Matrix (01)(17)(10)(21).
export function ndcFromBarcode(raw = '') {
  const v = String(raw).replace(/^\]d2|^\]C1|^\]e0/, '');
  let ndc10 = '', lot = '', expiry = '';
  if (/^\d{12}$/.test(v) && v[0] === '3') ndc10 = v.slice(1, 11);
  else if (/^\d{13}$/.test(v) && v.startsWith('03')) ndc10 = v.slice(2, 12);
  else if (/^01\d{14}/.test(v.replace(/\x1d/g, ''))) {
    let s = v, guard = 0;
    while (s && guard++ < 10) {
      const ai = s.slice(0, 2);
      if (ai === '01') { const g = s.slice(2, 16); if (g.startsWith('003')) ndc10 = g.slice(3, 13); s = s.slice(16); }
      else if (ai === '17') { const e = s.slice(2, 8); expiry = `20${e.slice(0, 2)}-${e.slice(2, 4)}-${e.slice(4, 6) === '00' ? '01' : e.slice(4, 6)}`; s = s.slice(8); }
      else if (ai === '10' || ai === '21') { const end = s.indexOf('\x1d', 2); if (ai === '10') lot = end < 0 ? s.slice(2) : s.slice(2, end); s = end < 0 ? '' : s.slice(end + 1); }
      else if (s[0] === '\x1d') s = s.slice(1);
      else break;
    }
  }
  return { ndc10, lot, expiry };
}
