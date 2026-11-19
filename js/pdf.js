// Lectura del PDF en el navegador: texto seleccionable por página, miniaturas y recortes para OCR.
import * as pdfjs from "../lib/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../lib/pdf.worker.min.mjs", import.meta.url).href;
const CMAPS = new URL("../lib/cmaps/", import.meta.url).href;
const FONTS = new URL("../lib/standard_fonts/", import.meta.url).href;

// Página con menos caracteres útiles que esto se considera escaneada (va a OCR).
export const MIN_CHARS_TEXT_PAGE = 60;

export async function openPdf(bytes) {
  // pdf.js transfiere el buffer al worker: le pasamos una copia para conservar el original.
  const task = pdfjs.getDocument({ data: bytes.slice(0), cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS, isEvalSupported: false });
  return task.promise;
}

/** Arma el texto de una página respetando saltos de línea y uniendo palabras cortadas con guion. */
function pageText(content) {
  let out = "";
  for (const it of content.items) {
    if (!("str" in it)) continue;
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Señales de que la página tiene fórmulas: símbolos matemáticos, letras matemáticas de Unicode
 * o varias igualdades. El texto extraído de esas páginas suele salir roto, así que van con visión.
 */
export function looksMath(text) {
  const ops = (text.match(/[\u2200-\u22FF\u2A00-\u2AFF\u27C0-\u27EF\u{1D400}-\u{1D7FF}]/gu) || []).length;
  const greek = (text.match(/[\u0391-\u03C9]/g) || []).length;
  const eq = (text.match(/=/g) || []).length;
  return ops >= 3 || (ops >= 1 && greek >= 3) || (eq >= 4 && (ops + greek) >= 1);
}

/**
 * ¿La página tiene imágenes de un tamaño que valga la pena (fotos, gráficos, diagramas)?
 * Recorre las operaciones de dibujo siguiendo la matriz de transformación para medir cada
 * imagen. Ignora logos chicos y las imágenes que cubren toda la hoja (fondos o escaneos con
 * capa de texto).
 */
async function hasFigure(page) {
  const { OPS } = pdfjs;
  const vp = page.getViewport({ scale: 1 });
  const pageArea = vp.width * vp.height;
  let ops;
  try { ops = await page.getOperatorList(); } catch { return false; }
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let total = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i]);
    else if (fn === OPS.paintFormXObjectBegin && ops.argsArray[i]?.[0]) { stack.push(ctm); ctm = mul(ctm, ops.argsArray[i][0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintImageXObjectRepeat) {
      const ratio = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea;
      if (ratio > 0.85) continue;
      total += ratio;
      if (ratio > 0.03 || total > 0.06) return true;
    }
  }
  return false;
}

/** Un texto "real" tiene letras; descarta capas OCR basura o solo números de página. */
function usefulChars(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  return letters;
}

/**
 * Analiza todas las páginas. Devuelve [{ n, text, chars, kind: "text"|"scan", fig, math }].
 * onProgress(i, total) se llama a medida que avanza.
 */
export async function analyze(pdf, onProgress) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    let text = "", fig = false;
    try {
      const page = await pdf.getPage(n);
      text = pageText(await page.getTextContent());
      // Solo se miden las imágenes de las páginas con texto: las escaneadas ya van con visión.
      if (usefulChars(text) >= MIN_CHARS_TEXT_PAGE) fig = await hasFigure(page);
      page.cleanup();
    } catch { /* página dañada: irá a OCR */ }
    const chars = usefulChars(text);
    const kind = chars >= MIN_CHARS_TEXT_PAGE ? "text" : "scan";
    pages.push({ n, text, chars, kind, fig, math: kind === "text" && looksMath(text) });
    if (n % 5 === 0 || n === pdf.numPages) onProgress?.(n, pdf.numPages);
  }
  return pages;
}

/** Dibuja una página en un canvas del ancho pedido (en px CSS). */
export async function renderPage(pdf, n, widthPx, canvas) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const ratio = window.devicePixelRatio || 1;
  const scale = (widthPx / base.width) * ratio;
  const vp = page.getViewport({ scale });
  canvas = canvas || document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  page.cleanup();
  return canvas;
}

/** Completa las marcas de figuras y fórmulas en documentos guardados con una versión anterior. */
export async function addFlags(pdf, pages) {
  for (const p of pages) {
    if (p.fig !== undefined) continue;
    p.math = p.kind === "text" && looksMath(p.text || "");
    p.fig = false;
    if (p.kind === "text") {
      try { const page = await pdf.getPage(p.n); p.fig = await hasFigure(page); page.cleanup(); } catch { /* sin marca */ }
    }
  }
  return pages;
}

/** Dibuja la página entera en un canvas con fondo blanco (para OCR y para recortar figuras). */
export async function pageCanvas(pdf, n, maxSide = 1600) {
  const page = await pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSide / Math.max(base.width, base.height), 3);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return canvas;
}

export const canvasJpegBase64 = (canvas, q = 0.85) => canvas.toDataURL("image/jpeg", q).split(",")[1];

/** Imagen JPEG (base64 sin prefijo) de una página. */
export async function pageJpegBase64(pdf, n, maxSide = 2000) {
  return canvasJpegBase64(await pageCanvas(pdf, n, maxSide));
}

/**
 * Recorta una figura del canvas de la página. box = [ymin, xmin, ymax, xmax] en 0–1000.
 * Devuelve un data URL JPEG o null si la caja no es válida.
 */
export function cropFigure(canvas, box, maxWidth = 1400) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [y0, x0, y1, x1] = box.map(v => Math.max(0, Math.min(1000, Number(v))));
  if (![y0, x0, y1, x1].every(Number.isFinite) || y1 <= y0 || x1 <= x0) return null;
  if ((y1 - y0) * (x1 - x0) < 4000) return null; // menos de 0,4 % de la hoja: ruido
  const pad = 8; // margen de 0,8 % para no cortar bordes
  y0 = Math.max(0, y0 - pad); x0 = Math.max(0, x0 - pad); y1 = Math.min(1000, y1 + pad); x1 = Math.min(1000, x1 + pad);
  const W = canvas.width, H = canvas.height;
  const sx = Math.round(x0 / 1000 * W), sy = Math.round(y0 / 1000 * H);
  const sw = Math.round((x1 - x0) / 1000 * W), sh = Math.round((y1 - y0) / 1000 * H);
  const scale = Math.min(1, maxWidth / sw);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.88);
}

let pdfLibPromise = null;
const loadPdfLib = () => (pdfLibPromise ||= import("../lib/pdf-lib.esm.min.js"));
const srcCache = new WeakMap();

/** Recorta las páginas [from..to] del PDF original y devuelve los bytes del PDF nuevo. */
export async function slicePdf(bytes, from, to) {
  const { PDFDocument } = await loadPdfLib();
  let src = srcCache.get(bytes);
  if (!src) {
    src = PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    srcCache.set(bytes, src);
  }
  const doc = await src;
  const out = await PDFDocument.create();
  const idx = [];
  for (let i = from; i <= to; i++) idx.push(i - 1);
  const copied = await out.copyPages(doc, idx);
  copied.forEach(p => out.addPage(p));
  return out.save({ useObjectStreams: true });
}

export function bytesToBase64(bytes) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
}
