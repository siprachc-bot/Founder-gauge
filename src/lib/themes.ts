// =====================================================================
//  themes.ts — curated SCREEN TEMPLATES for the gauge. A theme sets up the
//  PAGES (layout + which values + colours + how many) as a starting point; the
//  user's car settings (drivetrain / redline / units / brightness / mass) are
//  kept. Apply → the preview updates → tweak → Save writes it to the gauge.
//  Built-in only for now (no backend); community themes come later.
// =====================================================================
import { Ch, Layout, channelDef, type GaugeCfg, GAUGE_PAGES, SLOTS_PER_PAGE } from './founderGaugeCfg';

// RGB565 accents (match the CI + the sim palette).
const GOLD = 0xCD09;   // #C9A24A  SN gold
const RED  = 0xE249;   // #E24B4A
const BLUE = 0x4E1E;   // #4FC3F7
const GREEN = 0x3CE9;  // #3B9C4F
const WHITE = 0xFFFF;

type ThemePage = { layout: number; ch: number[]; arc: number; col2?: number; text?: number };
export interface GaugeTheme {
  id: string; name: string; desc: string;
  accent: number;                 // for the theme card chrome
  pages: ThemePage[];             // 1..GAUGE_PAGES
}

// H = hero, T = ticks, N = needle, B = bars — compact page builders.
const H = (arc: number, a: number, b = Ch.NONE, col2 = 0, text = 0): ThemePage =>
  ({ layout: Layout.HERO, ch: [a, b, 0, 0, 0], arc, col2, text });
const T = (arc: number, a: number, b = Ch.NONE, col2 = 0, text = 0): ThemePage =>
  ({ layout: Layout.TICKS, ch: [a, b, 0, 0, 0], arc, col2, text });
const N = (arc: number, a: number, b = Ch.NONE, col2 = 0, text = 0): ThemePage =>
  ({ layout: Layout.NEEDLE, ch: [a, b, 0, 0, 0], arc, col2, text });
const B4 = (arc: number, a: number, b: number, c: number, d: number, text = 0): ThemePage =>
  ({ layout: Layout.BARS, ch: [a, b, c, d, 0], arc, text });

export const THEMES: GaugeTheme[] = [
  { id: 'minimal-gold', name: 'Minimal Gold', accent: GOLD,
    desc: 'Clean hero dials in SN gold.',
    pages: [ H(GOLD, Ch.RPM, Ch.SPEED), H(GOLD, Ch.BOOST, Ch.COOLANT), H(GOLD, Ch.SOC, Ch.VOLT) ] },

  { id: 'track-red', name: 'Track Red', accent: RED,
    desc: 'Tach ticks + shift light, dyno power. Red hot.',
    pages: [ T(RED, Ch.RPM, Ch.SPEED), H(RED, Ch.BOOST, Ch.COOLANT), H(RED, Ch.PWR, Ch.TQ) ] },

  { id: 'neon-blue', name: 'Neon Blue', accent: BLUE,
    desc: 'Twin-needle clock + neon ticks.',
    pages: [ N(BLUE, Ch.RPM, Ch.SPEED, WHITE), T(BLUE, Ch.BOOST, Ch.COOLANT, GOLD), H(BLUE, Ch.SOC, Ch.VOLT) ] },

  { id: 'classic', name: 'Classic', accent: WHITE,
    desc: 'White-on-black instrument look.',
    pages: [ H(WHITE, Ch.SPEED, Ch.RPM), H(WHITE, Ch.COOLANT, Ch.OILTEMP), H(WHITE, Ch.FUELLVL, Ch.SOC) ] },

  { id: 'dyno', name: 'Dyno', accent: GOLD,
    desc: 'Power + torque front and centre.',
    pages: [ H(GOLD, Ch.PWR, Ch.TQ), T(GOLD, Ch.RPM, Ch.SPEED),
             B4(GOLD, Ch.BOOST, Ch.THROTTLE, Ch.COOLANT, Ch.SOC) ] },

  { id: 'ev', name: 'EV', accent: GREEN,
    desc: 'Battery, motor torque + efficiency.',
    pages: [ H(GREEN, Ch.SOC, Ch.VOLT), N(GREEN, Ch.MOTOR_TQ, Ch.SPEED, BLUE), H(GREEN, Ch.PWR, Ch.ACCEL) ] },
];

// Apply a theme to a config: replace the PAGES (layout/channels/colours + a
// sensible auto peak) and pageCount; KEEP the car's drivetrain, units, redline,
// brightness, mass. Returns a new cfg (does not mutate the input).
export function applyTheme(cfg: GaugeCfg, t: GaugeTheme): GaugeCfg {
  const pages = Array.from({ length: GAUGE_PAGES }, (_, p) => {
    const tp = t.pages[p];
    if (!tp) return { layout: Layout.HERO, ch: Array(SLOTS_PER_PAGE).fill(Ch.NONE),
                      arcColor: t.accent, peak: 0, color2: 0, textColor: 0 };
    const ch = Array.from({ length: SLOTS_PER_PAGE }, (_, s) => tp.ch[s] ?? Ch.NONE);
    return {
      layout: tp.layout, ch,
      arcColor: tp.arc,
      color2: tp.col2 ?? 0,
      textColor: tp.text ?? 0,
      peak: channelDef(ch[0])?.peak ?? 0,       // sensible redline for the primary
    };
  });
  return { ...cfg, pages, pageCount: Math.min(GAUGE_PAGES, Math.max(1, t.pages.length)) };
}
