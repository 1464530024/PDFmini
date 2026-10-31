#!/usr/bin/env node
/**
 * 一次启动跑完整套自检。
 *
 *   npm run smoke                 # 全部用例（默认）
 *   npm run smoke -- sel marquee  # 只跑名字里含 sel / marquee 的用例
 *   npm run smoke -- --list       # 只列出用例清单
 *   SMOKE_EXE=D:/path/PDFmini.exe node scripts/run-smoke.js   # 换成已安装/打包版本来跑
 *
 * 以前每个用例一个命令行开关、跑完就退出，N 个用例要启动 N 次 Electron；
 * 现在把用例拼成一份清单，交给 --smoke-run 在同一个进程里顺序跑完。
 */
const { spawnSync } = require('child_process');
const path = require('path');

// require('electron') 在 Node 里返回 electron 可执行文件路径；
// 直接用它比走 node_modules/.bin/electron.cmd 稳（Windows 上 .cmd 不能直接 spawn）
const E = process.env.SMOKE_EXE || require('electron');
const F = (n) => 'fixtures/' + n;

// 顺序有讲究：整体用例自己造文档，放第一个；其余各自 openPath
const SUITES = [
  'test',
  'sel:' + F('glyphs.pdf'),
  'sel:' + F('longurl.pdf'),
  'sel:' + F('outoforder.pdf'),
  'sel:' + F('text.pdf'),
  'viewcopy:' + F('image.pdf'),
  'nowrap:' + F('text.pdf'),
  'smart:' + F('text.pdf'),
  'smart:' + F('image.pdf'),
  'marquee:' + F('text.pdf'),
  'marquee:' + F('image.pdf'),
  'vector:' + F('vector.pdf'),
  'native:' + F('image.pdf'),
  'erase:' + F('text.pdf'),
  'insert:' + F('text.pdf'),
  'drop:' + F('text.pdf'),
  'link:' + F('text.pdf'),
  'form:' + F('form.pdf'),
  'imgdel:' + F('image.pdf'),
  'docx:' + F('sample.docx')
];

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args.includes('--list')) {
  SUITES.forEach((s) => console.log('  ' + s));
  process.exit(0);
}
const picked = args.length ? SUITES.filter((s) => args.some((k) => s.split(':')[0].includes(k))) : SUITES;
if (!picked.length) {
  console.error('没有匹配的用例，用 --list 看清单');
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;      // 否则 electron 会当 node 跑

console.log(`运行 ${picked.length} 个用例（单进程）…`);
const t0 = Date.now();
const r = spawnSync(E, ['.', '--smoke', '--smoke-run=' + picked.join(',')], {
  cwd: path.join(__dirname, '..'),
  env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
const outText = (r.stdout || '') + (r.stderr || '');
const line = outText.split(/\r?\n/).find((l) => l.indexOf('SMOKE_RESULT ') >= 0);
if (!line) {
  console.error('没有拿到结果（exit=' + r.status + (r.error ? ', ' + r.error.message : '') + '），原始输出：\n' + outText.slice(-4000));
  process.exit(1);
}

let res;
try {
  res = JSON.parse(line.slice(line.indexOf('SMOKE_RESULT ') + 'SMOKE_RESULT '.length));
} catch (e) {
  console.error('结果解析失败：' + line.slice(0, 500));
  process.exit(1);
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)));
for (const s of res.suites) {
  const mark = s.ok ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${pad(s.name, 34)} ${String(s.ms).padStart(6)}ms${s.bad && s.bad.length ? '  ' + JSON.stringify(s.bad) : ''}${s.error ? '  ' + s.error.slice(0, 200) : ''}`);
}
const bad = res.suites.filter((s) => !s.ok).length;
console.log(`\n${res.passed}/${res.total} 通过，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（1 次启动）`);
process.exit(bad ? 1 : 0);
