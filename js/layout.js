// Armado de la estructura (títulos, párrafos, listas, notas) a partir de los renglones del PDF,
// sin IA. Sirve para las páginas con texto seleccionable: es instantáneo y no gasta pedidos.
// Renglón: [texto, tamaño, x, y desde arriba, x final].

const T = 0, S = 1, X = 2, Y = 3, RX = 4;

const median = arr => { if (!arr.length) return 0; const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const normKey = t => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const isPageNum = t => /^[\W_]*((p(á|a)g(ina)?|page|p)\.?\s*)?(\d{1,4}|[ivxlcdm]{1,7})([\W_]*(de|of|\/)\s*\d{1,4})?[\W_]*$/i.test(t.trim());

/** Datos de todo el documento: tamaño de letra del cuerpo, interlineado y encabezados repetidos. */
export function docStats(pages) {
  const sizes = new Map();
  const leads = [];
  const edge = new Map();
  const textPages = pages.filter(p => p.kind === "text" && p.lines?.length);
  for (const p of textPages) {
    for (const l of p.lines) {
      const k = Math.round(l[S] * 2) / 2;
      sizes.set(k, (sizes.get(k) || 0) + l[T].length);
    }
    const seen = new Set();
    for (const l of p.lines) {
      if (l[Y] < p.h * 0.09 || l[Y] > p.h * 0.91) {
        const k = normKey(l[T]);
        if (k.length > 2 && !seen.has(k)) { seen.add(k); edge.set(k, (edge.get(k) || 0) + 1); }
      }
    }
  }
  const body = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  for (const p of textPages) {
    for (let i = 1; i < p.lines.length; i++) {
      const a = p.lines[i - 1], b = p.lines[i];
      const dy = b[Y] - a[Y];
      if (Math.abs(a[S] - body) < 0.6 && Math.abs(b[S] - body) < 0.6 && dy > body * 0.8 && dy < body * 2.2) leads.push(dy);
    }
  }
  const minRepeat = Math.max(2, Math.min(4, Math.ceil(textPages.length * 0.25)));
  const repeated = new Set([...edge.entries()].filter(([, c]) => c >= minRepeat).map(([k]) => k));
  return { body, lead: median(leads) || body * 1.25, repeated };
}

const BULLET = /^([•·▪‣◦●○■□►▸✓✔\-–—*])\s+/;
const ENUM = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivx]{1,4}[.)])\s+\S/;
const CAPTION = /^(fig(ura|ure|\.)?|tabla|table|cuadro|gr[áa]fico|imagen|l[áa]mina|plate|chart|diagrama)\s*[\dIVX]+/i;
const ENDS = /[.!?:;…»"”')\]]$/;

function classify(l, page, st) {
  const t = l[T], r = l[S] / st.body;
  const letters = (t.match(/\p{L}/gu) || []).length;
  const upper = (t.match(/\p{Lu}/gu) || []).length;
  if (CAPTION.test(t) && t.length < 400) return "caption";
  if (r >= 1.12 && t.length < 160 && !/[,;]$/.test(t)) return r >= 1.6 ? "h1" : r >= 1.3 ? "h2" : "h3";
  if (letters >= 4 && upper / letters > 0.85 && t.length <= 90 && r >= 0.95 && !ENDS.test(t)) return "h3";
  if (r <= 0.88 && l[Y] > page.h * 0.62) return "footnote";
  if (BULLET.test(t) || ENUM.test(t)) return "list_item";
  return "p";
}

const join = (a, b) => (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : a + " " + b);

/** Convierte los renglones de varias páginas seguidas en bloques. */
export function structure(pages, st) {
  const blocks = [];
  let cur = null, prev = null;
  const push = () => { if (cur && cur.text.trim()) blocks.push({ type: cur.type, page: cur.page, text: cur.text.trim() }); cur = null; };

  for (const p of pages) {
    const lines = (p.lines || []).filter(l => {
      const edgeZone = l[Y] < p.h * 0.09 || l[Y] > p.h * 0.91;
      return !(edgeZone && (st.repeated.has(normKey(l[T])) || isPageNum(l[T])));
    });
    const bodyLines = lines.filter(l => Math.abs(l[S] - st.body) < 0.6);
    const left = median(bodyLines.map(l => Math.round(l[X]))) || 0;
    const right = median(bodyLines.map(l => Math.round(l[RX]))) || p.w;
    prev = null;

    for (const l of lines) {
      const type = classify(l, p, st);
      const t = l[T];
      const dy = prev ? l[Y] - prev[Y] : 0;
      const bigGap = prev && dy > st.lead * 1.45;
      const indented = l[X] > left + st.body * 0.8 && l[X] < left + st.body * 6;
      const prevShort = prev && prev[RX] < right - st.body * 2.5 && ENDS.test(prev[T]);
      let fresh = !cur || cur.type !== type;

      if (!fresh) {
        if (type === "list_item") fresh = true;
        else if (type.startsWith("h")) fresh = bigGap || Math.abs(l[S] - cur.size) > 0.6;
        else if (type === "caption") fresh = bigGap;
        else if (type === "footnote") fresh = /^\(?[\d*†‡§]+\)?\s/.test(t) || bigGap;
        else fresh = !prev ? (ENDS.test(cur.text) || indented) : (bigGap || indented || prevShort);
      }
      // Renglón que sigue a un ítem de lista, con sangría igual o mayor: es parte del ítem.
      if (type === "p" && cur?.type === "list_item" && prev && !bigGap && l[X] > cur.x + st.body * 0.5) {
        cur.text = join(cur.text, t); prev = l; continue;
      }
      if (type === "p" && cur?.type === "footnote" && prev && !bigGap && l[S] / st.body <= 0.92) {
        cur.text = join(cur.text, t); prev = l; continue;
      }
      if (fresh) {
        push();
        const text = type === "list_item" ? t.replace(BULLET, "") : t;
        cur = { type, page: p.n, text, size: l[S], x: l[X] };
      } else {
        cur.text = join(cur.text, t);
      }
      prev = l;
    }
  }
  push();
  return blocks;
}
