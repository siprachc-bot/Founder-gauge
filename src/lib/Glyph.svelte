<script lang="ts">
  // =====================================================================
  //  Glyph — the shared minimal monoline-animated status language.
  //  One component, many states. White/mono strokes + a single accent.
  //  Used app-wide for: connecting, loading, saving, connected status,
  //  busy spinner, now-playing EQ. Pure CSS — no deps, animates on mount.
  // =====================================================================
  let {
    kind = 'dots',
    size = 22,
    accent = 'var(--accent, #c9a24a)',
  }: {
    kind?: 'dots' | 'saving' | 'connected' | 'connecting' | 'spinner' | 'eq';
    size?: number;
    accent?: string;
  } = $props();
</script>

{#if kind === 'dots'}
  <span class="g dots" style="--g:{size}px">
    <i></i><i></i><i></i>
  </span>
{:else if kind === 'saving'}
  <span class="g" style="--g:{size}px"><i class="fade"></i></span>
{:else if kind === 'connected'}
  <span class="g" style="--g:{size}px"><i class="breathe" style="background:{accent}"></i></span>
{:else if kind === 'connecting'}
  <span class="g wifi" style="--g:{size}px"><i></i><i></i><i></i><i></i></span>
{:else if kind === 'spinner'}
  <span class="spin" style="width:{size}px;height:{size}px"></span>
{:else if kind === 'eq'}
  <span class="g eq" style="--g:{size}px"><i style="background:{accent}"></i><i style="background:{accent}"></i><i style="background:{accent}"></i><i style="background:{accent}"></i><i style="background:{accent}"></i></span>
{/if}

<style>
  .g { display: inline-flex; align-items: center; justify-content: center; height: var(--g); gap: 3px; }
  .g i { background: var(--fg, #e9e7df); display: block; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; animation: gdb 1.2s infinite; }
  .dots i:nth-child(2) { animation-delay: .18s; }
  .dots i:nth-child(3) { animation-delay: .36s; }
  @keyframes gdb { 0%,80%,100% { transform: translateY(0); opacity: .35; } 40% { transform: translateY(-5px); opacity: 1; } }
  .fade { width: 60%; height: 60%; border-radius: 50%; animation: gfp 1.4s ease-in-out infinite; }
  @keyframes gfp { 0%,100% { transform: scale(.55); opacity: .3; } 50% { transform: scale(1); opacity: 1; } }
  .breathe { width: 10px; height: 10px; border-radius: 50%; animation: gbr 2s ease-in-out infinite; }
  @keyframes gbr { 0%,100% { opacity: .4; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
  .wifi { align-items: flex-end; gap: 3px; }
  .wifi i { width: 4px; border-radius: 1px; animation: gwf 1.6s infinite; }
  .wifi i:nth-child(1) { height: 30%; }
  .wifi i:nth-child(2) { height: 55%; animation-delay: .18s; }
  .wifi i:nth-child(3) { height: 80%; animation-delay: .36s; }
  .wifi i:nth-child(4) { height: 100%; animation-delay: .54s; }
  @keyframes gwf { 0%,70% { opacity: .18; } 25% { opacity: 1; } }
  .eq { align-items: flex-end; gap: 2px; }
  .eq i { width: 3px; height: 100%; border-radius: 1px; transform-origin: bottom; animation: geq .9s ease-in-out infinite; }
  .eq i:nth-child(2) { animation-delay: .15s; } .eq i:nth-child(3) { animation-delay: .3s; }
  .eq i:nth-child(4) { animation-delay: .45s; } .eq i:nth-child(5) { animation-delay: .6s; }
  @keyframes geq { 0%,100% { transform: scaleY(.25); } 50% { transform: scaleY(1); } }
  .spin { border-radius: 50%; border: 2.5px solid var(--border, #2c2a22); border-top-color: var(--fg, #e9e7df); display: inline-block; animation: gsp .9s linear infinite; }
  @keyframes gsp { to { transform: rotate(360deg); } }
</style>
