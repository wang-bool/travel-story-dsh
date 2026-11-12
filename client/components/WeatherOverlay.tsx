"use client";

// 地图天气特效层（纯 CSS/SVG 动画，pointer-events 不穿透）。
// 只在选中某个 Day 标签时显示（由父组件传入当天的 weather.effect）。
// 设计：每种天气都做前中后景层次——雨分三档（毛毛雨细密云丝 / 小雨两层渐隐 + 溅落涟漪 /
// 大雨加前景大雨滴与雨雾）、雪分两档（三层景深 + 摇摆，大雪更密更快并带地面积雪反光）、
// 晴（旋转光芒 + 光尘）、云（多团块云）、雾（多层流动雾带）、风分两档（清风缓流线 /
// 大风流线横扫 + 卷叶）、雷雨（天幕 + 顶部乌云 + 大雨 + 分叉闪电 + 全屏闪光）。
// 雨丝倾斜角随时间往复（阵风感），非线性节奏参考 Remotion 动效原则：缓动、错峰、分层。
// 注意：本组件的层次与相位要和 lib/map/weatherCanvas.ts（录制版）保持一致。

export const WEATHER_EFFECT_LABEL: Record<string, string> = {
  sun: "晴",
  cloud: "多云",
  overcast: "阴",
  fog: "雾",
  drizzle: "毛毛雨",
  rain: "小雨",
  "heavy-rain": "大雨",
  snow: "雪",
  "heavy-snow": "大雪",
  breeze: "清风",
  wind: "大风",
  storm: "雷雨",
};

// 注意：这张表是给录制版 canvas 字幕（lib/map/captions.ts）画文本用的；
// DOM 界面一律用下面的 WeatherIcon（SVG），不要把 emoji 当 UI 图标。
export const WEATHER_EFFECT_ICON: Record<string, string> = {
  sun: "☀️",
  cloud: "⛅",
  overcast: "☁️",
  fog: "🌫️",
  drizzle: "🌦️",
  rain: "🌧️",
  "heavy-rain": "🌧️",
  snow: "❄️",
  "heavy-snow": "🌨️",
  breeze: "🍃",
  wind: "💨",
  storm: "⛈️",
};

// DOM 界面的天气图标：Phosphor SVG，与全局图标同源（替代 emoji，跨平台一致）
import {
  Sun,
  CloudSun,
  Cloud,
  CloudFog,
  DropHalf,
  CloudRain,
  CloudSnow,
  Snowflake,
  Wind,
  CloudLightning,
  Thermometer,
} from "@phosphor-icons/react";

const WEATHER_ICON_COMPONENT = {
  sun: Sun,
  cloud: CloudSun,
  overcast: Cloud,
  fog: CloudFog,
  drizzle: DropHalf,
  rain: CloudRain,
  "heavy-rain": CloudRain,
  snow: CloudSnow,
  "heavy-snow": Snowflake,
  breeze: Wind,
  wind: Wind,
  storm: CloudLightning,
} as const;

// 强度档用实心填充区分：大雨 / 大雪 / 大风
const HEAVY_EFFECTS = new Set(["heavy-rain", "heavy-snow", "wind"]);

export function WeatherIcon({
  effect,
  size = 13,
  heavy,
}: {
  effect?: string | null;
  size?: number;
  /** 强度档（大雨/大雪/大风）用实心填充与小档区分 */
  heavy?: boolean;
}) {
  const Icon =
    WEATHER_ICON_COMPONENT[effect as keyof typeof WEATHER_ICON_COMPONENT] ??
    Thermometer;
  return (
    <Icon
      size={size}
      weight={heavy || (effect != null && HEAVY_EFFECTS.has(effect)) ? "fill" : "duotone"}
      aria-hidden="true"
    />
  );
}

const RAINY = new Set(["drizzle", "rain", "heavy-rain", "storm"]);
// 溅落涟漪：毛毛雨太细不溅，小雨起跳
const SPLASHY = new Set(["rain", "heavy-rain", "storm"]);

/** 蛇形阵风：三条并行流线（viewBox 480x120，铺满地图宽度）。
 *  路径中段预埋了一个整圆；CSS 用 stroke-dashoffset 滑窗让「一段线」沿路径行进——
 *  滑窗经过圆弧段时，线头自然原地绕一整圈再继续前进、尾巴跟上（蛇形）。
 *  与录制版 drawWind 同一段路径、同一节奏。 */
const WIND_SNAKE_PATH =
  "M-8 84 C52 44 96 94 150 68 C178 55 196 51 214 53 C222 54 230 50 238 50 A22 22 0 1 0 238 6 A22 22 0 1 0 238 50 C250 50 260 52 272 50 C320 30 372 62 418 44 L486 30";
const GUST_LINES = [
  { dy: 0, w: 2.2, o: 0.85 },
  { dy: -7, w: 1.4, o: 0.5 },
  { dy: 7, w: 1.4, o: 0.5 },
];
function WindGust({ className = "" }: { className?: string }) {
  return (
    <svg className={`wx-gust ${className}`} viewBox="0 0 480 120" fill="none" preserveAspectRatio="none" aria-hidden="true">
      {GUST_LINES.map((l, i) => (
        <path
          key={i}
          className="wx-snake"
          transform={`translate(0 ${l.dy})`}
          pathLength={1000}
          stroke="currentColor"
          strokeOpacity={l.o}
          strokeWidth={l.w}
          strokeLinecap="round"
          d={WIND_SNAKE_PATH}
        />
      ))}
    </svg>
  );
}

export function WeatherOverlay({ effect }: { effect?: string | null }) {
  if (!effect) return null;
  return (
    <div className={`weather-fx weather-fx-${effect}`} aria-hidden="true">
      {RAINY.has(effect) && (
        <>
          <div className="wx-rain wx-rain-back" />
          <div className="wx-rain wx-rain-front" />
          {/* 大雨/雷雨加第三层：前景稀疏大雨滴，拉出景深 */}
          {(effect === "heavy-rain" || effect === "storm") && <div className="wx-rain wx-rain-fore" />}
          {/* 溅落涟漪：毛毛雨太细不溅，小雨起跳 */}
          {SPLASHY.has(effect) && (
            <>
              <div className="wx-splash" style={{ left: "18%", bottom: "10%", animationDelay: "0s" }} />
              <div className="wx-splash" style={{ left: "47%", bottom: "16%", animationDelay: "0.7s" }} />
              <div className="wx-splash" style={{ left: "76%", bottom: "8%", animationDelay: "1.3s" }} />
              <div className="wx-splash" style={{ left: "33%", bottom: "20%", animationDelay: "1.7s" }} />
            </>
          )}
          {(effect === "heavy-rain" || effect === "storm") && <div className="wx-mist" />}
        </>
      )}
      {effect === "storm" && (
        <>
          <div className="wx-storm-veil" />
          <div className="wx-cloud wx-stormcloud wx-stormcloud-a"><i /><i /><i /></div>
          <div className="wx-cloud wx-stormcloud wx-stormcloud-b"><i /><i /><i /></div>
          <div className="wx-cloud wx-stormcloud wx-stormcloud-c"><i /><i /><i /></div>
          {/* 闪电与全屏闪光同周期（7s）错峰 3.4s，双闪节奏一致 */}
          <div className="wx-flash wx-flash-a" />
          <div className="wx-flash wx-flash-b" />
          <svg className="wx-bolt wx-bolt-a" viewBox="0 0 80 160">
            <path fill="currentColor" d="M45 2 L30 52 L40 52 L22 104 L32 104 L17 158 L53 92 L41 92 L59 48 L46 48 Z" />
            <path fill="currentColor" d="M30 52 L13 80 L19 82 L33 56 Z" />
            <path fill="currentColor" d="M41 92 L57 118 L51 121 L37 96 Z" />
          </svg>
          <svg className="wx-bolt wx-bolt-b" viewBox="0 0 80 160">
            <path fill="currentColor" d="M45 2 L30 52 L40 52 L22 104 L32 104 L17 158 L53 92 L41 92 L59 48 L46 48 Z" />
            <path fill="currentColor" d="M30 52 L13 80 L19 82 L33 56 Z" />
            <path fill="currentColor" d="M41 92 L57 118 L51 121 L37 96 Z" />
          </svg>
        </>
      )}
      {(effect === "cloud" || effect === "overcast") && (
        <>
          {effect === "overcast" && <div className="wx-veil" />}
          {/* 多云：云隙里偶尔透出一点暖阳 */}
          {effect === "cloud" && <div className="wx-sunhint" />}
          <div className="wx-cloud wx-cloud-a"><i /><i /><i /></div>
          <div className="wx-cloud wx-cloud-b"><i /><i /><i /></div>
          <div className="wx-cloud wx-cloud-d"><i /><i /><i /></div>
          <div className="wx-cloud wx-cloud-e"><i /><i /><i /></div>
          {effect === "overcast" && (
            <>
              <div className="wx-cloud wx-cloud-c"><i /><i /><i /></div>
              <div className="wx-cloud wx-cloud-f"><i /><i /><i /></div>
            </>
          )}
        </>
      )}
      {(effect === "snow" || effect === "heavy-snow") && (
        <>
          <div className="wx-sway"><div className="wx-snow wx-snow-back" /></div>
          <div className="wx-sway wx-sway-b"><div className="wx-snow wx-snow-mid" /></div>
          <div className="wx-sway wx-sway-c"><div className="wx-snow wx-snow-front" /></div>
          {/* 雪晶闪烁 + 底部积雪反光 */}
          <div className="wx-spark" style={{ left: "20%", top: "28%", animationDelay: "0s" }} />
          <div className="wx-spark" style={{ left: "44%", top: "52%", animationDelay: "0.9s" }} />
          <div className="wx-spark" style={{ left: "63%", top: "24%", animationDelay: "1.7s" }} />
          <div className="wx-spark" style={{ left: "81%", top: "58%", animationDelay: "2.3s" }} />
          <div className="wx-frost" />
        </>
      )}
      {(effect === "breeze" || effect === "wind") && (
        <>
          {/* 卡通阵风：三条并行流线收尾卷成涡旋（参考经典刮风插画），整体横扫 + 轻微摆动；
              与录制版 drawWind 共用同一段 SVG 路径 */}
          <WindGust className="wx-gust-a" />
          <WindGust className="wx-gust-b" />
          {effect === "wind" && <WindGust className="wx-gust-c" />}
          {/* 卷叶：跟着阵风一起横扫，自转 + 上下颠（清风只一片） */}
          <div className="wx-leaf-carrier" style={{ top: "32%", animationDelay: "0.4s" }}><i /></div>
          {effect === "wind" && (
            <>
              <div className="wx-leaf-carrier wx-leaf-carrier-b" style={{ top: "56%", animationDelay: "1.7s" }}><i /></div>
              <div className="wx-leaf-carrier" style={{ top: "74%", animationDelay: "2.7s" }}><i /></div>
            </>
          )}
        </>
      )}
      {effect === "fog" && (
        <>
          {/* 多层雾带：不同高度/速度/浓淡反向漂移，近处更快（视差），底部泛白压低能见度 */}
          <div className="wx-fogbank wx-fogbank-a" />
          <div className="wx-fogbank wx-fogbank-b" />
          <div className="wx-fogbank wx-fogbank-c" />
          <div className="wx-fogbank wx-fogbank-d" />
          <div className="wx-fog-veil" />
        </>
      )}
      {effect === "sun" && (
        <>
          {/* 双层光芒（正反旋转）+ 暖晕 + 镜头光晕链 + 漂浮光尘 */}
          <div className="wx-rays" />
          <div className="wx-rays wx-rays-b" />
          <div className="wx-glow" />
          <div className="wx-flare wx-flare-a" />
          <div className="wx-flare wx-flare-b" />
          <div className="wx-flare wx-flare-c" />
          <div className="wx-speck wx-speck-a" />
          <div className="wx-speck wx-speck-b" />
          <div className="wx-speck wx-speck-c" />
          <div className="wx-speck wx-speck-d" />
          <div className="wx-speck wx-speck-e" />
        </>
      )}
    </div>
  );
}
