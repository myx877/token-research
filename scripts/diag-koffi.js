// 临时诊断:最小复现 windows-backdrop 的 koffi 绑定,逐步打点定位崩在哪一句。
// 用法: node scripts/diag-koffi.js   或   npx electron scripts/diag-koffi.js
const fs = require('node:fs');
const path = require('node:path');

const LOG = path.resolve(__dirname, '..', '.diag-koffi.log');
fs.writeFileSync(LOG, '');
const log = (m) => { fs.appendFileSync(LOG, m + '\n'); process.stderr.write(m + '\n'); };
process.on('exit', (c) => log('[process.exit] code=' + c));

log('[env] ' + (process.versions.electron ? 'electron=' + process.versions.electron : 'node') + ' node=' + process.versions.node + ' abi=' + process.versions.modules);
log('[env] arch=' + process.arch + ' platform=' + process.platform);

const koffi = require('koffi');
log('[1] require koffi 完成,版本=' + (koffi.version || '?'));

const user32 = koffi.load('user32.dll');
log('[2] koffi.load user32.dll 完成');
const dwmapi = koffi.load('dwmapi.dll');
log('[3] koffi.load dwmapi.dll 完成');
const gdi32 = koffi.load('gdi32.dll');
log('[4] koffi.load gdi32.dll 完成');

const ACCENT_POLICY = koffi.struct('DSM_ACCENT_POLICY', {
  AccentState: 'int32_t',
  AccentFlags: 'int32_t',
  GradientColor: 'uint32_t',
  AnimationId: 'int32_t'
});
log('[5] struct DSM_ACCENT_POLICY 完成, sizeof=' + koffi.sizeof(ACCENT_POLICY));

koffi.struct('DSM_WCA_DATA', { Attrib: 'uint32_t', pvData: 'void *', cbData: 'size_t' });
log('[6] struct DSM_WCA_DATA 完成');
koffi.struct('DSM_DWM_BLURBEHIND', { dwFlags: 'uint32_t', fEnable: 'int32_t', hRgnBlur: 'void *', fTransitionOnMaximized: 'int32_t' });
log('[7] struct DSM_DWM_BLURBEHIND 完成');
koffi.struct('DSM_MARGINS', { cxLeftWidth: 'int32_t', cxRightWidth: 'int32_t', cyTopHeight: 'int32_t', cyBottomHeight: 'int32_t' });
log('[8] struct DSM_MARGINS 完成');

const SetWindowCompositionAttribute = user32.func('bool SetWindowCompositionAttribute(uintptr_t hwnd, const DSM_WCA_DATA *data)');
log('[9] func SetWindowCompositionAttribute 绑定完成');
const DwmEnableBlurBehindWindow = dwmapi.func('long DwmEnableBlurBehindWindow(uintptr_t hwnd, const DSM_DWM_BLURBEHIND *blurBehind)');
log('[10] func DwmEnableBlurBehindWindow 绑定完成');
const CreateRectRgn = gdi32.func('void *CreateRectRgn(int left, int top, int right, int bottom)');
log('[11] func CreateRectRgn 绑定完成');
const DeleteObject = gdi32.func('bool DeleteObject(void *object)');
log('[12] func DeleteObject 绑定完成');

const region = CreateRectRgn(0, 0, -1, -1);
log('[13] 调用 CreateRectRgn 完成, region=' + String(region));
const ok = DeleteObject(region);
log('[14] 调用 DeleteObject 完成, ok=' + String(ok));
log('[结果] koffi 绑定链路全部走通,没有崩');
