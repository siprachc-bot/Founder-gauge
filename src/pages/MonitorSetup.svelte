<script lang="ts">
  // =====================================================================
  //  MonitorSetup — the ONE screen of Founder Gauge.
  //
  //  Connect to the AXIS Monitor over BLE, read its 4-page "Custom Gauge"
  //  layout, let the user pick the PRIMARY (big arc) + SUPPORT (small)
  //  channel for each page, then write the 21-byte config back. The monitor
  //  validates + persists to NVS and fires an apply-ack notify.
  //
  //  v1 is HERO-only (each page = 1 big + 1 support value) — matching the
  //  monitor's 4-hero default. The firmware struct still carries a layout
  //  byte + 4 slots, so BARS can be added later with no wire change.
  // =====================================================================
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../lib/PageHeader.svelte';
  import { store } from '../lib/store.svelte';
  import {
    MonitorBleClient, defaultCfg, cfgValid, channelShort, channelDef,
    CHANNELS, CHANNEL_GROUPS, Ch, Layout, ARC_DEFAULT, BRIGHT_DEFAULT,
    hexToRgb565, rgb565ToHex, verStr, verCmp,
    OTA_TARGET_NODE, OTA_TARGET_MONITOR,
    type GaugeCfg, type DeviceVersions,
  } from '../lib/founderGaugeCfg';
  import {
    fetchCanManifest, latest, downloadFirmware, parseVer,
    type CanManifest, type CanReleaseEntry,
  } from '../lib/axisCanOta';

  type Phase = 'unavailable' | 'idle' | 'scanning' | 'connecting' | 'loading' | 'ready';

  let phase   = $state<Phase>('idle');
  let note    = $state('');                 // transient status / error line
  let cfg     = $state<GaugeCfg>(defaultCfg());
  let saved   = $state<GaugeCfg>(defaultCfg());
  let saving  = $state(false);
  let saveResult = $state<'ok' | 'rejected' | null>(null);
  let demo    = $state(false);              // preview the configurator with no gauge (SAVE disabled)

  const PAGE_NAMES = ['MAIN', 'PAGE 2', 'PAGE 3', 'PAGE 4'];

  // Dirty = the on-screen layout differs from what's on the monitor.
  // Compare the NORMALISED cfg (peak null→0, clamped, layout forced) against the
  // already-normalised `saved`, so an emptied peak field (null) doesn't falsely
  // read as "unsaved" when it coerces to the same 0 that's on the device.
  let dirty = $derived(JSON.stringify(normalize(cfg)) !== JSON.stringify(saved));

  const clone = (c: GaugeCfg): GaugeCfg => JSON.parse(JSON.stringify(c));

  // Force every page to HERO with only slots 0 (primary) + 1 (support) live,
  // carrying per-page colour + peak + global brightness. Sanitises anything
  // read off the device (or a NaN from an emptied peak input) too.
  function normalize(c: GaugeCfg): GaugeCfg {
    const d = defaultCfg();
    return {
      version: c.version || d.version,
      pages: c.pages.map(p => {
        const ch: [Ch, Ch, Ch, Ch] =
          [p.ch?.[0] ?? Ch.NONE, p.ch?.[1] ?? Ch.NONE, Ch.NONE, Ch.NONE];
        // Peak (native-unit redline): coerce null/NaN/negative → 0 (off), and
        // clamp to the primary channel's max so a fat-fingered off-scale value
        // (e.g. 99999 on an RPM page) can't be written as a bogus marker.
        const mx = channelDef(ch[0])?.max ?? 0;
        let peak = (Number.isFinite(p.peak) && (p.peak as number) > 0) ? (p.peak as number) : 0;
        if (mx > 0 && peak > mx) peak = mx;
        return { layout: Layout.HERO, ch, arcColor: p.arcColor || ARC_DEFAULT, peak };
      }),
      brightness: Number.isFinite(c.brightness)
        ? Math.max(8, Math.min(255, Math.round(c.brightness))) : BRIGHT_DEFAULT,
    };
  }

  // ---- per-page arc colour (custom picker, no preset lock-in) ----
  const pageHex = (i: number) => rgb565ToHex(cfg.pages[i].arcColor ?? ARC_DEFAULT);
  function setPageColor(i: number, hex: string) { cfg.pages[i].arcColor = hexToRgb565(hex); }

  // ---- per-page peak (native units of the big value) ----
  // Pre-fill the channel's sensible default when the big value changes.
  function onPrimaryChange(i: number) { cfg.pages[i].peak = channelDef(cfg.pages[i].ch[0])?.peak ?? 0; }
  const peakMax  = (i: number) => channelDef(cfg.pages[i].ch[0])?.max ?? 0;
  const peakUnit = (i: number) => channelDef(cfg.pages[i].ch[0])?.unit ?? '';

  // ---- global brightness (live-dims the AMOLED as the slider drags) ----
  function onBrightness(e: Event) {
    const v = +(e.currentTarget as HTMLInputElement).value;
    cfg.brightness = v;
    if (!demo && store.monClient) store.monClient.setBrightness(v).catch(() => {});
  }

  // ---- SN-AXIS-style OTA: pull the latest firmware from the GitHub release
  //      manifest, compare to what the devices report over BLE, install with
  //      one tap. The phone downloads the .bin (it has internet); the monitor
  //      flashes itself (self-OTA) or relays to the sensor over ESP-NOW. ----
  let manifest = $state<CanManifest | null>(null);
  let devVers  = $state<DeviceVersions | null>(null);
  let otaBusy  = $state(false);                     // fetching manifest / versions
  let otaNote  = $state('');
  let otaLoaded = false;                            // fetched once (lazy on expand)

  let flashing = $state<'' | 'monitor' | 'node'>(''); // which target is flashing
  let flashPct = $state(0);
  let flashMsg = $state('');

  const monLatest  = $derived(manifest ? latest(manifest.monitor) : null);
  const nodeLatest = $derived(manifest ? latest(manifest.node) : null);
  const monUpdate  = $derived(!!(monLatest && devVers &&
    verCmp(parseVer(monLatest.version), devVers.monitor) > 0));
  const nodeUpdate = $derived(!!(nodeLatest && devVers?.node &&
    verCmp(parseVer(nodeLatest.version), devVers.node) > 0));

  async function loadOta() {
    if (demo || !store.monClient || otaBusy) return;
    otaBusy = true; otaNote = '';
    try {
      const [m, v] = await Promise.all([
        fetchCanManifest(),
        store.monClient.readVersions().catch(() => null),
      ]);
      manifest = m; devVers = v; otaLoaded = true;
    } catch (e) {
      otaNote = 'Couldn’t load updates: ' + String((e as Error)?.message ?? e);
    } finally {
      otaBusy = false;
    }
  }
  // Lazy-load the manifest the first time the OTA card is opened.
  function onOtaToggle(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !otaLoaded) loadOta();
  }

  async function installUpdate(which: 'monitor' | 'node', entry: CanReleaseEntry) {
    if (!store.monClient || flashing) return;
    flashing = which; flashPct = 0; flashMsg = 'Downloading…';
    try {
      const bin = await downloadFirmware(entry);
      flashMsg = which === 'monitor' ? 'Flashing gauge…' : 'Flashing sensor…';
      const target = which === 'monitor' ? OTA_TARGET_MONITOR : OTA_TARGET_NODE;
      await store.monClient.flash(target, bin, (p) => (flashPct = p));
      flashMsg = which === 'monitor' ? '✓ Gauge updated — rebooting' : '✓ Sensor updated — rebooting';
      otaLoaded = false;
      setTimeout(loadOta, 4500);                    // device reboots; re-read versions
    } catch (e) {
      flashMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      flashing = '';
    }
  }

  // ---- Advanced: install a local .app.bin (pre-publish testing / offline) ----
  let manFile   = $state<Uint8Array | null>(null);
  let manName   = $state('');
  let manTarget = $state<'monitor' | 'node'>('node');
  async function onManPick(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    manFile = new Uint8Array(await f.arrayBuffer());
    manName = f.name; flashMsg = '';
  }
  async function doManFlash() {
    if (!store.monClient || !manFile || flashing) return;
    flashing = manTarget; flashPct = 0; flashMsg = 'Flashing…';
    try {
      const target = manTarget === 'monitor' ? OTA_TARGET_MONITOR : OTA_TARGET_NODE;
      await store.monClient.flash(target, manFile, (p) => (flashPct = p));
      flashMsg = '✓ flashed — rebooting';
    } catch (e) {
      flashMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      flashing = '';
    }
  }

  onMount(async () => {
    if (!(await MonitorBleClient.isAvailable())) { phase = 'unavailable'; return; }
    // Re-use a live link if we still hold one (survived a re-render).
    if (store.monClient) { await afterConnect(); return; }
    // Otherwise try a one-tap reconnect to the last device.
    if (store.lastDeviceId) {
      try {
        note = 'Reconnecting…';
        phase = 'connecting';
        const c = new MonitorBleClient(store.lastDeviceId);
        await c.connect(onDisconnect);
        store.monClient = c;
        await afterConnect();
        return;
      } catch { store.monClient = null; note = ''; }
    }
    phase = 'idle';
  });

  onDestroy(() => { /* keep the link alive in the store across navigations */ });

  function onDisconnect() {
    store.monClient = null;
    phase = 'idle';
    note  = 'Monitor disconnected.';
  }

  // Primary connect path: the OS device chooser (requestDevice). Works on
  // EVERY platform with no experimental flag — iOS/Android Capacitor pop the
  // native picker, desktop/Android Chrome pop the browser picker. This is the
  // reliable path; the live-scan list below is a fallback for where it works.
  async function connectPick() {
    note = '';
    phase = 'connecting';
    try {
      const id = await MonitorBleClient.pick();   // OS chooser → chosen deviceId
      await connectTo(id);
    } catch (e) {
      phase = 'idle';
      const m = String((e as Error)?.message ?? e);
      // A user-cancelled chooser isn't an error worth shouting about.
      note = /cancel|no device|not found/i.test(m) ? '' : m;
    }
  }

  // Fallback when the named "Connect to gauge" chooser turns up empty (e.g. the
  // monitor's advertised name is intermittent under ESP-NOW coexistence): open
  // the OS chooser with NO filter so EVERY nearby BLE device is listed. The user
  // picks "AXIS Monitor" (or its address) manually. Works on every platform,
  // unlike requestLEScan which desktop Chrome gates behind an experimental flag.
  async function connectShowAll() {
    note = '';
    phase = 'connecting';
    try {
      const id = await MonitorBleClient.pickAll();
      await connectTo(id);
    } catch (e) {
      phase = 'idle';
      const m = String((e as Error)?.message ?? e);
      note = /cancel|no device|not found/i.test(m) ? '' : m;
    }
  }

  async function connectTo(id: string) {
    phase = 'connecting';
    note  = 'Connecting…';
    try {
      const c = new MonitorBleClient(id);
      await c.connect(onDisconnect);
      store.monClient = c;
      store.setLastDevice(id);
      await afterConnect();
    } catch (e) {
      store.monClient = null;
      phase = 'idle';
      note  = 'Connect failed: ' + String((e as Error)?.message ?? e);
    }
  }

  // Runs once a link is up: subscribe to the ack notify + read the current cfg.
  async function afterConnect() {
    const c = store.monClient!;
    phase = 'loading';
    note  = 'Reading layout…';
    try {
      await c.onAck(onAck);
    } catch { /* notify optional — save falls back to a re-read */ }
    try {
      const live = normalize(await c.config());
      cfg   = clone(live);
      saved = clone(live);
      note  = '';
      phase = 'ready';
    } catch (e) {
      note  = String((e as Error)?.message ?? e);
      phase = 'ready';           // still let them edit + push (device may be blank)
    }
  }

  async function disconnect() {
    const c = store.monClient;
    store.monClient = null;
    phase = 'idle';
    note = '';
    if (c) { try { await c.offAck(); } catch {} await c.disconnect(); }
  }

  // ---- Save flow: write 21 bytes, then confirm via the ack notify (or a
  //      re-read fallback if the notify never lands). ----
  let saveDone: ((ok: boolean) => void) | null = null;

  function onAck(ok: boolean) {
    if (saveDone) { const f = saveDone; saveDone = null; f(ok); }
  }

  async function doSave() {
    if (!store.monClient || !dirty || saving) return;
    const next = normalize(cfg);
    if (!cfgValid(next)) { saveResult = 'rejected'; return; }
    saving = true; saveResult = null; note = '';

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true; saving = false; saveDone = null;
      saveResult = ok ? 'ok' : 'rejected';
      if (ok) { saved = clone(next); cfg = clone(next); }
      setTimeout(() => { saveResult = null; }, 2500);
    };

    saveDone = finish;
    try {
      await store.monClient.setConfig(next);
      // Fallback: if no ack in 1.5 s, re-read and compare.
      setTimeout(async () => {
        if (settled) return;
        try {
          const back = normalize(await store.monClient!.config());
          finish(JSON.stringify(back) === JSON.stringify(next));
        } catch { finish(false); }
      }, 1500);
    } catch (e) {
      note = 'Write failed: ' + String((e as Error)?.message ?? e);
      finish(false);
    }
  }

  function resetToDevice() { cfg = clone(saved); saveResult = null; }

  // Preview the 4-page configurator with factory defaults and NO gauge — lets
  // a buyer (or an App Store reviewer) see what the app does before pairing.
  // SAVE is disabled; "Disconnect" returns to the connect screen.
  function startDemo() {
    demo = true;
    cfg = defaultCfg();
    saved = defaultCfg();
    note = '';
    phase = 'ready';
  }
  function exitDemo() { demo = false; phase = 'idle'; note = ''; }
</script>

<PageHeader>
  {#if phase === 'ready' && demo}
    <span class="pill busy">◐ Demo</span>
  {:else if phase === 'ready'}
    <span class="pill ok">● Connected</span>
  {:else if phase === 'connecting' || phase === 'loading' || phase === 'scanning'}
    <span class="pill busy">● {phase}…</span>
  {:else}
    <span class="pill">○ Offline</span>
  {/if}
</PageHeader>

{#if phase === 'unavailable'}
  <div class="card msg">
    <h3>Bluetooth not available</h3>
    <p>
      Founder Gauge talks to your AXIS Monitor over Bluetooth. Use the
      <strong>iPhone / Android app</strong> or <strong>Chrome</strong> on desktop —
      Safari on the web can't do Web Bluetooth.
    </p>
    <button class="ghost wide" onclick={startDemo}>Preview the layout →</button>
  </div>

{:else if phase !== 'ready'}
  <!-- ---- Connect screen ---- -->
  <div class="card connect">
    <h3>Connect your gauge</h3>
    <p class="sub">Power on the AXIS Monitor, then connect. It appears as <b>AXIS Monitor</b>.</p>

    <button class="primary" onclick={connectPick} disabled={phase === 'connecting'}>
      {phase === 'connecting' ? 'Connecting…' : 'Connect to gauge'}
    </button>

    <button class="ghost wide" onclick={connectShowAll} disabled={phase === 'connecting'}>
      Can't find it? Show all devices →
    </button>

    {#if note}<p class="note">{note}</p>{/if}
    <button class="ghost wide" onclick={startDemo}>Preview the layout without a gauge →</button>
  </div>

{:else}
  <!-- ---- Configurator: 4 hero pages ---- -->
  {#if note}<p class="note">{note}</p>{/if}

  <div class="pages">
    {#each cfg.pages as page, i (i)}
      <div class="card page-card">
        <div class="page-head">
          <span class="page-tag">{PAGE_NAMES[i]}</span>
          <label class="swatch" style="background: {pageHex(i)}" title="Arc colour">
            <input type="color" value={pageHex(i)}
              oninput={(e) => setPageColor(i, (e.currentTarget as HTMLInputElement).value)}
              aria-label="Arc colour for {PAGE_NAMES[i]}" />
          </label>
        </div>

        <div class="page-body">
          <!-- structural preview: big primary + small support, per-page colour -->
          <svg class="prev" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="46" class="prev-bezel" />
            <path d="M 22 74 A 34 34 0 1 1 78 74" class="prev-arc" style="stroke: {pageHex(i)}" />
            <text x="50" y="46" class="prev-primary">{channelShort(page.ch[0])}</text>
            <text x="50" y="62" class="prev-support">{channelShort(page.ch[1])}</text>
          </svg>

          <div class="pickers">
            <label>
              <span class="lbl">Big value</span>
              <select bind:value={cfg.pages[i].ch[0]} onchange={() => onPrimaryChange(i)}>
                <option value={Ch.NONE}>— empty —</option>
                {#each CHANNEL_GROUPS as g (g)}
                  <optgroup label={g}>
                    {#each CHANNELS.filter(c => c.group === g) as c (c.id)}
                      <option value={c.id}>{c.label}{c.unit ? ` (${c.unit})` : ''}</option>
                    {/each}
                  </optgroup>
                {/each}
              </select>
            </label>
            <label>
              <span class="lbl">Small value</span>
              <select bind:value={cfg.pages[i].ch[1]}>
                <option value={Ch.NONE}>— empty —</option>
                {#each CHANNEL_GROUPS as g (g)}
                  <optgroup label={g}>
                    {#each CHANNELS.filter(c => c.group === g) as c (c.id)}
                      <option value={c.id}>{c.label}{c.unit ? ` (${c.unit})` : ''}</option>
                    {/each}
                  </optgroup>
                {/each}
              </select>
            </label>
            <label class="peak">
              <span class="lbl">Peak / redline <span class="hint">0 = off</span></span>
              <div class="peak-row">
                <input type="number" min="0" max={peakMax(i)} step="any"
                  bind:value={cfg.pages[i].peak} placeholder="off" />
                <span class="peak-unit">{peakUnit(i)}</span>
              </div>
            </label>
          </div>
        </div>
      </div>
    {/each}
  </div>

  <!-- global screen brightness (live-dims as you drag) -->
  <div class="card bright-card">
    <div class="bright-head">
      <span class="lbl">Screen brightness</span>
      <span class="bright-val">{Math.round(cfg.brightness / 255 * 100)}%</span>
    </div>
    <input type="range" min="8" max="255" value={cfg.brightness} oninput={onBrightness} />
  </div>

  <!-- SN-AXIS-style firmware updates (gauge + sensor, from GitHub releases) -->
  {#snippet fwRow(label: string, which: 'monitor' | 'node',
                  cur: string, ent: CanReleaseEntry | null, hasUpdate: boolean)}
    <div class="fw-row">
      <div class="fw-row-main">
        <span class="fw-row-label">{label}</span>
        <span class="fw-row-ver">
          {cur}{#if ent} · latest {ent.version}{/if}
        </span>
      </div>
      {#if flashing === which}
        <span class="fw-row-status">{flashPct}%</span>
      {:else if ent}
        <button class="fw-install" class:up={hasUpdate}
          onclick={() => installUpdate(which, ent)} disabled={flashing !== ''}>
          {hasUpdate ? `Update` : 'Reinstall'}
        </button>
      {:else if manifest}
        <span class="fw-row-status dim">—</span>
      {/if}
    </div>
    {#if hasUpdate && ent?.notes}<p class="fw-notes">{ent.notes}</p>{/if}
  {/snippet}

  {#if !demo}
    <details class="card fw-card" ontoggle={onOtaToggle}>
      <summary>
        Firmware updates
        {#if monUpdate || nodeUpdate}<span class="fw-badge">update</span>{/if}
      </summary>

      {#if otaBusy && !manifest}
        <p class="sub dim">Checking for updates…</p>
      {:else if manifest}
        {@render fwRow('Gauge (monitor)', 'monitor',
          verStr(devVers?.monitor), monLatest, monUpdate)}
        {@render fwRow('Sensor (OBD reader)', 'node',
          devVers?.node ? verStr(devVers.node) : 'unknown', nodeLatest, nodeUpdate)}
      {/if}

      {#if flashing}
        <div class="fw-bar"><div class="fw-fill" style="width:{flashPct}%"></div></div>
      {/if}
      {#if flashMsg}<p class="note">{flashMsg}</p>{/if}
      {#if otaNote}<p class="note">{otaNote}</p>{/if}

      <div class="fw-actions">
        <button class="ghost" onclick={loadOta} disabled={otaBusy || flashing !== ''}>
          {otaBusy ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <!-- Advanced: install a local .app.bin (offline / pre-release testing) -->
      <details class="fw-manual">
        <summary>Advanced — install a .bin file</summary>
        <p class="sub dim">Pick an <b>app image</b> (<code>.app.bin</code>, not merged) and the target.</p>
        <div class="fw-man-row">
          <select bind:value={manTarget} disabled={flashing !== ''}>
            <option value="node">Sensor (node)</option>
            <option value="monitor">Gauge (monitor)</option>
          </select>
          <input class="fw-input" type="file" accept=".bin" onchange={onManPick} disabled={flashing !== ''} />
        </div>
        {#if manName}<p class="fw-name">{manName} · {Math.round((manFile?.length ?? 0) / 1024)} KB</p>{/if}
        <button class="ghost wide" onclick={doManFlash} disabled={!manFile || flashing !== ''}>
          {flashing ? `Flashing… ${flashPct}%` : 'Flash this file'}
        </button>
      </details>
    </details>
  {/if}

  <!-- ---- sticky save bar ---- -->
  <div class="savebar">
    {#if demo}
      <span class="save-msg dim">Demo — connect a gauge to save</span>
    {:else if saveResult === 'ok'}
      <span class="save-msg ok">✓ Saved to monitor</span>
    {:else if saveResult === 'rejected'}
      <span class="save-msg bad">✕ Rejected — check values</span>
    {:else if dirty}
      <span class="save-msg dim">Unsaved changes</span>
    {:else}
      <span class="save-msg dim">In sync with gauge</span>
    {/if}
    <div class="save-actions">
      {#if dirty && !demo}<button class="ghost" onclick={resetToDevice} disabled={saving}>Undo</button>{/if}
      <button class="primary" onclick={doSave} disabled={demo || !dirty || saving}>
        {saving ? 'Saving…' : 'Save to gauge'}
      </button>
    </div>
  </div>

  <button class="disconnect" onclick={() => (demo ? exitDemo() : disconnect())}>
    {demo ? 'Exit preview' : 'Disconnect'}
  </button>
{/if}

<style>
  .pill {
    font-family: var(--font-mono);
    font-size: 11px; letter-spacing: 0.5px;
    padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted);
    white-space: nowrap;
  }
  .pill.ok   { color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, var(--border)); }
  .pill.busy { color: var(--accent);  border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-2);
    padding: var(--s-4);
  }
  h3 { margin: 0 0 var(--s-2); font-size: 18px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 var(--s-3); }
  .sub.dim { opacity: 0.7; }
  .msg p { color: var(--muted); font-size: 14px; line-height: 1.5; }
  .msg strong { color: var(--fg); }
  .note {
    font-family: var(--font-mono); font-size: 12px;
    color: var(--accent); margin: 0 0 var(--s-2); word-break: break-word;
  }

  button.primary {
    width: 100%;
    min-height: var(--tap-min);
    background: var(--accent); color: #000;
    border: 0; border-radius: var(--r-1);
    font-weight: 700; font-size: 15px; cursor: pointer;
  }
  button.primary:disabled { opacity: 0.4; cursor: default; }

  /* per-page arc-colour swatch (opens the OS colour picker — full custom) */
  .swatch {
    width: 34px; height: 24px; border-radius: var(--r-1);
    border: 1px solid var(--border); cursor: pointer; overflow: hidden;
    display: inline-block; position: relative; flex: 0 0 auto;
  }
  .swatch input[type="color"] {
    position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px);
    padding: 0; border: 0; background: none; cursor: pointer; opacity: 0;
  }

  .pages { display: flex; flex-direction: column; gap: var(--s-3); }
  .page-card { padding: var(--s-3) var(--s-4); }
  .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s-3); }
  .page-tag {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px;
    color: var(--accent); font-weight: 700;
  }

  /* peak / redline input */
  .peak .hint { text-transform: none; letter-spacing: 0; color: var(--muted); opacity: 0.7; }
  .peak-row { display: flex; align-items: center; gap: var(--s-2); }
  .peak-row input {
    flex: 1; min-width: 0; min-height: 40px;
    background: var(--surface-2); color: var(--fg);
    border: 1px solid var(--border); border-radius: var(--r-1);
    padding: 0 var(--s-2); font-size: 14px;
  }
  .peak-unit { font-family: var(--font-mono); font-size: 12px; color: var(--muted); flex: 0 0 auto; }

  /* global brightness */
  .bright-card { padding: var(--s-3) var(--s-4); }
  .bright-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--s-2); }
  .bright-val { font-family: var(--font-mono); font-size: 13px; color: var(--fg); }
  .bright-card input[type="range"] {
    width: 100%; accent-color: var(--accent); height: 28px;
  }

  .fw-card { padding: var(--s-3) var(--s-4); }
  .fw-card summary {
    font-size: 14px; font-weight: 600; cursor: pointer; color: var(--fg);
    list-style: none;
  }
  .fw-card summary::-webkit-details-marker { display: none; }
  .fw-card summary::before { content: '⌁ '; color: var(--accent); }
  .fw-card p { margin: var(--s-3) 0; }
  .fw-card code { font-family: var(--font-mono); font-size: 12px; color: var(--fg); }
  .fw-input { width: 100%; color: var(--muted); font-size: 13px; margin: var(--s-2) 0; }
  .fw-name { font-family: var(--font-mono); font-size: 12px; color: var(--fg); }
  .fw-bar { height: 8px; background: var(--surface-2); border-radius: 999px; overflow: hidden; margin: var(--s-2) 0; }
  .fw-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }

  /* "update" pill next to the summary when a newer build exists */
  .fw-badge {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.5px;
    text-transform: uppercase; color: #000; background: var(--accent);
    padding: 1px 6px; border-radius: 999px; margin-left: var(--s-2);
  }
  /* one device row: label + version on the left, action on the right */
  .fw-row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--s-3);
    padding: var(--s-3) 0; border-top: 1px solid var(--border);
  }
  .fw-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .fw-row-label { font-size: 14px; font-weight: 600; color: var(--fg); }
  .fw-row-ver { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  .fw-row-status { font-family: var(--font-mono); font-size: 13px; color: var(--accent); flex: 0 0 auto; }
  .fw-row-status.dim { color: var(--muted); }
  .fw-install {
    flex: 0 0 auto; min-height: 36px; padding: 0 var(--s-3);
    background: none; border: 1px solid var(--border); color: var(--muted);
    border-radius: var(--r-1); cursor: pointer; font-size: 13px; font-weight: 600;
  }
  .fw-install.up { background: var(--accent); color: #000; border-color: var(--accent); }
  .fw-install:disabled { opacity: 0.4; cursor: default; }
  .fw-notes {
    font-size: 12px; color: var(--muted); line-height: 1.5;
    margin: 0 0 var(--s-2) !important; max-height: 8em; overflow-y: auto;
  }
  .fw-actions { display: flex; justify-content: flex-end; margin-top: var(--s-2); }
  .fw-actions .ghost { font-size: 12px; }
  /* advanced manual-file sub-panel */
  .fw-manual { margin-top: var(--s-3); border-top: 1px solid var(--border); padding-top: var(--s-3); }
  .fw-manual > summary {
    font-size: 12px; font-weight: 500; color: var(--muted); cursor: pointer;
    list-style: none; font-family: var(--font-mono);
  }
  .fw-manual > summary::-webkit-details-marker { display: none; }
  .fw-manual > summary::before { content: '▸ '; }
  .fw-manual[open] > summary::before { content: '▾ '; }
  .fw-man-row { display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap; }
  .fw-man-row select { width: auto; flex: 0 0 auto; }
  .fw-man-row .fw-input { flex: 1; min-width: 140px; }
  .page-body { display: flex; align-items: center; gap: var(--s-4); }

  .prev { width: 84px; height: 84px; flex-shrink: 0; }
  .prev-bezel { fill: #000; stroke: var(--border); stroke-width: 1.5; }
  .prev-arc   { fill: none; stroke: var(--accent); stroke-width: 4; stroke-linecap: round; opacity: 0.9; }
  .prev-primary {
    fill: var(--fg); font-family: var(--font-mono); font-weight: 700;
    font-size: 13px; text-anchor: middle;
  }
  .prev-support {
    fill: var(--muted); font-family: var(--font-mono);
    font-size: 8px; text-anchor: middle; letter-spacing: 0.5px;
  }

  .pickers { flex: 1; display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; }
  .pickers label { display: flex; flex-direction: column; gap: 3px; }
  .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  select {
    width: 100%; min-height: 40px;
    background: var(--surface-2); color: var(--fg);
    border: 1px solid var(--border); border-radius: var(--r-1);
    padding: 0 var(--s-2); font-size: 14px;
  }

  .savebar {
    position: sticky; bottom: 0;
    display: flex; align-items: center; justify-content: space-between; gap: var(--s-3);
    background: color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border); border-radius: var(--r-2);
    padding: var(--s-3); margin-top: var(--s-1);
  }
  .save-msg { font-size: 13px; font-weight: 600; }
  .save-msg.ok  { color: var(--success); }
  .save-msg.bad { color: var(--danger); }
  .save-msg.dim { color: var(--muted); font-weight: 500; }
  .save-actions { display: flex; gap: var(--s-2); flex-shrink: 0; }
  .save-actions .primary { width: auto; padding: 0 var(--s-4); min-height: 40px; }
  .ghost {
    background: none; border: 1px solid var(--border); color: var(--muted);
    border-radius: var(--r-1); padding: 0 var(--s-3); min-height: 40px; cursor: pointer;
  }
  .ghost.wide {
    width: 100%; margin-top: var(--s-3); font-size: 13px;
    font-family: var(--font-mono); letter-spacing: 0.3px;
  }

  .disconnect {
    background: none; border: 0; color: var(--muted);
    font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.5px;
    padding: var(--s-3); cursor: pointer; align-self: center;
  }
</style>
