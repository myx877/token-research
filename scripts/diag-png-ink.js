// 落盘 PNG 的客观像素证据(不依赖任何模型的图像输入能力):
// 每张图输出尺寸/明暗比/中部墨比 + 品牌色命中(点位证明"画的是谁的颜色")。
// 用法:npx electron scripts/diag-png-ink.js <png...>
const { nativeImage } = require('electron');
const fs = require('node:fs');

const ACCENTS = {
  deepseek: [0x6E, 0x94, 0xF5],
  codex: [0xF2, 0xA0, 0x5C],
  kimi: [0x4E, 0xCB, 0x94],
  dsh: [0xA7, 0x8B, 0xFA],
  claude: [0xE8, 0x86, 0x5A],
  opencode: [0x5B, 0xC8, 0xD8]
};
const SUCCESS = [0x22, 0xC5, 0x5E];

function analyze(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return { file, empty: true };
  const size = img.getSize();
  const buf = img.toBitmap();
  const ch = buf.length / (size.width * size.height);
  let dark = 0, count = 0, green = 0;
  const hits = {};
  Object.keys(ACCENTS).forEach((k) => { hits[k] = 0; });
  const y0 = Math.floor(size.height * 0.15);
  const y1 = Math.floor(size.height * 0.9);
  let bandInk = 0, bandCount = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const i = (y * size.width + x) * ch;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      count += 1;
      if (luma < 96) dark += 1;
      if (y >= y0 && y < y1) {
        bandCount += 1;
        if (luma < 200) bandInk += 1;
      }
      Object.keys(ACCENTS).forEach((k) => {
        const a = ACCENTS[k];
        if (Math.abs(r - a[0]) + Math.abs(g - a[1]) + Math.abs(b - a[2]) < 90) hits[k] += 1;
      });
      if (Math.abs(r - SUCCESS[0]) + Math.abs(g - SUCCESS[1]) + Math.abs(b - SUCCESS[2]) < 120) green += 1;
    }
  }
  return {
    file: file.split(/[/\\]/).pop(),
    size: size.width + 'x' + size.height,
    darkRatio: +(dark / count).toFixed(3),
    bandInkRatio: +(bandInk / bandCount).toFixed(3),
    greenPx: green,
    accents: Object.fromEntries(Object.entries(hits).filter(([, v]) => v > 0))
  };
}

(async () => {
  const files = process.argv.slice(2).filter((f) => fs.existsSync(f));
  if (!files.length) { console.error('no files'); process.exit(1); }
  files.forEach((f) => console.log(JSON.stringify(analyze(f))));
  require('electron').app.quit();
})();
