// 天气特效的 canvas 版（录制/离线渲染用，与 DOM 版 WeatherOverlay 同风格）。
// 所有位置/相位由确定性伪随机驱动，只依赖 now —— 离线逐帧渲染与实时预览逐像素一致。

export interface WeatherFxView {
  w: number;
  h: number;
}

function hash(n: number) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** 主入口：effect 同 DayWeather.effect（sun/cloud/overcast/fog/drizzle/rain/heavy-rain/snow/heavy-snow/breeze/wind/storm） */
export function drawWeatherFx(
  ctx: CanvasRenderingContext2D,
  effect: string,
  view: WeatherFxView,
  now: number
) {
  ctx.save();
  if (effect === "drizzle") {
    ctx.fillStyle = "rgba(35,50,65,0.04)"; // 更薄的冷调薄纱（同 DOM 版 .weather-fx-drizzle）
    ctx.fillRect(0, 0, view.w, view.h);
    drawRain(ctx, view, now, "drizzle");
  } else if (effect === "rain") {
    ctx.fillStyle = "rgba(35,50,65,0.06)"; // 冷调薄纱定氛围（同 DOM 版 .weather-fx-rain）
    ctx.fillRect(0, 0, view.w, view.h);
    drawRain(ctx, view, now, "rain");
  }
  else if (effect === "heavy-rain") {
    ctx.fillStyle = "rgba(35,50,65,0.13)";
    ctx.fillRect(0, 0, view.w, view.h);
    drawRain(ctx, view, now, "heavy");
    drawMist(ctx, view, now);
  } else if (effect === "storm") {
    drawStormVeil(ctx, view);
    drawStormClouds(ctx, view, now);
    drawRain(ctx, view, now, "heavy");
    drawMist(ctx, view, now);
    drawBolt(ctx, view, now, 0.27, 0);
    drawBolt(ctx, view, now, 0.67, 3400);
  } else if (effect === "snow") drawSnow(ctx, view, now, false);
  else if (effect === "heavy-snow") drawSnow(ctx, view, now, true);
  else if (effect === "cloud" || effect === "overcast") drawClouds(ctx, view, now, effect === "overcast");
  else if (effect === "fog") drawFog(ctx, view, now);
  else if (effect === "breeze") drawWind(ctx, view, now, true);
  else if (effect === "wind") drawWind(ctx, view, now, false);
  else if (effect === "sun") drawSun(ctx, view, now);
  ctx.restore();
}

// ── 雨 ─────────────────────────────────────────────────────────────────────
type RainMode = "drizzle" | "rain" | "heavy";

/** 阵风：雨丝倾斜角随时间往复（与 DOM 版 wx-slant 6.5s ease-in-out 同构，-3.5° → -10°） */
function gustSlant(now: number) {
  const u = 0.5 - 0.5 * Math.cos((2 * Math.PI * now) / 13000); // 13s 一个来回 = 6.5s alternate
  return Math.tan(((3.5 + u * 6.5) * Math.PI) / 180);
}

function drawRain(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number, mode: RainMode) {
  const heavy = mode === "heavy";
  const drizzle = mode === "drizzle";
  const layers = [
    ...(heavy ? [{ count: 16, speed: 1000, len: 52, alpha: 0.5, width: 2.6 }] : []), // 前景大雨滴（景深）
    drizzle
      ? { count: 26, speed: 240, len: 15, alpha: 0.35, width: 0.85 } // 毛毛雨：稀、慢、细
      : { count: heavy ? 90 : 55, speed: 620, len: heavy ? 30 : 23, alpha: 0.55, width: heavy ? 1.6 : 1.25 },
    drizzle
      ? { count: 16, speed: 160, len: 10, alpha: 0.22, width: 0.7 }
      : { count: heavy ? 60 : 35, speed: 400, len: heavy ? 18 : 14, alpha: 0.32, width: heavy ? 1.2 : 0.95 },
  ];
  const slant = gustSlant(now);
  ctx.lineCap = "round";
  layers.forEach((layer, li) => {
    ctx.strokeStyle = `rgba(150,175,200,${layer.alpha})`;
    ctx.lineWidth = layer.width;
    ctx.beginPath();
    for (let i = 0; i < layer.count; i++) {
      const seed = li * 1000 + i;
      const x = hash(seed) * (view.w + 80) - 40 + 6; // +斜移补偿
      const speed = layer.speed * (0.8 + hash(seed + 3) * 0.5);
      const span = view.h + 80;
      const y = ((hash(seed + 11) * span + (now / 1000) * speed) % span) - 40;
      const len = layer.len * (0.75 + hash(seed + 5) * 0.5);
      ctx.moveTo(x + slant * len, y - len);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  // 溅落涟漪（4 处轮换扩散；毛毛雨太细不溅）
  if (drizzle) return;
  for (let j = 0; j < 4; j++) {
    const period = 1900;
    const phase = ((now + j * 630) % period) / period;
    const cx = (0.18 + hash(j + 40) * 0.6) * view.w;
    const cy = (0.84 + hash(j + 55) * 0.1) * view.h;
    ctx.strokeStyle = `rgba(180,205,225,${(1 - phase) * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 13 * (0.2 + phase * 1.5), 5 * (0.2 + phase * 1.5), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawStormVeil(ctx: CanvasRenderingContext2D, view: WeatherFxView) {
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, "rgba(28,36,50,0.32)");
  g.addColorStop(0.55, "rgba(28,36,50,0.12)");
  g.addColorStop(1, "rgba(28,36,50,0.18)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);
  // 四角压暗（电影感 vignette，与 DOM 版 .wx-storm-veil 的径向层同构）
  const v = ctx.createRadialGradient(view.w / 2, view.h / 2, Math.min(view.w, view.h) * 0.45, view.w / 2, view.h / 2, Math.hypot(view.w, view.h) * 0.62);
  v.addColorStop(0, "rgba(18,24,36,0)");
  v.addColorStop(1, "rgba(18,24,36,0.3)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, view.w, view.h);
}

/** 顶部乌云：三团深灰蓝椭圆缓慢漂移（与 DOM 版 .wx-stormcloud 同构） */
function drawStormClouds(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number) {
  for (let c = 0; c < 3; c++) {
    const seed = c * 47;
    const speed = (view.w * 1.6) / (40000 + hash(seed) * 25000);
    const x = ((hash(seed + 1) * view.w * 1.6 + (now / 1000) * speed) % (view.w * 1.6)) - view.w * 0.3;
    const y = view.h * (0.02 + hash(seed + 2) * 0.1);
    const size = (0.2 + hash(seed + 3) * 0.12) * view.w;
    ctx.fillStyle = `rgba(64,72,88,${0.5 + hash(seed + 4) * 0.15})`;
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.34, 0, 0, Math.PI * 2);
    ctx.ellipse(x - size * 0.4, y + size * 0.05, size * 0.55, size * 0.26, 0, 0, Math.PI * 2);
    ctx.ellipse(x + size * 0.42, y + size * 0.06, size * 0.5, size * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 大雨/雷雨底部雨雾（呼吸式起伏，与 DOM 版 .wx-mist 同构） */
function drawMist(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number) {
  const h = view.h * 0.36;
  const a = 0.6 + ((Math.sin(now / 1750) + 1) / 2) * 0.4; // 与 wx-mist-pulse 5.5s 周期一致
  const g = ctx.createLinearGradient(0, view.h - h, 0, view.h);
  g.addColorStop(0, "rgba(165,185,205,0)");
  g.addColorStop(0.55, `rgba(165,185,205,${0.05 * a})`);
  g.addColorStop(1, `rgba(165,185,205,${0.18 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, view.h - h, view.w, h);
}

/**
 * 分叉闪电：主闪干是逐段抖动的折线（每次落雷形状不同），
 * 带两条分支 + 辉光/亮芯双描边；命中瞬间叠一层全屏闪光。
 * 双闪节奏（7s 周期，delay 错峰）与 DOM 版 wx-bolt/wx-flash 一致。
 */
function drawBolt(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number, xFrac: number, delay: number) {
  const period = 7000;
  const t = (now + delay) % period;
  let alpha = 0;
  if (t >= 6440 && t < 6500) alpha = 1;
  else if (t >= 6500 && t < 6560) alpha = 0.18;
  else if (t >= 6560 && t < 6670) alpha = 0.9;
  else if (t >= 6670 && t < 6930) alpha = 0.9 * (1 - (t - 6670) / 260); // 余晖缓灭
  if (alpha <= 0.01) return;
  // 全屏闪光（从闪电一侧打来的径向光，近似 DOM 版 .wx-flash）
  const fg = ctx.createRadialGradient(xFrac * view.w, -view.h * 0.05, 0, xFrac * view.w, -view.h * 0.05, view.h * 1.1);
  fg.addColorStop(0, `rgba(240,245,255,${alpha * 0.35})`);
  fg.addColorStop(0.55, `rgba(200,215,255,${alpha * 0.14})`);
  fg.addColorStop(1, "rgba(200,215,255,0)");
  ctx.fillStyle = fg;
  ctx.fillRect(0, 0, view.w, view.h);
  // 主闪干：7 段折线，形状由本次落雷序号决定（逐次不同、逐帧确定）
  const strike = Math.floor((now + delay) / period);
  const segs = 7;
  const pts: Array<[number, number]> = [];
  for (let k = 0; k <= segs; k++) {
    const f = k / segs;
    const jitter = (hash(strike * 31 + k * 7) - 0.5) * view.w * 0.075 * (1 - f * 0.4);
    pts.push([xFrac * view.w + jitter, -view.h * 0.02 + view.h * 0.64 * f]);
  }
  const s = view.h / 720 + 0.4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const pass of [
    { width: 7 * s, color: `rgba(200,215,255,${alpha * 0.4})` }, // 辉光
    { width: 2.6 * s, color: `rgba(232,240,255,${alpha})` }, // 亮芯
  ]) {
    ctx.strokeStyle = pass.color;
    ctx.lineWidth = pass.width;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }
  // 两条分支（从闪干中上部岔出，逐渐变细变淡）
  for (const b of [2, 4]) {
    const dir = b === 2 ? -1 : 1;
    let cx = pts[b][0];
    let cy = pts[b][1];
    ctx.strokeStyle = `rgba(226,236,255,${alpha * 0.6})`;
    ctx.lineWidth = 1.4 * s;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let k = 0; k < 3; k++) {
      cx += dir * (0.03 + hash(strike * 17 + b * 5 + k) * 0.04) * view.w;
      cy += (0.05 + hash(strike * 23 + b * 3 + k) * 0.05) * view.h;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
}

// ── 雪 ─────────────────────────────────────────────────────────────────────
function drawSnow(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number, heavy: boolean) {
  // 小雪：中速斜落、中等密度（持续横向漂移）；大雪在其基础上再加密、加速、摆幅更急
  const layers = heavy
    ? [
        { count: 125, speed: 185, r: 4.4, alpha: 0.95, swayAmp: 50 },
        { count: 160, speed: 125, r: 2.9, alpha: 0.85, swayAmp: 35 },
        { count: 200, speed: 78, r: 1.9, alpha: 0.65, swayAmp: 22 },
      ]
    : [
        { count: 68, speed: 95, r: 3.4, alpha: 0.95, swayAmp: 40 },
        { count: 88, speed: 62, r: 2.3, alpha: 0.85, swayAmp: 28 },
        { count: 112, speed: 38, r: 1.5, alpha: 0.65, swayAmp: 18 },
      ];
  const drift = heavy ? 130 : 60; // px/s 持续横向漂移（雪天的风）
  layers.forEach((layer, li) => {
    ctx.fillStyle = `rgba(255,255,255,${layer.alpha})`;
    for (let i = 0; i < layer.count; i++) {
      const seed = li * 2000 + i;
      const sway = Math.sin(now / (1400 + li * 500) + i) * layer.swayAmp;
      const spanX = view.w + 40;
      const x = ((hash(seed) * spanX + sway + (now / 1000) * drift) % spanX) - 20;
      const span = view.h + 20;
      const y = ((hash(seed + 7) * span + (now / 1000) * layer.speed) % span) - 10;
      ctx.beginPath();
      ctx.arc(x, y, layer.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // 雪晶闪烁：几颗带辉光的亮点呼吸明灭（与 DOM 版 .wx-spark 同构）
  for (let i = 0; i < 4; i++) {
    const seed = i * 53;
    const twinkle = (Math.sin(now / 890 + i * 2.2) + 1) / 2; // ≈2.8s 周期
    const alpha = 0.12 + twinkle * 0.83;
    const x = (0.18 + hash(seed) * 0.66) * view.w;
    const y = (0.24 + hash(seed + 7) * 0.4) * view.h;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.shadowColor = `rgba(255,255,255,${alpha * 0.8})`;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, 2 + twinkle * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  // 底部积雪反光（与 DOM 版 .wx-frost 同构；大雪更厚更亮）
  const fh = view.h * (heavy ? 0.36 : 0.3);
  const fg = ctx.createLinearGradient(0, view.h - fh, 0, view.h);
  fg.addColorStop(0, "rgba(255,255,255,0)");
  fg.addColorStop(1, `rgba(255,255,255,${heavy ? 0.42 : 0.34})`);
  ctx.fillStyle = fg;
  ctx.fillRect(0, view.h - fh, view.w, fh);
}

// ── 多云 / 阴 ────────────────────────────────────────────────────────────────
function drawClouds(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number, overcast: boolean) {
  if (overcast) {
    const g = ctx.createLinearGradient(0, 0, 0, view.h);
    g.addColorStop(0, "rgba(100,110,120,0.20)");
    g.addColorStop(0.55, "rgba(100,110,120,0.05)");
    g.addColorStop(1, "rgba(100,110,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  } else {
    // 多云：云隙透出的一点暖阳（呼吸，与 DOM 版 .wx-sunhint 同构）
    const breathe = 0.85 + Math.sin(now / 4000) * 0.15;
    const hx = view.w * 0.88, hy = -view.h * 0.05;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, view.h * 0.55 * breathe);
    g.addColorStop(0, "rgba(255,224,150,0.28)");
    g.addColorStop(0.6, "rgba(255,224,150,0.06)");
    g.addColorStop(1, "rgba(255,224,150,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, view.h);
  }
  const count = overcast ? 6 : 4;
  for (let c = 0; c < count; c++) {
    const seed = c * 31;
    const speed = (view.w * 1.8) / (50000 + hash(seed) * 30000); // 缓慢漂移
    const x = ((hash(seed + 1) * view.w * 1.8 + (now / 1000) * speed) % (view.w * 1.8)) - view.w * 0.4;
    // 上下轻浮动（漂移之外的第二层运动，与 DOM 版 wx-bob 同构）
    const y = view.h * (0.06 + hash(seed + 2) * 0.55) + Math.sin(now / 2200 + c * 2.1) * 5;
    const size = (0.16 + hash(seed + 3) * 0.14) * view.w;
    const alpha = (overcast ? 0.24 : 0.2) + hash(seed + 4) * 0.08;
    ctx.fillStyle = overcast ? `rgba(228,232,238,${alpha})` : `rgba(255,255,255,${alpha})`;
    // 主块 + 两子块，拼出云形
    ctx.beginPath();
    ctx.ellipse(x, y, size, size * 0.42, 0, 0, Math.PI * 2);
    ctx.ellipse(x - size * 0.38, y + size * 0.06, size * 0.55, size * 0.32, 0, 0, Math.PI * 2);
    ctx.ellipse(x + size * 0.42, y + size * 0.08, size * 0.5, size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── 大风/清风 ────────────────────────────────────────────────────────────────
// 蛇形阵风：与 DOM 版 WindGust 同一段路径（viewBox 480x120，中段预埋整圆）。
// DOM 用 stroke-dashoffset 滑窗行进；canvas 用 SVGGeometryElement.getPointAtLength
// 采样同一窗口，逐帧确定（DOM/录制一致）。滑窗经过圆弧段时线头自然原地绕一圈。
// gentle（清风）对应 DOM 版 .weather-fx-breeze：只一条、更淡更慢 + 一片叶子
const WIND_SNAKE_PATH =
  "M-8 84 C52 44 96 94 150 68 C178 55 196 51 214 53 C222 54 230 50 238 50 A22 22 0 1 0 238 6 A22 22 0 1 0 238 50 C250 50 260 52 272 50 C320 30 372 62 418 44 L486 30";
let snakePathEl: SVGPathElement | null = null;
let snakeTotal = 0;
function snakeGeometry() {
  if (!snakePathEl) {
    snakePathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    snakePathEl.setAttribute("d", WIND_SNAKE_PATH);
    snakeTotal = snakePathEl.getTotalLength();
  }
  return { el: snakePathEl, total: snakeTotal };
}
function drawWind(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number, gentle: boolean) {
  const { el, total } = snakeGeometry();
  const gusts = gentle
    ? [{ y: 0.24, h: 0.3, period: 5500, delay: 0, alpha: 0.55 }]
    : [
        { y: 0.1, h: 0.3, period: 3200, delay: 0, alpha: 0.9 },
        { y: 0.38, h: 0.26, period: 4200, delay: -1800, alpha: 0.63 },
        { y: 0.62, h: 0.32, period: 2700, delay: -900, alpha: 0.8 },
      ];
  const seg = total * 0.43; // 蛇身长度（同 DOM 版 dasharray 430/1000）
  const tilt = (20 * Math.PI) / 180; // 同 DOM 版 rotate(20deg)（镜像后净斜率 ≈14°，右上→左下）
  // 深青灰主色（大风）/ 淡灰蓝（清风），同 DOM 版 .wx-gust / .weather-fx-breeze
  const rgb = gentle ? "122,146,166" : "74,96,116";
  ctx.lineCap = "round";
  for (const g of gusts) {
    const p = ((((now + g.delay) % g.period) + g.period) % g.period) / g.period;
    const fade = p < 0.08 ? p / 0.08 : p > 0.86 ? (1 - p) / 0.14 : 1; // 同 wx-snake 关键帧的淡入淡出
    if (fade <= 0) continue;
    const head = p * (total + seg); // 蛇头位置（dashoffset 430→-1000 的滑窗）
    const from = Math.max(0, head - seg);
    const to = Math.min(total, head);
    if (to <= from) continue;
    const kx = view.w / 480;
    const ky = (view.h * g.h) / 120;
    const yBase = g.y * view.h;
    const step = total / 160;
    // 与 DOM 版一致的几何变换：scale(-1,-1) + rotate(20°)，绕 svg 带中心 → 风向右上到左下
    const cx = view.w / 2;
    const cy = yBase + (view.h * g.h) / 2;
    for (const [dy, w, o] of [[0, 2.2, 0.85], [-7, 1.4, 0.5], [7, 1.4, 0.5]] as const) {
      ctx.strokeStyle = `rgba(${rgb},${o * g.alpha * fade})`;
      ctx.lineWidth = Math.max(1, w * ((kx + ky) / 2));
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(-1, -1);
      ctx.rotate(tilt);
      ctx.scale(kx, ky);
      ctx.translate(-240, -60 + dy);
      ctx.beginPath();
      for (let d = from; d <= to; d += step) {
        const pt = el.getPointAtLength(d);
        if (d === from) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      const ptEnd = el.getPointAtLength(to);
      ctx.lineTo(ptEnd.x, ptEnd.y);
      ctx.stroke();
      ctx.restore();
    }
  }
  // 卷叶：跟风同向（右上→左下斜落），自转 + 颠簸（与 DOM 版 .wx-leaf-carrier 同构；清风只一片、更慢更轻）
  const leafCount = gentle ? 1 : 3;
  for (let l = 0; l < leafCount; l++) {
    const period = gentle ? 5000 : l === 1 ? 2500 : 3000;
    const progress = ((now + l * 1100 + 300) % period) / period;
    const alpha = progress < 0.08 ? progress / 0.08 : progress > 0.84 ? (1 - progress) / 0.16 : 1;
    if (alpha <= 0) continue;
    const x = (1.16 - progress * 1.45) * view.w;
    const y = view.h * (0.18 + l * 0.22) + progress * 150 + Math.sin(progress * Math.PI * 4 + l) * 6;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(progress * Math.PI * (gentle ? 2.2 : 5) + l);
    const leafAlpha = alpha * (gentle ? 0.6 : 0.85);
    ctx.fillStyle = l === 1 ? `rgba(172,152,112,${leafAlpha})` : `rgba(204,188,80,${leafAlpha})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, l === 1 ? 4 : 5, l === 1 ? 2.5 : 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ── 雾 ─────────────────────────────────────────────────────────────────────
// 多层雾带反向缓漂（近层更快，视差）+ 呼吸薄纱，与 DOM 版 wx-fogbank/wx-fog-veil 同构
function drawFog(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number) {
  const bands = [
    { y: 0.16, period: 26000, dir: 1, alpha: 0.5, h: 0.24, delay: 0 },
    { y: 0.4, period: 34000, dir: -1, alpha: 0.47, h: 0.24, delay: 0 },
    { y: 0.66, period: 21000, dir: 1, alpha: 0.36, h: 0.24, delay: -9000 },
    { y: 0.88, period: 29000, dir: -1, alpha: 0.28, h: 0.24, delay: -15000 },
  ];
  for (const b of bands) {
    // ease-in-out alternate 用余弦近似：±5% 宽度往复 + 横向 scale 1→1.09 呼吸
    const u = Math.cos((2 * Math.PI * (now + b.delay)) / b.period); // 1 → -1
    const x = view.w / 2 + b.dir * u * view.w * 0.05;
    const rx = view.w * 0.85 * (1 + ((1 - u) / 2) * 0.09);
    const g = ctx.createRadialGradient(x, b.y * view.h, 0, x, b.y * view.h, rx);
    g.addColorStop(0, `rgba(228,233,239,${b.alpha})`);
    g.addColorStop(0.7, `rgba(228,233,239,${b.alpha * 0.55})`);
    g.addColorStop(1, "rgba(228,233,239,0)");
    ctx.save();
    ctx.translate(x, b.y * view.h);
    ctx.scale(1, (b.h * view.h) / rx);
    ctx.translate(-x, -b.y * view.h);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, b.y * view.h, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // 整体薄纱：顶部淡、底部泛白（7s 呼吸，同 wx-mist-pulse）
  const a = 0.6 + ((Math.sin((2 * Math.PI * now) / 7000) + 1) / 2) * 0.4;
  const g = ctx.createLinearGradient(0, 0, 0, view.h);
  g.addColorStop(0, `rgba(228,233,239,${0.1 * a})`);
  g.addColorStop(0.45, `rgba(228,233,239,${0.02 * a})`);
  g.addColorStop(1, `rgba(228,233,239,${0.18 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);
}

// ── 晴 ─────────────────────────────────────────────────────────────────────
function drawSun(ctx: CanvasRenderingContext2D, view: WeatherFxView, now: number) {
  const cx = view.w * 0.84, cy = -view.h * 0.06;
  // 双层光芒扇：主层正转、副层（更细更淡）反转，叠出光的厚度
  for (const layer of [
    { spokes: 10, alpha: 0.07, width: 0.05, dir: 1, period: 40000, offset: 0 },
    { spokes: 14, alpha: 0.035, width: 0.028, dir: -1, period: 55000, offset: 0.2 },
  ]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(layer.dir * (now / layer.period) * Math.PI * 2 + layer.offset);
    ctx.fillStyle = `rgba(255,216,140,${layer.alpha})`;
    for (let i = 0; i < layer.spokes; i++) {
      ctx.rotate((Math.PI * 2) / layer.spokes);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(view.h * layer.width, -view.h * 0.85);
      ctx.lineTo(-view.h * layer.width, -view.h * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  // 暖晕（呼吸）
  const breathe = 0.85 + Math.sin(now / 3000) * 0.15;
  const r = view.h * 0.72 * breathe;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, "rgba(255,224,150,0.5)");
  g.addColorStop(0.55, "rgba(255,224,150,0.14)");
  g.addColorStop(1, "rgba(255,224,150,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);
  // 镜头光晕链：沿太阳到画面的对角线，由大到小、由实到虚（与暖晕同呼吸）
  const flareBreathe = 0.85 + Math.sin(now / 3500 + 1) * 0.15;
  for (const f of [
    { t: 0.32, r: 18, ring: true, alpha: 0.4 },
    { t: 0.52, r: 9, ring: true, alpha: 0.28 },
    { t: 0.7, r: 4.5, ring: false, alpha: 0.2 },
  ]) {
    const fx = cx + (view.w * 0.42 - cx) * f.t;
    const fy = cy + (view.h * 0.62 - cy) * f.t;
    ctx.strokeStyle = `rgba(255,225,160,${f.alpha * flareBreathe})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(fx, fy, f.r * (view.h / 720 + 0.4), 0, Math.PI * 2);
    if (f.ring) ctx.stroke();
    else { ctx.fillStyle = `rgba(255,230,170,${f.alpha * flareBreathe})`; ctx.fill(); }
  }
  // 漂浮光尘
  for (let i = 0; i < 8; i++) {
    const seed = i * 77;
    const x = (0.2 + hash(seed) * 0.6) * view.w + Math.sin(now / (2400 + i * 300)) * 18;
    const y = (0.3 + hash(seed + 9) * 0.5) * view.h - ((now / (9000 + i * 2000) + hash(seed)) % 1) * view.h * 0.3;
    ctx.fillStyle = `rgba(255,235,180,${0.35 + hash(seed + 3) * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.5 + hash(seed + 5) * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}
