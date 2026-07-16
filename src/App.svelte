<script lang="ts">
  // Founder Gauge tabs: the gauge config (connect + configure + save) lives in
  // MonitorSetup; a Store tab (curated screen templates, later a marketplace)
  // and a lightweight Community tab (Supabase-backed) sit alongside it.
  import MonitorSetup from './pages/MonitorSetup.svelte';
  import Themes from './pages/Themes.svelte';
  import Community from './pages/Community.svelte';
  import { store } from './lib/store.svelte';

  let tab = $state<'gauge' | 'store' | 'community'>('gauge');

  // The Store tab applies a theme by handing it to the Gauge editor and bumping
  // wantGaugeTab; jump to the Gauge tab so the owner lands on the live preview.
  let seenWant = 0;
  $effect(() => {
    if (store.wantGaugeTab !== seenWant) { seenWant = store.wantGaugeTab; tab = 'gauge'; }
  });
</script>

<nav class="tabs">
  <button class:on={tab === 'gauge'}     onclick={() => tab = 'gauge'}>Gauge</button>
  <button class:on={tab === 'store'}     onclick={() => tab = 'store'}>Store</button>
  <button class:on={tab === 'community'} onclick={() => tab = 'community'}>Community</button>
</nav>

<main>
  {#if tab === 'gauge'}
    <MonitorSetup />
  {:else if tab === 'store'}
    <Themes />
  {:else}
    <Community />
  {/if}
</main>

<style>
  .tabs {
    display: flex; gap: 6px;
    padding: var(--s-3) var(--s-4) 0;
  }
  .tabs button {
    flex: 1; padding: 10px; border: 0; border-radius: 10px 10px 0 0;
    background: transparent; color: var(--muted); font-weight: 700; font-size: 15px; cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tabs button.on { color: var(--fg); border-bottom-color: var(--accent); }
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: var(--s-4);
    gap: var(--s-3);
    padding-bottom: calc(var(--s-4) + env(safe-area-inset-bottom, 0));
  }
</style>
