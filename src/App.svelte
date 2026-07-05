<script lang="ts">
  // Founder Gauge is a single-screen app: the whole experience (connect +
  // configure + save) lives in MonitorSetup. No router, no bottom nav.
  import MonitorSetup from './pages/MonitorSetup.svelte';
</script>

<main>
  <MonitorSetup />
</main>

<style>
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: var(--s-4);
    gap: var(--s-3);
    padding-bottom: calc(var(--s-4) + env(safe-area-inset-bottom, 0));
  }
</style>
