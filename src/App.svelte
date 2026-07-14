<script lang="ts">
  // Founder Gauge: the gauge config (connect + configure + save) lives in
  // MonitorSetup; a lightweight Community tab (Supabase-backed) sits alongside it.
  import MonitorSetup from './pages/MonitorSetup.svelte';
  import Community from './pages/Community.svelte';

  let tab = $state<'gauge' | 'community'>('gauge');
</script>

<nav class="tabs">
  <button class:on={tab === 'gauge'}     onclick={() => tab = 'gauge'}>Gauge</button>
  <button class:on={tab === 'community'} onclick={() => tab = 'community'}>Community</button>
</nav>

<main>
  {#if tab === 'gauge'}
    <MonitorSetup />
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
