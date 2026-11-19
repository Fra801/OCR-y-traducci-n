// Cliente de la API de Gemini que corre directamente en el navegador.
// La API key se guarda solo en este dispositivo (localStorage) y viaja únicamente a Google.

const API = "https://generativelanguage.googleapis.com/v1beta";

// Alias que Google mantiene apuntando al modelo vigente, más uno fijo como último recurso.
export const DEFAULT_MODEL = "gemini-flash-latest";
export const FALLBACK_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"];

const RETRYABLE = [429, 500, 502, 503, 504];

export class GeminiError extends Error {
  constructor(message, { code = 0, kind = "other", retryAfterMs = 0 } = {}) {
    super(message);
    this.code = code;
    this.kind = kind; // "overloaded" | "auth" | "notfound" | "badrequest" | "truncated" | "blocked" | "parse" | "aborted" | "other"
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new GeminiError("Cancelado", { kind: "aborted" })); }, { once: true });
});

function backoff(attempt, hintMs) {
  if (hintMs) return Math.min(hintMs + 500, 60000);
  return Math.min(2 ** attempt * 1000 + Math.random() * 700, 30000);
}

function parseRetryDelay(data) {
  const det = data?.error?.details || [];
  for (const d of det) {
    if (d["@type"]?.includes("RetryInfo") && d.retryDelay) {
      const s = parseFloat(d.retryDelay);
      if (!isNaN(s)) return s * 1000;
    }
  }
  return 0;
}

function classify(code, data) {
  const msg = data?.error?.message || `HTTP ${code}`;
  const status = data?.error?.status || "";
  if (RETRYABLE.includes(code) || /high demand|overloaded|unavailable|try again later|RESOURCE_EXHAUSTED/i.test(msg + status)) {
    return new GeminiError(msg, { code, kind: "overloaded", retryAfterMs: parseRetryDelay(data) });
  }
  if (code === 401 || code === 403 || /API key/i.test(msg)) return new GeminiError(msg, { code, kind: "auth" });
  if (code === 404) return new GeminiError(msg, { code, kind: "notfound" });
  if (code === 400) return new GeminiError(msg, { code, kind: "badrequest" });
  return new GeminiError(msg, { code });
}

async function rawCall(model, key, body, signal) {
  let resp;
  try {
    resp = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new GeminiError("Cancelado", { kind: "aborted" });
    throw new GeminiError("Sin conexión con Gemini (" + e.message + ")", { kind: "overloaded" });
  }
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* respuesta no JSON */ }
  if (!resp.ok || data?.error) throw classify(resp.status, data);
  return data;
}

/**
 * Llama a generateContent probando cada modelo de la lista, con reintentos y backoff
 * ante saturación. Devuelve { data, model }.
 */
export async function generate({ key, models, body, signal, onWait }) {
  let last = null;
  const tried = [];
  for (const model of models) {
    tried.push(model);
    let reqBody = body;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const data = await rawCall(model, key, reqBody, signal);
        return { data, model };
      } catch (e) {
        last = e;
        if (e.kind === "aborted" || e.kind === "auth") throw e;
        if (e.kind === "notfound") break; // ese modelo no existe para esta key: siguiente
        if (e.kind === "badrequest") {
          // Algunos modelos no aceptan el esquema JSON estricto: reintentar sin él una vez.
          if (reqBody.generationConfig?.responseSchema) {
            reqBody = structuredClone(reqBody);
            delete reqBody.generationConfig.responseSchema;
            continue;
          }
          throw e;
        }
        if (e.kind === "overloaded" && attempt < 4) {
          const ms = backoff(attempt, e.retryAfterMs);
          onWait?.({ model, ms, attempt });
          await sleep(ms, signal);
          continue;
        }
        if (e.kind === "overloaded") break; // probar el próximo modelo
        throw e;
      }
    }
  }
  if (last?.kind === "overloaded") {
    throw new GeminiError(`Gemini está saturado (probé ${tried.join(", ")} con varios reintentos). Esperá unos minutos y tocá «Continuar».`, { kind: "overloaded" });
  }
  throw last || new GeminiError("No se pudo usar ningún modelo.");
}

/** Extrae el texto de la respuesta y avisa si se cortó o fue bloqueada. */
export function responseText(data) {
  const c = data?.candidates?.[0];
  if (!c) {
    const why = data?.promptFeedback?.blockReason;
    throw new GeminiError(why ? `Gemini bloqueó el contenido (${why}).` : "Gemini no devolvió respuesta.", { kind: "blocked" });
  }
  const text = (c.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  if (c.finishReason === "MAX_TOKENS") throw new GeminiError("La respuesta se cortó por largo.", { kind: "truncated" });
  if (c.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(c.finishReason) && !text) {
    throw new GeminiError(`Gemini no completó la respuesta (${c.finishReason}).`, { kind: "blocked" });
  }
  return text;
}

/** Parsea JSON tolerando ```json ... ``` alrededor. */
export function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1];
  try { return JSON.parse(t); } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* sigue */ } }
    throw new GeminiError("La respuesta no era un JSON válido.", { kind: "parse" });
  }
}

/** Lista los modelos de texto disponibles para la key (sirve también para validarla). */
export async function listModels(key) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${API}/models?pageSize=200${pageToken ? "&pageToken=" + pageToken : ""}`, { headers: { "x-goog-api-key": key } });
    const data = await r.json().catch(() => null);
    if (!r.ok || data?.error) throw classify(r.status, data);
    for (const m of data.models || []) {
      const id = m.name.replace(/^models\//, "");
      if (!(m.supportedGenerationMethods || []).includes("generateContent")) continue;
      if (!/^gemini/.test(id) || /tts|image|embedding|live|audio|transcribe|banana|omni|robotics|computer/i.test(id)) continue;
      out.push({ id, label: m.displayName || id });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}
