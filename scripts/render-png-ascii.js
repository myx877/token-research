/**
 * 把已落盘 PNG 降采样成 ASCII 灰度图 + 平台色点标记,供无法直读图像的模型做结构级目视复核。
 * 价值:能看出"卡片是否真的画出来了/表格行列是否对齐/有没有大片空白或重叠/深浅色主题"。
 *
 * 用法: npx electron scripts/render-png-ascii.js <png路径> [列数] [行数] [起始y比例] [结束y比例]
 * 例:  npx electron scripts/render-png-ascii.js docs/verification/usage-summary/electron-day-light.png 150 60
 */
const fs = require('node:fs');
const path = require('node:path');

const RAMP = ' .:-=+*#%@';
// 平台色点(renderer/src/lib/providers-meta.js 同一组色)
const ACCENTS = [
  { ch: 'D', rgb: [0x6E, 0x94, 0xF5] },
  { ch: 'C', rgb: [0xF2, 0xA0, 0x5C] },
  { ch: 'O', rgb: [0x5B, 0xC8, 0xD8] }
];

function main() {
  const { app, nativeImage } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(() => {
    const args = process.argv.slice(process.versions.electron ? 2 : 2).filter((a) => !a.startsWith('-'));
    const file = path.resolve(args[0]);
    const cols = Number(args[1]) || 150;
    const rows = Number(args[2]) || 60;
    const fromRatio = args[3] === undefined ? 0 : Number(args[3]);
    const toRatio = args[4] === undefined ? 1 : Number(args[4]);

    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    const buf = img.toBitmap ? img.toBitmap() : img.getBitmap();
    const yStart = Math.floor(size.height * fromRatio);
    const yEnd = Math.min(size.height, Math.floor(size.height * toRatio));
    const bw = size.width / cols;
    const bh = (yEnd - yStart) / rows;

    console.log('# ' + path.basename(file) + '  ' + size.width + 'x' + size.height
      + '  → ASCII ' + cols + 'x' + rows + (fromRatio || toRatio < 1 ? ' (y ' + fromRatio + '~' + toRatio + ')' : ''));
    console.log('#' + '-'.repeat(cols));
    for (let r = 0; r < rows; r += 1) {
      let line = '';
      for (let c = 0; c < cols; c += 1) {
        const x0 = Math.floor(c * bw);
        const x1 = Math.max(x0 + 1, Math.floor((c + 1) * bw));
        const ya = yStart + Math.floor(r * bh);
        const yb = Math.max(ya + 1, yStart + Math.floor((r + 1) * bh));
        let sum = 0, n = 0, accent = null, accentHits = 0;
        for (let y = ya; y < yb; y += 1) {
          for (let x = x0; x < x1; x += 1) {
            const i = (y * size.width + x) * 4;
            const p = [buf[i], buf[i + 1], buf[i + 2]];
            const q = [p[2], p[1], p[0]];
            sum += Math.max(
              0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2],
              0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]
            );
            n += 1;
            for (const a of ACCENTS) {
              const d = Math.min(
                Math.abs(p[0] - a.rgb[0]) + Math.abs(p[1] - a.rgb[1]) + Math.abs(p[2] - a.rgb[2]),
                Math.abs(q[0] - a.rgb[0]) + Math.abs(q[1] - a.rgb[1]) + Math.abs(q[2] - a.rgb[2])
              );
              if (d < 90) {
                accent = a;
                accentHits += 1;
              }
            }
          }
        }
        const luma = sum / n;
        // 色点像素占比高时优先显示平台字母,便于定位列
        if (accent && accentHits / n > 0.25) line += accent.ch;
        else line += RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.round(((255 - luma) / 255) * (RAMP.length - 1))))];
      }
      console.log('|' + line + '|  y' + Math.round(yStart + r * bh));
    }
    console.log('#' + '-'.repeat(cols));
    console.log('图例: 空=白/亮底  @#*=+:-=暗墨; D=DeepSeek蓝 C=Codex橙 O=opencode青(平台色点)');
    console.log('文件: ' + file + ' (' + fs.statSync(file).size + ' bytes)');
    app.quit();
  }).catch((e) => {
    console.error(String(e && e.stack ? e.stack : e));
    process.exitCode = 1;
    app.quit();
  });
}

main();
