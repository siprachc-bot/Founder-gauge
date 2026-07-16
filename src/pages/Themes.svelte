<script lang="ts">
  // Theme Store — its own tab. Browse curated SCREEN TEMPLATES (each sets a
  // gauge's pages/layout/colours), preview them exactly as they'll look on the
  // glass, and Apply → hands off to the Gauge editor (store.applyTheme) so the
  // owner can tweak + Save. Free (first-party) themes apply instantly; paid
  // packs show a price and a Get button (real purchase flow is not wired yet —
  // see the note under "Selling" in chat).
  import GaugePreview from '../lib/GaugePreview.svelte';
  import { chanMeta } from '../lib/gaugeRender';
  import { rgb565ToHex } from '../lib/founderGaugeCfg';
  import { THEMES, themePrice, isFree, type GaugeTheme } from '../lib/themes';
  import { store } from '../lib/store.svelte';

  let getting = $state<string | null>(null);   // id of the paid theme mid-"Get"
  let note = $state('');

  const owned = (t: GaugeTheme) => isFree(t) || store.isOwned(t.id);

  function apply(t: GaugeTheme) {
    store.applyTheme(t);                        // → switches to Gauge tab + previews
    note = `Applied "${t.name}" — opening the editor to tweak & Save.`;
  }

  function get(t: GaugeTheme) {
    // Purchase flow placeholder. On iOS, selling in-app digital content requires
    // Apple In-App Purchase (StoreKit); until that's wired, offer a local
    // test-unlock in this founder build only.
    getting = getting === t.id ? null : t.id;
  }
  function testUnlock(t: GaugeTheme) {
    store.markOwned(t.id); getting = null;
    note = `Unlocked "${t.name}" (test). Apply it any time.`;
  }
</script>

<div class="store">
  <header class="store-head">
    <h1>Theme Store</h1>
    <p>Screen templates for your AXIS gauge — tap a look, tweak it, save it.</p>
  </header>

  {#if note}<p class="note">{note}</p>{/if}

  <div class="grid">
    {#each THEMES as t (t.id)}
      <div class="card" style="--acc:{rgb565ToHex(t.accent)}">
        <div class="thumb">
          <GaugePreview layout={t.pages[0].layout} arc={rgb565ToHex(t.pages[0].arc)}
            col2={rgb565ToHex(t.pages[0].col2 || t.pages[0].arc)}
            text={rgb565ToHex(t.pages[0].text || 0xffff)}
            ch={t.pages[0].ch} chan={chanMeta} size={150} />
          {#if t.tag}<span class="tag">{t.tag}</span>{/if}
        </div>

        <div class="meta">
          <div class="row">
            <span class="name">{t.name}</span>
            {#if isFree(t)}
              <span class="price free">FREE</span>
            {:else if store.isOwned(t.id)}
              <span class="price owned">OWNED</span>
            {:else}
              <span class="price">฿{themePrice(t)}</span>
            {/if}
          </div>
          <span class="desc">{t.desc}</span>
          {#if t.author}<span class="author">{t.author}</span>{/if}

          {#if owned(t)}
            <button class="btn apply" onclick={() => apply(t)}>Apply</button>
          {:else}
            <button class="btn get" onclick={() => get(t)}>Get · ฿{themePrice(t)}</button>
            {#if getting === t.id}
              <div class="buybox">
                <p>Purchases aren’t enabled in this build yet.</p>
                <button class="btn unlock" onclick={() => testUnlock(t)}>Unlock (test)</button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <p class="foot">More themes coming — and soon, share or sell your own.</p>
</div>

<style>
  .store { display: flex; flex-direction: column; gap: var(--s-3); }
  .store-head h1 { margin: 0; font-size: 22px; font-weight: 800; }
  .store-head p  { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .note {
    margin: 0; padding: 8px 12px; border-radius: 10px; font-size: 13px;
    background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--fg);
  }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--s-3); }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--card, #14161a); border: 1px solid #23272d; border-radius: 14px;
  }
  .thumb {
    position: relative; display: flex; justify-content: center; align-items: center;
    padding: 12px 0 8px; background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--acc) 12%, #000), #000);
  }
  .tag {
    position: absolute; top: 8px; right: 8px; padding: 2px 7px; border-radius: 999px;
    font-size: 10px; font-weight: 800; letter-spacing: .5px;
    background: var(--acc); color: #000;
  }
  .meta { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px 12px; }
  .row  { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
  .name { font-weight: 700; font-size: 15px; }
  .price { font-size: 12px; font-weight: 800; color: var(--acc); white-space: nowrap; }
  .price.free  { color: var(--muted); }
  .price.owned { color: #3b9c4f; }
  .desc   { color: var(--muted); font-size: 12px; line-height: 1.35; min-height: 32px; }
  .author { color: #6a6f78; font-size: 11px; }
  .btn {
    margin-top: 8px; padding: 9px; border: 0; border-radius: 10px;
    font-weight: 700; font-size: 14px; cursor: pointer;
  }
  .btn.apply  { background: var(--acc); color: #000; }
  .btn.get    { background: transparent; color: var(--acc); border: 1px solid var(--acc); }
  .buybox { margin-top: 8px; padding: 8px; border-radius: 10px; background: #1b1e23; }
  .buybox p { margin: 0 0 6px; font-size: 11.5px; color: var(--muted); }
  .btn.unlock { margin: 0; width: 100%; background: #2a2e35; color: var(--fg); font-size: 13px; }
  .foot { margin: 4px 0 0; text-align: center; color: #6a6f78; font-size: 12px; }
</style>
