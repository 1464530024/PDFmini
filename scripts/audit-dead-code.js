/**
 * 冗余代码审计（开发工具，不参与打包）
 * 1) 找出「导出但从未被其它模块引用」的符号
 * 2) 找出 i18n 字典里「没有任何文件引用」的中文 key
 * 3) 找出 CSS 里「HTML/JS 中都不出现」的类选择器
 * 用法：node scripts/audit-dead-code.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'src', 'renderer', 'js');
const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
const src = {};
for (const f of files) src[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
const allJs = Object.values(src).join('\n');

function wordCount(name, hay) {
  const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b', 'g');
  return (hay.match(re) || []).length;
}

/* ---------- 1) 未被引用的导出 ---------- */
const exportsFound = [];
for (const f of files) {
  const body = src[f];
  const re1 = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re1.exec(body))) exportsFound.push([f, m[1]]);
  const re2 = /^export\s*\{([^}]*)\}/gm;
  while ((m = re2.exec(body))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) exportsFound.push([f, name]);
    }
  }
}
const unusedExports = [];
for (const [f, n] of exportsFound) {
  if (wordCount(n, allJs) <= 1 && wordCount(n, fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8')) === 0) {
    unusedExports.push([f, n]);
  }
}

/* ---------- 2) 未被引用的 i18n key ---------- */
const i18nBody = src['i18n.js'];
const enKeys = [];
{
  const re = /^\s*'([^']+)':/gm;
  let m;
  while ((m = re.exec(i18nBody))) enKeys.push(m[1]);
}
const otherJs = files.filter((f) => f !== 'i18n.js').map((f) => src[f]).join('\n');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'style.css'), 'utf8');
const unusedKeys = [];
const seen = new Set();
for (const k of enKeys) {
  if (seen.has(k)) { unusedKeys.push([k, 'DUP']); continue; }
  seen.add(k);
  if (otherJs.includes("'" + k + "'") || otherJs.includes('"' + k + '"')) continue;
  if (html.includes(k) || css.includes(k)) continue;
  unusedKeys.push([k, 'unused']);
}

/* ---------- 3) CSS 选择器引用情况 ---------- */
const cssClasses = new Set();
{
  const re = /\.(-?[_a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(css))) cssClasses.add(m[1]);
}
const unusedCss = [];
for (const c of cssClasses) {
  if (allJs.includes(c) || html.includes(c)) continue;
  unusedCss.push(c);
}

/* ---------- 4) 图标：定义但从未被引用的 ---------- */
const iconsBody = src['icons.js'];
const iconNames = [];
{
  const re = /^\s{2}([A-Za-z][\w]*):\s*'</gm;
  let m;
  while ((m = re.exec(iconsBody))) iconNames.push(m[1]);
}
const jsNoIcons = files.filter((f) => f !== 'icons.js').map((f) => src[f]).join('\n');
const unusedIcons = iconNames.filter((n) => !jsNoIcons.includes("'" + n + "'"));
const defaultExportUsed = /import\s+P\s+from|import\s+\w+\s+from\s+'\.\/icons\.js'/.test(allJs);

/* ---------- 5) 连续重复行（同一文件里内容完全相同的相邻语句块） ---------- */
function dupLines(name, body) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1].trim();
    const b = lines[i].trim();
    if (a && a === b && a.length > 8) out.push([i + 1, a.slice(0, 70)]);
  }
  return out;
}

/* ---------- 输出 ---------- */
console.log('=== 导出总数 / 未被引用 ===');
console.log('  exports:', exportsFound.length, ' unused:', unusedExports.length);
unusedExports.forEach((u) => console.log('    ' + u[0] + '  ->  ' + u[1]));
console.log('\n=== i18n key 总数 / 未被引用或重复 ===');
console.log('  keys:', enKeys.length, ' unused/dup:', unusedKeys.length);
unusedKeys.forEach((u) => console.log('    [' + u[1] + '] ' + u[0]));
console.log('\n=== CSS 类名总数 / 未被引用 ===');
console.log('  classes:', cssClasses.size, ' unused:', unusedCss.length);
console.log('    ' + unusedCss.join(', '));

console.log('\n=== 图标总数 / 未被引用 ===');
console.log('  icons:', iconNames.length, ' unused:', unusedIcons.length, ' default-export-used:', defaultExportUsed);
console.log('    ' + unusedIcons.join(', '));

console.log('\n=== 相邻重复行 ===');
for (const f of files) {
  const d = dupLines(f, src[f]);
  if (d.length) { console.log('  ' + f); d.forEach((x) => console.log('    L' + x[0] + '  ' + x[1])); }
}
