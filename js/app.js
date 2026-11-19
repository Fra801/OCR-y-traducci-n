import { openPdf, analyze, renderPage, addFlags } from "./pdf.js";
import { planChunks, runChunk, mergedBlocks, tailBefore, needsVision } from "./engine.js";
import { listModels, DEFAULT_MODEL, FALLBACK_MODELS } from "./gemini.js";
import { saveDoc, getDoc, saveFile, getFile, listDocs, deleteDoc, fingerprint } from "./store.js";
import { esc, blockHtml, toText, toMarkdown, toHtml, toWord, download } from "./export.js";

export const APP_VERSION = "1.1.0";
const $ = id => document.getElementById(id);

/* ================= Ajustes ================= */
const SKEY = "ocrt.settings";
const S = Object.assign({
  key: "", model: DEFAULT_MODEL, models: [], mode: "auto", translate: false, targetLang: "español",
  bilingual: true, ocrPages: 4, parallel: 2, fontScale: 1, figures: true, describe: false,
}, JSON.parse(localStorage.getItem(SKEY) || "{}"));
const saveS = () => localStorage.setItem(SKEY, JSON.stringify(S));

/* ================= Estado ================= */
let doc = null;      // documento actual (se guarda en IndexedDB)
let bytes = null;    // PDF original
let pdf = null;      // documento de pdf.js
let running = null;  // { ctrl, done, total }
let view = "t";      // t | bi | o

/* ================= Utilidades ================= */
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("on"), ms);
}
const fmtMB = n => (n / 1024 / 1024).toFixed(n > 10485760 ? 0 : 1) + " MB";
const fmtDate = t => new Date(t).toLocaleDateString("es-AR", { day: "numeric", month: "short" }) + " · " + new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ================= API key ================= */
function keyBadge() {
  $("keyDot").classList.toggle("ok", !!S.key);
  $("keyLabel").textContent = S.key ? "Gemini conectado" : "Poner API key";
  $("settingsBtn").title = $("keyLabel").textContent;
}
function fillModels() {
  const sel = $("modelSel");
  const base = [
    { id: "gemini-flash-latest", label: "Gemini Flash (recomendado)" },
    { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite (más rápido y barato)" },
    { id: "gemini-pro-latest", label: "Gemini Pro (más preciso, más lento)" },
  ];
  const seen = new Set(base.map(m => m.id));
  const extra = (S.models || []).filter(m => !seen.has(m.id));
  sel.innerHTML = base.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join("") +
    (extra.length ? `<optgroup label="Disponibles con tu key">${extra.map(m => `<option value="${esc(m.id)}">${esc(m.label)} · ${esc(m.id)}</option>`).join("")}</optgroup>` : "");
  if (![...sel.options].some(o => o.value === S.model)) sel.insertAdjacentHTML("beforeend", `<option value="${esc(S.model)}">${esc(S.model)}</option>`);
  sel.value = S.model;
}
function openSettings(msg) {
  $("keyIn").value = S.key;
  $("keyMsg").textContent = msg || "";
  $("keyMsg").className = "key-msg" + (msg ? " bad" : "");
  $("settingsDlg").showModal();
  if (!S.key) setTimeout(() => $("keyIn").focus(), 50);
}
$("settingsBtn").onclick = () => openSettings();
$("keyShow").onclick = () => { const i = $("keyIn"); i.type = i.type === "password" ? "text" : "password"; };
$("keyTest").onclick = async () => {
  const k = $("keyIn").value.trim();
  const m = $("keyMsg");
  if (!k) { m.textContent = "Pegá la key primero."; m.className = "key-msg bad"; return; }
  m.textContent = "Probando…"; m.className = "key-msg";
  try {
    const list = await listModels(k);
    S.models = list; saveS(); fillModels();
    m.textContent = `Funciona · ${plural(list.length, "modelo disponible", "modelos disponibles")}`; m.className = "key-msg ok";
  } catch (e) {
    m.textContent = e.kind === "auth" || e.kind === "badrequest" ? "La key no es válida." : "No se pudo probar: " + e.message;
    m.className = "key-msg bad";
  }
};
$("settingsForm").addEventListener("submit", e => {
  if (e.submitter?.value !== "save") return;
  S.key = $("keyIn").value.trim(); saveS(); keyBadge();
  toast(S.key ? "API key guardada en este dispositivo." : "Se quitó la API key.");
  updateRunBtn();
});
$("keyDel").onclick = () => { $("keyIn").value = ""; S.key = ""; saveS(); keyBadge(); $("settingsDlg").close(); toast("API key borrada."); updateRunBtn(); };

/* ================= Pantallas ================= */
function show(screen) {
  $("home").hidden = screen !== "home";
  $("work").hidden = screen !== "work";
  window.scrollTo({ top: 0 });
}
$("homeBtn").onclick = () => { if (running) return toast("Hay un proceso en curso: detenelo primero."); closeDoc(); };
$("closeDoc").onclick = () => $("homeBtn").onclick();
function closeDoc() { doc = null; bytes = null; pdf?.destroy?.(); pdf = null; show("home"); renderRecents(); }

/* ================= Carga del PDF ================= */
const drop = $("drop");
$("fileInput").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) loadFile(f); });
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (!$("home").hidden) drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === "drop" || e.target === drop) drop.classList.remove("over"); }));
document.addEventListener("drop", e => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (running) return toast("Esperá a que termine el proceso actual.");
  loadFile(f);
});

async function loadFile(file) {
  if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) return toast("Elegí un archivo PDF.");
  drop.classList.add("loading");
  const t = drop.querySelector(".drop-t");
  const t0 = t.textContent;
  try {
    t.textContent = "Abriendo el PDF";
    const b = new Uint8Array(await file.arrayBuffer());
    const id = await fingerprint(b, file.name);
    const prev = await getDoc(id).catch(() => null);
    const p = await openPdf(b);
    if (prev) {
      bytes = b; pdf = p; doc = prev;
      if (doc.pages.some(x => x.fig === undefined)) { t.textContent = "Buscando figuras y fórmulas"; await addFlags(p, doc.pages); saveDoc(doc); }
      if (!(await getFile(id).catch(() => null))) saveFile(id, b);
      toast("Ya lo habías abierto: se recuperó desde el historial.");
    } else {
      const pages = await analyze(p, (i, n) => { t.textContent = `Leyendo páginas · ${i} de ${n}`; });
      bytes = b; pdf = p;
      doc = {
        id, name: file.name, size: file.size, numPages: p.numPages, createdAt: Date.now(), updatedAt: Date.now(),
        pages, chunks: [], options: null,
      };
      await saveFile(id, b);
      await saveDoc(doc);
    }
    openWork();
  } catch (e) {
    console.error(e);
    toast(/password/i.test(e?.name + e?.message) ? "El PDF tiene contraseña: quitásela y volvé a subirlo." : "No se pudo abrir el PDF: " + (e.message || e), 5000);
  } finally {
    drop.classList.remove("loading");
    t.textContent = t0;
  }
}

async function openFromHistory(id) {
  if (running) return toast("Hay un proceso en curso.");
  const d = await getDoc(id);
  if (!d) return;
  doc = d; bytes = null; pdf = null;
  const b = await getFile(id).catch(() => null);
  if (b) { bytes = b; try { pdf = await openPdf(b); } catch { pdf = null; } }
  if (pdf && doc.pages.some(x => x.fig === undefined)) { await addFlags(pdf, doc.pages); saveDoc(doc); }
  $("historyDlg").close();
  openWork();
}

/* ================= Área de trabajo ================= */
function openWork() {
  show("work");
  $("fileName").textContent = doc.name;
  $("fileSub").textContent = `${plural(doc.numPages, "página", "páginas")} · ${fmtMB(doc.size)}`;
  const o = doc.options || {};
  $("fromPage").max = $("toPage").max = doc.numPages;
  $("fromPage").value = o.from || 1;
  $("toPage").value = o.to || doc.numPages;
  setSeg("modeSeg", o.mode || S.mode);
  $("translate").checked = o.translate ?? S.translate;
  $("targetLang").value = o.targetLang || S.targetLang;
  $("bilingual").checked = o.bilingual ?? S.bilingual;
  $("glossary").value = o.glossary || "";
  $("figures").checked = o.figures ?? S.figures;
  $("describe").checked = o.describe ?? S.describe;
  $("describeRow").hidden = !$("figures").checked;
  $("ocrPages").value = o.ocrPages || S.ocrPages;
  $("parallel").value = S.parallel;
  fillModels();
  $("transOpts").hidden = !$("translate").checked;
  $("preview").hidden = true;
  $("errBox").hidden = true;
  $("runRow").hidden = true;
  $("searchIn").value = "";
  view = "t";
  setSeg("viewSeg", "t");
  renderAnalysis();
  renderMap();
  renderReader();
  updateRunBtn();
}

function renderAnalysis() {
  const t = doc.pages.filter(p => p.kind === "text").length;
  const s = doc.numPages - t;
  const figs = doc.pages.filter(p => p.fig).length, math = doc.pages.filter(p => p.math).length;
  let txt;
  if (!s) txt = `Las <b>${doc.numPages}</b> páginas tienen texto seleccionable.`;
  else if (!t) txt = `Las <b>${doc.numPages}</b> páginas son imágenes escaneadas: van con OCR.`;
  else txt = `<b>${t}</b> con texto seleccionable y <b>${s}</b> ${s === 1 ? "escaneada" : "escaneadas"}.`;
  const extra = [];
  if (figs) extra.push(`<b>${figs}</b> con figuras`);
  if (math) extra.push(`<b>${math}</b> con fórmulas`);
  if (extra.length) txt += ` Hay ${extra.join(" y ")}: esas también van con visión para recortar las figuras y escribir las fórmulas bien.`;
  $("analysis").innerHTML = txt;
  $("modeHint").textContent = !s && !figs && !math ? "Si el texto sale desordenado o con símbolos raros, probá «Todo con OCR»." : "";
}

function chunkOfPage(n) { return doc.chunks.find(c => n >= c.from && n <= c.to); }

function renderMap() {
  const from = +$("fromPage").value || 1, to = +$("toPage").value || doc.numPages;
  const mode = getSeg("modeSeg");
  const html = doc.pages.map(p => {
    const c = chunkOfPage(p.n);
    const st = c ? ({ done: "done", working: "working", error: "err" }[c.status] || "") : "";
    const kind = mode === "ocr" ? "s" : mode === "text" ? "" : (needsVision(p, $("figures").checked) ? "s" : "");
    const out = p.n < from || p.n > to ? "out" : "";
    const what = [p.kind === "text" ? "texto" : "escaneada", p.fig && "figuras", p.math && "fórmulas"].filter(Boolean).join(", ");
    const mark = p.math ? "∑" : p.fig ? "◩" : "";
    return `<button class="pg-t ${kind} ${st} ${out}" data-n="${p.n}" title="Página ${p.n} · ${what}">${mark ? `<em>${mark}</em>` : ""}${p.n}</button>`;
  }).join("");
  $("pagemap").innerHTML = html;
}
$("pagemap").addEventListener("click", async e => {
  const b = e.target.closest(".pg-t");
  if (!b) return;
  const n = +b.dataset.n;
  document.querySelectorAll(".pg-t.sel").forEach(x => x.classList.remove("sel"));
  b.classList.add("sel");
  const target = document.querySelector(`.pgm[data-page="${n}"]`) || [...document.querySelectorAll(".pgm")].filter(x => +x.dataset.page <= n).pop();
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!pdf) return;
  const p = doc.pages[n - 1];
  $("preview").hidden = false;
  $("previewCap").textContent = `Página ${n} · ${p.kind === "text" ? "con texto (" + p.chars + " letras)" : "escaneada"}${p.fig ? " · figuras" : ""}${p.math ? " · fórmulas" : ""}`;
  try { await renderPage(pdf, n, 300, $("previewCanvas")); } catch { $("preview").hidden = true; }
});

/* ---------- opciones ---------- */
function setSeg(id, v) { $(id).querySelectorAll("button").forEach(b => { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-checked", b.dataset.v === v); }); }
function getSeg(id) { return $(id).querySelector("button.on")?.dataset.v; }
$("modeSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; setSeg("modeSeg", b.dataset.v); S.mode = b.dataset.v; saveS(); renderMap(); updateRunBtn(); });
$("translate").onchange = () => { $("transOpts").hidden = !$("translate").checked; S.translate = $("translate").checked; saveS(); updateRunBtn(); };
$("targetLang").onchange = () => { S.targetLang = $("targetLang").value; saveS(); updateRunBtn(); };
$("bilingual").onchange = () => { S.bilingual = $("bilingual").checked; saveS(); updateRunBtn(); };
$("figures").onchange = () => { S.figures = $("figures").checked; $("describeRow").hidden = !S.figures; saveS(); renderMap(); updateRunBtn(); };
$("describe").onchange = () => { S.describe = $("describe").checked; saveS(); updateRunBtn(); };
$("glossary").oninput = debounce(updateRunBtn, 300);
$("modelSel").onchange = () => { S.model = $("modelSel").value; saveS(); };
$("ocrPages").onchange = () => { S.ocrPages = clamp(+$("ocrPages").value, 1, 15); $("ocrPages").value = S.ocrPages; saveS(); updateRunBtn(); };
$("parallel").onchange = () => { S.parallel = clamp(+$("parallel").value, 1, 6); $("parallel").value = S.parallel; saveS(); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v || a));
function fixRange() {
  let f = clamp(+$("fromPage").value, 1, doc.numPages), t = clamp(+$("toPage").value, 1, doc.numPages);
  if (f > t) [f, t] = [t, f];
  $("fromPage").value = f; $("toPage").value = t;
  renderMap(); updateRunBtn();
}
$("fromPage").onchange = fixRange; $("toPage").onchange = fixRange;
$("allPages").onclick = () => { $("fromPage").value = 1; $("toPage").value = doc.numPages; fixRange(); };

function currentOptions() {
  return {
    from: +$("fromPage").value, to: +$("toPage").value, mode: getSeg("modeSeg"),
    translate: $("translate").checked, targetLang: $("targetLang").value,
    bilingual: $("bilingual").checked, glossary: $("glossary").value.trim(),
    ocrPages: clamp(+$("ocrPages").value, 1, 15),
    figures: $("figures").checked, describe: $("figures").checked && $("describe").checked,
  };
}
const sameOptions = (a, b) => a && b && ["from", "to", "mode", "translate", "targetLang", "bilingual", "glossary", "ocrPages", "figures", "describe"].every(k => a[k] === b[k]);

function updateRunBtn() {
  if (!doc) return;
  const btn = $("runBtn");
  const o = currentOptions();
  const pendingSame = sameOptions(o, doc.options) && doc.chunks.some(c => c.status !== "done");
  const doneSame = sameOptions(o, doc.options) && doc.chunks.length && doc.chunks.every(c => c.status === "done");
  const plan = planChunks(doc.pages, o).filter(c => c.kind !== "empty");
  const pages = o.to - o.from + 1;
  btn.disabled = !!running;
  if (running) {
    btn.innerHTML = `Procesando…`;
  } else if (pendingSame) {
    const left = doc.chunks.filter(c => c.status !== "done");
    btn.innerHTML = `Continuar <small>· faltan ${plural(left.length, "tramo", "tramos")}</small>`;
  } else if (doneSame) {
    btn.innerHTML = `Volver a procesar <small>· ${plural(plan.length, "pedido", "pedidos")}</small>`;
  } else {
    const verb = o.translate ? "Procesar y traducir" : "Procesar";
    btn.innerHTML = `${verb} ${plural(pages, "página", "páginas")} <small>· ${plural(plan.length, "pedido", "pedidos")}</small>`;
  }
  btn.dataset.state = pendingSame ? "resume" : doneSame ? "redo" : "new";
}

/* ================= Procesamiento ================= */
$("runBtn").onclick = () => start();
$("stopBtn").onclick = () => { if (running) { running.ctrl.abort(); $("progText").textContent = "Deteniendo…"; } };

async function start() {
  if (running || !doc) return;
  if (!S.key) return openSettings("Para procesar hace falta tu API key de Gemini.");
  const o = currentOptions();
  const state = $("runBtn").dataset.state;
  const hasDone = doc.chunks.some(c => c.status === "done" && c.blocks?.length);
  if (state !== "resume") {
    if (hasDone && !confirm("Esto reemplaza el resultado actual de este documento. ¿Seguimos?")) return;
    doc.options = o;
    doc.chunks = planChunks(doc.pages, o);
  }
  const needsPdf = doc.chunks.some(c => c.kind === "ocr" && c.status !== "done");
  if (needsPdf && !bytes) return showErr("No está el PDF original guardado. Volvé a subir el archivo para continuar.");

  const ctrl = new AbortController();
  const todo = doc.chunks.filter(c => c.status !== "done").map(c => c.id);
  running = { ctrl, done: 0, total: todo.length };
  doc.chunks.forEach(c => { if (c.status === "error") { c.status = "pending"; c.error = ""; } });
  $("errBox").hidden = true;
  $("runRow").hidden = false;
  $("waitNote").hidden = true;
  updateRunBtn();
  setOptsDisabled(true);
  progress();

  const models = [S.model, ...FALLBACK_MODELS.filter(m => m !== S.model)];
  const opts = { ...o, key: S.key, models, fileName: doc.name };
  let fatal = null;
  const queue = [...todo];

  async function worker() {
    while (queue.length && !ctrl.signal.aborted && !fatal) {
      const id = queue.shift();
      const idx = doc.chunks.findIndex(c => c.id === id);
      if (idx < 0) continue;
      const chunk = doc.chunks[idx];
      chunk.status = "working";
      renderMap(); renderReaderSoon();
      try {
        const ctx = {
          pages: doc.pages, bytes, pdf, signal: ctrl.signal,
          prevTail: chunk.kind === "text" ? tailBefore(doc.pages, chunk.from) : "",
          onWait: ({ model, ms }) => { const w = $("waitNote"); w.hidden = false; w.textContent = `Gemini está con mucha demanda (${model}). Reintento en ${Math.round(ms / 1000)} s…`; },
        };
        const res = await runChunk(chunk, opts, ctx);
        const at = doc.chunks.findIndex(c => c.id === id);
        doc.chunks.splice(at, 1, ...res);
        $("waitNote").hidden = true;
      } catch (e) {
        if (e.kind === "auth") { fatal = e; chunk.status = "pending"; break; }
        chunk.status = "error";
        chunk.error = e.message || String(e);
      }
      if (doc.chunks.find(c => c.id === id)?.status !== "pending") running.done++;
      doc.updatedAt = Date.now();
      summarize();
      saveDoc(doc);
      progress(); renderMap(); renderReaderSoon();
    }
  }
  await Promise.all(Array.from({ length: Math.min(S.parallel, todo.length) || 1 }, worker));

  doc.chunks.forEach(c => { if (c.status === "working") c.status = "pending"; });
  saveDoc(doc);
  const aborted = ctrl.signal.aborted;
  running = null;
  setOptsDisabled(false);
  renderMap(); renderReader(); updateRunBtn();
  const errs = doc.chunks.filter(c => c.status === "error");
  if (fatal) {
    $("runRow").hidden = true;
    openSettings("Gemini rechazó la API key: " + fatal.message);
  } else if (errs.length) {
    showErr(`${plural(errs.length, "tramo quedó", "tramos quedaron")} con error. ${esc(errs[0].error)}<br><button class="link" id="retryAll">Reintentar los que fallaron</button>`);
    $("retryAll").onclick = () => start();
    $("runRow").hidden = true;
  } else if (aborted) {
    $("progText").textContent = "Detenido. Podés continuar cuando quieras.";
    $("stopBtn").hidden = true;
  } else {
    $("runRow").hidden = true;
    toast(doc.translated ? "Listo: documento transcripto y traducido." : "Listo: documento transcripto.");
  }
}

function setOptsDisabled(dis) {
  $("opts").querySelectorAll("input,select,textarea,.seg button,.chip").forEach(el => { el.disabled = dis; });
  $("stopBtn").hidden = !dis;
}
function progress() {
  if (!running) return;
  const pct = running.total ? Math.round((running.done / running.total) * 100) : 0;
  $("progBar").style.width = Math.max(pct, 3) + "%";
  $("progText").textContent = `${running.done} de ${plural(running.total, "tramo", "tramos")} · ${pct}%`;
}
function showErr(html) { const b = $("errBox"); b.innerHTML = html; b.hidden = false; }

/** Idioma detectado (el más frecuente) y si hubo traducción. */
function summarize() {
  const done = doc.chunks.filter(c => c.status === "done" && c.detectedLanguage);
  const count = {};
  done.forEach(c => { count[c.detectedLanguage] = (count[c.detectedLanguage] || 0) + c.blocks.length + 1; });
  doc.detectedLanguage = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  doc.translated = done.some(c => c.translated);
}

/* ================= Lector ================= */
const renderReaderSoon = debounce(() => renderReader(), 150);

function renderReader() {
  const r = $("reader");
  const chunks = doc.chunks || [];
  const any = chunks.some(c => c.status === "done" && c.blocks.length) || chunks.some(c => c.status !== "done");
  r.className = "reader view-" + view;
  r.style.setProperty("--rs", S.fontScale);
  if (!chunks.length || !any) {
    r.innerHTML = $("readerEmpty")?.outerHTML || "";
    if (!$("readerEmpty")) r.innerHTML = `<div class="empty" id="readerEmpty"><div class="empty-art"><i></i><i></i><i></i></div><p>Elegí las opciones y tocá <b>Procesar</b>. El texto va apareciendo acá a medida que se lee cada tramo de páginas.</p></div>`;
    $("readerEmpty").hidden = false;
    setTools(false);
    renderMeta();
    return;
  }
  const bilingual = !!doc.options?.bilingual && doc.options?.translate;
  let html = "", run = [], lastPage = 0, inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  const flush = () => {
    for (const b of mergedBlocks(run)) {
      if (b.page !== lastPage) { closeList(); html += `<div class="pgm" data-page="${b.page}"><span>p. ${b.page}</span></div>`; lastPage = b.page; }
      if (b.type === "list_item" && !inList) { html += "<ul>"; inList = true; }
      if (b.type !== "list_item") closeList();
      html += blockHtml(b, { bilingual });
    }
    run = [];
  };
  for (const c of chunks) {
    if (c.status === "done") { run.push(c); continue; }
    flush(); closeList();
    const label = c.from === c.to ? `Página ${c.from}` : `Páginas ${c.from}–${c.to}`;
    const st = c.status === "working" ? ["working", c.kind === "ocr" ? "aplicando OCR…" : "estructurando…"] : c.status === "error" ? ["err", "error"] : ["", "en cola"];
    html += `<div class="ph-chunk ${st[0]}" data-page="${c.from}"><div class="lab"><b>${label}</b><br>${st[1]}${c.status === "error" ? `<br><small>${esc(c.error)}</small>` : ""}</div><div class="bars"><i></i><i></i><i></i></div></div>`;
  }
  flush(); closeList();
  r.innerHTML = html;
  const hasOrig = bilingual && !!r.querySelector(".bi");
  $("viewSeg").hidden = !hasOrig;
  setTools(true);
  renderMeta();
  buildToc();
  if ($("searchIn").value.trim()) runSearch(false);
}

function setTools(on) {
  ["copyBtn", "exportBtn", "tocBtn", "searchIn"].forEach(id => { $(id).disabled = !on; });
}

function renderMeta() {
  const m = $("metaRow");
  if (!doc.chunks.length) { m.innerHTML = ""; return; }
  const done = doc.chunks.filter(c => c.status === "done");
  const pagesBy = k => done.filter(c => c.kind === k).reduce((s, c) => s + c.to - c.from + 1, 0);
  const t = pagesBy("text"), o = pagesBy("ocr");
  const tokens = done.reduce((s, c) => s + (c.tokens || 0), 0);
  const models = [...new Set(done.map(c => c.model).filter(Boolean))];
  const parts = [];
  if (doc.detectedLanguage) parts.push(`<span class="badge">Idioma original: <b>${esc(doc.detectedLanguage)}</b></span>`);
  if (doc.translated) parts.push(`<span class="badge a"><i></i>Traducido al ${esc(doc.options?.targetLang || "español")}</span>`);
  if (t) parts.push(`<span class="badge t"><i></i>${plural(t, "página", "páginas")} con texto (sin OCR)</span>`);
  if (o) parts.push(`<span class="badge s"><i></i>${plural(o, "página", "páginas")} con OCR</span>`);
  if (models.length) parts.push(`<span class="badge" title="${tokens.toLocaleString("es-AR")} tokens">${esc(models.join(", "))}</span>`);
  m.innerHTML = parts.join("");
}

/* ---------- vista bilingüe ---------- */
$("viewSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  view = b.dataset.v; setSeg("viewSeg", view);
  $("reader").className = "reader view-" + view;
});

/* ---------- tamaño de letra ---------- */
function setFont(d) { S.fontScale = Math.round(clamp(S.fontScale + d, 0.8, 1.5) * 100) / 100; saveS(); $("reader").style.setProperty("--rs", S.fontScale); }
$("fontDown").onclick = () => setFont(-0.08);
$("fontUp").onclick = () => setFont(0.08);

/* ---------- índice ---------- */
function buildToc() {
  const hs = [...$("reader").querySelectorAll(".bi-t h1.b, .bi-t h2.b, .reader > h1.b, .reader > h2.b")];
  $("tocBtn").disabled = !hs.length;
  $("tocMenu").innerHTML = hs.map((h, i) => { h.id = "h-" + i; return `<button data-h="${i}" class="${h.tagName === "H2" ? "l2" : ""}">${esc(h.textContent)}</button>`; }).join("");
}
$("tocBtn").onclick = e => { e.stopPropagation(); toggleMenu("tocMenu"); };
$("tocMenu").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  $("h-" + b.dataset.h)?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("tocMenu").hidden = true;
});
function toggleMenu(id) { const m = $(id); const open = m.hidden; document.querySelectorAll(".menu").forEach(x => x.hidden = true); m.hidden = !open; }
document.addEventListener("click", e => { if (!e.target.closest(".menu-wrap")) document.querySelectorAll(".menu").forEach(x => x.hidden = true); });
$("reader").addEventListener("click", e => {
  const img = e.target.closest(".b-figure img");
  if (img) { $("lbImg").src = img.src; $("lbCap").textContent = img.closest("figure").querySelector(".fig-desc")?.textContent || ""; $("lightbox").showModal(); return; }
  const s = e.target.closest(".pgm span");
  if (s) $("pagemap").querySelector(`[data-n="${s.parentElement.dataset.page}"]`)?.click();
});

/* ---------- búsqueda ---------- */
let hits = [], hitIdx = 0;
function clearMarks() {
  $("reader").querySelectorAll("mark").forEach(m => { const t = document.createTextNode(m.textContent); m.replaceWith(t); });
  $("reader").normalize();
}
function runSearch(jump = true) {
  clearMarks();
  hits = []; hitIdx = 0;
  const q = $("searchIn").value.trim();
  if (q.length < 2) { $("sCount").textContent = ""; $("sPrev").hidden = $("sNext").hidden = true; return; }
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const nq = norm(q);
  const walker = document.createTreeWalker($("reader"), NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest(".pgm,.ph-chunk,.katex,math,.b-math") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue, nt = norm(text);
    if (nt.length !== text.length) continue; // caracteres compuestos raros: se omiten
    let i = nt.indexOf(nq), last = 0;
    if (i < 0) continue;
    const frag = document.createDocumentFragment();
    while (i >= 0) {
      frag.append(text.slice(last, i));
      const m = document.createElement("mark");
      m.textContent = text.slice(i, i + q.length);
      frag.append(m); hits.push(m);
      last = i + q.length;
      i = nt.indexOf(nq, last);
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  $("sCount").textContent = hits.length ? `${hits.length}` : "0";
  $("sPrev").hidden = $("sNext").hidden = hits.length < 2;
  if (hits.length && jump) goHit(0);
}
function goHit(i) {
  if (!hits.length) return;
  hits[hitIdx]?.classList.remove("cur");
  hitIdx = (i + hits.length) % hits.length;
  hits[hitIdx].classList.add("cur");
  hits[hitIdx].scrollIntoView({ behavior: "smooth", block: "center" });
  $("sCount").textContent = `${hitIdx + 1}/${hits.length}`;
}
$("searchIn").addEventListener("input", debounce(() => runSearch(true), 250));
$("searchIn").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); goHit(hitIdx + (e.shiftKey ? -1 : 1)); } });
$("sNext").onclick = () => goHit(hitIdx + 1);
$("sPrev").onclick = () => goHit(hitIdx - 1);

/* ---------- copiar y exportar ---------- */
function exportBlocks() {
  const blocks = mergedBlocks(doc.chunks);
  if (view === "o") return blocks.map(b => b.original ? { ...b, text: b.original } : b);
  return blocks;
}
function exportMeta() {
  const base = doc.name.replace(/\.pdf$/i, "");
  const bits = [doc.name];
  if (doc.detectedLanguage) bits.push("idioma original: " + doc.detectedLanguage);
  if (doc.translated && view !== "o") bits.push("traducido al " + (doc.options?.targetLang || "español"));
  const o = doc.options || {};
  if (o.from && (o.from !== 1 || o.to !== doc.numPages)) bits.push(`páginas ${o.from}–${o.to}`);
  return { title: base, note: bits.join(" · "), file: base + (doc.translated && view !== "o" ? " (" + (o.targetLang || "español") + ")" : "") };
}
$("copyBtn").onclick = async () => {
  const text = toText(exportBlocks());
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* sin portapapeles */ }
    ta.remove();
  }
  const b = $("copyBtn"); b.classList.add("copied"); b.querySelector("span").textContent = "Copiado";
  setTimeout(() => { b.classList.remove("copied"); b.querySelector("span").textContent = "Copiar"; }, 1600);
};
$("exportBtn").onclick = e => { e.stopPropagation(); toggleMenu("exportMenu"); };
$("exportMenu").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  $("exportMenu").hidden = true;
  const blocks = exportBlocks(), meta = exportMeta();
  switch (b.dataset.x) {
    case "txt": return download(toText(blocks), meta.file + ".txt", "text/plain;charset=utf-8");
    case "md": return download(toMarkdown(blocks, meta), meta.file + ".md", "text/markdown;charset=utf-8");
    case "html": return download(toHtml(blocks, meta), meta.file + ".html", "text/html;charset=utf-8");
    case "doc": return download(toWord(blocks, meta), meta.file + ".doc", "application/msword");
    case "print": return window.print();
  }
});

/* ================= Historial ================= */
function recentHtml(d) {
  const total = d.chunks?.length || 0;
  const done = d.chunks?.filter(c => c.status === "done").length || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const state = !total ? "sin procesar" : pct === 100 ? (d.translated ? "traducido" : "listo") : `${pct}% procesado`;
  return `<div class="recent" data-id="${esc(d.id)}" role="button" tabindex="0">
    <span class="ri"><i style="height:${pct}%"></i></span>
    <span style="min-width:0"><div class="rn">${esc(d.name)}</div><div class="rs">${plural(d.numPages, "página", "páginas")} · ${state}${d.detectedLanguage ? " · " + esc(d.detectedLanguage) : ""} · ${fmtDate(d.updatedAt)}</div></span>
    <button class="rdel" data-del="${esc(d.id)}" title="Borrar del historial"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg></button>
  </div>`;
}
async function renderRecents() {
  const docs = await listDocs();
  $("recents").hidden = !docs.length;
  $("recentList").innerHTML = docs.slice(0, 5).map(recentHtml).join("");
  $("historyList").innerHTML = docs.length ? docs.map(recentHtml).join("") : `<p class="muted">Todavía no hay documentos.</p>`;
}
async function onRecentClick(e) {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    if (!confirm("¿Borrar este documento del historial?")) return;
    await deleteDoc(del.dataset.del);
    if (doc?.id === del.dataset.del) closeDoc();
    return renderRecents();
  }
  const r = e.target.closest(".recent");
  if (r) openFromHistory(r.dataset.id);
}
$("recentList").addEventListener("click", onRecentClick);
$("historyList").addEventListener("click", onRecentClick);
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList?.contains("recent")) e.target.click(); });
$("historyBtn").onclick = async () => { await renderRecents(); $("historyDlg").showModal(); };
$("historyClose").onclick = () => $("historyDlg").close();
$("lightbox").addEventListener("click", () => $("lightbox").close());
[$("settingsDlg"), $("historyDlg")].forEach(d => d.addEventListener("click", e => { if (e.target === d) d.close(); }));

window.addEventListener("beforeunload", e => { if (running) { e.preventDefault(); e.returnValue = ""; } });

/* ================= Inicio ================= */
keyBadge();
fillModels();
renderRecents();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
window.__app = { get doc() { return doc; }, APP_VERSION };
