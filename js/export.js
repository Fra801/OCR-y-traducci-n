// Exportación del resultado: texto, Markdown, HTML y Word. También arma el HTML del lector.
import katex from "../lib/katex/katex.min.mjs";

export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Fórmulas en LaTeX. math: "html" (KaTeX, para el lector e imprimir), "mathml" (archivos .html:
 * los navegadores la dibujan sin fuentes extra) o "tex" (Word y texto: queda el código LaTeX).
 */
export function tex(src, { display = false, math = "html" } = {}) {
  if (math === "tex") return esc(display ? src : `\\(${src}\\)`);
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: "ignore", output: math === "mathml" ? "mathml" : "htmlAndMathml", trust: false });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

const MATH_INLINE = /\\\(([\s\S]+?)\\\)/g;

/** **negrita**, *cursiva* y \( fórmulas \) → HTML. */
export function inline(s, { math = "html" } = {}) {
  const str = String(s ?? "");
  let out = "", last = 0, m;
  MATH_INLINE.lastIndex = 0;
  while ((m = MATH_INLINE.exec(str))) {
    out += fmt(str.slice(last, m.index)) + tex(m[1], { math });
    last = m.index + m[0].length;
  }
  return out + fmt(str.slice(last));
}
const fmt = s => esc(s)
  .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
const plain = s => String(s ?? "").replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1$2");

export function toText(blocks) {
  return blocks.map(b => {
    if (b.type === "list_item") return "• " + plain(b.text);
    if (b.type === "table") return [b.text ? plain(b.text) : "", ...(b.rows || []).map(r => r.map(plain).join("\t"))].filter(Boolean).join("\n");
    if (b.type === "h1") return plain(b.text).toUpperCase();
    if (b.type === "math") return "    " + b.text;
    if (b.type === "figure") return `[Figura, p. ${b.page}${b.text ? ": " + b.text : ""}]`;
    return plain(b.text);
  }).join("\n\n");
}

const mdMath = s => String(s ?? "").replace(MATH_INLINE, (_, t) => "$" + t.trim() + "$");

export function toMarkdown(blocks, meta) {
  const head = `# ${meta.title}\n\n> ${meta.note}\n\n`;
  let fig = 0;
  return head + blocks.map(b => ({ ...b, text: b.type === "math" ? b.text : mdMath(b.text), rows: b.rows?.map(r => r.map(mdMath)) })).map(b => {
    switch (b.type) {
      case "math": return "$$\n" + b.text + "\n$$";
      case "figure": fig++; return b.img ? `![${(b.text || "Figura " + fig).replace(/[\[\]]/g, "")}](${b.img})` : "";
      case "h1": return "# " + b.text;
      case "h2": return "## " + b.text;
      case "h3": return "### " + b.text;
      case "list_item": return "- " + b.text;
      case "quote": return "> " + b.text;
      case "caption": return "*" + plain(b.text) + "*";
      case "footnote": return "<sup>" + esc(plain(b.text)) + "</sup>";
      case "table": {
        const rows = b.rows || [];
        if (!rows.length) return b.text;
        const w = Math.max(...rows.map(r => r.length));
        const line = r => "| " + Array.from({ length: w }, (_, i) => (r[i] || "").replace(/\|/g, "\\|")).join(" | ") + " |";
        return (b.text ? `**${b.text}**\n\n` : "") + [line(rows[0]), "|" + " --- |".repeat(w), ...rows.slice(1).map(line)].join("\n");
      }
      default: return b.text;
    }
  }).join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function blockHtml(b, { bilingual = false, math = "html", imgSrc = null } = {}) {
  const tag = { h1: "h1", h2: "h2", h3: "h3", quote: "blockquote", caption: "figcaption", footnote: "aside", list_item: "li" }[b.type] || "p";
  const il = t => inline(t, { math });
  let inner;
  if (b.type === "table") {
    const rows = b.rows || [];
    inner = (b.text ? `<div class="tcap">${il(b.text)}</div>` : "") +
      `<div class="twrap"><table>${rows.map((r, i) => `<tr>${r.map(c => i === 0 ? `<th>${il(c)}</th>` : `<td>${il(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
    return `<div class="b b-table" data-page="${b.page}">${inner}</div>`;
  }
  if (b.type === "math") {
    return `<div class="b b-math" data-page="${b.page}">${tex(b.text, { display: true, math })}</div>`;
  }
  if (b.type === "figure") {
    const src = imgSrc ? imgSrc(b) : b.img;
    return `<figure class="b b-figure" data-page="${b.page}">${src ? `<img src="${esc(src)}" alt="${esc(b.text || "Figura de la página " + b.page)}" loading="lazy">` : ""}${b.text ? `<div class="fig-desc">${il(b.text)}</div>` : ""}</figure>`;
  }
  inner = `<${tag} class="b b-${b.type}">${il(b.text)}</${tag}>`;
  if (bilingual && b.original) {
    return `<div class="bi" data-page="${b.page}"><div class="bi-o">${`<${tag} class="b b-${b.type}">${il(b.original)}</${tag}>`}</div><div class="bi-t">${inner}</div></div>`;
  }
  return inner.replace("<" + tag + " ", `<${tag} data-page="${b.page}" `);
}

const DOC_CSS = `body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1b1b1f;line-height:1.15;font-size:17px}
p{margin:0 0 .8em}
h1,h2,h3{font-family:Helvetica,Arial,sans-serif;line-height:1.25}h1{font-size:1.8em;margin:1.6em 0 .5em}h2{font-size:1.35em;margin:1.4em 0 .4em}h3{font-size:1.1em}
blockquote{border-left:3px solid #3247ff;margin:1em 0;padding:.2em 1em;color:#333;font-style:italic}li{margin:.3em 0 .3em 1.2em}
figcaption{font-size:.9em;color:#555;font-style:italic;text-align:center}aside{font-size:.85em;color:#555;border-top:1px solid #ddd;padding-top:.4em}
table{border-collapse:collapse;margin:1em 0;font-size:.92em;width:100%}td,th{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f2f2f6}
.tcap{font-weight:bold;margin-top:1em}figure{margin:1.4em 0;text-align:center}figure img{max-width:100%;height:auto}.fig-desc{font-size:.85em;color:#666;font-style:italic;margin-top:.4em}
.b-math{margin:1em 0;text-align:center;overflow-x:auto}math{font-size:1.1em}.texmath{font-family:Consolas,monospace;color:#333}.meta{font-family:Helvetica,Arial,sans-serif;font-size:.8em;color:#777;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:24px}`;

function htmlBody(blocks, opts) {
  let body = "", inList = false;
  for (const b of blocks) {
    if (b.type === "list_item" && !inList) { body += "<ul>"; inList = true; }
    if (b.type !== "list_item" && inList) { body += "</ul>"; inList = false; }
    let h = blockHtml(b, opts).replace(/ data-page="\d+"/, "");
    if (!["math", "figure", "table"].includes(b.type)) h = h.replace(/ class="[^"]*"/, "");
    body += h + "\n";
  }
  if (inList) body += "</ul>";
  return body;
}

/** Página web autónoma: las figuras van incrustadas y las fórmulas en MathML. */
export function toHtml(blocks, meta) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(meta.title)}</title><style>${DOC_CSS}</style></head><body><div class="meta">${esc(meta.note)}</div>${htmlBody(blocks, { math: "mathml" })}</body></html>`;
}

/**
 * Word: un .doc en formato MHTML (HTML + imágenes en un solo archivo), que Word abre con
 * formato e imágenes. Las fórmulas quedan como código LaTeX: en Word 365 se convierten
 * seleccionándolas e insertando una ecuación en modo LaTeX.
 */
export function toWord(blocks, meta) {
  const imgs = [];
  const body = htmlBody(blocks, {
    math: "tex",
    imgSrc: b => {
      if (!b.img) return null;
      const name = `file:///C:/ocr/figura${imgs.length + 1}.jpg`;
      imgs.push({ name, data: b.img.split(",")[1], type: b.img.slice(5, b.img.indexOf(";")) });
      return name;
    },
  }).replace(/<figure class="b b-figure">/g, "<p align=\"center\">").replace(/<\/figure>/g, "</p>")
    .replace(/<div class="b b-math">([\s\S]*?)<\/div>/g, '<p align="center" class="texmath">$1</p>');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]--><style>${DOC_CSS} img{max-width:16cm} p,li{line-height:115%;mso-line-height-rule:auto} p{margin:0 0 10pt}</style></head><body><div class="meta">${esc(meta.note)}</div>${body}</body></html>`;
  const B = "----=_ocr_traduccion_" + Date.now();
  const b64 = str => { const u = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const wrap = s => s.replace(/.{1,76}/g, "$&\r\n");
  let out = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${B}"\r\n\r\n` +
    `--${B}\r\nContent-Location: file:///C:/ocr/documento.htm\r\nContent-Transfer-Encoding: base64\r\nContent-Type: text/html; charset="utf-8"\r\n\r\n${wrap(b64(html))}\r\n`;
  for (const im of imgs) out += `--${B}\r\nContent-Location: ${im.name}\r\nContent-Transfer-Encoding: base64\r\nContent-Type: ${im.type}\r\n\r\n${wrap(im.data)}\r\n`;
  return out + `--${B}--\r\n`;
}

export function download(content, name, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
