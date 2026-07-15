<script lang="ts">
  // Power (hp) + torque (Nm) vs rpm — a classic dyno chart, drawn as inline SVG
  // (no chart lib in the Capacitor webview). AXIS palette: gold power, blue torque.
  import type { DynoResult } from './dyno';
  let { result, redline = 7000 }: { result: DynoResult; redline?: number } = $props();

  const W = 340, H = 220;                    // viewBox units
  const mL = 34, mR = 34, mT = 14, mB = 26;  // margins (left hp axis, right Nm axis)
  const iw = W - mL - mR, ih = H - mT - mB;

  const GOLD = '#C9A24A', BLUE = '#4FC3F7';

  // Axis ranges — round the tops up to a clean number, x spans 0..redline.
  const niceTop = (v: number) => { const s = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / s * 1.1) * s; };
  const hpMax = $derived(niceTop(result.peakHp.hp));
  const nmMax = $derived(niceTop(result.peakNm.nm));
  const rpmMax = $derived(Math.max(redline, result.rpmHi + 200));

  const x  = (rpm: number) => mL + (rpm / rpmMax) * iw;
  const yH = (hp: number)  => mT + ih - (hp / hpMax) * ih;
  const yN = (nm: number)  => mT + ih - (nm / nmMax) * ih;

  const path = (pts: string) => pts;
  const hpPath = $derived(result.curve.map((c, i) => `${i ? 'L' : 'M'}${x(c.rpm).toFixed(1)} ${yH(c.hp).toFixed(1)}`).join(' '));
  const nmPath = $derived(result.curve.map((c, i) => `${i ? 'L' : 'M'}${x(c.rpm).toFixed(1)} ${yN(c.nm).toFixed(1)}`).join(' '));
  const hpArea = $derived(`${hpPath} L${x(result.curve[result.curve.length-1].rpm).toFixed(1)} ${mT+ih} L${x(result.curve[0].rpm).toFixed(1)} ${mT+ih} Z`);

  const rpmTicks = $derived(Array.from({ length: Math.floor(rpmMax / 1000) + 1 }, (_, i) => i * 1000));
  const hpTicks  = $derived([0, 0.25, 0.5, 0.75, 1].map(f => Math.round(f * hpMax)));
</script>

<svg viewBox="0 0 {W} {H}" class="dyno" role="img" aria-label="Dyno power and torque curves">
  <!-- horizontal grid + left (hp) axis labels -->
  {#each hpTicks as hv}
    <line x1={mL} x2={mL+iw} y1={yH(hv)} y2={yH(hv)} class="grid" />
    <text x={mL-4} y={yH(hv)+3} class="ax hp" text-anchor="end">{hv}</text>
  {/each}
  <!-- right (Nm) axis labels -->
  {#each [0,0.5,1].map(f=>Math.round(f*nmMax)) as nv}
    <text x={mL+iw+4} y={yN(nv)+3} class="ax nm" text-anchor="start">{nv}</text>
  {/each}
  <!-- rpm ticks -->
  {#each rpmTicks as rv}
    <line x1={x(rv)} x2={x(rv)} y1={mT} y2={mT+ih} class="grid v" />
    <text x={x(rv)} y={H-8} class="ax" text-anchor="middle">{rv/1000|0}k</text>
  {/each}
  <!-- redline -->
  {#if redline < rpmMax}
    <line x1={x(redline)} x2={x(redline)} y1={mT} y2={mT+ih} class="redline" />
  {/if}

  <!-- torque (blue) under power, then power (gold) on top -->
  <path d={nmPath} class="tq" />
  <path d={hpArea} class="pw-fill" />
  <path d={hpPath} class="pw" />

  <!-- peak markers -->
  <circle cx={x(result.peakHp.rpm)} cy={yH(result.peakHp.hp)} r="2.6" fill={GOLD} />
  <circle cx={x(result.peakNm.rpm)} cy={yN(result.peakNm.nm)} r="2.6" fill={BLUE} />
</svg>

<div class="peaks">
  <span class="pk hp"><b>{Math.round(result.peakHp.hp)}</b> hp <small>@ {result.peakHp.rpm.toLocaleString()}</small></span>
  <span class="pk nm"><b>{Math.round(result.peakNm.nm)}</b> Nm <small>@ {result.peakNm.rpm.toLocaleString()}</small></span>
  <span class="pk g">gear {result.gear}</span>
</div>

<style>
  .dyno { width: 100%; height: auto; display: block; }
  .grid   { stroke: rgba(255,255,255,.07); stroke-width: .5; }
  .grid.v { stroke: rgba(255,255,255,.04); }
  .redline{ stroke: #e24b4a; stroke-width: .8; stroke-dasharray: 3 3; opacity: .6; }
  .ax     { fill: #6a6f78; font-size: 8px; font-family: ui-monospace, monospace; }
  .ax.hp  { fill: #C9A24A; } .ax.nm { fill: #4FC3F7; }
  .tq     { fill: none; stroke: #4FC3F7; stroke-width: 1.6; stroke-linejoin: round; opacity: .9; }
  .pw     { fill: none; stroke: #C9A24A; stroke-width: 2;   stroke-linejoin: round;
            filter: drop-shadow(0 0 3px rgba(201,162,74,.5)); }
  .pw-fill{ fill: rgba(201,162,74,.10); stroke: none; }
  .peaks  { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-top: 8px; font-size: 13px; }
  .pk b   { font-size: 17px; }
  .pk.hp b{ color: #C9A24A; } .pk.nm b { color: #4FC3F7; }
  .pk small { color: var(--muted); }
  .pk.g   { color: var(--muted); align-self: center; }
</style>
