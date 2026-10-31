// Word(.docx) → PDF —— 纯离线实现，不依赖 Office / LibreOffice，也不增加安装体积。
//
// 链路：ZIP 解析（自实现，解压用浏览器内置 DecompressionStream）
//      → 解析 word/document.xml（DOMParser）
//      → 提取段落 / 标题 / 列表 / 表格
//      → pdf-lib 排版输出（中文走系统字体子集内嵌）
//
// 说明：复杂排版（浮动图片、艺术字、分栏、页眉页脚域）会有损失，正文/标题/列表/表格可保真呈现。

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadSystemCjk, hasNonLatin } from './flatten.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;

/* ------------------------------------------------------------------ *
 * ZIP：只读实现（支持 stored / deflate）
 * ------------------------------------------------------------------ */
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function unzipIndex(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || dv.getUint32(off, true) !== SIG_CENTRAL) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(off + 46, off + 46 + nameLen));
    files.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { files, dv };
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function unzipEntry(bytes, index, name) {
  const entry = index.files.get(name);
  if (!entry) return null;
  const dv = index.dv;
  const lo = entry.localOff;
  if (lo + 30 > bytes.length || dv.getUint32(lo, true) !== SIG_LOCAL) return null;
  const nameLen = dv.getUint16(lo + 26, true);
  const extraLen = dv.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error('unsupported zip compression');
}

/* ------------------------------------------------------------------ *
 * document.xml → 结构化块
 * ------------------------------------------------------------------ */
function attr(el, name) {
  return el.getAttribute('w:' + name) || el.getAttribute(name) || '';
}

function paragraphText(p) {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType !== 1) continue;
      const ln = c.localName;
      if (ln === 't') out += c.textContent || '';
      else if (ln === 'tab') out += '    ';
      else if (ln === 'br' || ln === 'cr') out += ' ';
      else if (ln === 'delText' || ln === 'instrText') { /* 跳过修订删除内容与域代码 */ }
      else walk(c);
    }
  };
  walk(p);
  return out.replace(/\s+$/, '');
}

function paragraphMeta(p) {
  let level = 0;
  let list = false;
  for (const el of p.getElementsByTagName('*')) {
    const ln = el.localName;
    if (ln === 'pStyle') {
      const v = String(attr(el, 'val') || '').toLowerCase();
      const m = v.match(/heading\s*(\d)/) || v.match(/^h(\d)$/) || v.match(/^(\d)$/);
      if (m) level = Math.min(4, parseInt(m[1], 10));
      if (/^title$/.test(v)) level = 1;
    } else if (ln === 'outlineLvl') {
      const v = parseInt(attr(el, 'val') || '-1', 10);
      if (v >= 0) level = Math.min(4, v + 1);
    } else if (ln === 'numPr') {
      list = true;
    } else if (ln === 'b') {
      /* 加粗：无对应字重时忽略 */
    }
  }
  return { level, list };
}

function tableRows(tbl) {
  const rows = [];
  const trs = Array.from(tbl.getElementsByTagName('*')).filter((e) => e.localName === 'tr');
  for (const tr of trs) {
    const cells = [];
    const tcs = Array.from(tr.children).filter((e) => e.localName === 'tc');
    for (const tc of tcs) {
      const ps = Array.from(tc.getElementsByTagName('*')).filter((e) => e.localName === 'p');
      const text = ps.map(paragraphText).filter(Boolean).join('\n');
      cells.push(text);
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function collectBody(body, blocks) {
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType !== 1) continue;
    const ln = node.localName;
    if (ln === 'p') {
      const text = paragraphText(node);
      const meta = paragraphMeta(node);
      if (!text && !meta.list) continue;
      blocks.push({ type: 'p', text, level: meta.level, list: meta.list });
    } else if (ln === 'tbl') {
      const rows = tableRows(node);
      if (rows.length) blocks.push({ type: 'table', rows });
    } else if (ln === 'sdt' || ln === 'sdtContent' || ln === 'tc' || ln === 'txbxContent') {
      collectBody(node, blocks);
    }
  }
}

export function parseDocxDocumentXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = Array.from(doc.getElementsByTagName('*')).find((e) => e.localName === 'body');
  // 只要解析出了 body 就继续（有些文档带无关的 XML 瑕疵，不应直接判失败）
  if (!body) {
    throw new Error('invalid document.xml (root=' + (doc.documentElement && doc.documentElement.tagName) + ')');
  }
  const blocks = [];
  collectBody(body, blocks);
  return blocks;
}

/* ------------------------------------------------------------------ *
 * 排版：块 → PDF
 * ------------------------------------------------------------------ */
function sanitize(str, font) {
  if (font.cjk) return str;
  return String(str).replace(/[^\u0000-\u00ff]/g, '?');
}

function measure(font, text, size) {
  try { return font.ref.widthOfTextAtSize(sanitize(text, font), size); }
  catch (e) { return text.length * size * 0.6; }
}

function wrap(font, text, size, maxWidth) {
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    if (!rawLine) { out.push(''); continue; }
    let line = '';
    for (const ch of rawLine) {
      const test = line + ch;
      if (line && measure(font, test, size) > maxWidth) { out.push(line); line = ch; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

/** 把 .docx 字节转成 PDF 字节 */
export async function docxToPdf(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const index = unzipIndex(data);
  const xmlBytes = await unzipEntry(data, index, 'word/document.xml');
  if (!xmlBytes) throw new Error('word/document.xml not found');
  const blocks = parseDocxDocumentXml(new TextDecoder('utf-8').decode(xmlBytes));
  if (!blocks.length) throw new Error('empty document');

  const pdf = await PDFDocument.create();
  pdf.setTitle('Converted from Word');
  pdf.setProducer('PDFmini');

  let cjk = null;
  try {
    const raw = await loadSystemCjk();
    if (raw) {
      pdf.registerFontkit(fontkit);
      cjk = await pdf.embedFont(raw, { subset: true });
    }
  } catch (e) { cjk = null; }

  const plain = await pdf.embedFont(StandardFonts.Helvetica);
  // 有中文字体时统一用它（涵盖中英文），否则退回 Helvetica 并把非拉丁字符降级
  const bodyFont = { ref: cjk || plain, cjk: !!cjk };
  const titleSize = (lv) => (lv === 1 ? 19 : lv === 2 ? 16 : lv === 3 ? 13.5 : 12);
  const BODY = 10.6;

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const maxW = PAGE_W - MARGIN * 2;

  const newPage = () => { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; };
  const ensure = (h) => { if (y - h < MARGIN) newPage(); };

  const drawLines = (lines, size, indent, lineH, color, bullet) => {
    let first = true;
    for (const line of lines) {
      ensure(lineH);
      if (line) {
        page.drawText(sanitize(line, bodyFont), {
          x: MARGIN + indent, y: y - size, size,
          font: bodyFont.ref, color: color || rgb(0.09, 0.1, 0.11)
        });
      }
      // 项目符号用「画圆点」实现，避免依赖字体里是否存在 U+2022（子集内嵌可能缺失而变成豆腐块）
      if (bullet && first) {
        page.drawCircle({
          x: MARGIN + indent - 9,
          y: y - size * 0.32,
          size: Math.max(1.1, size * 0.15),
          color: color || rgb(0.25, 0.27, 0.3)
        });
      }
      first = false;
      y -= lineH;
    }
  };

  const drawTable = (rows) => {
    const cols = Math.max(...rows.map((r) => r.length));
    const cellPad = 5;
    const size = 9.8;
    const colW = maxW / cols;
    const lineH = size * 1.5;
    for (const row of rows) {
      // 计算该行高度
      const cellLines = [];
      let maxLines = 1;
      for (let c = 0; c < cols; c++) {
        const lines = wrap(bodyFont, row[c] || '', size, colW - cellPad * 2);
        cellLines.push(lines);
        maxLines = Math.max(maxLines, lines.length);
      }
      const rowH = maxLines * lineH + cellPad * 2;
      ensure(rowH);
      const top = y;
      // 单元格文字
      for (let c = 0; c < cols; c++) {
        let cy = top - cellPad - size;
        for (const line of cellLines[c]) {
          if (line) {
            page.drawText(sanitize(line, bodyFont), {
              x: MARGIN + c * colW + cellPad, y: cy, size, font: bodyFont.ref,
              color: rgb(0.09, 0.1, 0.11)
            });
          }
          cy -= lineH;
        }
      }
      // 边框
      const g = rgb(0.72, 0.75, 0.79);
      page.drawRectangle({
        x: MARGIN, y: top - rowH, width: maxW, height: rowH,
        borderColor: g, borderWidth: 0.6
      });
      for (let c = 1; c < cols; c++) {
        page.drawLine({
          start: { x: MARGIN + c * colW, y: top },
          end: { x: MARGIN + c * colW, y: top - rowH },
          thickness: 0.6, color: g
        });
      }
      y = top - rowH;
    }
    y -= 6;
  };

  for (const b of blocks) {
    if (b.type === 'table') { drawTable(b.rows); continue; }
    const lv = b.level || 0;
    const size = lv ? titleSize(lv) : BODY;
    const indent = lv ? 0 : (b.list ? 18 : 0);
    const lineH = size * (lv ? 1.7 : 1.62);
    if (lv) y -= size * 0.5;
    const lines = wrap(bodyFont, b.text || '', size, maxW - indent);
    drawLines(lines, size, indent, lineH, lv ? rgb(0.06, 0.07, 0.08) : undefined, !lv && b.list);
    y -= lv ? size * 0.35 : 3.2;
  }

  return pdf.save();
}
