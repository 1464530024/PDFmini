/**
 * 构建脚本：用 esbuild 打包渲染进程代码，并复制 pdf.js worker。
 * 输出目录：src/renderer/dist/
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'dist');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyWorker() {
  // 必须与主库同源（legacy/build），worker 与主库 API 版本需一致
  const candidates = [
    'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js',
    'node_modules/pdfjs-dist/legacy/build/pdf.worker.js'
  ];
  const src = candidates.map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
  if (!src) throw new Error('未找到 pdf.js worker 文件，请确认 pdfjs-dist 已安装');
  const dest = path.join(OUT_DIR, 'pdf.worker.js');
  fs.copyFileSync(src, dest);
  console.log('[build] worker ->', path.relative(ROOT, dest));
}

// 复制 CMap 与标准字体，保证部分 PDF（CJK 编码/内置字体缺失）正常渲染
function copyDir(relSrc, relDest, filter) {
  const src = path.join(ROOT, relSrc);
  if (!fs.existsSync(src)) return;
  const dest = path.join(OUT_DIR, relDest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (filter && !filter(f)) continue;
    const s = path.join(src, f);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, path.join(dest, f));
      n++;
    }
  }
  console.log(`[build] ${relSrc} -> dist/${relDest} (${n} files)`);
}

function copyPdfAssets() {
  copyDir('node_modules/pdfjs-dist/cmaps', 'cmaps', (f) => f.endsWith('.bcmap'));
  copyDir('node_modules/pdfjs-dist/standard_fonts', 'standard_fonts', (f) => f.endsWith('.pfb') || f.endsWith('.ttf') || f.endsWith('.otf'));
}

async function main() {
  ensureDir(OUT_DIR);
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'renderer', 'js', 'app.js')],
    bundle: true,
    outfile: path.join(OUT_DIR, 'bundle.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome110'],
    sourcemap: process.env.PDFMINI_DEBUG ? 'inline' : false,
    minify: !process.env.PDFMINI_DEBUG,
    legalComments: 'none',
    // 默认 charset='ascii' 会把所有中文转成 \uXXXX（每个汉字 6 字节），
    // 本应用文案以中文为主，改用 utf8 直接保留原字符可显著减小体积
    charset: 'utf8',
    logLevel: 'info',
    loader: { '.ttf': 'file' }
  });
  copyWorker();
  copyPdfAssets();
  console.log('[build] 完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
