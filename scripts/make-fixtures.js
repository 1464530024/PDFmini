// 生成自检用测试 PDF（文字 + 图片）
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function main() {
  const outDir = path.join(__dirname, '..', 'fixtures');
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 纯文字 PDF（拉丁 + 数字，StandardFonts 即可）
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage([595.28, 841.89]);
  const lines = [
    'PDFmini Test Document',
    'This is the first line of sample text.',
    'Second line with numbers 12345 and 67890.',
    'The quick brown fox jumps over the lazy dog.',
    'A short line here.',
    'Another paragraph line for block splitting tests.',
    'Contact: hello@example.com  Tel: 010-88886666'
  ];
  let y = 760;
  for (const ln of lines) {
    p1.drawText(ln, { x: 70, y, size: 14, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 30;
  }
  p1.drawText('Heading Section', { x: 70, y, size: 20, font: bold, color: rgb(0.8, 0, 0.17) });
  y -= 40;
  for (let i = 0; i < 6; i++) {
    p1.drawText('Body paragraph line ' + (i + 1) + ' with some filler text.', { x: 70, y, size: 12, font });
    y -= 22;
  }
  // 第二页
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText('Page Two', { x: 70, y: 780, size: 18, font: bold });
  p2.drawText('Second page content line.', { x: 70, y: 740, size: 14, font });
  fs.writeFileSync(path.join(outDir, 'text.pdf'), await doc.save());

  // 2) 文字 + 图片 PDF
  const doc2 = await PDFDocument.create();
  const f2 = await doc2.embedFont(StandardFonts.Helvetica);
  const pg = doc2.addPage([595.28, 841.89]);
  pg.drawText('Image Test Page', { x: 70, y: 780, size: 18, font: f2 });
  pg.drawText('Below is a picture:', { x: 70, y: 750, size: 13, font: f2 });
  // 生成一张 PNG（红块）
  const png = makePng(240, 160, [228, 0, 43]);
  const img = await doc2.embedPng(png);
  pg.drawImage(img, { x: 90, y: 420, width: 240, height: 160 });
  pg.drawText('Text under the image', { x: 70, y: 380, size: 13, font: f2 });
  fs.writeFileSync(path.join(outDir, 'image.pdf'), await doc2.save());

  // 3) 中英混排 PDF（用系统黑体）
  try {
    const { PDFDocument: PD, rgb: rg } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const d3 = await PD.create();
    d3.registerFontkit(fontkit);
    const hei = await d3.embedFont(fs.readFileSync('C:/Windows/Fonts/simhei.ttf'), { subset: true });
    const g = d3.addPage([595.28, 841.89]);
    const zh = ['中文测试文档标题', '这是一段中文正文，用于测试文字编辑功能。', '包含标点，句号。感叹号！问号？', 'English and 中文 mixed line 123.'];
    let yy = 760;
    for (const s of zh) { g.drawText(s, { x: 70, y: yy, size: 16, font: hei, color: rg(0.1, 0.1, 0.1) }); yy -= 34; }
    fs.writeFileSync(path.join(outDir, 'cjk.pdf'), await d3.save());
  } catch (e) {
    console.warn('CJK fixture skipped:', e.message);
  }

  // 4) 带表单域 PDF
  const d4 = await PDFDocument.create();
  const f4 = await d4.embedFont(StandardFonts.Helvetica);
  const pg4 = d4.addPage([595.28, 841.89]);
  pg4.drawText('Form Test', { x: 70, y: 780, size: 18, font: f4 });
  const form = d4.getForm();
  const tf = form.createTextField('fullname');
  tf.setText('');
  tf.addToPage(pg4, { x: 70, y: 700, width: 240, height: 24, font: f4 });
  const cb = form.createCheckBox('agree');
  cb.addToPage(pg4, { x: 70, y: 660, width: 16, height: 16 });
  fs.writeFileSync(path.join(outDir, 'form.pdf'), await d4.save());

  // 5) 简单 Word 文档（.docx）
  fs.writeFileSync(path.join(outDir, 'sample.docx'), makeDocx());

  // 6) 矢量点阵图（模拟二维码）：纯矢量方块，图片算子与文字层都识别不到
  //    —— 用于验证「框选删除必须删干净」
  const d6 = await PDFDocument.create();
  const f6 = await d6.embedFont(StandardFonts.Helvetica);
  const pg6 = d6.addPage([595.28, 841.89]);
  pg6.drawText('Vector pattern page', { x: 60, y: 790, size: 14, font: f6 });
  const ox = 120, oy = 420, cell = 9, gap = 3;
  for (let r = 0; r < 26; r++) {
    for (let c = 0; c < 26; c++) {
      // 伪随机决定该格是否落墨，形成二维码式的点阵
      if (((r * 7 + c * 13) % 5) < 3) continue;
      pg6.drawRectangle({
        x: ox + c * (cell + gap), y: oy - r * (cell + gap),
        width: cell, height: cell, color: rgb(0, 0, 0)
      });
    }
  }
  pg6.drawText('Text below pattern', { x: 60, y: 120, size: 13, font: f6 });
  fs.writeFileSync(path.join(outDir, 'vector.pdf'), await d6.save());

  // 7) 长 URL 混排页（模拟「知识库链接清单」）：一行里中文前缀（黑体）+ 超长 URL（Helvetica）
  //    —— 用于验证文本层选中高亮的对齐/重叠问题
  try {
    const { PDFDocument: PD, rgb: rg } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const d7 = await PD.create();
    d7.registerFontkit(fontkit);
    const hei = await d7.embedFont(fs.readFileSync('C:/Windows/Fonts/simhei.ttf'), { subset: true });
    const helv = await d7.embedFont(StandardFonts.Helvetica);
    const pg = d7.addPage([595.28, 841.89]);
    pg.drawText('一、考研历年真题及解析', { x: 56, y: 780, size: 17, font: hei, color: rg(0.05, 0.05, 0.05) });
    const entries = [
      ['【ima知识库】考研英语历年真题 ', 'https://ima.qq.com/wiki/?shareId=7ffc590035185dec70a7ed1f877500fcd7d288c7b8675e64fe2208a3d9718c87'],
      ['【ima知识库】考研数学历年真题 ', 'https://ima.qq.com/wiki/?shareId=ec52da57272136811975b6e6865e8b487d0a1a9703fcd25e1efde0248180d2'],
      ['【ima知识库】考研政治历年真题 ', 'https://ima.qq.com/wiki/?shareId=d51aaf375b90bba64cdc7f1eae06d8a7d416ddf9eee4c5610bf8e730de9da1ac'],
      ['【ima知识库】考研专业课真题库 ', 'https://ima.qq.com/wiki/?shareId=824b2f866cf94bb23207fce342a81970408d1d943f68b80d35790e2c76d217b1']
    ];
    let ey = 742;
    for (const [label, url] of entries) {
      const lw = hei.widthOfTextAtSize(label, 15);
      pg.drawText(label, { x: 56, y: ey, size: 15, font: hei, color: rg(0.85, 0.1, 0.15) });
      // URL 很长：从中文后面接着写，超出页宽就换到下一行继续
      const maxW = 595.28 - 56 - 46;
      let rest = url;
      let cx = 56 + lw;
      let cy = ey;
      while (rest) {
        const avail = (cx === 56) ? maxW : (595.28 - 46 - cx);
        let n = Math.max(1, Math.floor(avail / helv.widthOfTextAtSize('0', 14)));
        let seg = rest.slice(0, n);
        // 尽量在字符边界切，避免半个字符
        pg.drawText(seg, { x: cx, y: cy, size: 14, font: helv, color: rg(0.05, 0.05, 0.05) });
        rest = rest.slice(seg.length);
        cy -= 30;
        cx = 56;
      }
      ey = cy - 16;
    }
    fs.writeFileSync(path.join(outDir, 'longurl.pdf'), await d7.save());
  } catch (e) {
    console.warn('longurl fixture skipped:', e.message);
  }

  // 8) 逐字成块页：模拟「每个字形一个 Type3 字体」的 PDF —— pdf.js 会为每个字生成一个 span，
  //    选中高亮因此呈阶梯状碎块（用户截图现象）
  try {
    const { PDFDocument: PD, rgb: rg } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const d8 = await PD.create();
    d8.registerFontkit(fontkit);
    const hei = await d8.embedFont(fs.readFileSync('C:/Windows/Fonts/simhei.ttf'), { subset: true });
    const helv = await d8.embedFont(StandardFonts.Helvetica);
    const pg = d8.addPage([595.28, 841.89]);
    const rows = [
      ['【ima知识库】考研英语历年真题 ', 'https://ima.qq.com/wiki/?shareId=7ffc590035185dec70a7ed1'],
      ['【ima知识库】考研数学历年真题 ', 'https://ima.qq.com/wiki/?shareId=ec52da5727213681197'],
      ['【ima知识库】考研政治历年真题 ', 'https://ima.qq.com/wiki/?shareId=d51aaf375b90bba64cd'],
      ['【ima知识库】考研专业课真题库 ', 'https://ima.qq.com/wiki/?shareId=824b2f866cf94bb232']
    ];
    let ry = 760;
    for (const [label, url] of rows) {
      let cx = 56;
      for (const ch of Array.from(label)) {
        pg.drawText(ch, { x: cx, y: ry, size: 15, font: hei, color: rg(0.85, 0.1, 0.15) });
        cx += 15;
      }
      for (const ch of Array.from(url)) {
        pg.drawText(ch, { x: cx, y: ry, size: 14, font: helv, color: rg(0.05, 0.05, 0.05) });
        cx += helv.widthOfTextAtSize(ch, 14);
        if (cx > 540) break;
      }
      ry -= 34;
    }
    fs.writeFileSync(path.join(outDir, 'glyphs.pdf'), await d8.save());
  } catch (e) {
    console.warn('glyphs fixture skipped:', e.message);
  }

  // 9) 乱序内容流：行按「自下而上」绘制 —— 文本层 DOM 顺序与视觉顺序相反，
  //    用于验证「拖选跳行」被修复（viewer 会把 span 重排成视觉顺序）
  try {
    const { PDFDocument: PD, rgb: rg } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const d9 = await PD.create();
    d9.registerFontkit(fontkit);
    const hei = await d9.embedFont(fs.readFileSync('C:/Windows/Fonts/simhei.ttf'), { subset: true });
    const helv = await d9.embedFont(StandardFonts.Helvetica);
    const pg = d9.addPage([595.28, 841.89]);
    const rows9 = [
      ['【ima知识库】考研英语历年真题 ', 'https://ima.qq.com/wiki/?shareId=7ffc590035185dec70a7ed1'],
      ['【ima知识库】考研数学历年真题 ', 'https://ima.qq.com/wiki/?shareId=ec52da5727213681197'],
      ['【ima知识库】考研政治历年真题 ', 'https://ima.qq.com/wiki/?shareId=d51aaf375b90bba64cd'],
      ['【ima知识库】考研专业课真题库 ', 'https://ima.qq.com/wiki/?shareId=824b2f866cf94bb232']
    ];
    // ⚠️ 从最后一行往上画：内容流顺序 = 视觉顺序的倒序
    for (let r = rows9.length - 1; r >= 0; r--) {
      const y = 700 - r * 34;
      const [label, url] = rows9[r];
      let cx = 56;
      for (const ch of Array.from(label)) {
        pg.drawText(ch, { x: cx, y, size: 15, font: hei, color: rg(0.85, 0.1, 0.15) });
        cx += 15;
      }
      for (const ch of Array.from(url)) {
        pg.drawText(ch, { x: cx, y, size: 14, font: helv, color: rg(0.05, 0.05, 0.05) });
        cx += helv.widthOfTextAtSize(ch, 14);
        if (cx > 540) break;
      }
    }
    fs.writeFileSync(path.join(outDir, 'outoforder.pdf'), await d9.save());
  } catch (e) {
    console.warn('outoforder fixture skipped:', e.message);
  }

  console.log('fixtures ready at ' + outDir);
}

/** 生成一个最小但合法的 .docx（含标题/正文/表格） */
function makeDocx() {
  const zlib = require('zlib');
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Word 转 PDF 测试文档</w:t></w:r></w:p>
<w:p><w:r><w:t>总体说明</w:t></w:r></w:p>
<w:p><w:r><w:t>这是第一段正文，用于验证 Word 转 PDF 的中文渲染。</w:t></w:r></w:p>
<w:p><w:r><w:t>Second paragraph in English for layout testing.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>中文渲染</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>通过</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>English</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>OK</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`
  };
  const chunks = [];
  const central = [];
  let offset = 0;
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const name of Object.keys(files)) {
    const data = Buffer.from(files[name], 'utf8');
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// 最小 PNG 编码器（纯色 RGB）
function makePng(w, h, [r, g, b]) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; }
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

main().catch((e) => { console.error(e); process.exit(1); });
