/**
 * electron-builder afterPack 钩子：
 * 1) 由于本机无法创建符号链接，winCodeSign 解压会失败，
 *    因此关闭 electron-builder 的 exe 资源编辑，改用手工调用 rcedit 写入图标与版本信息。
 * 2) 剔除 Electron 运行时里对本应用无用的文件，减小安装体积（Chromium 许可文本 9.1MB）。
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** 运行时不需要、删除后不影响任何功能的文件 */
const STRIP_FILES = [
  'LICENSES.chromium.html'
];

function stripUnused(appOutDir) {
  for (const name of STRIP_FILES) {
    const p = path.join(appOutDir, name);
    try {
      if (fs.existsSync(p)) {
        const size = fs.statSync(p).size;
        fs.rmSync(p, { force: true });
        console.log(`[after-pack] 已移除 ${name}（${(size / 1048576).toFixed(1)} MB）`);
      }
    } catch (e) {
      console.log(`[after-pack] 移除 ${name} 失败：${e && e.message}`);
    }
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const root = path.join(__dirname, '..');
  stripUnused(context.appOutDir);
  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const rcedit = path.join(root, 'build', 'rcedit-x64.exe');
  const icon = path.join(root, 'build', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.log('[after-pack] 未找到可执行文件：' + exePath);
    return;
  }
  if (!fs.existsSync(rcedit)) {
    console.log('[after-pack] 未找到 rcedit，跳过图标写入');
    return;
  }

  const args = [exePath];
  if (fs.existsSync(icon)) args.push('--set-icon', icon);
  args.push(
    '--set-version-string', 'ProductName', 'PDFmini',
    '--set-version-string', 'FileDescription', 'PDFmini - 轻量 PDF 阅读与编辑',
    '--set-version-string', 'CompanyName', 'PDFmini',
    '--set-version-string', 'LegalCopyright', 'Copyright © 2026 PDFmini',
    '--set-version-string', 'OriginalFilename', exeName,
    '--set-file-version', context.packager.appInfo.version,
    '--set-product-version', context.packager.appInfo.version
  );

  try {
    execFileSync(rcedit, args, { stdio: 'inherit' });
    console.log('[after-pack] 已写入图标与版本信息：' + exeName);
  } catch (e) {
    console.log('[after-pack] rcedit 执行失败：' + (e && e.message));
  }
};
