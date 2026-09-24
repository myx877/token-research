// 一次性诊断:在指定矩形里定位"接近某颜色"的像素分布,判断是成片图元还是字形边缘彩边。
// 用法:npx electron scripts/diag-color-scan.js <png> <x> <y> <w> <h> <r> <g> <b> <tol>
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const [file, x, y, w, h, r, g, b, tol] = process.argv.slice(2);
  const target = [Number(r), Number(g), Number(b)];
  const tolerance = Number(tol);
  const img = nativeImage.createFromPath(file).crop({
    x: Number(x), y: Number(y), width: Number(w), height: Number(h)
  });
  const size = img.getSize();
  const buf = img.toBitmap();
  let hits = 0;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  const rows = new Map();
  let sample = null;
  let best = 1e9;
  for (let py = 0; py < size.height; py += 1) {
    for (let px = 0; px < size.width; px += 1) {
      const i = (py * size.width + px) * 4;
      const c1 = [buf[i], buf[i + 1], buf[i + 2]];
      const c2 = [c1[2], c1[1], c1[0]];
      const d1 = Math.abs(c1[0] - target[0]) + Math.abs(c1[1] - target[1]) + Math.abs(c1[2] - target[2]);
      const d2 = Math.abs(c2[0] - target[0]) + Math.abs(c2[1] - target[1]) + Math.abs(c2[2] - target[2]);
      const d = Math.min(d1, d2);
      if (d < best) { best = d; sample = c1; }
      if (d < tolerance) {
        hits += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        rows.set(py, (rows.get(py) || 0) + 1);
      }
    }
  }
  console.log('裁剪尺寸 ' + size.width + 'x' + size.height + ' 目标色 rgb(' + target.join(',') + ') 容差 ' + tolerance);
  console.log('命中 ' + hits + ' 像素;包围盒 x[' + minX + '..' + maxX + '] y[' + minY + '..' + maxY + ']');
  console.log('最接近目标的像素 rgb(' + (sample || []).join(',') + ') 距离 ' + best);
  const ys = Array.from(rows.keys()).sort((a1, b1) => a1 - b1);
  console.log('按行命中(前 40 行,行号:命中数):');
  console.log(ys.slice(0, 40).map((k) => k + ':' + rows.get(k)).join(' '));
  console.log('命中的行数 ' + ys.length + '(散布在多少行 → 成片图元会集中在极少行,字形彩边会散布很多行)');
  app.quit();
});
