// =====================================================================
//  themes.ts — curated SCREEN TEMPLATES for the gauge. A theme sets up the
//  PAGES (layout + which values + colours + how many) as a starting point; the
//  user's car settings (drivetrain / redline / units / brightness / mass) are
//  kept. Apply → the preview updates → tweak → Save writes it to the gauge.
//  Built-in only for now (no backend); community themes come later.
// =====================================================================
import { Ch, Layout, channelDef, type GaugeCfg, GAUGE_PAGES, SLOTS_PER_PAGE } from './founderGaugeCfg';

// RGB565 accents (match the CI + the sim palette).
const WHITE = 0xFFFF;

type ThemePage = { layout: number; ch: number[]; arc: number; col2?: number; text?: number };
export interface GaugeTheme {
  id: string; name: string; desc: string;
  accent: number;                 // for the theme card chrome
  pages: ThemePage[];             // 1..GAUGE_PAGES
  price?: number;                 // THB; 0/undefined = free (built-in)
  author?: string;                // "SN Motorsports" for first-party, later a creator
  tag?: string;                   // short badge: "PRO", "NEW", "EV"…
}

// THB price of a theme (0 = free). Central helper so UI never reads .price raw.
export const themePrice = (t: GaugeTheme): number => t.price ?? 0;
export const isFree = (t: GaugeTheme): boolean => themePrice(t) <= 0;

// A theme is a layout the gauge does not already have. The eight entries that
// used to sit here — Minimal Gold, Track Red, Neon Blue, Classic, Dyno, EV,
// Apex, Aurora — were all HERO/TICKS/NEEDLE/BARS in different colours, i.e.
// things the owner can already build for free in the editor in under a minute.
// Selling those is selling nothing. TUNER is the first entry that earns the
// word: an artwork the gauge cannot draw until it is bought.
const CYAN = 0x3E5D;   // #3FC8E8  TUNER's accent, from the sim
const STEEL = 0x39C9;  // #39404A  honeycomb — its OWN colour, not tied to the accent

// TUNER is FOUR slots (owner 2026-07-18): a dot tacho, the arc (a SLOT whose label
// follows whatever channel is dropped in — reads EV / BOOST / WATER, never a
// borrowed name), and a readout that stacks a big PRIMARY over a small SECONDARY.
// SOC is the arc default because a T8's battery drains under throttle and refills
// on regen — a real instrument on this car, not decoration; the readout defaults
// pair a live pressure with coolant so the plate reads useful out of the box.
const TUNER = (dot: number, arc: number,
              pri: number = Ch.BOOST, sec: number = Ch.COOLANT): ThemePage =>
  ({ layout: Layout.TUNER, ch: [dot, arc, pri, sec, 0], arc: CYAN, col2: STEEL, text: WHITE });

export const THEMES: GaugeTheme[] = [
  { id: 'tuner', name: 'Tuner', accent: CYAN, price: 199, tag: 'NEW', author: 'SN Motorsports',
    desc: 'Import-scene dash, drawn from scratch: a stepped energy arc that carries ' +
          'its own label, a dot tacho with the redline as a red arc, and a floating ' +
          'triangle pointer that strobes at the limit. The arc is a slot — pick what it shows.',
    pages: [ TUNER(Ch.RPM, Ch.SOC,   Ch.BOOST, Ch.COOLANT),
             TUNER(Ch.RPM, Ch.BOOST, Ch.SPEED, Ch.COOLANT),
             TUNER(Ch.RPM, Ch.PWR,   Ch.BOOST, Ch.SOC) ] },
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
