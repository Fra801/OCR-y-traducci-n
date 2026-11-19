// Planificación por tramos de páginas, prompts y procesamiento de cada tramo con Gemini.
import { generate, responseText, parseJson, GeminiError } from "./gemini.js";
import { slicePdf, bytesToBase64, pageJpegBase64 } from "./pdf.js";

export const BLOCK_TYPES = ["h1", "h2", "h3", "p", "list_item", "quote", "table", "caption", "footnote"];

// Límites por pedido: chicos para que la respuesta nunca se corte y el progreso se vea seguido.
export const LIMITS = { textChars: 12000, textPages: 20, inlineBytes: 14 * 1024 * 1024 };

/**
 * Divide el rango elegido en tramos. Páginas consecutivas del mismo tipo van juntas.
 * mode: "auto" | "ocr" | "text"
 */
export function planChunks(pages, { from, to, mode, ocrPages }) {
  const chunks = [];
  let cur = null;
  const flush = () => { if (cur) chunks.push(cur); cur = null; };
  for (const p of pages) {
    if (p.n < from || p.n > to) continue;
    const kind = mode === "ocr" ? "ocr" : mode === "text" ? "text" : (p.kind === "text" ? "text" : "ocr");
    if (kind === "text" && !p.text) { // "solo texto" en una página vacía: nada que mandar
      flush();
      chunks.push({ from: p.n, to: p.n, kind: "empty" });
      continue;
    }
    const fits = cur && cur.kind === kind && (kind === "text"
      ? cur.chars + p.text.length <= LIMITS.textChars && cur.to - cur.from + 1 < LIMITS.textPages
      : cur.to - cur.from + 1 < ocrPages);
    if (!fits) { flush(); cur = { from: p.n, to: p.n, kind, chars: 0 }; }
    cur.to = p.n;
    cur.chars += kind === "text" ? p.text.length : 0;
  }
  flush();
  return chunks.map((c, i) => ({ id: `${c.from}-${c.to}-${i}`, from: c.from, to: c.to, kind: c.kind, status: c.kind === "empty" ? "done" : "pending", blocks: [] }));
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    detectedLanguage: { type: "STRING" },
    translated: { type: "BOOLEAN" },
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: BLOCK_TYPES },
          page: { type: "INTEGER" },
          text: { type: "STRING" },
          original: { type: "STRING" },
          rows: { type: "ARRAY", items: { type: "ARRAY", items: { type: "STRING" } } },
        },
        required: ["type", "text"],
        propertyOrdering: ["type", "page", "text", "original", "rows"],
      },
    },
  },
  required: ["detectedLanguage", "translated", "blocks"],
  propertyOrdering: ["detectedLanguage", "translated", "blocks"],
};

function translationRules(o) {
  if (!o.translate) {
    return `IDIOMA
- No traduzcas nada: transcribí en el idioma original.
- "detectedLanguage": nombre del idioma original, escrito en español (ej.: "Inglés", "Francés", "Español").
- "translated": false. No completes "original".`;
  }
  const lang = o.targetLang || "español";
  return `IDIOMA Y TRADUCCIÓN
- Detectá el idioma original y escribí su nombre en español en "detectedLanguage" (ej.: "Inglés", "Alemán").
- Si el original NO está en ${lang}, traducí TODO al ${lang} de la forma más fiel, precisa y literal posible: conservá el significado exacto, el tono, el registro (formal, técnico, poético, coloquial) y el orden de las ideas. No resumas, no parafrasees, no omitas ni agregues nada. Es una traducción profesional, no una adaptación. Nombres propios, títulos de obras citadas y términos que no se traducen quedan como están.
- Si el original YA está en ${lang}, dejalo exactamente igual y poné "translated": false.
- "translated": true si tradujiste.${o.bilingual ? `
- En cada bloque traducido, poné en "original" el texto en su idioma original, tal cual (lo vamos a mostrar al lado de la traducción).` : `
- No completes "original".`}${o.glossary ? `
- Respetá este glosario y estas indicaciones del usuario en toda la traducción:
${o.glossary}` : ""}`;
}

const STRUCTURE_RULES = `ESTRUCTURA (campo "blocks", en el orden del documento, de principio a fin)
- "h1": título principal o de capítulo · "h2": sección · "h3": subsección.
- "p": párrafo. Uní las líneas de un mismo párrafo en un solo bloque (el PDF corta las líneas por ancho de página, eso no es un párrafo nuevo).
- "list_item": cada elemento de una lista o viñeta, sin el símbolo de viñeta; si está numerado, conservá el número o la letra al comienzo.
- "quote": cita textual o recuadro destacado.
- "table": una tabla. En "rows" va cada fila como lista de celdas (la primera fila es el encabezado si lo hay). En "text", el título de la tabla o "".
- "caption": epígrafe de figura o imagen. Si hay una figura sin texto, no la describas.
- "footnote": nota al pie o al final, con su número o símbolo al comienzo.
- "page": número de página del documento original donde empieza el bloque (usá la numeración que te indico, no la impresa en la hoja).
- Omití encabezados y pies de página que se repiten en cada hoja (título del libro corrido, número de folio), marcas de agua y guiones de corte de palabra.
- Conservá negritas como **texto** y cursivas como *texto* cuando estén en el original. No uses otro formato ni markdown.
- No resumas ni inventes: todo el contenido, completo.`;

function buildPrompt(chunk, o, ctx) {
  const range = chunk.from === chunk.to ? `la página ${chunk.from}` : `las páginas ${chunk.from} a ${chunk.to}`;
  const head = chunk.kind === "ocr"
    ? `Te paso ${range} de un PDF (llamado «${o.fileName}»), como documento o como imágenes de cada página en orden. Aplicá OCR y transcribí TODO el texto que contengan, incluido el texto dentro de imágenes escaneadas, con máxima exactitud carácter por carácter.`
    : `Te paso el texto ya extraído de ${range} de un PDF (llamado «${o.fileName}»). Es texto seleccionable, no hace falta OCR. Cada página va marcada con [[PÁGINA n]]. Reconstruí la estructura del documento sin alterar el contenido.`;
  const cont = ctx.prevTail ? `\n\nCONTINUIDAD: el tramo anterior terminaba así (no lo repitas, solo sirve para saber si el primer párrafo continúa uno anterior):\n«…${ctx.prevTail}»` : "";
  return `${head}

${translationRules(o)}

${STRUCTURE_RULES}${cont}

Devolvé únicamente el JSON pedido.`;
}

async function buildParts(chunk, o, ctx) {
  const prompt = buildPrompt(chunk, o, ctx);
  if (chunk.kind === "text") {
    const body = ctx.pages.filter(p => p.n >= chunk.from && p.n <= chunk.to).map(p => `[[PÁGINA ${p.n}]]\n${p.text}`).join("\n\n");
    return [{ text: prompt + `\n\nTEXTO:\n"""\n${body}\n"""` }];
  }
  // OCR: intento recortar el PDF (más liviano y fiel); si no se puede o pesa mucho, mando imágenes.
  let pdfPart = null;
  try {
    const sliced = await slicePdf(ctx.bytes, chunk.from, chunk.to);
    if (sliced.byteLength <= LIMITS.inlineBytes) pdfPart = { inline_data: { mime_type: "application/pdf", data: await bytesToBase64(sliced) } };
  } catch { /* PDF protegido o raro: imágenes */ }
  if (pdfPart) return [pdfPart, { text: prompt }];
  const parts = [];
  for (let n = chunk.from; n <= chunk.to; n++) {
    parts.push({ text: `[[PÁGINA ${n}]]` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: await pageJpegBase64(ctx.pdf, n) } });
  }
  parts.push({ text: prompt });
  return parts;
}

function cleanBlocks(raw, chunk) {
  const list = Array.isArray(raw) ? raw : raw?.blocks || [];
  return list
    .filter(b => b && (b.text || (b.rows && b.rows.length)))
    .map(b => {
      const out = { type: BLOCK_TYPES.includes(b.type) ? b.type : "p", text: String(b.text || "").trim() };
      const pg = parseInt(b.page, 10);
      out.page = pg >= chunk.from && pg <= chunk.to ? pg : chunk.from;
      if (b.original && String(b.original).trim() && String(b.original).trim() !== out.text) out.original = String(b.original).trim();
      if (out.type === "table") out.rows = (b.rows || []).map(r => (Array.isArray(r) ? r : [r]).map(c => String(c ?? "")));
      return out;
    });
}

/**
 * Procesa un tramo. Si la respuesta se corta o no es JSON válido, lo divide en dos y
 * procesa cada mitad. Devuelve una lista de tramos ya resueltos (uno o varios).
 */
export async function runChunk(chunk, o, ctx) {
  try {
    const parts = await buildParts(chunk, o, ctx);
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    };
    const { data, model } = await generate({ key: o.key, models: o.models, body, signal: ctx.signal, onWait: ctx.onWait });
    const parsed = parseJson(responseText(data));
    const usage = data.usageMetadata || {};
    return [{
      ...chunk,
      status: "done",
      model,
      detectedLanguage: parsed.detectedLanguage || "",
      translated: !!parsed.translated,
      blocks: cleanBlocks(parsed, chunk),
      tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
      error: "",
    }];
  } catch (e) {
    if ((e.kind === "truncated" || e.kind === "parse") && chunk.to > chunk.from) {
      const mid = Math.floor((chunk.from + chunk.to) / 2);
      const a = { ...chunk, id: chunk.id + "a", to: mid };
      const b = { ...chunk, id: chunk.id + "b", from: mid + 1 };
      const ra = await runChunk(a, o, ctx);
      const rb = await runChunk(b, o, { ...ctx, prevTail: "" });
      return [...ra, ...rb];
    }
    if (e.kind === "aborted") return [{ ...chunk, status: "pending", error: "" }];
    if (e.kind === "truncated") e.message = "La página tiene demasiado texto para una sola respuesta. Probá con otro modelo.";
    throw Object.assign(e instanceof GeminiError ? e : new GeminiError(e.message || String(e)), { chunk });
  }
}

const ENDS_SENTENCE = /[.!?:;…»"”')\]]\s*$/;

/**
 * Une todos los bloques del documento en orden. Si un párrafo quedó partido entre dos
 * tramos (termina sin puntuación y el siguiente empieza en minúscula), los junta.
 */
export function mergedBlocks(chunks) {
  const out = [];
  for (const c of chunks) {
    if (c.status !== "done") continue;
    c.blocks.forEach((b, i) => {
      const prev = out[out.length - 1];
      if (i === 0 && prev && prev.type === "p" && b.type === "p" && !ENDS_SENTENCE.test(prev.text) && /^\p{Ll}/u.test(b.text)) {
        out[out.length - 1] = { ...prev, text: prev.text + " " + b.text, original: prev.original && b.original ? prev.original + " " + b.original : prev.original };
      } else out.push(b);
    });
  }
  return out;
}

/** Últimas palabras del texto de las páginas previas a un tramo (para dar continuidad). */
export function tailBefore(pages, n, len = 280) {
  const p = pages.find(x => x.n === n - 1);
  if (!p || !p.text) return "";
  return p.text.slice(-len).replace(/\s+/g, " ").trim();
}
