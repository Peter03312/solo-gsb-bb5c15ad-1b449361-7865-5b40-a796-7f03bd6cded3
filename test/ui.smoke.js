/*
 * 前端冒烟测试：node test/ui.smoke.js
 * 用最小 DOM/Canvas 桩在 Node 中执行 app.js，模拟完整用户流程：
 * 载入示例 → 成对点击 4 对控制点 → 拟合成功 → 导出矩阵/残差/校准扫描图 PNG →
 * 右键删点 → 清空 → 共线点被拒绝 → 透明度滑杆 →
 * 稳健模式：共线仍拒绝 → 外点剔除与导出身份 → 拖动外点归位 →
 * 容差调整（含非法值）→ 关闭稳健模式回到经典最小二乘 →
 * 差异区域视图：注入「左黑右白」像素模式检出差异区域，阈值/最小面积调整、
 * 非法参数与条件失效时清空并说明原因。
 * 「导出校准扫描图」按钮随重算结果启用/禁用并说明原因，导出 PNG 走本地
 * transformRGBA 像素变换。同时校验 app.js 引用的所有 DOM id 都存在于 index.html。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------- 浏览器环境桩 ----------
const requestedIds = new Set();
const els = {};

// 可注入的像素模式：(x, y) => [r, g, b, a]；null 时返回不透明黑
let pixelPattern = null;

function makeCtx() {
  return new Proxy({}, {
    get: (t, k) => {
      // 导出校准扫描图 / 差异区域需要读取源像素：返回长度正确的 RGBA 缓冲
      if (k === 'getImageData') {
        return (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
              const o = (j * w + i) * 4;
              const px = pixelPattern ? pixelPattern(x + i, y + j) : [0, 0, 0, 255];
              data[o] = px[0];
              data[o + 1] = px[1];
              data[o + 2] = px[2];
              data[o + 3] = px[3];
            }
          }
          return { data, width: w, height: h };
        };
      }
      return () => {};
    },
    set: () => true
  });
}

function makeEl(tag) {
  return {
    tag,
    listeners: {},
    _q: {},
    className: '', textContent: '', innerHTML: '', value: '0.5',
    checked: false, disabled: false, files: [], dataset: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    querySelector(sel) { return this._q[sel] || (this._q[sel] = makeEl(sel)); },
    closest() { return null; },
    click() {}, remove() {}, appendChild() {}, setAttribute() {}
  };
}

function makeCanvas() {
  const el = makeEl('canvas');
  el.width = 300; el.height = 150;
  el.getContext = () => makeCtx();
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: el.width, height: el.height });
  el.toDataURL = () => 'data:image/png;base64,xxxx';
  el.toBlob = (cb) => cb(new Blob(['fake-png'], { type: 'image/png' }));
  return el;
}

const winListeners = {};
global.window = { addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); } };
const fireWindow = (type, ev) => (winListeners[type] || []).forEach((fn) => fn(ev));
global.document = {
  getElementById(id) {
    requestedIds.add(id);
    if (!els[id]) els[id] = id.endsWith('Canvas') ? makeCanvas() : makeEl(id);
    return els[id];
  },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl(tag); },
  body: { appendChild() {} }
};
global.Affine = require('../public/js/affine.js');
global.Image = class {
  constructor() { this.naturalWidth = 960; this.naturalHeight = 640; this.onload = null; }
  set src(v) { setImmediate(() => this.onload && this.onload()); }
};
global.ImageData = class {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      // new ImageData(width, height)：空白 RGBA 缓冲
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c;
    }
  }
};
global.FileReader = class {
  readAsDataURL() { this.result = 'data:image/png;base64,xxxx'; setImmediate(() => this.onload && this.onload()); }
};
const blobs = [];
global.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:fake'; };
global.URL.revokeObjectURL = () => {};

// ---------- 加载前端 ----------
require('../public/js/app.js');

// ---------- 工具 ----------
const fire = (el, type, ev = {}) => (el.listeners[type] || []).forEach((fn) => fn(ev));
const clickCanvas = (canvas, x, y) =>
  fire(canvas, 'mousedown', { button: 0, clientX: x, clientY: y, preventDefault() {} });
const tick = () => new Promise((r) => setImmediate(r));
const rowCount = () => (els.ptTable.querySelector('tbody').innerHTML.match(/<tr/g) || []).length;
const tbodyDiff = () => els.diffTable.querySelector('tbody').innerHTML;

(async () => {
  // 0. app.js 引用的 id 必须都存在于 index.html
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const id of requestedIds) {
    assert.ok(htmlIds.has(id), `app.js 引用了 index.html 中不存在的 id: ${id}`);
  }
  assert.ok(els.status.textContent.includes('请上传参考图与扫描图'));
  // 导出校准扫描图：图像缺失时禁用并说明原因
  assert.strictEqual(els.btnExportImage.disabled, true);
  assert.ok(els.exportImgHint.textContent.includes('图像缺失'), '应说明图像缺失: ' + els.exportImgHint.textContent);
  // 差异区域：图像缺失时不可用并说明原因，旧标记（表格/摘要）为空
  assert.ok(els.diffHint.textContent.includes('差异区域不可用'), '差异区域初始应不可用: ' + els.diffHint.textContent);
  assert.ok(els.diffHint.textContent.includes('图像缺失'), '应说明图像缺失: ' + els.diffHint.textContent);
  assert.strictEqual(els.diffTable.querySelector('tbody').innerHTML, '');
  assert.strictEqual(els.diffSummary.textContent, '');
  console.log('✓ 初始渲染正常，DOM id 与 index.html 一致（导出校准扫描图禁用并说明原因，差异区域不可用）');

  // 1. 载入示例图像
  fire(els.btnSample, 'click');
  await tick(); await tick();
  assert.strictEqual(els.refCanvas.width, 960);
  assert.strictEqual(els.scanCanvas.width, 640 > 0 ? 960 : 0); // 两图同尺寸
  assert.ok(els.status.textContent.includes('至少还需 3 对'));
  // 拟合无效（控制点不足）：导出校准扫描图仍禁用并说明原因
  assert.strictEqual(els.btnExportImage.disabled, true);
  assert.ok(els.exportImgHint.textContent.includes('拟合无效'), '应说明拟合无效: ' + els.exportImgHint.textContent);
  console.log('✓ 示例图像载入，提示需要 3 对控制点');

  // 2. 成对点击 4 对控制点（scan = M·ref，M 为示例图像的生成矩阵）
  const M = { a: 0.9962, b: -0.0105, c: 17.5, d: 0.0119, e: 0.9974, f: -11.2 };
  const refPts = [[90, 90], [870, 110], [120, 540], [830, 550]];
  const scanPt = ([x, y]) => [M.a * x + M.b * y + M.c, M.d * x + M.e * y + M.f];
  for (const rp of refPts) {
    clickCanvas(els.refCanvas, rp[0], rp[1]);
    const sp = scanPt(rp);
    clickCanvas(els.scanCanvas, sp[0], sp[1]);
  }
  assert.ok(els.status.textContent.includes('拟合成功'), '状态应显示拟合成功: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('RMSE'));
  assert.ok(els.fitPanel.innerHTML.includes('u = a·x + b·y + c'));
  assert.strictEqual(rowCount(), 4);
  assert.strictEqual(els.btnExportMatrix.disabled, false);
  // 留出验证：4 个精确点全部可验证，表格无「无法验证/不参与」
  const tbodyHtml = () => els.ptTable.querySelector('tbody').innerHTML;
  assert.ok(els.status.textContent.includes('留出验证 RMSE'), '状态栏应含留出验证汇总: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('4 点可验证'));
  assert.ok(els.fitPanel.innerHTML.includes('验证 RMSE'), '拟合面板应含留出验证小结');
  assert.ok(!tbodyHtml().includes('无法验证') && !tbodyHtml().includes('不参与'));
  // 差异区域：拟合有效后可用；桩像素为均匀不透明黑 → 无差异
  assert.strictEqual(els.diffHint.textContent, '', '差异区域可用时不应显示原因');
  assert.ok(els.diffSummary.textContent.includes('差异像素 0'), '默认像素应无差异: ' + els.diffSummary.textContent);
  assert.ok(els.diffSummary.textContent.includes('差异区域 0 个'), '应无差异区域: ' + els.diffSummary.textContent);
  assert.ok(tbodyDiff().includes('未发现差异区域'), '差异表格应显示未发现差异区域');
  console.log('✓ 4 对点拟合成功，矩阵面板与残差表渲染（含留出验证列与汇总），差异区域视图可用');

  // 2.5 导出校准扫描图 PNG：拟合成功后按钮启用，点击走本地像素变换并下载
  assert.strictEqual(els.btnExportImage.disabled, false, '拟合成功后导出校准扫描图应启用');
  assert.strictEqual(els.exportImgHint.textContent, '', '可用时不应显示禁用原因');
  const pngBlobs = blobs.length;
  fire(els.btnExportImage, 'click');
  assert.strictEqual(blobs.length, pngBlobs + 1, '应生成一个 PNG 下载');
  assert.strictEqual(blobs[blobs.length - 1].type, 'image/png');
  assert.ok(els.status.textContent.includes('已导出校准扫描图'), '状态应确认导出: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('960×640'), 'PNG 尺寸应与参考图原始宽高一致: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('经典最小二乘'));
  console.log('✓ 导出校准扫描图 PNG（与参考图同尺寸，仅含变换后扫描图，经典模式）');

  // 3. 导出矩阵 JSON，并验证其逆映射精度
  fire(els.btnExportMatrix, 'click');
  const mj = JSON.parse(await blobs[blobs.length - 1].text());
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(Number.isFinite(mj.matrix[k]));
  assert.deepStrictEqual(mj.matrixRowMajor[2], [0, 0, 1]);
  const sp0 = scanPt(refPts[0]);
  const bx = mj.matrix.a * sp0[0] + mj.matrix.b * sp0[1] + mj.matrix.c;
  const by = mj.matrix.d * sp0[0] + mj.matrix.e * sp0[1] + mj.matrix.f;
  assert.ok(Math.hypot(bx - refPts[0][0], by - refPts[0][1]) < 1e-6, '导出矩阵应精确反映扫描→参考映射');
  assert.strictEqual(mj.looValidation.verifiableCount, 4, '矩阵导出也应带留出验证汇总');
  console.log('✓ 导出矩阵 JSON 正确（六参数 + 行主序矩阵 + 留出验证汇总）');

  // 4. 导出残差 JSON
  fire(els.btnExportResiduals, 'click');
  const rj = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(rj.points.length, 4);
  assert.strictEqual(rj.points.filter((p) => p.isMaxResidual).length, 1);
  assert.ok(Number.isFinite(rj.rmse));
  // 留出验证导出：4 点可验证，逐点 looStatus/looErrorPx 齐全
  assert.strictEqual(rj.looValidation.verifiableCount, 4);
  assert.strictEqual(rj.looValidation.participantCount, 4);
  assert.ok(Number.isFinite(rj.looValidation.rmse));
  assert.ok(Number.isFinite(rj.looValidation.maxIndex));
  assert.ok(rj.points.every((p) => p.looStatus === 'ok' && Number.isFinite(p.looErrorPx)));
  console.log('✓ 导出残差 JSON 正确（唯一最大残差点标记 + 逐点留出验证）');

  // 5. 右键删除一个点 → 立即重算，剩 3 行
  fire(els.refCanvas, 'contextmenu', { clientX: refPts[0][0], clientY: refPts[0][1], preventDefault() {} });
  assert.strictEqual(rowCount(), 3);
  assert.ok(els.status.textContent.includes('3 对点'));
  // 参与点不足 4 个：验证列全部「无法验证」，汇总不可用（不拿残差充数）
  assert.strictEqual((tbodyHtml().match(/无法验证/g) || []).length, 3);
  assert.ok(els.status.textContent.includes('留出验证：不可用（无可验证点）'));
  assert.ok(els.fitPanel.innerHTML.includes('不可用'));
  // 导出残差 JSON：汇总字段为 null，逐点 looErrorPx 为 null
  fire(els.btnExportResiduals, 'click');
  const rj3 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(rj3.looValidation.verifiableCount, 0);
  assert.strictEqual(rj3.looValidation.rmse, null);
  assert.strictEqual(rj3.looValidation.maxError, null);
  assert.strictEqual(rj3.looValidation.maxIndex, null);
  assert.ok(rj3.points.every((p) => p.looStatus === 'unverifiable' && p.looErrorPx === null));
  console.log('✓ 右键删点后立即重算（剩 3 对）；留出验证整体不可用并显式标注');

  // 6. 清空后点击共线三点 → 拒绝并提示
  fire(els.btnClear, 'click');
  assert.ok(els.status.textContent.includes('至少还需'));
  const refs = [[90, 90], [870, 110], [120, 540]];
  const line = [[100, 100], [200, 200], [300, 300]]; // 扫描图侧共线
  for (let i = 0; i < 3; i++) {
    clickCanvas(els.refCanvas, refs[i][0], refs[i][1]);
    clickCanvas(els.scanCanvas, line[i][0], line[i][1]);
  }
  assert.ok(els.status.textContent.includes('共线'), '共线应被拒绝: ' + els.status.textContent);
  assert.ok(els.status.className.includes('error'));
  assert.ok(els.btnExportMatrix.disabled, '拟合失败时导出按钮应禁用');
  assert.ok(els.btnExportImage.disabled, '拟合失败时导出校准扫描图应禁用');
  assert.ok(els.exportImgHint.textContent.includes('共线'), '禁用原因应说明共线: ' + els.exportImgHint.textContent);
  assert.ok(!els.status.textContent.includes('留出验证'), '拟合失败时不应显示留出验证汇总');
  // 差异区域：拟合无效 → 清空旧标记并说明原因
  assert.ok(els.diffHint.textContent.includes('差异区域不可用'), '拟合失败后差异区域应不可用: ' + els.diffHint.textContent);
  assert.ok(els.diffHint.textContent.includes('共线'), '应说明共线原因: ' + els.diffHint.textContent);
  assert.ok(!tbodyDiff().includes('<tr'), '差异表格应清空');
  assert.strictEqual(els.diffSummary.textContent, '');
  console.log('✓ 共线控制点被拒绝并提示，导出按钮禁用（含校准扫描图的原因说明），差异区域清空并说明原因');

  // 7. 透明度滑杆
  els.opacity.value = '0.8';
  fire(els.opacity, 'input');
  assert.strictEqual(els.opacityVal.textContent, '80%');
  console.log('✓ 透明度滑杆联动');

  // 8. 稳健模式：当前 3 个共线点仍被拒绝，点对保留、导出禁用
  els.robustMode.checked = true;
  fire(els.robustMode, 'change');
  assert.ok(els.tolerance.disabled === false, '稳健模式开启后容差输入应可用');
  assert.ok(els.status.textContent.includes('非共线'), '稳健模式也应提示无非共线三点: ' + els.status.textContent);
  assert.ok(els.btnExportMatrix.disabled, '无非共线三点时导出必须禁用');
  assert.strictEqual(rowCount(), 3, '拒绝拟合时点对应保留');
  console.log('✓ 稳健模式下无非共线三点：说明原因、保留点对、禁用导出');

  // 9. 清空后打 4 个精确内点 + 1 个粗大外点，稳健模式剔除外点
  fire(els.btnClear, 'click');
  const good = [refPts[0], refPts[1], refPts[2], refPts[3]];
  for (const rp of good) {
    clickCanvas(els.refCanvas, rp[0], rp[1]);
    const sp = scanPt(rp);
    clickCanvas(els.scanCanvas, sp[0], sp[1]);
  }
  // 第 5 对：参考点与第 1 对相同，扫描点放在完全错误的位置
  clickCanvas(els.refCanvas, refPts[0][0], refPts[0][1] + 60);
  clickCanvas(els.scanCanvas, 600, 400);
  assert.strictEqual(rowCount(), 5);
  assert.ok(els.status.textContent.includes('内点 4'), '应识别 4 个内点: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('外点 1'), '应识别 1 个外点: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('不计入 RMSE'));
  assert.ok(els.fitPanel.innerHTML.includes('内点 4 / 共 5'));
  // 表格：1 行外点（红）、4 行带「内点」徽章
  const outRows = (els.ptTable.querySelector('tbody').innerHTML.match(/out-row/g) || []).length;
  const inBadges = (els.ptTable.querySelector('tbody').innerHTML.match(/badge in/g) || []).length;
  assert.strictEqual(outRows, 1);
  assert.strictEqual(inBadges, 4);
  // 留出验证：仅 4 个内点参与，外点行显示「不参与」
  assert.strictEqual((tbodyHtml().match(/不参与/g) || []).length, 1, '外点验证列应显示不参与');
  assert.ok(!tbodyHtml().includes('无法验证'));
  assert.ok(els.status.textContent.includes('4 点可验证'), '状态栏应统计可验证点: ' + els.status.textContent);
  assert.ok(els.fitPanel.innerHTML.includes('外点 1 个不参与'), '拟合面板应说明外点不参与验证');
  console.log('✓ 稳健模式：双图/残差表区分内外点，外点不计 RMSE 且验证列显示「不参与」');

  // 10. 两种导出记录内外点身份，且矩阵为同一最终矩阵
  fire(els.btnExportMatrix, 'click');
  const mj2 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(mj2.mode, 'robust');
  assert.strictEqual(mj2.rmseScope, 'inliers');
  assert.strictEqual(mj2.inlierCount, 4);
  assert.strictEqual(mj2.outlierCount, 1);
  assert.strictEqual(mj2.tolerancePx, 2);
  assert.strictEqual(mj2.looValidation.participantCount, 4, '留出验证参与集应为内点');
  assert.strictEqual(mj2.looValidation.verifiableCount, 4);
  fire(els.btnExportResiduals, 'click');
  const rj2 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(rj2.points.length, 5);
  assert.strictEqual(rj2.points.filter((p) => p.isInlier).length, 4);
  assert.strictEqual(rj2.points.filter((p) => !p.isInlier).length, 1);
  assert.strictEqual(rj2.points[4].isInlier, false);
  assert.strictEqual(rj2.points[4].isMaxResidual, false, '外点不应标记为最大残差内点');
  assert.strictEqual(rj2.points[4].looStatus, 'excluded', '外点留出验证应为 excluded');
  assert.strictEqual(rj2.points[4].looErrorPx, null);
  assert.ok(rj2.points.slice(0, 4).every((p) => p.looStatus === 'ok' && Number.isFinite(p.looErrorPx)));
  assert.strictEqual(rj2.looValidation.verifiableCount, 4);
  const mm = mj2.matrix;
  assert.ok(Math.hypot(
    mm.a * scanPt(refPts[0])[0] + mm.b * scanPt(refPts[0])[1] + mm.c - refPts[0][0],
    mm.d * scanPt(refPts[0])[0] + mm.e * scanPt(refPts[0])[1] + mm.f - refPts[0][1]
  ) < 1e-6, '导出矩阵应与叠加预览使用的最终矩阵一致（精确恢复内点映射）');
  // 稳健模式同样可导出校准扫描图 PNG（同一最终矩阵）
  assert.strictEqual(els.btnExportImage.disabled, false, '稳健模式拟合有效时应可导出校准扫描图');
  const pngBlobs2 = blobs.length;
  fire(els.btnExportImage, 'click');
  assert.strictEqual(blobs.length, pngBlobs2 + 1);
  assert.strictEqual(blobs[blobs.length - 1].type, 'image/png');
  assert.ok(els.status.textContent.includes('已导出校准扫描图'));
  assert.ok(els.status.textContent.includes('稳健'), '导出确认应注明稳健模式: ' + els.status.textContent);
  console.log('✓ 稳健模式导出：同一最终矩阵 + 逐点内外点身份 + 校准扫描图 PNG');

  // 11. 拖动外点标记到正确位置 → 同步重算，变为 5 个内点
  const correct = scanPt([refPts[0][0], refPts[0][1] + 60]);
  fire(els.scanCanvas, 'mousedown', { button: 0, clientX: 600, clientY: 400, preventDefault() {} });
  fireWindow('mousemove', { clientX: correct[0], clientY: correct[1] });
  fireWindow('mouseup', {});
  assert.ok(els.status.textContent.includes('内点 5'), '拖动归位后应为 5 个内点: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('外点 0'));
  assert.ok(els.status.textContent.includes('RMSE'));
  assert.ok(els.status.textContent.includes('5 点可验证'), '拖动后留出验证应实时更新: ' + els.status.textContent);
  assert.ok(!tbodyHtml().includes('不参与'), '无外点后验证列不应再有「不参与」');
  console.log('✓ 点位编辑（拖动）后同步重算，外点变为内点，留出验证同步更新');

  // 12. 容差调整即时重算：改为 0 px 仍为全内点（点完全精确）
  els.tolerance.value = '0';
  fire(els.tolerance, 'input');
  assert.strictEqual(els.status.className.includes('error'), false, '容差 0 合法');
  assert.ok(els.status.textContent.includes('容差 0.00'));
  assert.ok(els.status.textContent.includes('内点 5'));
  // 非法容差：说明原因并禁用导出，点对保留
  els.tolerance.value = '-1';
  fire(els.tolerance, 'input');
  assert.ok(els.status.textContent.includes('像素容差'), '非法容差应说明原因: ' + els.status.textContent);
  assert.ok(els.btnExportMatrix.disabled);
  assert.ok(els.btnExportImage.disabled, '非法容差导致拟合无效时导出校准扫描图应禁用');
  assert.ok(els.exportImgHint.textContent.includes('拟合无效'), '应说明拟合无效: ' + els.exportImgHint.textContent);
  assert.ok(els.diffHint.textContent.includes('拟合无效'), '非法容差时差异区域应说明原因: ' + els.diffHint.textContent);
  assert.ok(!tbodyDiff().includes('<tr'), '非法容差时差异表格应清空');
  assert.strictEqual(rowCount(), 5);
  // 恢复合法容差
  els.tolerance.value = '2';
  fire(els.tolerance, 'input');
  assert.ok(els.status.textContent.includes('内点 5'));
  assert.strictEqual(els.btnExportImage.disabled, false, '容差恢复后导出校准扫描图应重新启用');
  console.log('✓ 容差调整同步重算；非法容差提示并禁用导出（含校准扫描图）');

  // 13. 关闭稳健模式 → 回到经典最小二乘，全部点参与拟合
  els.robustMode.checked = false;
  fire(els.robustMode, 'change');
  assert.ok(els.tolerance.disabled, '关闭稳健模式后容差输入应禁用');
  assert.ok(els.status.textContent.includes('拟合成功'), '经典模式应拟合成功: ' + els.status.textContent);
  assert.ok(els.status.textContent.includes('留出验证 RMSE'), '经典模式同样显示留出验证汇总');
  assert.ok(els.status.textContent.includes('5 点可验证'));
  fire(els.btnExportMatrix, 'click');
  const mj3 = JSON.parse(await blobs[blobs.length - 1].text());
  assert.strictEqual(mj3.mode, 'leastSquares');
  assert.strictEqual(mj3.rmseScope, 'all');
  assert.strictEqual(mj3.pointCount, 5);
  assert.strictEqual(mj3.looValidation.verifiableCount, 5);
  console.log('✓ 关闭稳健模式后回到经典最小二乘（导出 mode/rmseScope 对应，留出验证同步）');

  // 14. 差异区域视图：注入「左黑右白」像素模式（边界 x=480），校准后扫描图边界
  //     随拟合矩阵错位约 16px → 应在边界处检出 1 个差异区域
  pixelPattern = (x) => (x < 480 ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  fire(els.btnSample, 'click'); // 重新载入示例 → 源像素缓存失效，按新模式重新提取
  await tick(); await tick();
  for (const rp of refPts) {
    clickCanvas(els.refCanvas, rp[0], rp[1]);
    const sp = scanPt(rp);
    clickCanvas(els.scanCanvas, sp[0], sp[1]);
  }
  assert.ok(els.status.textContent.includes('拟合成功'), '应拟合成功: ' + els.status.textContent);
  assert.ok(els.diffSummary.textContent.includes('差异区域 1 个'),
    '应检出 1 个差异区域: ' + els.diffSummary.textContent);
  assert.ok(els.diffSummary.textContent.includes('差异像素'), '摘要应含差异像素统计');
  const rangeMatch = tbodyDiff().match(/<td>(\d+) ~ (\d+)<\/td>/);
  assert.ok(rangeMatch, '表格应给出参考图 X 坐标范围: ' + tbodyDiff());
  const minX = Number(rangeMatch[1]);
  const maxX = Number(rangeMatch[2]);
  assert.ok(minX >= 440 && minX <= 480 && maxX >= 465 && maxX <= 500,
    `差异带应位于边界 x=480 附近，实际 ${minX}~${maxX}`);
  const areaMatch = tbodyDiff().match(/<td>1<\/td>\s*<td>(\d+)<\/td>/);
  assert.ok(areaMatch && Number(areaMatch[1]) > 1000, '差异区域像素数应显著: ' + tbodyDiff());
  console.log('✓ 差异区域视图：复用重采样结果逐像素比较，八邻域分组检出边界差异带');

  // 15. 阈值调为 255：任何通道差值都无法超过 → 0 个区域（差异像素同步归零）
  els.diffThreshold.value = '255';
  fire(els.diffThreshold, 'input');
  assert.ok(els.diffSummary.textContent.includes('差异区域 0 个'), '阈值 255 应无差异区域: ' + els.diffSummary.textContent);
  assert.ok(tbodyDiff().includes('未发现差异区域'));
  // 恢复阈值后重新检出（重采样结果命中缓存，无需重采样）
  els.diffThreshold.value = '32';
  fire(els.diffThreshold, 'input');
  assert.ok(els.diffSummary.textContent.includes('差异区域 1 个'), '阈值恢复后应重新检出: ' + els.diffSummary.textContent);
  // 最小面积调大 → 区域被过滤（差异像素仍统计）
  els.diffMinArea.value = '999999';
  fire(els.diffMinArea, 'input');
  assert.ok(els.diffSummary.textContent.includes('差异区域 0 个'), '小于最小面积的区域应被过滤: ' + els.diffSummary.textContent);
  assert.ok(!els.diffSummary.textContent.includes('差异像素 0'), '差异像素仍应统计: ' + els.diffSummary.textContent);
  els.diffMinArea.value = '16';
  fire(els.diffMinArea, 'input');
  assert.ok(els.diffSummary.textContent.includes('差异区域 1 个'), '最小面积恢复后应重新检出');
  console.log('✓ 差异区域：阈值/最小面积调整即时重算，过滤与统计独立');

  // 16. 非法阈值 → 清空旧标记并说明原因；恢复后重新检出
  els.diffThreshold.value = '-1';
  fire(els.diffThreshold, 'input');
  assert.ok(els.diffHint.textContent.includes('差异区域不可用'), '非法阈值应不可用: ' + els.diffHint.textContent);
  assert.ok(els.diffHint.textContent.includes('阈值'), '应说明阈值非法: ' + els.diffHint.textContent);
  assert.ok(!tbodyDiff().includes('<tr'), '非法参数时差异表格应清空');
  assert.strictEqual(els.diffSummary.textContent, '');
  els.diffThreshold.value = '32';
  fire(els.diffThreshold, 'input');
  assert.ok(els.diffSummary.textContent.includes('差异区域 1 个'), '参数恢复后应重新检出');
  // 清空控制点 → 条件失效：清空旧标记并说明原因
  fire(els.btnClear, 'click');
  assert.ok(els.diffHint.textContent.includes('拟合无效'), '清空点位后应说明原因: ' + els.diffHint.textContent);
  assert.ok(!tbodyDiff().includes('<tr'), '条件失效后差异表格应清空');
  assert.strictEqual(els.diffSummary.textContent, '');
  console.log('✓ 差异区域：非法参数与条件失效时清空旧标记并说明原因');

  console.log('\n前端冒烟测试全部通过 ✔');
})().catch((err) => {
  console.error('冒烟测试失败:', err);
  process.exit(1);
});
