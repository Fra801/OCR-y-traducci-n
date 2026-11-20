// Exportación a Word (.docx real, Office Open XML), armada en el navegador sin librerías:
// los XML del documento se empaquetan en un ZIP sin compresión.

/* ---------- ZIP (método "store") ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = u => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); // UTF-8
    h.setUint16(8, 0, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, 0, true); c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, u) => s + u.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/* ---------- utilidades ---------- */
const x = s => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function b64bytes(b64) {
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/** Ancho y alto en píxeles de un JPEG o PNG (sin decodificar la imagen). */
function imgSize(u) {
  if (u[0] === 0x89 && u[1] === 0x50) return { w: (u[16] << 24 | u[17] << 16 | u[18] << 8 | u[19]) >>> 0, h: (u[20] << 24 | u[21] << 16 | u[22] << 8 | u[23]) >>> 0 };
  let i = 2;
  while (i + 9 < u.length) {
    if (u[i] !== 0xff) { i++; continue; }
    const m = u[i + 1], len = u[i + 2] << 8 | u[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: u[i + 5] << 8 | u[i + 6], w: u[i + 7] << 8 | u[i + 8] };
    i += 2 + len;
  }
  return { w: 800, h: 600 };
}

/** Texto con **negrita**, *cursiva* y fórmulas \( … \) → corridas de Word. */
function runs(text, base = "") {
  const out = [];
  const re = /\*\*([^*\n]+?)\*\*|(^|[^*\w])\*([^*\n]+?)\*(?!\w)|\\\((.+?)\\\)/g;
  const s = String(text ?? "");
  let last = 0, m;
  const r = (t, pr = "") => { if (t) out.push(`<w:r>${base || pr ? `<w:rPr>${base}${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`); };
  while ((m = re.exec(s))) {
    if (m[1] != null) { r(s.slice(last, m.index)); r(m[1], "<w:b/>"); }
    else if (m[3] != null) { r(s.slice(last, m.index) + m[2]); r(m[3], "<w:i/>"); }
    else { r(s.slice(last, m.index)); r("\\(" + m[4].trim() + "\\)", `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>`); }
    last = re.lastIndex;
  }
  r(s.slice(last));
  return out.join("") || `<w:r><w:t></w:t></w:r>`;
}
const para = (text, style, base) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${runs(text, base)}</w:p>`;

const NO_BORDERS = `<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>`;
const TEXT_W = 9638; // ancho útil de una hoja A4 con márgenes de 2 cm, en twips

/** Epígrafe: tabla transparente de una sola celda que ocupa todo el ancho. */
const captionTable = text => `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/>${NO_BORDERS}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${TEXT_W}"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="5000" w:type="pct"/></w:tcPr>${para(text, "Epigrafe")}</w:tc></w:tr></w:tbl><w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>`;

function dataTable(b) {
  const rows = b.rows || [];
  const w = Math.max(1, ...rows.map(r => r.length));
  const col = Math.floor(TEXT_W / w);
  const border = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`).join("")}</w:tblBorders>`;
  const cap = b.text ? para(b.text, "", "<w:b/>") : "";
  return cap + `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${col}"/>`.repeat(w)}</w:tblGrid>` +
    rows.map((r, i) => `<w:tr>${i === 0 ? `<w:trPr><w:tblHeader/></w:trPr>` : ""}${Array.from({ length: w }, (_, j) =>
      `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/>${i === 0 ? `<w:shd w:val="clear" w:color="auto" w:fill="F2F2F6"/>` : ""}</w:tcPr>${para(r[j] || "", "Celda", i === 0 ? "<w:b/>" : "")}</w:tc>`).join("")}</w:tr>`).join("") +
    `</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`;
}

function imagePara(id, rid, u, alt) {
  const { w, h } = imgSize(u);
  const maxW = 5760000, maxH = 7920000; // 16 cm × 22 cm en EMU
  let cx = w * 9525, cy = h * 9525;
  const k = Math.min(1, maxW / cx, maxH / cy);
  cx = Math.round(cx * k); cy = Math.round(cy * k);
  return `<w:p><w:pPr><w:jc w:val="center"/><w:keepNext/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Figura ${id}" descr="${x(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="figura${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Times New Roman"/><w:sz w:val="23"/><w:szCs w:val="23"/><w:lang w:val="es-AR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Epigrafe"><w:name w:val="Epígrafe"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Cita"><w:name w:val="Cita"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="3247FF"/></w:pBdr><w:ind w:left="400"/></w:pPr><w:rPr><w:i/><w:color w:val="333333"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Nota"><w:name w:val="Nota"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/></w:pBdr></w:pPr><w:rPr><w:color w:val="555555"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Formula"><w:name w:val="Fórmula"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="333333"/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Vineta"><w:name w:val="Viñeta"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/><w:ind w:left="567" w:hanging="283"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Celda"><w:name w:val="Celda"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Datos del documento"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="DDDDDD"/></w:pBdr><w:spacing w:after="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="567" w:hanging="283"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

/**
 * Documento de Word con títulos, párrafos, listas, tablas, figuras y epígrafes.
 * Las fórmulas quedan como código LaTeX (en Word 365 se convierten insertando una ecuación en modo LaTeX).
 */
export function toDocx(blocks, meta) {
  const media = [];
  const STYLE = { h1: "Heading1", h2: "Heading2", h3: "Heading3", quote: "Cita", footnote: "Nota", list_item: "Vineta" };
  let body = para(meta.note, "Meta");
  for (const b of blocks) {
    if (b.type === "figure") {
      if (!b.img) continue;
      const mime = b.img.slice(5, b.img.indexOf(";"));
      const ext = mime === "image/png" ? "png" : "jpeg";
      const u = b64bytes(b.img.split(",")[1]);
      const n = media.length + 1;
      media.push({ name: `word/media/figura${n}.${ext}`, data: u, rid: `rIdImg${n}`, ext });
      body += imagePara(n, `rIdImg${n}`, u, b.text || `Figura de la página ${b.page}`);
      if (b.text) body += para(b.text, "Epigrafe", `<w:color w:val="777777"/>`);
    } else if (b.type === "caption") body += captionTable(b.text);
    else if (b.type === "table") body += (b.rows || []).length ? dataTable(b) : para(b.text);
    else if (b.type === "math") body += `<w:p><w:pPr><w:pStyle w:val="Formula"/></w:pPr><w:r><w:t xml:space="preserve">${x(b.text)}</w:t></w:r></w:p>`;
    else body += para(b.text, STYLE[b.type] || "");
  }
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const exts = [...new Set(media.map(m => m.ext))];
  return zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map(e => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(meta.title)}</dc:title><dc:creator>OCR y traducción</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>` },
    { name: "word/document.xml", data: doc },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/numbering.xml", data: NUMBERING },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.name.replace("word/", "")}"/>`).join("")}</Relationships>` },
    ...media.map(m => ({ name: m.name, data: m.data })),
  ]);
}
