// Cliente de la API de Claude (Anthropic) que corre directamente en el navegador.
// La API key se guarda solo en este dispositivo (localStorage) y viaja únicamente a Anthropic.
// Si en ajustes hay una URL base propia (un proxy compatible con la API de Anthropic), los
// pedidos van ahí en vez de a Anthropic. Recibe los pedidos en el mismo formato que Gemini y devuelve la respuesta con la forma de
// Gemini, así el resto de la app no cambia.

import { GeminiError } from "./gemini.js";

const OFFICIAL = "https://api.anthropic.com";
// URL base elegida en ajustes (vacía = Anthropic). Se acepta con o sin "/v1" al final.
function apiBase() {
  let b = "";
  try { b = (JSON.parse(localStorage.getItem("ocrt.settings") || "{}").claudeBase || "").trim(); } catch { /* ajustes rotos */ }
  b = (b || OFFICIAL).replace(/\/+$/, "");
  return /\/v1$/.test(b) ? b : b + "/v1";
}
const isOfficial = () => apiBase() === OFFICIAL + "/v1";
const MAX_TOKENS = 20000;

export const CLAUDE_MODELS = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (rápido y barato)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (más preciso)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (el más preciso, más caro)" },
];
export const CLAUDE_FALLBACK = ["claude-haiku-5-5", "claude-sonnet-5-5"];
export const isClaude = model => /^claude/.test(model || "");

const headers = key => ({
  "content-type": "application/json",
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  // Necesario para llamar a la API de Anthropic desde el navegador (CORS). La key es del propio
  // usuario. A un proxy no se le manda: si no lo tiene permitido, el navegador corta el pedido.
  ...(isOfficial() ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
});

/** Esquema de Gemini (tipos en mayúscula, propertyOrdering) → JSON Schema estándar. */
function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = {};
  if (s.type) out.type = String(s.type).toLowerCase();
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    out.additionalProperties = false;
  }
  if (s.required) out.required = s.required;
  return out;
}

/** Partes de Gemini → bloques de contenido de Claude. */
function toContent(parts) {
  return parts.map(p => {
    const d = p.inline_data || p.inlineData;
    if (d) {
      const mime = d.mime_type || d.mimeType;
      return mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: mime, data: d.data } }
        : { type: "image", source: { type: "base64", media_type: mime, data: d.data } };
    }
    return { type: "text", text: p.text || "" };
  });
}

function classify(code, data, resp) {
  const msg = data?.error?.message || `HTTP ${code}`;
  const type = data?.error?.type || "";
  if ([429, 500, 502, 503, 504, 529].includes(code) || /overloaded|rate_limit|api_error/.test(type)) {
    const ra = parseFloat(resp?.headers?.get?.("retry-after") || "");
    return new GeminiError(msg, { code, kind: "overloaded", retryAfterMs: isNaN(ra) ? 0 : ra * 1000 });
  }
  if (code === 401 || code === 403 || /authentication|permission/.test(type)) return new GeminiError(msg, { code, kind: "auth" });
  if (code === 404 || type === "not_found_error") return new GeminiError(msg, { code, kind: "notfound" });
  if (code === 400 && /credit|billing|balance/i.test(msg)) return new GeminiError("Tu cuenta de la API de Claude no tiene saldo: " + msg, { code, kind: "auth" });
  if (code === 400) return new GeminiError(msg, { code, kind: "badrequest" });
  return new GeminiError(msg, { code });
}

async function post(key, req, signal) {
  let resp;
  try {
    resp = await fetch(`${apiBase()}/messages`, { method: "POST", headers: headers(key), body: JSON.stringify(req), signal });
  } catch (e) {
    if (signal?.aborted) throw new GeminiError("Cancelado", { kind: "aborted" });
    throw new GeminiError((isOfficial() ? "Sin conexión con Claude (" : "Sin conexión con la URL base de Claude; puede que no acepte pedidos desde el navegador (") + e.message + ")", { kind: "overloaded" });
  }
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* respuesta no JSON */ }
  if (!resp.ok || data?.type === "error") throw classify(resp.status, data, resp);
  return data;
}

// Qué opciones aceptó cada modelo (esfuerzo bajo y esquema JSON), para no volver a probar.
const OKEY = "ocrt.claudeopts";
const accepted = JSON.parse(localStorage.getItem(OKEY) || "{}");
const saveOpts = () => { try { localStorage.setItem(OKEY, JSON.stringify(accepted)); } catch { /* sin almacenamiento */ } };

/**
 * Un pedido a Claude con un cuerpo armado para Gemini. Devuelve la respuesta con la forma de
 * Gemini (candidates, finishReason, usageMetadata).
 */
export async function claudeCall(model, key, body, signal) {
  const parts = body.contents?.[0]?.parts || [];
  const schema = body.generationConfig?.responseSchema;
  const st = accepted[model] ||= { effort: true, schema: true };
  const drop = k => { st[k] = false; saveOpts(); };
  for (;;) {
    const req = {
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: toContent(parts) }],
    };
    const oc = {};
    // Para transcribir y traducir no hace falta razonar mucho: esfuerzo bajo es más rápido.
    if (st.effort) oc.effort = "low";
    if (st.schema && schema) oc.format = { type: "json_schema", schema: toJsonSchema(schema) };
    if (Object.keys(oc).length) req.output_config = oc;
    try {
      const data = await post(key, req, signal);
      return toGeminiShape(data);
    } catch (e) {
      if (e.kind !== "badrequest") throw e;
      if (st.effort && /effort/i.test(e.message)) { drop("effort"); continue; }
      if (st.schema && schema && /schema|format|output_config/i.test(e.message)) { drop("schema"); continue; }
      if (st.effort) { drop("effort"); continue; }
      throw e;
    }
  }
}

function toGeminiShape(data) {
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const finishReason = data.stop_reason === "max_tokens" ? "MAX_TOKENS"
    : data.stop_reason === "refusal" ? "SAFETY"
    : "STOP";
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: data.usage?.input_tokens || 0, candidatesTokenCount: data.usage?.output_tokens || 0 },
  };
}

/** Lista los modelos disponibles para la key (sirve también para validarla). */
export async function listClaudeModels(key) {
  const r = await fetch(`${apiBase()}/models?limit=100`, { headers: headers(key) });
  const data = await r.json().catch(() => null);
  if (!r.ok || data?.type === "error") throw classify(r.status, data, r);
  return (data.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
}
