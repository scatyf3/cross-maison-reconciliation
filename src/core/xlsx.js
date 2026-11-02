// src/core/xlsx.js
// Minimal, dependency-free XLSX (Excel) writer. An .xlsx is a ZIP of XML parts;
// this hand-builds the XML and a store-only ZIP so a real multi-sheet workbook
// can be produced in the browser with no libraries (GitHub-Pages friendly).
// buildWorkbookBlob([{ name, rows: [[cell,...],...] }, ...]) -> Blob

function esc(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function isNumeric(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return Number.isFinite(Number(v));
  return false;
}
function colName(n) {
  let s = ""; n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function sheetXml(rows) {
  let body = "";
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] || [];
    let rowXml = "";
    for (let c = 0; c < cells.length; c++) {
      const ref = colName(c) + (r + 1);
      const v = cells[c];
      if (isNumeric(v)) rowXml += '<c r="' + ref + '"><v>' + esc(Number(v)) + '</v></c>';
      else rowXml += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
    }
    body += '<row r="' + (r + 1) + '">' + rowXml + '</row>';
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    body + '</sheetData></worksheet>';
}
function contentTypes(n) {
  let o = "";
  for (let i = 1; i <= n; i++) o += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    o + '</Types>';
}
function rootRels() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
}
function workbookXml(names) {
  let sheets = "";
  for (let i = 0; i < names.length; i++) sheets += '<sheet name="' + esc(names[i]) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets + '</sheets></workbook>';
}
function workbookRels(n) {
  let rels = "";
  for (let i = 1; i <= n; i++) rels += '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>';
}
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function strBytes(s) { return new TextEncoder().encode(s); }
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  for (const f of files) {
    const nameB = strBytes(f.name), crc = crc32(f.data), size = f.data.length;
    const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameB.length), u16(0));
    chunks.push(new Uint8Array(local)); chunks.push(nameB); chunks.push(f.data);
    const cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    central.push(new Uint8Array(cen)); central.push(nameB);
    offset += local.length + nameB.length + size;
  }
  let centralSize = 0; for (const c of central) centralSize += c.length;
  const centralStart = offset;
  const end = [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(centralStart), u16(0));
  const all = [].concat(chunks, central, [new Uint8Array(end)]);
  let total = 0; for (const p of all) total += p.length;
  const out = new Uint8Array(total); let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}
function safeSheetName(name, used) {
  let n = String(name || "Sheet").replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31) || "Sheet";
  let base = n, i = 1;
  while (used.has(n)) { const suffix = " (" + (++i) + ")"; n = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(n); return n;
}
export function buildWorkbookBlob(sheets) {
  const used = new Set();
  const defs = (sheets || []).map((s) => ({ name: safeSheetName(s.name, used), rows: s.rows || [] }));
  const files = [];
  files.push({ name: "[Content_Types].xml", data: strBytes(contentTypes(defs.length)) });
  files.push({ name: "_rels/.rels", data: strBytes(rootRels()) });
  files.push({ name: "xl/workbook.xml", data: strBytes(workbookXml(defs.map((d) => d.name))) });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: strBytes(workbookRels(defs.length)) });
  for (let i = 0; i < defs.length; i++) files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: strBytes(sheetXml(defs[i].rows)) });
  return new Blob([zip(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
