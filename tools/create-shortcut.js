'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

function createBaseShortcut(destPath) {
  const rootDir = path.resolve(__dirname, '..');
  const targetScript = path.join(rootDir, '后台启动(无黑框).vbs');
  const iconPath = path.join(rootDir, 'resources', 'brand', 'unidownload.ico');

  const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${destPath.replace(/'/g, "''")}')
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"${targetScript.replace(/'/g, "''")}"'
$sc.WorkingDirectory = '${rootDir.replace(/'/g, "''")}'
$sc.IconLocation = '${iconPath.replace(/'/g, "''")}'
$sc.Description = 'Unidownload 多网盘直链下载'
$sc.Save()
`;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  try {
    execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'ignore' });
    return fs.existsSync(destPath);
  } catch {
    return false;
  }
}

function main() {
  const home = process.env.USERPROFILE || 'C:\\Users\\ASUS';
  const baseLnk = path.join(home, 'Desktop', 'Unidownload.lnk');
  
  if (!createBaseShortcut(baseLnk)) {
    console.error('未能直接生成快捷方式，请使用项目根目录下的「启动.bat」。');
    return;
  }
  console.log('[OK] 成功生成桌面快捷方式: ' + baseLnk);

  // Sync to all OneDrive desktop sync folders if any
  try {
    for (const item of fs.readdirSync(home)) {
      if (item.startsWith('OneDrive')) {
        const desktopDir = path.join(home, item, 'Desktop');
        if (fs.existsSync(desktopDir)) {
          const targetLnk = path.join(desktopDir, 'Unidownload.lnk');
          fs.copyFileSync(baseLnk, targetLnk);
          console.log('[OK] 已同步至桌面: ' + targetLnk);
        }
      }
    }
  } catch {
    // ignore sync errors
  }
}

main();
