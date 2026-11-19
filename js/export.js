// Exportación del resultado: texto, Markdown, HTML y Word.

export const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** **negrita** y *cursiva* → HTML (sobre texto ya escapado). */
export function inline(s) {
  return esc(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
}
const plain = s => String(s ?? "").replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1$2");

export function toText(blocks) {
  return blocks.map(b => {
    if (b.type === "list_item") return "• " + plain(b.text);
    if (b.type === "table") return [b.text ? plain(b.text) : "", ...(b.rows || []).map(r => r.map(plain).join("\t"))].filter(Boolean).join("\n");
    if (b.type === "h1") return plain(b.text).toUpperCase();
    return plain(b.text);
  }).join("\n\n");
}

export function toMarkdown(blocks, meta) {
  const head = `# ${meta.title}\n\n> ${meta.note}\n\n`;
  return head + blocks.map(b => {
    switch (b.type) {
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

export function blockHtml(b, { bilingual = false } = {}) {
  const tag = { h1: "h1", h2: "h2", h3: "h3", quote: "blockquote", caption: "figcaption", footnote: "aside", list_item: "li" }[b.type] || "p";
  let inner;
  if (b.type === "table") {
    const rows = b.rows || [];
    inner = (b.text ? `<div class="tcap">${inline(b.text)}</div>` : "") +
      `<div class="twrap"><table>${rows.map((r, i) => `<tr>${r.map(c => i === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
    return `<div class="b b-table" data-page="${b.page}">${inner}</div>`;
  }
  inner = `<${tag} class="b b-${b.type}">${inline(b.text)}</${tag}>`;
  if (bilingual && b.original) {
    return `<div class="bi" data-page="${b.page}"><div class="bi-o">${`<${tag} class="b b-${b.type}">${inline(b.original)}</${tag}>`}</div><div class="bi-t">${inner}</div></div>`;
  }
  return inner.replace("<" + tag + " ", `<${tag} data-page="${b.page}" `);
}

const DOC_CSS = `body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1b1b1f;line-height:1.7;font-size:17px}
h1,h2,h3{font-family:Helvetica,Arial,sans-serif;line-height:1.25}h1{font-size:1.8em;margin:1.6em 0 .5em}h2{font-size:1.35em;margin:1.4em 0 .4em}h3{font-size:1.1em}
blockquote{border-left:3px solid #3247ff;margin:1em 0;padding:.2em 1em;color:#333;font-style:italic}li{margin:.3em 0 .3em 1.2em}
figcaption{font-size:.9em;color:#555;font-style:italic;text-align:center}aside{font-size:.85em;color:#555;border-top:1px solid #ddd;padding-top:.4em}
table{border-collapse:collapse;margin:1em 0;font-size:.92em;width:100%}td,th{border:1px solid #ccc;padding:5px 8px;text-align:left;vertical-align:top}th{background:#f2f2f6}
.tcap{font-weight:bold;margin-top:1em}.meta{font-family:Helvetica,Arial,sans-serif;font-size:.8em;color:#777;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:24px}`;

export function toHtml(blocks, meta) {
  let body = "", inList = false;
  for (const b of blocks) {
    if (b.type === "list_item" && !inList) { body += "<ul>"; inList = true; }
    if (b.type !== "list_item" && inList) { body += "</ul>"; inList = false; }
    body += blockHtml(b).replace(/ data-page="\d+"/, "").replace(/ class="[^"]*"/, "") + "\n";
  }
  if (inList) body += "</ul>";
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>${DOC_CSS}</style></head><body><div class="meta">${esc(meta.note)}</div>${body}</body></html>`;
}

/** Word abre sin problemas un HTML con este encabezado y extensión .doc. */
export function toWord(blocks, meta) {
  return toHtml(blocks, meta)
    .replace("<html lang=\"es\">", `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="es">`)
    .replace("<head>", `<head><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->`);
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
