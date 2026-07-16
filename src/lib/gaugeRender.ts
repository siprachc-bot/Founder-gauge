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
export interface ChanMeta { label: string; unit: string; min: number; max: number; }
export interface PagePreview {
  layout: number;                 // 0 HERO · 1 BARS · 2 NEEDLE · 3 TICKS
  ch: number[];                   // channel ids per slot
  arc: string; col2: string; text: string;   // resolved css colours
}
export type ChanLookup = (id: number) => ChanMeta | null;

const SZ = 466, CX = 233, CY = 233, D = Math.PI / 180;
const MUT = '#6a6f78', LBL = '#9aa0a8', TRACK = '#181a1e';
const FT = (w: number, s: number) => `${w} ${s}px Michroma, ui-monospace, monospace`;
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
    const ys = [140, 205, 270, 335];
    for (let i = 0; i < 4; i++) {
      const m = chan(page.ch[i]); const y = ys[i];
      const R = 210, dy = y - CY, hw = Math.sqrt(Math.max(0, R * R - dy * dy));
      const bw = Math.min(hw - 8, 150) * 2, bx = CX - bw / 2;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = m ? LBL : '#4a4f57'; ctx.font = FT(500, 14);
      ctx.fillText(m ? m.label.toUpperCase() : '—', bx, y - 13);
      ctx.fillStyle = TRACK; roundRect(ctx, bx, y - 7, bw, 14, 7);
      if (m) {
        const s = sample(m);
        ctx.save(); ctx.shadowColor = arc; ctx.shadowBlur = 8;
        ctx.fillStyle = arc; roundRect(ctx, bx, y - 7, bw * s.frac, 14, 7); ctx.restore();
        ctx.textAlign = 'right'; ctx.fillStyle = text; ctx.font = FT(600, 20);
        ctx.fillText(s.text + (s.unit ? ' ' + s.unit : ''), bx + bw, y - 13);
      }
    }
    return;
  }

  if (page.layout === 2) {                       // ---- NEEDLE (clock, 2 hands) ----
    ctx.strokeStyle = 'rgba(154,160,168,.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(CX, CY, 196, 0, 2 * Math.PI); ctx.stroke();
    for (let q = 0; q < 4; q++) { const a = (q * 90 + 45) * D;   // faint crosshair
      ctx.strokeStyle = 'rgba(154,160,168,.15)';
      ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(CX + Math.cos(a) * 150, CY + Math.sin(a) * 150); ctx.stroke(); }
    const m1 = chan(page.ch[1]);
    const hand = (f: number, len: number, w: number, col: string) => {
      const a = (A0 + (A1 - A0) * f) * D, c = Math.cos(a), s = Math.sin(a);
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 14;
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(CX + c * len, CY + s * len); ctx.stroke();
      ctx.restore();
    };
    if (m1) hand(sample(m1).frac, 116, 5, col2);         // short 2nd hand
    if (m0) hand(sample(m0).frac, 188, 2.4, arc);        // long primary hand
    ctx.save(); ctx.shadowColor = arc; ctx.shadowBlur = 8; ctx.fillStyle = arc;
    ctx.beginPath(); ctx.arc(CX, CY, 4, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    if (m0) {
      const s = sample(m0);
      ctx.fillStyle = LBL; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 15);
      ctx.fillText(s.label, CX, CY + 78);
      ctx.fillStyle = text; ctx.textBaseline = 'middle'; ctx.font = FT(700, m1 ? 40 : 50);
      ctx.fillText(s.text, CX, CY + (m1 ? 112 : 118));
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
    if (m0) {
      const s = sample(m0);
      ctx.fillStyle = LBL; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 15);
      ctx.fillText(s.label, CX, CY - (m1 ? 50 : 42));
      ctx.fillStyle = text; ctx.textBaseline = 'middle'; ctx.font = FT(700, m1 ? 44 : 54);
      ctx.fillText(s.text, CX, CY + (m1 ? 0 : 8));
      if (m1) { const s2 = sample(m1);
        ctx.fillStyle = MUT; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 12);
        ctx.fillText(chan(page.ch[1])!.label.toUpperCase(), CX, CY + 68);
        ctx.fillStyle = col2; ctx.font = FT(600, 20); ctx.fillText(s2.text + ' ' + s2.unit, CX, CY + 92); }
    }
    return;
  }

  // ---- HERO (default) ----
  band(ctx, 196, 13, A0, A1, TRACK);
  if (m0) {
    const s = sample(m0);
    ctx.save(); ctx.shadowColor = arc; ctx.shadowBlur = 10;
    band(ctx, 196, 13, A0, A0 + (A1 - A0) * s.frac, arc); ctx.restore();
    ctx.fillStyle = LBL; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 16);
    ctx.fillText(s.label, CX, CY - 46);
    ctx.fillStyle = text; ctx.textBaseline = 'middle'; ctx.font = FT(700, 82);
    ctx.fillText(s.text, CX, CY + 2);
    ctx.fillStyle = MUT; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 15);
    ctx.fillText(s.unit, CX, CY + 40);
  } else {
    ctx.fillStyle = MUT; ctx.textBaseline = 'middle'; ctx.font = FT(700, 40); ctx.fillText('—', CX, CY);
  }
  const m1 = chan(page.ch[1]);
  if (m1) {
    const s = sample(m1);
    ctx.fillStyle = MUT; ctx.textBaseline = 'alphabetic'; ctx.font = FT(500, 12);
    ctx.fillText(s.label, CX, CY + 78);
    ctx.fillStyle = text; ctx.font = FT(600, 24); ctx.fillText(s.text + (s.unit ? ' ' + s.unit : ''), CX, CY + 102);
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
