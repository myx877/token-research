/**
 * 截图局部放大工具:把 PNG 的某个区域裁出来并放大,便于肉眼看清单个字形/颜色。
 * 用法: npx electron scripts/crop-png.js <src.png> <dst.png> <x> <y> <w> <h> [scale]
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const [src, dst, x, y, w, h, scale] = process.argv.slice(2);
const factor = Number(scale) || 4;

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(path.resolve(src));
  if (img.isEmpty()) {
    console.error('无法读取图像: ' + src);
    process.exit(1);
  }
  const size = img.getSize();
  const crop = { x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
  const out = img.crop(crop).resize({
    width: Math.round(crop.width * factor),
    height: Math.round(crop.height * factor),
    quality: 'best'
  });
  fs.writeFileSync(path.resolve(dst), out.toPNG());
  console.log('源尺寸 ' + size.width + 'x' + size.height
    + ' → 裁剪 ' + crop.width + 'x' + crop.height + ' @(' + crop.x + ',' + crop.y + ')'
    + ' → 放大 ' + factor + 'x → ' + path.resolve(dst));
  app.quit();
});
