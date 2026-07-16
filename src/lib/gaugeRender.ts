// =====================================================================
//  gaugeRender.ts — a FAITHFUL canvas render of a gauge page, matching the
//  real AMOLED gauge (axis_can_monitor ScreenGauge / axis_gauge sim). Used by
//  GaugePreview.svelte in BOTH apps so "preview in the app" looks like the
//  actual device. No live data — draws a representative value so the style +
//  colours + layout read exactly as they will on the glass.
//
//  Coordinate system = the device's 466×466 (CX=CY=233); the component scales
//  the canvas down. Ported from axis_gauge/sim/gauge.html.
// =====================================================================
import { channelDef } from './founderGaugeCfg';

export interface ChanMeta { label: string; unit: string; min: number; max: number; }
export interface PagePreview {
  layout: number;                 // 0 HERO · 1 BARS · 2 NEEDLE · 3 TICKS
  ch: number[];                   // channel ids per slot
  arc: string; col2: string; text: string;   // resolved css colours
}
export type ChanLookup = (id: number) => ChanMeta | null;

// Shared channel → preview-meta lookup (short label, unit, range). Used by every
// GaugePreview so the editor and the Store render channels identically.
// ⚠️ Ch.NONE (0) HAS a CHANNELS entry — '— empty —', range 0..1 — so channelDef
// happily returns an object for it and every `if (m)` guard downstream sails
// straight through. That's why empty bars were drawing "0.62" with a 62%-full
// track: 0.62 of the range 0..1. An empty slot is not a channel; say so here,
// once, rather than making every caller special-case id 0.
export const chanMeta: ChanLookup = (id) => {
  if (!id) return null;                       // Ch.NONE — empty slot
  const d = channelDef(id);
  return d ? { label: d.short ?? d.label, unit: d.unit, min: d.min, max: d.max } : null;
};

const SZ = 466, CX = 233, CY = 233, D = Math.PI / 180;
const MUT = '#6a6f78', LBL = '#9aa0a8', TRACK = '#181a1e';
// ---- TYPE, SIZED FROM THE DEVICE ------------------------------------------
// The glass draws with Adafruit-GFX faces compiled from this very OTF
// (axis_can_monitor/Psionic.h, via fontconvert). So the preview names the
// DEVICE FACE and converts — it never carries a px number of its own, which is
// how the two drifted apart in the first place.
//
// ⚠️ GFX "pt" is NOT px. psionic13pt7b's digits stand 20px tall on the glass;
//    the old code wrote `20px` and got 14px. Same number, different unit.
//
// cap = digit '0' height, adv = digit '0' xAdvance. BOTH read out of Psionic.h's
// glyph table — not guessed, not derived.
const FACE = {
  p6:  { cap:  8, adv: 11 },
  p8:  { cap: 11, adv: 15 },
  p10: { cap: 14, adv: 18 },
  p13: { cap: 20, adv: 26 },
  p20: { cap: 27, adv: 36 },
  p48: { cap: 66, adv: 86 },
} as const;
const EM_PER_CAP = 1 / 0.70;   // Psionic's cap is 0.70 em (canvas-measured)
const OTF_ADV    = 0.978;      // the live OTF's digit advance / em (canvas-measured)

// ⚠️ WHY letterSpacing: matching cap height alone is NOT enough. The device's
// faces are BITMAPS that fontconvert rasterised and rounded to whole pixels, so
// their advance is 4–8% tighter than the OTF's at the same cap height (ratio
// 0.900–0.963 vs the OTF's 0.978, and it varies per face). Left uncorrected the
// preview runs ~7% wide: "4960" measured 368.9px and overflowed HERO's 366px
// clear — while on the glass it is 4×86 = 344px and fits with 22px to spare.
// A preview that invents an overflow the device won't have is worse than no
// preview, so each face carries its own correction.
// ⚠️ NO weight argument either: Psionic.h is a SINGLE face and the panel cannot
// embolden. Asking the browser for 700 gets synthetic bold the glass can't show.
function setDevFont(ctx: CanvasRenderingContext2D, face: keyof typeof FACE, mul = 1): void {
  const f = FACE[face];
  const em = f.cap * mul * EM_PER_CAP;
  ctx.font = `${em.toFixed(1)}px Psionic, Orbitron, 'Arial Narrow', sans-serif`;
  // Unsupported on older WebKit — it degrades to the ~7% over-wide render, never breaks.
  ctx.letterSpacing = `${(f.adv * mul - em * OTF_ADV).toFixed(2)}px`;
}

// ⚠️ Canvas does NOT re-render when a webfont finishes loading. Unlike DOM text
// it has no font-display behaviour: whatever is available at fillText() time is
// baked in, and it stays wrong. So the font must be resolved BEFORE the first
// draw, and the caller must redraw once this settles.
let fontReady: Promise<unknown> | null = null;
export function ensureGaugeFont(): Promise<unknown> {
  if (fontReady) return fontReady;
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  fontReady = fonts?.load
    ? Promise.all([fonts.load('400 82px Psionic'), fonts.load('700 82px Psionic')])
        .then(() => fonts.ready)
        .catch(() => undefined)          // never block the preview on a font miss
    : Promise.resolve();
  return fontReady;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function dim(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${Math.round(((n >> 16) & 255) * t)},${Math.round(((n >> 8) & 255) * t)},${Math.round((n & 255) * t)})`;
}
// A representative reading + its format, from the channel's range (0.62 of span).
function sample(m: ChanMeta): { frac: number; text: string; unit: string; label: string } {
  const frac = 0.62;
  const v = m.min + frac * (m.max - m.min);
  const span = m.max - m.min;
  const txt = span <= 3 ? v.toFixed(2) : span <= 25 ? v.toFixed(1) : String(Math.round(v / 10) * 10);
  return { frac, text: txt, unit: m.unit, label: m.label.toUpperCase() };
}

export function renderGaugePreview(
  ctx: CanvasRenderingContext2D, page: PagePreview, chan: ChanLookup,
): void {
  ctx.clearRect(0, 0, SZ, SZ);
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.arc(CX, CY, 231, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = '#23272d'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(CX, CY, 231, 0, 2 * Math.PI); ctx.stroke();
  ctx.textAlign = 'center';

  const { arc, col2, text } = page;
  const m0 = chan(page.ch[0]);
  const A0 = 135, A1 = 405;

  if (page.layout === 1) {                       // ---- BARS ----
    const ys = [150, 210, 270, 330];             // ScreenGauge renderBars
    for (let i = 0; i < 4; i++) {
      const m = chan(page.ch[i]); const y = ys[i];
      const R = 210, dy = y - CY, hw = Math.sqrt(Math.max(0, R * R - dy * dy));
      const bw = Math.max(40, Math.min(hw - 8, 150) * 2), bx = CX - bw / 2;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';        // device: top_left
      ctx.fillStyle = m ? LBL : '#4a4f57'; setDevFont(ctx, 'p8');
      ctx.fillText(m ? m.label.toUpperCase() : '—', bx, y - 26);
      ctx.fillStyle = TRACK; roundRect(ctx, bx, y - 7, bw, 14, 7);
      if (m) {
        const s = sample(m);
        ctx.save(); ctx.shadowColor = arc; ctx.shadowBlur = 8;
        ctx.fillStyle = arc; roundRect(ctx, bx, y - 7, bw * s.frac, 14, 7); ctx.restore();
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';  // device: bottom_right
        ctx.fillStyle = text; setDevFont(ctx, 'p13');
        ctx.fillText(s.text + (s.unit ? ' ' + s.unit : ''), bx + bw, y - 10);
      }
    }
    return;
  }

  if (page.layout === 2) {                       // ---- NEEDLE (chronograph) ----
    // Mirrors ScreenGauge renderNeedle after the 2026-07-16 redesign: the primary
    // owns the whole dial, the 2nd value gets its OWN sub-dial with its own pivot
    // and scale. Was two hands on one pivot, which forced both values onto a
    // single sweep and made neither readable against it.
    const m1 = chan(page.ch[1]);
    const SX = 233, SY = 338, SR = 86;           // sub-dial, measured off the mock
    ctx.strokeStyle = 'rgba(154,160,168,.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(CX, CY, 196, 0, 2 * Math.PI); ctx.stroke();
    for (let q = 0; q < 4; q++) { const a = (q * 90) * D;      // main crosshair
      ctx.strokeStyle = 'rgba(154,160,168,.15)';
      ctx.beginPath(); ctx.moveTo(CX + Math.cos(a) * 70, CY + Math.sin(a) * 70);
      ctx.lineTo(CX + Math.cos(a) * 231, CY + Math.sin(a) * 231); ctx.stroke(); }
    if (m1) {                                    // sub-dial frame + its crosshair
      ctx.strokeStyle = 'rgba(154,160,168,.45)';
      ctx.beginPath(); ctx.arc(SX, SY, SR, 0, 2 * Math.PI); ctx.stroke();
      for (let q = 0; q < 4; q++) { const a = (q * 90) * D;
        ctx.strokeStyle = 'rgba(154,160,168,.28)';
        ctx.beginPath(); ctx.moveTo(SX + Math.cos(a) * SR * 0.55, SY + Math.sin(a) * SR * 0.55);
        ctx.lineTo(SX + Math.cos(a) * SR, SY + Math.sin(a) * SR); ctx.stroke(); }
    }
    // Tapered hand with a counterweight TAIL past the pivot — the tail is what
    // tells the eye where the pivot is, which only matters now there are two.
    const hand = (ox: number, oy: number, f: number, w: number, len: number, tail: number, col: string) => {
      const a = (A0 + (A1 - A0) * f) * D, c = Math.cos(a), s = Math.sin(a);
      const px = -s, py = c, bx = ox - c * tail, by = oy - s * tail;
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(bx + px * w, by + py * w);
      ctx.lineTo(ox + c * len, oy + s * len);
      ctx.lineTo(bx - px * w, by - py * w);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(bx, by, w, 0, 2 * Math.PI); ctx.fill();
      ctx.restore();
    };
    if (m1) hand(SX, SY, sample(m1).frac, 2.0, 78, 9, col2);          // sub-dial hand
    if (m0) hand(CX, CY, sample(m0).frac, 3.4, 192, 35, arc);         // primary + tail
    if (m0) {
      const s = sample(m0);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = LBL; setDevFont(ctx, 'p13'); ctx.fillText(s.label, CX, 160);
      ctx.fillStyle = text; setDevFont(ctx, 'p20'); ctx.fillText(s.text, CX, 189);
      ctx.fillStyle = MUT;  setDevFont(ctx, 'p8');  ctx.fillText(s.unit, CX, 209);
    }
    if (m1) {                                    // 2nd value reads INSIDE its sub-dial
      const s2 = sample(m1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = MUT;  setDevFont(ctx, 'p10'); ctx.fillText(s2.label, SX, 367);
      ctx.fillStyle = text; setDevFont(ctx, 'p13'); ctx.fillText(s2.text, SX, 393);
    }
    return;
  }

  if (page.layout === 3) {                       // ---- TICKS ----
    const NT = 40, RR = 210, MAJ = 5, PAT = [10, 30, 75, 100, 75, 30, 10];
    const patAt = (d: number) => { const x = Math.abs(d); if (x >= 3) return 0;
      const i = Math.floor(x), t = x - i; return (PAT[3 + i] + (PAT[3 + i + 1] - PAT[3 + i]) * t) / 100; };
    const tick = (i: number, len: number, w: number, col: string) => {
      const a = (A0 + (A1 - A0) * (i / (NT - 1))) * D, c = Math.cos(a), s = Math.sin(a);
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(CX + c * (RR - len), CY + s * (RR - len)); ctx.lineTo(CX + c * RR, CY + s * RR); ctx.stroke();
    };
    const fi = (m0 ? sample(m0).frac : 0) * (NT - 1);
    for (let i = 0; i < NT; i++) {               // faint anchors
      if (!(i % MAJ === 0 || i === NT - 1)) continue;
      if (Math.abs(i - fi) < 3) continue;
      tick(i, 13, 3, 'rgba(255,255,255,.08)');
    }
    ctx.save();
    for (let i = Math.ceil(fi - 3); i <= Math.floor(fi + 3); i++) {   // neon window
      if (i < 0 || i >= NT) continue;
      const k = patAt(i - fi); if (k <= 0.01) continue;
      const len = 9 + 15 * k, w = 3 + 1.5 * k;
      ctx.shadowColor = arc; ctx.shadowBlur = 24 * k;
      tick(i, len, w, dim(arc, k));
      if (k > 0.9) { ctx.shadowColor = 'rgba(255,255,255,.9)'; ctx.shadowBlur = 14;
        tick(i, len, w * 0.5, `rgba(255,255,255,${0.55 * (k - 0.9) / 0.1})`); }
    }
    ctx.restore();
    const m1 = chan(page.ch[1]);
    if (m1) {                                    // 2nd value: short outer tick
      const a = (A0 + (A1 - A0) * sample(m1).frac) * D, c = Math.cos(a), s = Math.sin(a);
      ctx.save(); ctx.shadowColor = col2; ctx.shadowBlur = 20;
      ctx.strokeStyle = col2; ctx.lineWidth = 3; ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(CX + c * 220, CY + s * 220); ctx.lineTo(CX + c * 230, CY + s * 230); ctx.stroke();
      ctx.restore();
    }
    if (m0) {                                    // ScreenGauge renderTicks
      const s = sample(m0);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';  // device: middle_center
      ctx.fillStyle = LBL; setDevFont(ctx, 'p10');
      ctx.fillText(s.label, CX, CY - (m1 ? 50 : 42));
      ctx.fillStyle = text;
      if (m1) setDevFont(ctx, 'p20', 1.6); else setDevFont(ctx, 'p48');
      ctx.fillText(s.text, CX, CY + (m1 ? 0 : 8));
      ctx.fillStyle = arc; setDevFont(ctx, 'p8');
      ctx.fillText(s.unit, CX, CY + (m1 ? 40 : 52));
      if (m1) { const s2 = sample(m1);
        ctx.fillStyle = MUT;  setDevFont(ctx, 'p8');  ctx.fillText(s2.label, CX, CY + 68);
        ctx.fillStyle = col2; setDevFont(ctx, 'p13'); ctx.fillText(s2.text + ' ' + s2.unit, CX, CY + 96); }
    }
    return;
  }

  // ---- HERO (default) ----
  band(ctx, 196, 13, A0, A1, TRACK);
  if (m0) {
    const s = sample(m0);
    ctx.save(); ctx.shadowColor = arc; ctx.shadowBlur = 10;
    band(ctx, 196, 13, A0, A0 + (A1 - A0) * s.frac, arc); ctx.restore();
    // ScreenGauge renderHero — every datum on the device is middle_center
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = LBL; setDevFont(ctx, 'p10');
    ctx.fillText(s.label, CX, CY - 56);
    ctx.fillStyle = text; setDevFont(ctx, 'p48');
    ctx.fillText(s.text, CX, CY + 4);
    ctx.fillStyle = MUT; setDevFont(ctx, 'p8');
    ctx.fillText(s.unit, CX, CY + 52);
  } else {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = MUT; setDevFont(ctx, 'p20'); ctx.fillText('—', CX, CY);
  }
  const m1 = chan(page.ch[1]);
  if (m1) {
    const s = sample(m1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = LBL; setDevFont(ctx, 'p10');           // device: y=334 absolute
    ctx.fillText(s.label, CX, 334);
    ctx.fillStyle = text; setDevFont(ctx, 'p20');          // device: y=374, 20pt
    ctx.fillText(s.text + (s.unit ? ' ' + s.unit : ''), CX, 374);
  }
}

function band(ctx: CanvasRenderingContext2D, rmid: number, half: number, a0: number, a1: number, col: string) {
  ctx.strokeStyle = col; ctx.lineWidth = 2 * half; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(CX, CY, rmid, a0 * D, a1 * D, false); ctx.stroke();
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (w <= 0) return; r = Math.min(r, h / 2, w / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
}
