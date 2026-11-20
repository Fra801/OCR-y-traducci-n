// Planificación por tramos de páginas, prompts y procesamiento de cada tramo con Gemini.
import { generate, responseText, parseJson, GeminiError } from "./gemini.js";
import { slicePdf, bytesToBase64, pageCanvas, canvasJpegBase64, cropFigure } from "./pdf.js";
import { structure } from "./layout.js";

export const BLOCK_TYPES = ["h1", "h2", "h3", "p", "list_item", "quote", "math", "table", "figure", "caption", "footnote"];

// Límites por pedido: chicos para que la respuesta nunca se corte y el progreso se vea seguido.
export const LIMITS = { textChars: 12000, textPages: 20, inlineBytes: 14 * 1024 * 1024 };

/**
 * Divide el rango elegido en tramos. Páginas consecutivas del mismo tipo van juntas.
 * mode: "auto" | "ocr" | "text"
 * En automático van con visión las páginas escaneadas, las que tienen fórmulas y, si se pidió
 * recortar figuras, las que tienen imágenes.
 */
export const needsVision = (p, figures) => p.kind !== "text" || !!p.math || (figures && !!p.fig);

export function planChunks(pages, { from, to, mode, ocrPages, figures }) {
  const chunks = [];
  let cur = null;
  const flush = () => { if (cur) chunks.push(cur); cur = null; };
  for (const p of pages) {
    if (p.n < from || p.n > to) continue;
    const kind = mode === "ocr" ? "ocr" : mode === "text" ? "text" : (needsVision(p, figures) ? "ocr" : "text");
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
          box: { type: "ARRAY", items: { type: "INTEGER" } },
        },
        required: ["type", "text"],
        propertyOrdering: ["type", "page", "box", "text", "original", "rows"],
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
- "math": ecuación o fórmula en renglón aparte. En "text" va SOLO el código LaTeX, sin $ ni \\[ \\] alrededor (ej.: \\frac{a}{b} = \\sqrt{x^2+1}). Si está numerada, agregá \\tag{n} con su número. Varias líneas alineadas: usá \\begin{aligned} … \\end{aligned}.
- Fórmulas, variables, símbolos y unidades dentro de un párrafo, lista, tabla o título: escribilos en LaTeX entre \\( y \\) (ej.: la velocidad \\(v_0\\) vale \\(850\\,\\mathrm{m/s}\\)). Nunca uses $ para matemática. El LaTeX tiene que ser válido para KaTeX.
- Lo que está dentro de una fórmula no se traduce, salvo palabras en \\text{…}.
- "page": número de página del documento original donde empieza el bloque (usá la numeración que te indico, no la impresa en la hoja).
- Omití encabezados y pies de página que se repiten en cada hoja (título del libro corrido, número de folio), marcas de agua y guiones de corte de palabra.
- Conservá negritas como **texto** y cursivas como *texto* cuando estén en el original. No uses otro formato ni markdown.
- No resumas ni inventes: todo el contenido, completo.`;

function figureRules(o) {
  if (!o.figures) return `\n- Figuras, fotos, gráficos y diagramas: no los describas; transcribí solo su epígrafe ("caption") si tiene.`;
  return `
- "figure": un bloque por cada figura, foto, gráfico, diagrama, mapa o ilustración (no por logos ni adornos), en el lugar donde aparece. En "box" va su recuadro en la imagen de esa página como [ymin, xmin, ymax, xmax] con valores de 0 a 1000, ajustado a la figura completa (incluí sus rótulos y ejes, pero no el epígrafe). ${o.describe
    ? `En "text" va una descripción breve y objetiva de lo que muestra (1 o 2 oraciones${o.translate ? `, en ${o.targetLang || "español"}` : ", en el idioma del documento"}), sin inventar datos que no se ven.`
    : `"text": "".`}
- El epígrafe de la figura va aparte, como "caption", inmediatamente después del bloque "figure".
- No transcribas como párrafos los textos que están DENTRO de una figura (rótulos de un gráfico, nombres en un diagrama): ya quedan en la imagen recortada.`;
}

function buildPrompt(chunk, o, ctx) {
  const range = chunk.from === chunk.to ? `la página ${chunk.from}` : `las páginas ${chunk.from} a ${chunk.to}`;
  const head = chunk.kind === "ocr"
    ? `Te paso ${range} de un PDF (llamado «${o.fileName}»), como documento o como imágenes de cada página en orden. Aplicá OCR y transcribí TODO el texto que contengan, incluido el texto dentro de imágenes escaneadas, con máxima exactitud carácter por carácter.`
    : `Te paso el texto ya extraído de ${range} de un PDF (llamado «${o.fileName}»). Es texto seleccionable, no hace falta OCR. Cada página va marcada con [[PÁGINA n]]. Reconstruí la estructura del documento sin alterar el contenido.`;
  const cont = ctx.prevTail ? `\n\nCONTINUIDAD: el tramo anterior terminaba así (no lo repitas, solo sirve para saber si el primer párrafo continúa uno anterior):\n«…${ctx.prevTail}»` : "";
  return `${head}

${translationRules(o)}

${STRUCTURE_RULES}${chunk.kind === "ocr" ? figureRules(o) : `\n- No uses bloques "figure": acá solo hay texto.`}${cont}

Devolvé únicamente el JSON pedido.`;
}

const pagesOf = (c, ctx) => ctx.pages.filter(p => p.n >= c.from && p.n <= c.to);

async function buildParts(chunk, o, ctx) {
  // Imágenes de página solo donde puede haber figuras para recortar (escaneadas o con imágenes).
  // Las páginas con fórmulas sin figuras van como PDF recortado: pesa mucho menos y se lee igual.
  const wantImg = chunk.kind === "ocr" && o.figures && !!ctx.pdf && pagesOf(chunk, ctx).some(p => p.kind !== "text" || p.fig);
  if (chunk.kind === "ocr") o = { ...o, figures: wantImg };
  const prompt = buildPrompt(chunk, o, ctx);
  if (chunk.kind === "text") {
    const body = ctx.pages.filter(p => p.n >= chunk.from && p.n <= chunk.to).map(p => `[[PÁGINA ${p.n}]]\n${p.text}`).join("\n\n");
    return [{ text: prompt + `\n\nTEXTO:\n"""\n${body}\n"""` }];
  }
  // Con figuras: mando la imagen de cada página (las coordenadas de los recuadros se refieren a
  // esa imagen y después recorto del mismo canvas).
  if (wantImg) return imageParts(chunk, prompt, ctx);
  // Sin figuras: intento recortar el PDF (más liviano y fiel); si no se puede o pesa mucho, imágenes.
  let pdfPart = null;
  try {
    const sliced = await slicePdf(ctx.bytes, chunk.from, chunk.to);
    if (sliced.byteLength <= LIMITS.inlineBytes) pdfPart = { inline_data: { mime_type: "application/pdf", data: await bytesToBase64(sliced) } };
  } catch { /* PDF protegido o raro: imágenes */ }
  if (pdfPart) return [pdfPart, { text: prompt }];
  return imageParts(chunk, prompt, ctx);
}

async function imageParts(chunk, prompt, ctx) {
  const parts = [];
  ctx.canvases = new Map();
  for (let n = chunk.from; n <= chunk.to; n++) {
    const canvas = await pageCanvas(ctx.pdf, n, 1600);
    ctx.canvases.set(n, canvas);
    parts.push({ text: `[[PÁGINA ${n}]] (imagen de la página ${n})` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: canvasJpegBase64(canvas, 0.82) } });
  }
  parts.push({ text: prompt });
  return parts;
}

function cleanBlocks(raw, chunk, ctx) {
  const list = Array.isArray(raw) ? raw : raw?.blocks || [];
  return list
    .filter(b => b && (b.text || (b.rows && b.rows.length) || b.type === "figure"))
    .map(b => {
      const out = { type: BLOCK_TYPES.includes(b.type) ? b.type : "p", text: String(b.text || "").trim() };
      const pg = parseInt(b.page, 10);
      out.page = pg >= chunk.from && pg <= chunk.to ? pg : chunk.from;
      if (b.original && String(b.original).trim() && String(b.original).trim() !== out.text) out.original = String(b.original).trim();
      if (out.type === "table") out.rows = (b.rows || []).map(r => (Array.isArray(r) ? r : [r]).map(c => String(c ?? "")));
      if (out.type === "math") out.text = out.text.replace(/^\s*(\$\$?|\\\[|\\\()\s*|\s*(\$\$?|\\\]|\\\))\s*$/g, "");
      if (out.type === "figure") {
        const canvas = ctx.canvases?.get(out.page);
        out.img = canvas ? cropFigure(canvas, b.box) : null;
        delete out.original;
        if (!out.img) return out.text ? { ...out, type: "caption", text: "[Figura] " + out.text } : null;
      }
      return out;
    })
    .filter(Boolean);
}

/**
 * Procesa un tramo. Si la respuesta se corta o no es JSON válido, lo divide en dos y
 * procesa cada mitad. Devuelve una lista de tramos ya resueltos (uno o varios).
 */
const TSCHEMA = {
  type: "OBJECT",
  properties: {
    detectedLanguage: { type: "STRING" },
    translated: { type: "BOOLEAN" },
    items: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["detectedLanguage", "translated", "items"],
  propertyOrdering: ["detectedLanguage", "translated", "items"],
};
const TYPE_NAME = { h1: "título", h2: "sección", h3: "subtítulo", p: "párrafo", list_item: "ítem de lista", footnote: "nota al pie", caption: "epígrafe", quote: "cita" };

/**
 * Página con texto, camino rápido: la estructura se arma en la app (sin IA) y, si hay que
 * traducir, a Gemini solo se le mandan los textos para traducir. El original no se le pide
 * de vuelta: ya lo tenemos.
 */
async function runLocal(chunk, o, ctx, t0) {
  const local = structure(pagesOf(chunk, ctx), o.stats);
  const done = extra => [{ ...chunk, status: "done", error: "", detectedLanguage: "", translated: false, tokens: 0, model: "local", blocks: local, ...extra, ms: Math.round(performance.now() - t0) }];
  if (!o.translate || !local.length) return done({});
  const lang = o.targetLang || "español";
  const input = local.map(b => ({ tipo: TYPE_NAME[b.type] || "párrafo", texto: b.text }));
  const prompt = `Sos traductor profesional. Te paso, en orden, los ${local.length} fragmentos de un tramo de un documento (llamado «${o.fileName}»): títulos, párrafos, ítems de lista, notas y epígrafes. El "tipo" es solo contexto.

- Detectá el idioma original y escribí su nombre en español en "detectedLanguage" (ej.: "Inglés").
- Si NO está en ${lang}, traducí cada fragmento al ${lang} de la forma más fiel, precisa y literal posible: el significado exacto, el tono, el registro (formal, técnico, poético, coloquial) y el orden de las ideas. No resumas, no parafrasees, no omitas ni agregues nada. Nombres propios y títulos de obras citadas quedan como están. "translated": true.
- Si ya está en ${lang}, devolvé cada fragmento exactamente igual y "translated": false.
- Algunos fragmentos pueden venir cortados (siguen en el próximo): traducilos igual, sin completarlos.
- "items": EXACTAMENTE ${local.length} textos, en el mismo orden, uno por fragmento de entrada. Nunca juntes ni dividas fragmentos.
- Solo texto plano, sin markdown.${o.glossary ? `
- Respetá este glosario y estas indicaciones del usuario:
${o.glossary}` : ""}

FRAGMENTOS:
${JSON.stringify(input)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: TSCHEMA } };
  const { data, model } = await generate({ key: o.key, models: o.textModels || o.models, body, signal: ctx.signal, onWait: ctx.onWait });
  const parsed = parseJson(responseText(data));
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  if (items.length !== local.length) {
    if (chunk.to > chunk.from) throw new GeminiError("La traducción no devolvió todos los fragmentos.", { kind: "parse" });
    return null; // una sola página: se arma con Gemini (camino completo)
  }
  const usage = data.usageMetadata || {};
  const tr = !!parsed.translated;
  return done({
    model, detectedLanguage: parsed.detectedLanguage || "", translated: tr,
    tokens: (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
    blocks: local.map((b, i) => {
      const text = tr ? String(items[i] || "").trim() || b.text : b.text;
      return tr && o.bilingual && text !== b.text ? { ...b, text, original: b.text } : { ...b, text };
    }),
  });
}

export async function runChunk(chunk, o, ctx) {
  const t0 = performance.now();
  try {
    if (chunk.kind === "text" && o.fast && o.stats && pagesOf(chunk, ctx).every(p => p.lines?.length)) {
      const r = await runLocal(chunk, o, ctx, t0);
      if (r) return r;
      o = { ...o, fast: false };
    }
    const parts = await buildParts(chunk, o, ctx);
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
    };
    const models = chunk.kind === "text" ? (o.textModels || o.models) : o.models;
    const { data, model } = await generate({ key: o.key, models, body, signal: ctx.signal, onWait: ctx.onWait });
    const parsed = parseJson(responseText(data));
    const usage = data.usageMetadata || {};
    return [{
      ms: Math.round(performance.now() - t0),
      ...chunk,
      status: "done",
      model,
      detectedLanguage: parsed.detectedLanguage || "",
      translated: !!parsed.translated,
      blocks: cleanBlocks(parsed, chunk, ctx),
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

const norm = t => String(t || "").toLowerCase().replace(/[\d\s.·|–—-]+/g, " ").trim();

/**
 * Quita encabezados y pies que se repiten en cada hoja aunque el modelo los haya transcripto
 * (título corrido del capítulo o del libro, números de folio sueltos). Un encabezado corrido
 * es un texto corto que aparece como primer bloque de dos o más páginas distintas.
 */
function dropRunningHeads(blocks) {
  const isFirst = i => i === 0 || blocks[i].page !== blocks[i - 1].page;
  const groups = new Map();
  blocks.forEach((b, i) => {
    if (!isFirst(i) || !/^(h1|h2|h3|p)$/.test(b.type) || String(b.text || "").length > 80) return;
    const k = norm(b.text);
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const drop = new Set();
  for (const idx of groups.values()) {
    // Tres páginas o más, o dos seguidas: así un subtítulo que casualmente abre dos hojas lejanas no se pierde.
    const pages = [...new Set(idx.map(i => blocks[i].page))];
    if (pages.length < 2 || (pages.length === 2 && Math.abs(pages[1] - pages[0]) !== 1)) continue;
    // Si el primero es el único de su tipo (p. ej. el título real del capítulo entre encabezados corridos), se queda.
    const t0 = blocks[idx[0]].type;
    const keepFirst = idx.filter(i => blocks[i].type === t0).length === 1 && t0 === "h1";
    idx.forEach((i, j) => { if (!(keepFirst && j === 0)) drop.add(i); });
  }
  return blocks.filter((b, i) => !drop.has(i) && !(b.type === "p" && /^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(b.text || "")));
}

/**
 * Une todos los bloques del documento en orden, quita los encabezados corridos y, si un
 * párrafo quedó partido entre dos páginas o tramos (termina sin puntuación y el siguiente
 * empieza en minúscula), los junta.
 */
export function mergedBlocks(chunks) {
  const all = dropRunningHeads(chunks.filter(c => c.status === "done").flatMap(c => c.blocks));
  const out = [];
  for (const b of all) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "p" && b.type === "p" && b.page !== prev.page && !ENDS_SENTENCE.test(prev.text) && /^\p{Ll}/u.test(b.text)) {
      out[out.length - 1] = { ...prev, text: prev.text + " " + b.text, original: prev.original && b.original ? prev.original + " " + b.original : prev.original };
    } else out.push(b);
  }
  return out;
}

/** Últimas palabras del texto de las páginas previas a un tramo (para dar continuidad). */
export function tailBefore(pages, n, len = 280) {
  const p = pages.find(x => x.n === n - 1);
  if (!p || !p.text) return "";
  return p.text.slice(-len).replace(/\s+/g, " ").trim();
}
