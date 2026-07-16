<script lang="ts">
  // In-app mini-render of a gauge page — HERO / BARS / NEEDLE / TICKS — so the
  // owner sees the style + colours BEFORE Save (no live-preview-on-the-gauge, which
  // caused all the page-bounce/jump). Not pixel-perfect; just clearly recognisable.
  import { Layout } from './founderGaugeCfg';
  let { layout, arc, col2, text, labels }:
    { layout: number; arc: string; col2: string; text: string; labels: string[] } = $props();

  const C = 50, D = Math.PI / 180;
  // 270° sweep, matching the gauge (start bottom-left, end bottom-right).
  const A0 = 135, A1 = 405;
  const pt = (a: number, r: number) => [C + Math.cos(a * D) * r, C + Math.sin(a * D) * r];
  function arcPath(r: number, f0 = 0, f1 = 1) {
    const [x0, y0] = pt(A0 + (A1 - A0) * f0, r);
    const [x1, y1] = pt(A0 + (A1 - A0) * f1, r);
    const large = (A1 - A0) * (f1 - f0) > 180 ? 1 : 0;
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  const ticks = Array.from({ length: 21 }, (_, i) => i);   // 0..20 across the sweep
  const litLo = 12, litHi = 15;                            // a small "lit window"
</script>

<svg viewBox="0 0 100 100" class="gp" role="img" aria-label="page preview">
  <circle cx="50" cy="50" r="47" class="bezel" />

  {#if layout === Layout.HERO}
    <path d={arcPath(38)} class="track" />
    <path d={arcPath(38, 0, 0.62)} style="stroke:{arc}" class="fill" />
    <text x="50" y="52" class="big" style="fill:{text}">{labels[0] ?? '—'}</text>
    {#if labels[1]}<text x="50" y="66" class="sml">{labels[1]}</text>{/if}

  {:else if layout === Layout.BARS}
    {#each [0,1,2,3] as b}
      <rect x="18" y={22 + b*16} width="64" height="7" rx="3.5" class="bartrack" />
      <rect x="18" y={22 + b*16} width={64 * (0.75 - b*0.13)} height="7" rx="3.5" style="fill:{arc}" />
      <text x="18" y={20 + b*16} class="tiny">{labels[b] ?? ''}</text>
    {/each}

  {:else if layout === Layout.NEEDLE}
    <circle cx="50" cy="50" r="38" class="ring" />
    <!-- short 2nd hand (col2) behind, long primary hand (arc) on top -->
    {#if labels[1]}
      <line x1="50" y1="50" x2={pt(A0 + (A1-A0)*0.30, 22)[0]} y2={pt(A0 + (A1-A0)*0.30, 22)[1]}
            style="stroke:{col2}" class="hand2" />
    {/if}
    <line x1="50" y1="50" x2={pt(A0 + (A1-A0)*0.66, 34)[0]} y2={pt(A0 + (A1-A0)*0.66, 34)[1]}
          style="stroke:{arc}" class="hand1" />
    <circle cx="50" cy="50" r="2.4" style="fill:{arc}" />
    <text x="50" y="82" class="sml" style="fill:{text}">{labels[0] ?? ''}</text>

  {:else}
    <!-- TICKS -->
    {#each ticks as t}
      {@const a = A0 + (A1 - A0) * (t / 20)}
      {@const lit = t >= litLo && t <= litHi}
      <line x1={pt(a, lit ? 34 : 40)[0]} y1={pt(a, lit ? 34 : 40)[1]}
            x2={pt(a, 42)[0]} y2={pt(a, 42)[1]}
            style="stroke:{lit ? arc : 'rgba(255,255,255,.14)'}" stroke-width={lit ? 2.4 : 1.4} stroke-linecap="round" />
    {/each}
    {#if labels[1]}
      <!-- 2nd value: short outer tick in col2 -->
      <line x1={pt(A0 + (A1-A0)*0.85, 44)[0]} y1={pt(A0 + (A1-A0)*0.85, 44)[1]}
            x2={pt(A0 + (A1-A0)*0.85, 47.5)[0]} y2={pt(A0 + (A1-A0)*0.85, 47.5)[1]}
            style="stroke:{col2}" stroke-width="2.6" stroke-linecap="round" />
    {/if}
    <text x="50" y="54" class="big" style="fill:{text}">{labels[0] ?? '—'}</text>
  {/if}
</svg>

<style>
  .gp    { width: 96px; height: 96px; flex: 0 0 auto; }
  .bezel { fill: #000; stroke: #23272d; stroke-width: 1.4; }
  .track { fill: none; stroke: rgba(255,255,255,.10); stroke-width: 5; stroke-linecap: round; }
  .fill  { fill: none; stroke-width: 5; stroke-linecap: round; }
  .ring  { fill: none; stroke: rgba(255,255,255,.10); stroke-width: 1; }
  .bartrack { fill: rgba(255,255,255,.09); }
  .hand1 { stroke-width: 2.4; stroke-linecap: round; }
  .hand2 { stroke-width: 3.4; stroke-linecap: round; }
  .big   { font: 700 15px ui-monospace, monospace; text-anchor: middle; dominant-baseline: middle; }
  .sml   { font: 600 8px ui-monospace, monospace; text-anchor: middle; fill: #8a8f98; }
  .tiny  { font: 600 5px ui-monospace, monospace; fill: #8a8f98; }
</style>
