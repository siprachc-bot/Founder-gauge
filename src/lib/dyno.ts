// =====================================================================
//  dyno.ts — turn a pulled drive log into a POWER/TORQUE curve.
//
//  Same physics as the firmware VirtualDyno (axis_can_monitor/ui/VirtualDyno.h):
//      F        = m·a  +  ½·ρ·CdA·v²  +  Crr·m·g      (accel + aero + rolling)
//      P_wheel  = F·v
//      P_crank  = P_wheel / η                          (η = driveline efficiency)
//      torque   = P_crank / ω_engine                   (ω = rpm·2π/60)
//
//  The drive log only carries speed + rpm (no power field), so we DERIVE the
//  curve here exactly as the gauge does live — then plot hp & Nm vs rpm.
//  Finds the best full-throttle pull, sweeps it into rpm bins, smooths, and
//  reports the peaks. Everything offline in the app; no new firmware/wire data.
// =====================================================================
import type { DriveSample } from './driveLog';

export interface DynoPoint { rpm: number; hp: number; nm: number; }
export interface DynoResult {
  curve:  DynoPoint[];                     // binned + smoothed, ascending rpm
  peakHp: { hp: number; rpm: number };
  peakNm: { nm: number; rpm: number };
  gear:   string;                          // gear the pull was in ("EV"/"2"/…)
  rpmLo:  number; rpmHi: number;           // rpm span of the pull
  sampleCount: number;                     // samples that fed the curve
}

const RHO = 1.225;   // air density kg/m³
const G   = 9.81;    // gravity m/s²
const HP  = 745.7;   // W per hp

export interface DynoParams { massKg: number; CdA: number; Crr: number; eff: number; }
export const DYNO_DEFAULT = { CdA: 0.70, Crr: 0.015, eff: 0.85 };

// Centered moving average (window w, odd) — tames the 5 Hz speed quantisation
// before we differentiate it (dv/dt amplifies noise).
function smooth(a: number[], w = 5): number[] {
  const h = (w - 1) >> 1, out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++) { s += a[j]; n++; }
    out[i] = s / n;
  }
  return out;
}

/**
 * Build a dyno curve from a drive log. Returns null if no usable full-throttle
 * pull is present (need throttle high + rpm rising over a decent span).
 */
export function computeDyno(
  samples: DriveSample[],
  massKg: number,
  p: Omit<DynoParams, 'massKg'> = DYNO_DEFAULT,
): DynoResult | null {
  if (samples.length < 8) return null;

  const t  = samples.map(s => s.tSec);
  const v  = smooth(samples.map(s => s.speedKmh / 3.6));   // m/s, smoothed
  const rpm = samples.map(s => s.rpm);

  // Per-sample crank power (W) via central-difference acceleration.
  const powW = new Array<number>(samples.length).fill(0);
  for (let i = 1; i < samples.length - 1; i++) {
    const dt = t[i + 1] - t[i - 1];
    if (dt <= 0) continue;
    const a  = (v[i + 1] - v[i - 1]) / dt;                 // m/s²
    const vi = v[i];
    const F  = massKg * a + 0.5 * RHO * p.CdA * vi * vi + p.Crr * massKg * G;
    const pw = (F * vi) / p.eff;                           // crank watts
    powW[i]  = pw > 0 ? pw : 0;
  }
  const powSm = smooth(powW, 5);

  // ---- Find the best WOT pull: a run of high-throttle, rising-rpm samples ----
  // Score each candidate by peak power; keep the strongest. A shift (rpm drops)
  // or a lift (throttle falls) ends the run.
  let best = { s: -1, e: -1, peak: 0 };
  let runS = -1;
  for (let i = 1; i < samples.length; i++) {
    const wot = samples[i].throttlePct >= 70 && v[i] > 3;   // pedal down + actually moving
    const rising = rpm[i] >= rpm[i - 1] - 150;               // allow tiny dips, break on a real drop
    if (wot && rising) {
      if (runS < 0) runS = i - 1;
    } else if (runS >= 0) {
      const span = rpm[Math.max(runS, i - 1)] - rpm[runS];
      if (span >= 1500 && (t[i - 1] - t[runS]) >= 1.5) {
        let pk = 0; for (let k = runS; k < i; k++) pk = Math.max(pk, powSm[k]);
        if (pk > best.peak) best = { s: runS, e: i - 1, peak: pk };
      }
      runS = -1;
    }
  }
  if (runS >= 0) {                                          // trailing run
    const span = rpm[samples.length - 1] - rpm[runS];
    if (span >= 1500) {
      let pk = 0; for (let k = runS; k < samples.length; k++) pk = Math.max(pk, powSm[k]);
      if (pk > best.peak) best = { s: runS, e: samples.length - 1, peak: pk };
    }
  }
  if (best.s < 0) return null;

  // ---- Bin the pull by rpm (250-rpm bins) — power envelope per bin ----
  const BIN = 250;
  const bins = new Map<number, { hp: number; nm: number }>();
  for (let i = best.s; i <= best.e; i++) {
    if (powSm[i] <= 0 || rpm[i] < 500) continue;
    const key = Math.round(rpm[i] / BIN) * BIN;
    const hp  = powSm[i] / HP;
    const w   = (rpm[i] * 2 * Math.PI) / 60;                // engine ω rad/s
    const nm  = w > 1 ? powSm[i] / w : 0;
    const cur = bins.get(key);
    if (!cur || hp > cur.hp) bins.set(key, { hp, nm });     // envelope: best at each rpm
  }
  const curve: DynoPoint[] = [...bins.entries()]
    .map(([rpm, b]) => ({ rpm, hp: b.hp, nm: b.nm }))
    .sort((a, b) => a.rpm - b.rpm);
  if (curve.length < 3) return null;

  // Light smoothing across bins (the envelope can be jagged).
  const hpS = smooth(curve.map(c => c.hp), 3);
  const nmS = smooth(curve.map(c => c.nm), 3);
  curve.forEach((c, i) => { c.hp = hpS[i]; c.nm = nmS[i]; });

  const peakHp = curve.reduce((m, c) => (c.hp > m.hp ? { hp: c.hp, rpm: c.rpm } : m), { hp: 0, rpm: 0 });
  const peakNm = curve.reduce((m, c) => (c.nm > m.nm ? { nm: c.nm, rpm: c.rpm } : m), { nm: 0, rpm: 0 });

  return {
    curve, peakHp, peakNm,
    gear:  samples[best.s].gear,
    rpmLo: curve[0].rpm, rpmHi: curve[curve.length - 1].rpm,
    sampleCount: best.e - best.s + 1,
  };
}
