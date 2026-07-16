<script lang="ts">
  // Faithful in-app render of a gauge page (canvas) — looks like the real AMOLED
  // gauge. Style + colours are shown here so the owner previews without touching
  // the glass; Save is what writes to the gauge.
  import { renderGaugePreview, ensureGaugeFont, type ChanLookup } from './gaugeRender';
  let { layout, arc, col2, text, chan, ch, size = 116 }:
    { layout: number; arc: string; col2: string; text: string;
      chan: ChanLookup; ch: number[]; size?: number } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  // Canvas bakes in whatever font exists at draw time and never revisits it, so
  // the first paint can land before Psionic arrives. Flip this when the font
  // resolves and the effect re-runs — one redraw, and the CI font is real.
  let fontLoaded = $state(false);
  ensureGaugeFont().then(() => (fontLoaded = true));

  $effect(() => {
    fontLoaded;                                         // redraw once the CI font lands
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const px = size * dpr;
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(px / 466, 0, 0, px / 466, 0, 0);   // 466-space → display px
    renderGaugePreview(ctx, { layout, arc, col2, text, ch }, chan);
  });
</script>

<canvas bind:this={canvas} style="width:{size}px;height:{size}px" aria-label="page preview"></canvas>

<style>
  canvas { display: block; flex: 0 0 auto; border-radius: 50%; background: #000; }
</style>
