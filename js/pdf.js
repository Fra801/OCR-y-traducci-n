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

/** Un texto "real" tiene letras; descarta capas OCR basura o solo números de página. */
function usefulChars(text) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  return letters;
}

/**
 * Analiza todas las páginas. Devuelve [{ n, text, chars, kind: "text"|"scan" }].
 * onProgress(i, total) se llama a medida que avanza.
 */
export async function analyze(pdf, onProgress) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    let text = "";
    try {
      const page = await pdf.getPage(n);
      text = pageText(await page.getTextContent());
      page.cleanup();
    } catch { /* página dañada: irá a OCR */ }
    const chars = usefulChars(text);
    pages.push({ n, text, chars, kind: chars >= MIN_CHARS_TEXT_PAGE ? "text" : "scan" });
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

/** Imagen JPEG (base64 sin prefijo) de una página, para OCR cuando no se puede recortar el PDF. */
export async function pageJpegBase64(pdf, n, maxSide = 2000) {
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
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
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
