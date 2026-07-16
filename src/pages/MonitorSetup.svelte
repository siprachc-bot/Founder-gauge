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
    CHANNELS, CHANNEL_GROUPS, Ch, Layout, LAYOUT_NAMES, ARC_DEFAULT, BRIGHT_DEFAULT, SLOTS_PER_PAGE, GAUGE_PAGES,
    hexToRgb565, rgb565ToHex, verStr, verCmp,
    UC_COUNT, UNIT_OPTIONS, UNITS_METRIC, UNITS_IMPERIAL,
    OTA_TARGET_NODE, OTA_TARGET_MONITOR,
    type GaugeCfg, type DeviceVersions, type FwVersion, type AccelTimes,
    type ExhaustStatus,
  } from '../lib/founderGaugeCfg';
  import {
    fetchCanManifest, latest, downloadFirmware, parseVer,
    type CanManifest, type CanReleaseEntry,
  } from '../lib/axisCanOta';
  import { parseDriveLog, toCsv, driveLogName, saveTextFile } from '../lib/driveLog';
  import { computeDyno, type DynoResult } from '../lib/dyno';
  import DynoChart from '../lib/DynoChart.svelte';
  import GaugePreview from '../lib/GaugePreview.svelte';
  import { parseCanLog, toSavvyCanCsv, canLogStats } from '../lib/canLog';
  import {
    type CarProfile, loadProfiles, addProfile, renameProfile,
    updateProfileCfg, deleteProfile, loadActiveId, saveActiveId,
  } from '../lib/carProfiles';
  import { richDtc, SEVERITY_META, type DtcRich } from '../lib/dtcRich';
  import {
    GEAR_PROFILES, encodeGearProfile, gearProfileById, DEFAULT_GEAR_PROFILE_ID,
  } from '../lib/gearProfiles';
  import {
    presetBrands, presetModels, presetsFor, presetById,
  } from '../lib/drivetrainPresets';

  type Phase = 'unavailable' | 'idle' | 'scanning' | 'connecting' | 'loading' | 'ready';

  let phase   = $state<Phase>('idle');
  let note    = $state('');                 // transient status / error line
  let cfg     = $state<GaugeCfg>(defaultCfg());
  let saved   = $state<GaugeCfg>(defaultCfg());
  let saving  = $state(false);
  let saveResult = $state<'ok' | 'rejected' | null>(null);
  let demo    = $state(false);              // preview the configurator with no gauge (SAVE disabled)

  const PAGE_NAMES = ['MAIN','PAGE 2','PAGE 3','PAGE 4','PAGE 5','PAGE 6','PAGE 7','PAGE 8','PAGE 9','PAGE 10'];
  // Which page the single big preview + the controls below edit.
  let selPage = $state(0);
  $effect(() => { if (selPage >= cfg.pageCount) selPage = cfg.pageCount - 1; if (selPage < 0) selPage = 0; });
  function addPage()    { if (cfg.pageCount < GAUGE_PAGES) { cfg.pageCount += 1; selPage = cfg.pageCount - 1; } }
  function removePage() { if (cfg.pageCount > 1) { cfg.pageCount -= 1; if (selPage >= cfg.pageCount) selPage = cfg.pageCount - 1; } }

  // Dirty = the on-screen layout differs from what's on the monitor.
  // Compare the NORMALISED cfg (peak null→0, clamped, layout forced) against the
  // already-normalised `saved`, so an emptied peak field (null) doesn't falsely
  // read as "unsaved" when it coerces to the same 0 that's on the device.
  let dirty = $derived(JSON.stringify(normalize(cfg)) !== JSON.stringify(saved));

  // HYBRID live preview (owner's call): COLOURS + CHANNELS + peaks preview on the
  // gauge in real time, but the LAYOUT (Hero/Bars/Needle/Ticks) is held until Save —
  // a layout change is what made the gauge jump to a half-configured page. So we
  // push a preview with every page's layout forced to the SAVED layout: the glass
  // recolours / re-channels the page you're editing live, but its style only
  // changes when you Save. The in-app GaugePreview shows the new style meanwhile.
  // Preview is IN THE APP only (the faithful GaugePreview canvas below) — nothing
  // is pushed to the glass as you edit, so the gauge can't bounce/jump/desync.
  // Save() is the sole writer to the device. (Brightness stays live — global dim,
  // no page state, can't bounce.)
  const chanMeta = (id: number) => {
    const d = channelDef(id);
    return d ? { label: d.short ?? d.label, unit: d.unit, min: d.min, max: d.max } : null;
  };

  const clone = (c: GaugeCfg): GaugeCfg => JSON.parse(JSON.stringify(c));

  // Keep the user's chosen layout + as many slots as that layout actually uses
  // (BARS = 4, HERO/NEEDLE = 2, TICKS = 1), carrying per-page colours + peak +
  // global brightness. Sanitises anything read off the device (or a NaN from an
  // emptied peak input) too.
  function normalize(c: GaugeCfg): GaugeCfg {
    const d = defaultCfg();
    return {
      version: c.version || d.version,
      // Always exactly GAUGE_PAGES entries (the array is fixed-size on the wire);
      // pageCount decides how many are actually shown. Missing pages → empty NONE.
      pages: Array.from({ length: GAUGE_PAGES }, (_, p) => {
        const src = c.pages?.[p];
        const lay = (Number.isFinite(src?.layout) && (src!.layout as number) >= 0 && (src!.layout as number) <= Layout.TICKS)
          ? (src!.layout as Layout) : Layout.HERO;
        const used = slotsUsed(lay);   // BARS 4 · HERO/NEEDLE 2 · TICKS 1
        const ch: Ch[] = Array.from({ length: SLOTS_PER_PAGE }, (_, s) =>
          s < used ? (src?.ch?.[s] ?? Ch.NONE) : Ch.NONE);
        const mx = channelDef(ch[0])?.max ?? 0;
        let peak = (Number.isFinite(src?.peak) && (src!.peak as number) > 0) ? (src!.peak as number) : 0;
        if (mx > 0 && peak > mx) peak = mx;
        return {
          layout: lay, ch, arcColor: src?.arcColor || ARC_DEFAULT, peak,
          // v11: 0 = "reuse the arc colour" / "default white text" on the device.
          color2:    (src?.color2    ?? 0) & 0xffff,
          textColor: (src?.textColor ?? 0) & 0xffff,
        };
      }),
      pageCount: Number.isFinite(c.pageCount)
        ? Math.max(1, Math.min(GAUGE_PAGES, Math.round(c.pageCount))) : d.pageCount,
      brightness: Number.isFinite(c.brightness)
        ? Math.max(8, Math.min(255, Math.round(c.brightness))) : BRIGHT_DEFAULT,
      // Vehicle-global calc-gear params. MUST be carried through here or the
      // dirty-check/save (which run on normalize(cfg)) silently drop them.
      rpmLimit: Number.isFinite(c.rpmLimit)
        ? Math.max(1000, Math.min(12000, Math.round(c.rpmLimit))) : d.rpmLimit,
      gearCount: Number.isFinite(c.gearCount)
        ? Math.max(0, Math.min(8, Math.round(c.gearCount))) : d.gearCount,   // 0 = CVT/eCVT
      // shiftRpm: 0 = off, else clamped to a sane RPM window.
      shiftRpm: Number.isFinite(c.shiftRpm)
        ? (c.shiftRpm <= 0 ? 0 : Math.max(1000, Math.min(12000, Math.round(c.shiftRpm)))) : d.shiftRpm,
      // Drivetrain (accurate calc-gear). Always length-8; unused gears keep their default.
      gearRatios: Array.from({ length: 8 }, (_, i) => {
        const r = c.gearRatios?.[i];
        return (Number.isFinite(r) && (r as number) > 0)
          ? Math.round((r as number) * 1000) / 1000 : (d.gearRatios[i] ?? 0);
      }),
      finalDrive: (Number.isFinite(c.finalDrive) && c.finalDrive > 0)
        ? Math.round(c.finalDrive * 1000) / 1000 : d.finalDrive,
      tireWidth:  Number.isFinite(c.tireWidth)  ? Math.max(100, Math.min(400, Math.round(c.tireWidth)))  : d.tireWidth,
      tireAspect: Number.isFinite(c.tireAspect) ? Math.max(20,  Math.min(90,  Math.round(c.tireAspect))) : d.tireAspect,
      tireRim:    Number.isFinite(c.tireRim)    ? Math.max(10,  Math.min(26,  Math.round(c.tireRim)))    : d.tireRim,
      // Per-quantity display units — always length UC_COUNT; clamp each to its
      // class's option count (else the firmware clamps to native anyway).
      units: Array.from({ length: UC_COUNT }, (_, i) => {
        const nOpt = UNIT_OPTIONS.find(u => u.cls === i)?.opts.length ?? 1;
        const u = c.units?.[i];
        return (Number.isFinite(u)) ? Math.max(0, Math.min(nOpt - 1, Math.round(u as number))) : 0;
      }),
      massKg: Number.isFinite(c.massKg) ? Math.max(300, Math.min(6000, Math.round(c.massKg))) : d.massKg,
    };
  }
  // ---- unit pickers ----
  function setUnit(cls: number, sel: number) { cfg.units = cfg.units.map((u, i) => i === cls ? sel : u); }
  function setUnitSystem(imperial: boolean) { cfg.units = [...(imperial ? UNITS_IMPERIAL : UNITS_METRIC)]; }
  const isImperial = () => JSON.stringify(cfg.units) === JSON.stringify(UNITS_IMPERIAL);
  const isMetric   = () => JSON.stringify(cfg.units) === JSON.stringify(UNITS_METRIC);

  // How many value slots a layout actually draws:
  //   BARS = 4 bars · HERO = big + support · NEEDLE = 2 hands · TICKS = ring + a
  //   short outer tick for the 2nd value (the RING itself stays single-value).
  const slotsUsed = (l: Layout) => l === Layout.BARS ? 4 : 2;
  const SLOT_NAMES: Record<number, string[]> = {
    [Layout.HERO]:   ['Big value', 'Small value'],
    [Layout.BARS]:   ['Bar 1', 'Bar 2', 'Bar 3', 'Bar 4'],
    [Layout.NEEDLE]: ['Long needle', 'Short needle'],
    [Layout.TICKS]:  ['Lit ticks', 'Outer tick (2nd value)'],
  };
  // Layouts whose 2nd value carries its own colour (needle-2 hand / outer tick).
  const has2ndColor = (l: Layout) => l === Layout.NEEDLE || l === Layout.TICKS;

  // ---- per-page arc colour (custom picker, no preset lock-in) ----
  const pageHex = (i: number) => rgb565ToHex(cfg.pages[i].arcColor ?? ARC_DEFAULT);
  function setPageColor(i: number, hex: string) {
    // Colour shows in the in-app GaugePreview; Save pushes it to the gauge (no
    // live-recolour on the glass — that jumped the gauge to this page).
    cfg.pages[i].arcColor = hexToRgb565(hex);
  }
  // ---- v11: 2nd needle hand + value-text colour (0 on the wire = "use default",
  //      so the swatch shows the arc colour / white until the owner picks one) ----
  const hand2Hex = (i: number) => rgb565ToHex(cfg.pages[i].color2 || (cfg.pages[i].arcColor ?? ARC_DEFAULT));
  const textHex  = (i: number) => rgb565ToHex(cfg.pages[i].textColor || 0xffff);
  const setHand2Color = (i: number, hex: string) => { cfg.pages[i].color2    = hexToRgb565(hex); };
  const setTextColor  = (i: number, hex: string) => { cfg.pages[i].textColor = hexToRgb565(hex); };

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

  // ---- Version-gate the channel picker ----------------------------------
  // The Phase-B channels (id >= Ch.LAMBDA_M) only exist in monitor firmware
  // >= v0.7.2. An older gauge's cfgValid() REJECTS any config carrying a
  // channel id >= its CH_COUNT, so saving one to a v0.7.1 gauge produces a
  // cryptic "Rejected — check values". Rather than HIDE them (confusing — the
  // channels seem to vanish), keep them VISIBLE but DISABLED with a "· needs
  // v0.7.2" hint until the gauge reports a new-enough version (devVers refreshes
  // after an OTA → they enable). Unknown version (demo / not read yet) = enabled.
  const PHASE_B_MIN: FwVersion = { major: 0, minor: 7, patch: 2 };
  const monHasPhaseB = $derived(!devVers?.monitor || verCmp(devVers.monitor, PHASE_B_MIN) >= 0);
  // A channel the CONNECTED gauge is too old to accept (can't be selected/saved).
  const chGated = (id: number) => !monHasPhaseB && id >= Ch.LAMBDA_M;
  // A stale config still carrying a gated channel would reject on save — flag it
  // so the reject message can point the user at the firmware update.
  const cfgNeedsNewerMon = $derived(!monHasPhaseB &&
    cfg.pages.some(p => p.ch.some(ch => ch >= Ch.LAMBDA_M)));

  let flashing = $state<'' | 'monitor' | 'node'>(''); // which target is flashing
  let flashPct = $state(0);
  let flashMsg = $state('');

  const monLatest  = $derived(manifest ? latest(manifest.monitor) : null);
  const nodeLatest = $derived(manifest ? latest(manifest.node) : null);
  const monUpdate  = $derived(!!(monLatest && devVers &&
    verCmp(parseVer(monLatest.version), devVers.monitor) > 0));
  const nodeUpdate = $derived(!!(nodeLatest && devVers?.node &&
    verCmp(parseVer(nodeLatest.version), devVers.node) > 0));

  // ---- Anti-gateway-lockout: cool-down between SENSOR (node) flashes ----------
  // Every node reboot pokes the car's OBD gateway to lock the bus; back-to-back
  // re-flashes = a burst of pokes the SPA gateway's anti-flood trips on → it stops
  // answering and the gauge drops to rpm/speed only until the car is key-cycled.
  // So after a node flash we BLOCK the next one for NODE_OTA_COOLDOWN_S — reboots
  // spaced this far apart never look like a flood. (The gauge/monitor OTA doesn't
  // poke OBD, so it's never blocked.)
  const NODE_OTA_COOLDOWN_S = 40;
  let nodeCoolUntil = $state(0);            // Date.now() ms until node OTA is allowed again
  let nowTick       = $state(Date.now());
  let coolTimer: ReturnType<typeof setInterval> | null = null;
  const nodeCooling  = $derived(nowTick < nodeCoolUntil);
  const nodeCoolLeft = $derived(Math.max(0, Math.ceil((nodeCoolUntil - nowTick) / 1000)));
  function startNodeCooldown() {
    nodeCoolUntil = Date.now() + NODE_OTA_COOLDOWN_S * 1000;
    if (!coolTimer) coolTimer = setInterval(() => {
      nowTick = Date.now();
      if (nowTick >= nodeCoolUntil && coolTimer) { clearInterval(coolTimer); coolTimer = null; }
    }, 500);
  }

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
      flashMsg = which === 'monitor' ? '✓ Gauge updated — rebooting'
               : `✓ Sensor updated — let it reconnect (~${NODE_OTA_COOLDOWN_S}s) before updating again`;
      if (which === 'node') startNodeCooldown();     // don't re-flash the sensor too soon (gateway anti-flood)
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
      if (manTarget === 'node') startNodeCooldown();   // sensor cool-down (gateway anti-flood)
    } catch (e) {
      flashMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      flashing = '';
    }
  }

  // ---- Drive log: pull the on-device recorder file over BLE + export CSV ----
  let logBusy = $state(false);      // pulling / erasing
  let logPct  = $state(0);
  let logMsg  = $state('');
  let logStat = $state('');         // "N samples · X KB" once GET_INFO ran
  let logLoaded = false;

  async function loadLogInfo() {
    if (demo || !store.monClient || logBusy) return;
    try {
      const i = await store.monClient.logInfo();
      logLoaded = true;
      logStat = i.count > 0
        ? `${i.count.toLocaleString()} samples · ${Math.round(i.size / 1024)} KB · ~${Math.round(i.count / 5)}s`
        : 'No drive recorded yet';
    } catch (e) {
      logStat = ''; logMsg = 'Couldn’t read log: ' + String((e as Error)?.message ?? e);
    }
  }
  function onLogToggle(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !logLoaded) loadLogInfo();
  }

  async function pullDriveLog() {
    if (!store.monClient || logBusy) return;
    logBusy = true; logPct = 0; logMsg = 'Pulling log…';
    try {
      const raw = await store.monClient.pullLog((p) => (logPct = p));
      const log = parseDriveLog(raw);
      if (!log.samples.length) { logMsg = 'The log is empty.'; return; }
      await saveTextFile(driveLogName(log), 'text/csv', toCsv(log));
      logMsg = `✓ Exported ${log.samples.length.toLocaleString()} samples`;
    } catch (e) {
      logMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      logBusy = false;
    }
  }

  // ---- Dyno graph: pull the log + derive a power/torque curve (dyno.ts) ----
  let dynoResult = $state<DynoResult | null>(null);
  let dynoMsg    = $state('');
  async function showDynoGraph() {
    if (!store.monClient || logBusy) return;
    logBusy = true; logPct = 0; dynoMsg = ''; dynoResult = null; logMsg = 'Reading drive…';
    try {
      const raw = await store.monClient.pullLog((p) => (logPct = p));
      const log = parseDriveLog(raw);
      logMsg = '';
      if (!log.samples.length) { dynoMsg = 'No drive recorded yet.'; return; }
      const r = computeDyno(log.samples, cfg.massKg);
      if (!r) { dynoMsg = 'No full-throttle pull found in this drive — do one hard WOT pull, then try again.'; return; }
      dynoResult = r;
    } catch (e) {
      dynoMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      logBusy = false;
    }
  }

  async function eraseDriveLog() {
    if (!store.monClient || logBusy) return;
    if (!confirm('Erase the drive log stored on the gauge? This cannot be undone.')) return;
    logBusy = true; logMsg = 'Erasing…';
    try {
      const ok = await store.monClient.eraseLog();
      logMsg = ok ? '✓ Log erased' : '✗ Couldn’t erase (is it recording?)';
      logStat = ok ? 'No drive recorded yet' : logStat;
    } catch (e) {
      logMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      logBusy = false;
    }
  }

  // ---- Multi-car profiles (app-side; a profile = a saved GaugeCfg + name) ----
  let profiles    = $state<CarProfile[]>(loadProfiles());
  let activeCarId = $state<string>(loadActiveId());
  let carBusy     = $state(false);
  let carNote     = $state('');

  /** Load a profile into the editor and (if connected) push it to the gauge. */
  async function applyCar(id: string) {
    const p = profiles.find(x => x.id === id);
    if (!p || carBusy) return;
    const nc = normalize(clone(p.cfg));
    cfg = nc;                                   // editor reflects the chosen car
    activeCarId = id; saveActiveId(id);
    carNote = '';
    if (demo || !store.monClient) { carNote = `Loaded "${p.name}" (connect a gauge to apply)`; return; }
    carBusy = true;
    try {
      await store.monClient.setConfig(nc);      // device validates + persists
      saved = clone(nc);                        // now in sync with the gauge
      carNote = `✓ Applied "${p.name}"`;
    } catch (e) {
      carNote = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      carBusy = false;
    }
  }

  // ---- Push-A: real-gear car profile (a 38-byte gear-decode spec pushed to
  //      the node so the car's TRUE P/R/N/D gear decodes without a reflash) ----
  const GEAR_LS_KEY = 'foundergauge.gearCar';
  let gearCarId = $state<string>(
    (() => { try { return localStorage.getItem(GEAR_LS_KEY) || DEFAULT_GEAR_PROFILE_ID; }
             catch { return DEFAULT_GEAR_PROFILE_ID; } })(),
  );
  let gearBusy = $state(false);
  let gearNote = $state('');
  let gearCar  = $derived(gearProfileById(gearCarId));

  /** Send the selected car's gear-decode profile to the node (via the monitor). */
  async function sendGearProfile() {
    const p = gearCar;
    if (!p || gearBusy) return;
    try { localStorage.setItem(GEAR_LS_KEY, p.id); } catch { /* private mode */ }
    gearNote = '';
    if (!p.pushable) { gearNote = 'This car needs an in-car gear scan before it can be sent.'; return; }
    if (demo || !store.monClient) { gearNote = 'Connect a gauge first.'; return; }
    gearBusy = true;
    try {
      await store.monClient.setGearProfile(encodeGearProfile(p));
      gearNote = `✓ Sent "${p.name}" — the sensor now decodes its real gear.`;
    } catch (e) {
      gearNote = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      gearBusy = false;
    }
  }

  // ---- Drivetrain preset (Brand → Model → Year fills the gear ratios etc.) ----
  let presetBrand = $state('');
  let presetModel = $state('');
  let presetId    = $state('');
  let presetModelList = $derived(presetBrand ? presetModels(presetBrand) : []);
  let presetYearList  = $derived(presetBrand && presetModel ? presetsFor(presetBrand, presetModel) : []);
  let chosenPreset    = $derived(presetId ? presetById(presetId) : undefined);

  function onPresetBrand() { presetModel = ''; presetId = ''; }
  function onPresetModel() {
    presetId = '';
    // Single year/trim variant → auto-apply so the user doesn't need a 3rd tap.
    const list = presetsFor(presetBrand, presetModel);
    if (list.length === 1) applyPreset(list[0].id);
  }
  /** Fill the drivetrain fields from a preset (tyre is left for the user).
   *  CVT/eCVT presets (gearCount 0, no ratios) only set the redline — there is
   *  no fixed gear to calculate, so gear ratios are left untouched. */
  function applyPreset(id: string) {
    const p = presetById(id);
    if (!p) return;
    presetId = id;
    cfg.rpmLimit = p.redline;
    if (p.shiftRpm) cfg.shiftRpm = p.shiftRpm;
    if (p.gearCount >= 1 && p.ratios.length === p.gearCount) {
      const r = [...p.ratios];
      while (r.length < 8) r.push(0);
      cfg.gearCount  = p.gearCount;
      cfg.gearRatios = r.slice(0, 8);
      cfg.finalDrive = p.finalDrive;
    } else {
      cfg.gearCount = 0;    // CVT/eCVT → gauge shows a constant "CVT" label
    }
  }

  // ---- Exhaust valve control (char 7e1c020e; monitor drives a 433 RF TX) ----
  let exh       = $state<ExhaustStatus | null>(null);
  let exhBusy   = $state(false);
  let exhMsg    = $state('');
  // RF codes from the sniffer (axis_exhaust_node/tools/rf_sniffer)
  let rfOpen    = $state(0);
  let rfClose   = $state(0);
  let rfBits    = $state(24);
  let rfProto   = $state(1);
  let rfPulse   = $state(350);
  let rfSingle  = $state(false);
  const MODE_LABELS = ['Quiet', 'Auto', 'Loud'];
  const VALVE_LABELS = ['closed', 'open', '—'];

  async function readExhaust() {
    if (demo || !store.monClient || exhBusy) return;
    exhBusy = true;
    try { exh = await store.monClient.readExhaust(); exhMsg = ''; }
    catch (e) { exhMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { exhBusy = false; }
  }
  async function setExhaustMode(mode: number) {
    if (demo || !store.monClient || exhBusy) return;
    exhBusy = true; exhMsg = 'Setting…';
    try { await store.monClient.setExhaustMode(mode); await new Promise(r => setTimeout(r, 250)); await readExhaust(); exhMsg = ''; }
    catch (e) { exhMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { exhBusy = false; }
  }
  async function pushRfCodes() {
    if (demo || !store.monClient || exhBusy) return;
    if (!rfOpen) { exhMsg = 'Enter the OPEN code from the sniffer first.'; return; }
    exhBusy = true; exhMsg = 'Sending codes…';
    try {
      await store.monClient.setExhaustCodes({ open: rfOpen, close: rfClose, bits: rfBits, proto: rfProto, pulse: rfPulse, repeat: 8, single: rfSingle });
      await new Promise(r => setTimeout(r, 200)); await readExhaust();
      exhMsg = '✓ Codes saved to the gauge.';
    } catch (e) { exhMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { exhBusy = false; }
  }
  async function exhaustTest(open: boolean) {
    if (demo || !store.monClient || exhBusy) return;
    exhBusy = true; exhMsg = `Testing ${open ? 'OPEN' : 'CLOSE'}…`;
    try { await store.monClient.exhaustPulse(open); exhMsg = `Sent ${open ? 'OPEN' : 'CLOSE'} pulse.`; }
    catch (e) { exhMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { exhBusy = false; }
  }

  function saveCurrentAsCar() {
    const name = (prompt('Name this car (e.g. "V60 T8", "My BMW")') ?? '').trim();
    if (!name) return;
    const r = addProfile(profiles, name, normalize(cfg));
    profiles = r.list; activeCarId = r.id; saveActiveId(r.id);
    carNote = `✓ Saved "${name}"`;
  }
  function renameCar(id: string) {
    const p = profiles.find(x => x.id === id); if (!p) return;
    const name = (prompt('Rename car', p.name) ?? '').trim();
    if (!name) return;
    profiles = renameProfile(profiles, id, name);
  }
  function updateCar(id: string) {
    const p = profiles.find(x => x.id === id); if (!p) return;
    if (!confirm(`Overwrite "${p.name}" with the current settings?`)) return;
    profiles = updateProfileCfg(profiles, id, normalize(cfg));
    carNote = `✓ Updated "${p.name}"`;
  }
  function deleteCar(id: string) {
    const p = profiles.find(x => x.id === id); if (!p) return;
    if (!confirm(`Delete "${p.name}"?`)) return;
    profiles = deleteProfile(profiles, id);
    if (activeCarId === id) { activeCarId = ''; saveActiveId(''); }
  }

  // ---- Fault-code (DTC) lookup — offline rich explainer, no backend ----
  let dtcInput  = $state('');
  let dtcResult = $state<DtcRich | null>(null);
  let dtcErr    = $state('');
  function lookupDtc() {
    const r = richDtc(dtcInput);
    if (!r) { dtcErr = 'Enter a code like P0301, P0420, U0100…'; dtcResult = null; return; }
    dtcErr = ''; dtcResult = r;
  }

  function toRich(codes: string[]): DtcRich[] {
    return codes.map((c) => richDtc(c)).filter((x): x is DtcRich => !!x);
  }

  // ---- Read / clear the car's ACTUAL stored codes (char 7e1c020a) ----
  let carCodes  = $state<DtcRich[]>([]);
  let carMil    = $state(false);
  let carRead   = $state(false);     // a read has completed (so "none" is meaningful)
  let carCond   = $state<{ rpm: number; coolant: number; load: number } | null>(null);
  let dtcBusy   = $state(false);
  let carMsg    = $state('');
  async function readCarCodes() {
    if (demo || !store.monClient || dtcBusy) return;
    dtcBusy = true; carMsg = 'Reading the car…';
    try {
      const snap = await store.monClient.readDtcCodes();
      carCodes = toRich(snap.codes);
      carMil = snap.mil; carRead = true; carCond = snap.conditions ?? null;
      carMsg = snap.count === 0
        ? '' : `${snap.count} stored code${snap.count === 1 ? '' : 's'}`;
    } catch (e) {
      carMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      dtcBusy = false;
    }
  }
  async function clearCarCodes() {
    if (demo || !store.monClient || dtcBusy) return;
    if (!confirm('Clear all stored codes and turn off the check-engine light? The car must be running / in READY.')) return;
    dtcBusy = true; carMsg = 'Clearing…';
    try {
      await store.monClient.clearDtcCodes();
      await new Promise((r) => setTimeout(r, 2500));   // let the node run Mode-04 + rescan
      const snap = await store.monClient.readDtcCodes();
      carCodes = toRich(snap.codes);
      carMil = snap.mil; carRead = true; carCond = snap.conditions ?? null;
      carMsg = snap.count === 0
        ? '✓ Cleared — no codes remain'
        : `${snap.count} code${snap.count === 1 ? '' : 's'} still present (fault may be active, or the gateway blocked the clear)`;
    } catch (e) {
      carMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      dtcBusy = false;
    }
  }

  // Compose a deep-dive prompt for the code and hand it to the chat (sendPrompt
  // lives in the widget host; in the app we open a web search as the offline CTA).
  function deepDive(r: DtcRich) {
    const q = encodeURIComponent(`${r.code} ${r.headline} — causes and step-by-step DIY diagnosis`);
    window.open(`https://www.google.com/search?q=${q}`, '_blank');
  }

  // ---- Acceleration best times (char 7e1c020b) ----
  const SPEED_LABELS = ['0-100 km/h', '100-200 km/h', '200-300 km/h'];
  const DIST_LABELS  = ['60 ft', '201 m (1/8 mi)', '402 m (1/4 mi)'];
  let accelTimes = $state<AccelTimes | null>(null);
  let accelBusy  = $state(false);
  let accelMsg   = $state('');
  const fmtT = (ms: number | null) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');
  async function readAccelTimes() {
    if (demo || !store.monClient || accelBusy) return;
    accelBusy = true; accelMsg = 'Reading…';
    try {
      accelTimes = await store.monClient.readAccelTimes();
      accelMsg = '';
    } catch (e) {
      accelMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      accelBusy = false;
    }
  }
  function accelHasAny(t: AccelTimes | null): boolean {
    return !!t && [...t.speed, ...t.dist].some((e) => e.ms != null);
  }
  async function downloadAccelCsv() {
    if (!accelTimes) return;
    const rows = ['category,target,time_s,trap_kmh'];
    accelTimes.speed.forEach((e, i) => {
      if (e.ms != null) rows.push(`speed,${SPEED_LABELS[i]},${(e.ms / 1000).toFixed(2)},`);
    });
    accelTimes.dist.forEach((e, i) => {
      if (e.ms != null) rows.push(`distance,${DIST_LABELS[i]},${(e.ms / 1000).toFixed(2)},${e.trapKmh ?? ''}`);
    });
    await saveTextFile('axis-accel-times.csv', 'text/csv', rows.join('\n'));
  }

  // ---- Node log (char 7e1c020c) — the CAN node's captured diagnostic log ----
  let nlogBusy = $state(false);
  let nlogPct  = $state(0);
  let nlogMsg  = $state('');
  async function downloadNodeLog() {
    if (demo || !store.monClient || nlogBusy) return;
    nlogBusy = true; nlogPct = 0; nlogMsg = 'Reading node log…';
    try {
      const text = await store.monClient.pullNodeLog((p) => (nlogPct = p));
      if (!text.trim()) { nlogMsg = 'Node log is empty — drive so the node logs, then pull.'; return; }
      await saveTextFile('axis-node-log.txt', 'text/plain', text);
      const lines = text.trim().split('\n').length;
      nlogMsg = `✓ Saved ${lines} lines`;
    } catch (e) {
      nlogMsg = '✗ ' + String((e as Error)?.message ?? e);
    } finally {
      nlogBusy = false;
    }
  }
  async function eraseNodeLog() {
    if (demo || !store.monClient || nlogBusy) return;
    if (!confirm('Clear the captured node log?')) return;
    nlogBusy = true;
    try { nlogMsg = (await store.monClient.eraseNodeLog()) ? '✓ Cleared' : 'Could not clear'; }
    catch (e) { nlogMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { nlogBusy = false; }
  }

  // ---- Raw CAN capture (char 7e1c020d) — bus RE ----
  let canCapturing = $state(false);
  let canBusy      = $state(false);
  let canPct       = $state(0);
  let canMsg       = $state('');
  async function refreshCanState() {
    if (demo || !store.monClient) return;
    try { canCapturing = (await store.monClient.canLogInfo()).capturing; } catch { /* ignore */ }
  }
  async function toggleCanCapture() {
    if (demo || !store.monClient || canBusy) return;
    canBusy = true;
    try {
      await store.monClient.setCanCapture(!canCapturing);
      canCapturing = !canCapturing;
      canMsg = canCapturing ? 'Capturing — drive, then Download CSV' : 'Stopped';
    } catch (e) { canMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { canBusy = false; }
  }
  async function downloadCanCsv() {
    if (demo || !store.monClient || canBusy) return;
    canBusy = true; canPct = 0; canMsg = 'Pulling capture…';
    try {
      const raw = await store.monClient.pullCanLog((p) => (canPct = p));
      const frames = parseCanLog(raw);
      if (!frames.length) { canMsg = 'Capture is empty.'; return; }
      const st = canLogStats(frames);
      await saveTextFile('axis-canbus-savvycan.csv', 'text/csv', toSavvyCanCsv(frames));
      canMsg = `✓ ${st.frames.toLocaleString()} frames · ${st.ids} IDs · ~${st.spanS}s → SavvyCAN CSV`;
    } catch (e) { canMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { canBusy = false; }
  }
  async function eraseCanLog() {
    if (demo || !store.monClient || canBusy) return;
    if (!confirm('Clear the raw CAN capture?')) return;
    canBusy = true;
    try { canMsg = (await store.monClient.eraseCanLog()) ? '✓ Cleared' : 'Could not clear'; }
    catch (e) { canMsg = '✗ ' + String((e as Error)?.message ?? e); }
    finally { canBusy = false; }
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

  onDestroy(() => { if (coolTimer) clearInterval(coolTimer); /* keep the link alive in the store across navigations */ });

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
    // Eagerly read the monitor firmware version so the channel picker can
    // version-gate Phase-B channels from the FIRST render (loadOta is lazy —
    // only fires when the OTA card is expanded, which is too late for the gate).
    c.readVersions().then(v => { if (v) devVers = v; }).catch(() => {});
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
    demo = true; selPage = 0;
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

  <!-- ONE big gauge preview of the selected page (like the real glass) + page dots -->
  <div class="card ed-top">
    <div class="ed-preview">
      <GaugePreview layout={cfg.pages[selPage].layout} arc={pageHex(selPage)} col2={hand2Hex(selPage)}
        text={textHex(selPage)} ch={cfg.pages[selPage].ch} chan={chanMeta} size={232} />
    </div>
    <div class="ed-name">{PAGE_NAMES[selPage]}</div>
    <div class="ed-pages">
      <button class="pg-btn" onclick={removePage} disabled={cfg.pageCount <= 1} aria-label="Remove page">−</button>
      {#each cfg.pages.slice(0, cfg.pageCount) as _u, di (di)}
        <button class="pv-dot" class:on={di === selPage} onclick={() => (selPage = di)} aria-label={PAGE_NAMES[di]}>{di + 1}</button>
      {/each}
      <button class="pg-btn" onclick={addPage} disabled={cfg.pageCount >= GAUGE_PAGES} aria-label="Add page">+</button>
    </div>
  </div>

  <!-- controls for the SELECTED page only -->
  <div class="pages">
    {#if cfg.pages[selPage]}
      {@const i = selPage}
      {@const page = cfg.pages[selPage]}
      <div class="card page-card">
        <div class="page-head">
          <span class="page-tag">{PAGE_NAMES[i]}</span>
          <div class="sw-row">
            <!-- Arc / 1st-needle colour -->
            <label class="swatch" style="background: {pageHex(i)}"
                   title={page.layout === Layout.NEEDLE ? 'Long-needle colour' : 'Arc / tick colour'}>
              <input type="color" value={pageHex(i)}
                oninput={(e) => setPageColor(i, (e.currentTarget as HTMLInputElement).value)}
                aria-label="Arc colour for {PAGE_NAMES[i]}" />
            </label>
            <!-- NEEDLE only: the 2nd (short) hand gets its own colour -->
            {#if has2ndColor(page.layout)}
              <label class="swatch" style="background: {hand2Hex(i)}"
                     title={page.layout === Layout.NEEDLE ? 'Short-needle colour' : '2nd-value tick colour'}>
                <input type="color" value={hand2Hex(i)}
                  oninput={(e) => setHand2Color(i, (e.currentTarget as HTMLInputElement).value)}
                  aria-label="Second value colour for {PAGE_NAMES[i]}" />
              </label>
            {/if}
            <!-- Every layout: the value TEXT colour -->
            <label class="swatch txt" style="background: {textHex(i)}" title="Text colour">
              <input type="color" value={textHex(i)}
                oninput={(e) => setTextColor(i, (e.currentTarget as HTMLInputElement).value)}
                aria-label="Text colour for {PAGE_NAMES[i]}" />
            </label>
          </div>
        </div>

        <!-- layout: how this page is drawn on the gauge -->
        <div class="lay-row">
          {#each [Layout.HERO, Layout.BARS, Layout.NEEDLE, Layout.TICKS] as L}
            <button type="button" class="chip sm" class:on={cfg.pages[i].layout === L}
                    onclick={() => cfg.pages[i].layout = L}>{LAYOUT_NAMES[L]}</button>
          {/each}
        </div>

        <div class="page-body single">
          <div class="pickers">
            <!-- One select per slot the chosen layout actually draws:
                 BARS = 4 bars, HERO/NEEDLE = 2, TICKS = 1. -->
            {#each Array(slotsUsed(page.layout)) as _, s (s)}
              <label>
                <span class="lbl">{SLOT_NAMES[page.layout]?.[s] ?? `Value ${s + 1}`}</span>
                <select bind:value={cfg.pages[i].ch[s]}
                        onchange={() => { if (s === 0) onPrimaryChange(i); }}>
                  <option value={Ch.NONE}>— empty —</option>
                  {#each CHANNEL_GROUPS as g (g)}
                    <optgroup label={g}>
                      {#each CHANNELS.filter(c => c.group === g) as c (c.id)}
                        <option value={c.id} disabled={chGated(c.id)}>{c.label}{c.unit ? ` (${c.unit})` : ''}{chGated(c.id) ? ' · needs v0.7.2' : ''}</option>
                      {/each}
                    </optgroup>
                  {/each}
                </select>
              </label>
            {/each}
            <label class="peak">
              <span class="lbl">Peak / redline <span class="hint">0 = off</span></span>
              <div class="peak-row">
                <input type="number" min="0" max={peakMax(i)} step="any"
                  bind:value={cfg.pages[i].peak} placeholder="off" />
                <span class="peak-unit">{peakUnit(i)}</span>
              </div>
            </label>
            <!-- Shift light lives on the RPM page (it's an RPM threshold). Global
                 cfg.shiftRpm; shown only when this page's big value is RPM. -->
            {#if page.ch[0] === Ch.RPM}
              <label class="peak">
                <span class="lbl">Shift light <span class="hint">RPM · 0 = off</span></span>
                <div class="peak-row">
                  <input type="number" min="0" max="12000" step="100"
                    bind:value={cfg.shiftRpm} placeholder="off" />
                  <span class="peak-unit">RPM</span>
                </div>
              </label>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- global screen brightness (live-dims as you drag) -->
  <div class="card bright-card">
    <div class="bright-head">
      <span class="lbl">Screen brightness</span>
      <span class="bright-val">{Math.round(cfg.brightness / 255 * 100)}%</span>
    </div>
    <input type="range" min="8" max="255" value={cfg.brightness} oninput={onBrightness} />
  </div>

  <!-- units: per-quantity display unit; the gauge converts at render time -->
  <div class="card units-card">
    <div class="bright-head"><span class="lbl">Units</span></div>
    <div class="unit-system">
      <button type="button" class="chip" class:on={isMetric()}   onclick={() => setUnitSystem(false)}>Metric</button>
      <button type="button" class="chip" class:on={isImperial()} onclick={() => setUnitSystem(true)}>Imperial</button>
    </div>
    {#each UNIT_OPTIONS as row}
      <div class="unit-row">
        <span class="unit-lbl">{row.label}</span>
        <div class="unit-opts">
          {#each row.opts as opt, i}
            <button type="button" class="chip sm" class:on={(cfg.units?.[row.cls] ?? 0) === i}
                    onclick={() => setUnit(row.cls, i)}>{opt}</button>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  <!-- vehicle / drivetrain: feeds the monitor's calculated-gear rule -->
  <div class="card">
    <div class="bright-head"><span class="lbl">Drivetrain</span></div>
    <p class="sub dim" style="margin-top:4px;">
      Pick your car and enter your tyre size — the gear ratios are filled in for you.
    </p>

    <!-- 1) Pick the car: Brand → Model → Year -->
    <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px;">
      <span>Brand</span>
      <select bind:value={presetBrand} onchange={onPresetBrand} style="width:64%;">
        <option value="">Choose…</option>
        {#each presetBrands() as b}<option value={b}>{b}</option>{/each}
      </select>
    </label>
    {#if presetBrand}
      <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;">
        <span>Model</span>
        <select bind:value={presetModel} onchange={onPresetModel} style="width:64%;">
          <option value="">Choose…</option>
          {#each presetModelList as m}<option value={m}>{m}</option>{/each}
        </select>
      </label>
    {/if}
    {#if presetModel && presetYearList.length > 1}
      <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;">
        <span>Year</span>
        <select value={presetId} onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value)} style="width:64%;">
          <option value="">Choose…</option>
          {#each presetYearList as p (p.id)}<option value={p.id}>{p.years}</option>{/each}
        </select>
      </label>
    {/if}
    {#if chosenPreset}
      <p class="sub dim" style="margin-top:6px;line-height:1.4;">
        <b>{chosenPreset.trans}{chosenPreset.verified ? ' ✓' : ''}</b> ·
        {chosenPreset.gearCount >= 1 ? `${chosenPreset.gearCount}-speed` : 'no fixed gears — the gauge shows “CVT”'}{#if chosenPreset.note} · {chosenPreset.note}{/if}
      </p>
    {/if}

    <!-- 2) Tyre size — the one thing the user must enter -->
    <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;">
      <span>Tyre size</span>
      <span style="display:flex;align-items:center;gap:4px;">
        <input type="number" min="100" max="400" step="5" bind:value={cfg.tireWidth}  style="width:56px;text-align:right;" />/
        <input type="number" min="20"  max="90"  step="5" bind:value={cfg.tireAspect} style="width:44px;text-align:right;" />R
        <input type="number" min="10"  max="26"  step="1" bind:value={cfg.tireRim}    style="width:44px;text-align:right;" />
      </span>
    </label>

    <!-- Vehicle weight — powers the VirtualDyno (Power/Torque channels) -->
    <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;">
      <span>Weight (kg)<br><small class="sub dim" style="font-weight:400;">incl. driver — used for Power/Torque</small></span>
      <input type="number" min="300" max="6000" step="10" bind:value={cfg.massKg} style="width:72px;text-align:right;" />
    </label>

    <!-- Advanced: type the numbers by hand (car not listed / fine-tuning) -->
    <details class="dt-adv">
      <summary>Advanced — enter values manually</summary>
      <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;">
        <span>Redline (RPM)</span>
        <input type="number" min="1000" max="12000" step="100" bind:value={cfg.rpmLimit}
               style="width:96px;text-align:right;" />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;">
        <span>Forward gears</span>
        <select bind:value={cfg.gearCount} style="width:96px;">
          {#each [4, 5, 6, 7, 8] as n}<option value={n}>{n}</option>{/each}
        </select>
      </label>
      <div style="margin-top:12px;opacity:.85;font-size:.85em;">Gear ratios</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px 12px;margin-top:6px;">
        {#each Array(cfg.gearCount) as _, i}
          <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span style="opacity:.7;">G{i + 1}</span>
            <input type="number" min="0" max="20" step="0.001" bind:value={cfg.gearRatios[i]}
                   style="width:80px;text-align:right;" />
          </label>
        {/each}
      </div>
      <label style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px;">
        <span>Final drive</span>
        <input type="number" min="0.5" max="10" step="0.001" bind:value={cfg.finalDrive}
               style="width:96px;text-align:right;" />
      </label>
    </details>

    <p style="opacity:.6;font-size:.8em;margin-top:8px;line-height:1.4;">
      The gear is calculated from RPM + speed using your gear ratios, final drive
      and tyre size. If the gear reads a step high or low, nudge Final drive in
      Advanced. (Shift light is set on the RPM page.)
    </p>
  </div>

  <!-- Exhaust valve — the gauge replays the fob's cloned 433 MHz codes over a TX module -->
  {#if !demo}
    <details class="card fw-card" ontoggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && !exh) readExhaust(); }}>
      <summary>Exhaust valve</summary>
      <p class="sub dim">
        The gauge opens/closes your exhaust valve by replaying your remote's codes over a
        433&nbsp;MHz transmitter — no extra box. <b>Quiet</b> = closed, <b>Auto</b> = opens when
        driven hard, <b>Loud</b> = open.
      </p>

      {#if exh && !exh.hasCodes}
        <p class="note">⚠ No remote codes yet — clone them below first (bottom of this card).</p>
      {/if}

      <!-- mode selector -->
      <div class="exh-modes">
        {#each MODE_LABELS as m, i}
          <button class="exh-mode" class:on={exh?.mode === i} disabled={exhBusy}
                  onclick={() => setExhaustMode(i)}>{m}</button>
        {/each}
      </div>
      {#if exh}
        <p class="sub dim" style="margin-top:6px;">
          Valve now: <b>{VALVE_LABELS[exh.valve] ?? '—'}</b>{#if exh.mode === 1} · auto opens ≥ {exh.openRpm} rpm or ≥ {exh.openThr}% throttle{/if}
        </p>
      {/if}
      {#if exhMsg}<p class="note">{exhMsg}</p>{/if}

      <!-- test pulses -->
      <div class="dtc-row">
        <button class="ghost" onclick={() => exhaustTest(true)}  disabled={exhBusy}>Test OPEN</button>
        <button class="ghost" onclick={() => exhaustTest(false)} disabled={exhBusy}>Test CLOSE</button>
      </div>

      <!-- clone the remote (advanced) -->
      <details class="dt-adv">
        <summary>Clone the remote (one-time setup)</summary>
        <p class="sub dim" style="margin-top:6px;line-height:1.4;">
          Run the RF sniffer (<code>axis_exhaust_node/tools/rf_sniffer</code>), press OPEN &amp; CLOSE
          on your fob, and type the printed <code>value</code>s here.
        </p>
        <label class="exh-row"><span>OPEN code</span>
          <input type="number" min="0" bind:value={rfOpen} /></label>
        <label class="exh-row"><span>CLOSE code</span>
          <input type="number" min="0" bind:value={rfClose} /></label>
        <label class="exh-row"><span>Bits</span>
          <input type="number" min="8" max="64" bind:value={rfBits} /></label>
        <label class="exh-row"><span>Protocol</span>
          <input type="number" min="1" max="12" bind:value={rfProto} /></label>
        <label class="exh-row"><span>Pulse (µs)</span>
          <input type="number" min="50" max="2000" bind:value={rfPulse} /></label>
        <label class="exh-row"><span>One toggle button</span>
          <input type="checkbox" bind:checked={rfSingle} /></label>
        <button class="fw-install up" style="margin-top:10px;" onclick={pushRfCodes} disabled={exhBusy}>
          Save codes to gauge
        </button>
      </details>
    </details>
  {/if}

  <!-- Push-A: real gear — pick the car so the sensor reads the TRUE selector -->
  {#if !demo}
    <div class="card">
      <div class="bright-head"><span class="lbl">Real gear (car model)</span></div>
      <p class="sub dim" style="margin-top:4px;">
        Pick your car so the sensor reads the <b>real</b> P/R/N/D straight off the
        car's computer (not just the calculated gear). Sent to the sensor and remembered.
      </p>
      <select class="car-select" bind:value={gearCarId} disabled={gearBusy} style="margin-top:8px;">
        {#each GEAR_PROFILES as p (p.id)}
          <option value={p.id} disabled={!p.pushable}>
            {p.name}{p.verified ? ' ✓' : p.pushable ? '' : ' (coming soon)'}
          </option>
        {/each}
      </select>
      {#if gearCar}
        <p class="sub dim" style="margin-top:6px;line-height:1.4;">
          <b>{gearCar.platform}</b>{#if gearCar.note} · {gearCar.note}{/if}
        </p>
      {/if}
      <button class="ghost wide" style="margin-top:10px;"
        onclick={sendGearProfile} disabled={gearBusy || !gearCar?.pushable}>
        {gearBusy ? 'Sending…' : 'Send to sensor'}
      </button>
      {#if gearNote}<p class="note">{gearNote}</p>{/if}
    </div>
  {/if}

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
      {:else if which === 'node' && nodeCooling}
        <span class="fw-row-status dim">reconnecting… {nodeCoolLeft}s</span>
      {:else if ent}
        <button class="fw-install" class:up={hasUpdate}
          onclick={() => installUpdate(which, ent)}
          disabled={flashing !== '' || (which === 'node' && nodeCooling)}>
          {hasUpdate ? `Update` : 'Reinstall'}
        </button>
      {:else if manifest}
        <span class="fw-row-status dim">—</span>
      {/if}
    </div>
    {#if which === 'node' && nodeCooling}
      <p class="fw-notes">Sensor is rebooting — wait for it to reconnect before updating again (avoids overloading the car's gateway).</p>
    {:else if hasUpdate && ent?.notes}<p class="fw-notes">{ent.notes}</p>{/if}
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
        <button class="ghost wide" onclick={doManFlash}
                disabled={!manFile || flashing !== '' || (manTarget === 'node' && nodeCooling)}>
          {flashing ? `Flashing… ${flashPct}%`
           : (manTarget === 'node' && nodeCooling) ? `Sensor reconnecting… ${nodeCoolLeft}s`
           : 'Flash this file'}
        </button>
      </details>
    </details>
  {/if}

  <!-- Cars — save a full gauge setup per car and switch between them (app-side) -->
  <div class="card">
    <h3>Cars</h3>
    <p class="sub dim">Save this whole setup (gearbox, tyres, pages, colours) as a named car, then switch between cars in one tap.</p>
    {#if profiles.length}
      <select class="car-select" bind:value={activeCarId} disabled={carBusy}>
        <option value="">Choose a car…</option>
        {#each profiles as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
      {#if activeCarId}
        <div class="fw-actions">
          <button class="fw-install up" onclick={() => applyCar(activeCarId)} disabled={carBusy}>
            {carBusy ? 'Applying…' : 'Apply to gauge'}
          </button>
          <button class="ghost" onclick={() => updateCar(activeCarId)} disabled={carBusy}>Save changes here</button>
          <button class="ghost" onclick={() => renameCar(activeCarId)} disabled={carBusy}>Rename</button>
          <button class="ghost" onclick={() => deleteCar(activeCarId)} disabled={carBusy}>Delete</button>
        </div>
      {/if}
    {:else}
      <p class="sub dim">No cars saved yet — set up the gauge below, then save it as your first car.</p>
    {/if}
    <div class="fw-actions">
      <button class="primary" onclick={saveCurrentAsCar} disabled={carBusy}>Save current as a new car</button>
    </div>
    {#if carNote}<p class="note">{carNote}</p>{/if}
  </div>

  <!-- Fault-code lookup — offline OBD-II dictionary (no backend) -->
  <details class="card fw-card">
    <summary>Fault-code lookup</summary>

    {#snippet richCard(r: DtcRich)}
      <div class="rc" style="--sev:{SEVERITY_META[r.severity].color}">
        <div class="rc-top">
          <span class="rc-code">{r.code}</span>
          <span class="rc-badge">{SEVERITY_META[r.severity].label}</span>
        </div>
        <p class="rc-headline">{r.headline}</p>
        <p class="rc-sys">{r.systemShort}</p>

        <p class="rc-section">Symptoms you'll actually feel</p>
        <ul class="rc-list">
          {#each r.symptoms as s}<li>{s}</li>{/each}
        </ul>

        <div class="rc-drive">{r.drive}</div>

        <p class="rc-section">Most likely causes</p>
        <ol class="rc-causes">
          {#each r.causes as c, i}<li><span class="rc-num">{i + 1}</span><span>{c}</span></li>{/each}
        </ol>

        <p class="rc-section">What to check / try first</p>
        <ul class="rc-fixes">
          {#each r.fixes as f}<li>{f}</li>{/each}
        </ul>

        {#if !r.known}<p class="sub dim">Shown from the code structure — not in the built-in list.</p>{/if}
        <button class="rc-ai" onclick={() => deepDive(r)}>Search more detail &amp; videos ↗</button>
      </div>
    {/snippet}

    {#if !demo}
      <!-- Read the car's ACTUAL stored codes straight off the gauge (char 7e1c020a) -->
      <p class="sub dim">Read the trouble codes your car has stored right now — the gauge pulls them from the car and explains each one in plain English.</p>
      <div class="dtc-row">
        <button class="ghost" onclick={readCarCodes} disabled={dtcBusy}>
          {carRead ? 'Re-read from car' : 'Read codes from car'}
        </button>
        {#if carRead && (carCodes.length > 0 || carMil)}
          <button class="ghost" style="color:#e24b4a" onclick={clearCarCodes} disabled={dtcBusy}>Clear codes</button>
        {/if}
      </div>
      {#if carMsg}<p class="note">{carMsg}</p>{/if}
      {#if carRead && carCodes.length === 0 && !carMsg}
        <p class="sub" style="color:#3b9c4f">✓ No stored codes — your car is clean.</p>
      {/if}
      {#if carCond && carCodes.length > 0}
        <div class="rc-chips">
          <span class="rc-chip">Now · RPM {carCond.rpm}</span>
          <span class="rc-chip">Coolant {carCond.coolant}°C</span>
          <span class="rc-chip">Load {carCond.load}%</span>
        </div>
      {/if}
      {#each carCodes as r (r.code)}
        {@render richCard(r)}
      {/each}
      <p class="sub dim" style="margin-top:16px">Or look up any code by hand:</p>
    {:else}
      <p class="sub dim">Type an OBD-II trouble code (from a scan or your dash) to see what it means. Offline; plain English.</p>
    {/if}

    <div class="dtc-row">
      <input class="fw-input dtc-input" type="text" placeholder="e.g. P0301" bind:value={dtcInput}
             maxlength="5" onkeydown={(e) => { if (e.key === 'Enter') lookupDtc(); }} />
      <button class="ghost" onclick={lookupDtc}>Look up</button>
    </div>
    {#if dtcErr}<p class="note">{dtcErr}</p>{/if}
    {#if dtcResult}{@render richCard(dtcResult)}{/if}
  </details>

  <!-- Acceleration best times — the gauge's ACCEL TIMER results over BLE -->
  {#if !demo}
    <details class="card fw-card">
      <summary>Acceleration times</summary>
      <p class="sub dim">Your best runs from the gauge's <b>ACCEL TIMER</b> menu — saved on the gauge and read here.</p>
      <div class="dtc-row">
        <button class="ghost" onclick={readAccelTimes} disabled={accelBusy}>
          {accelTimes ? 'Refresh' : 'Read best times'}
        </button>
        {#if accelHasAny(accelTimes)}
          <button class="ghost" onclick={downloadAccelCsv}>Download CSV</button>
        {/if}
      </div>
      {#if accelMsg}<p class="note">{accelMsg}</p>{/if}
      {#if accelTimes}
        <table class="acc-tbl">
          <tbody>
            <tr><td class="acc-h" colspan="2">By speed</td></tr>
            {#each accelTimes.speed as e, i}
              <tr><td>{SPEED_LABELS[i]}</td><td class="acc-v">{fmtT(e.ms)}</td></tr>
            {/each}
            <tr><td class="acc-h" colspan="2">By distance</td></tr>
            {#each accelTimes.dist as e, i}
              <tr><td>{DIST_LABELS[i]}</td>
                <td class="acc-v">{fmtT(e.ms)}{#if e.ms != null && e.trapKmh} · {e.trapKmh} km/h{/if}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if !accelHasAny(accelTimes)}
          <p class="sub dim">No runs saved yet — arm a run from the gauge's ACCEL TIMER menu.</p>
        {/if}
      {/if}
    </details>
  {/if}

  <!-- Drive log — pull the on-gauge recorder file over BLE + export CSV -->
  {#if !demo}
    <details class="card fw-card" ontoggle={onLogToggle}>
      <summary>Drive log</summary>
      <p class="sub dim">
        Records your drive on the gauge when you tap <b>RECORD</b> in its menu.
        Pull it here to save a spreadsheet (CSV) of every reading over time.
      </p>
      {#if logStat}<p class="fw-row-ver">{logStat}</p>{/if}
      {#if logBusy && logPct > 0}
        <div class="fw-bar"><div class="fw-fill" style="width:{logPct}%"></div></div>
      {/if}
      {#if logMsg}<p class="note">{logMsg}</p>{/if}
      <div class="fw-actions">
        <button class="fw-install up" onclick={showDynoGraph} disabled={logBusy}>
          {logBusy ? `Reading… ${logPct}%` : '📈 Dyno graph'}
        </button>
        <button class="ghost" onclick={pullDriveLog} disabled={logBusy}>Download CSV</button>
        <button class="ghost" onclick={eraseDriveLog} disabled={logBusy}>Erase</button>
      </div>
      {#if dynoMsg}<p class="note">{dynoMsg}</p>{/if}
      {#if dynoResult}
        <div class="dyno-wrap">
          <DynoChart result={dynoResult} redline={cfg.rpmLimit} />
          <p class="sub dim" style="text-align:center;margin-top:6px">
            Derived from {dynoResult.sampleCount} samples of your pull ·
            {dynoResult.rpmLo.toLocaleString()}–{dynoResult.rpmHi.toLocaleString()} rpm ·
            physics from vehicle weight ({cfg.massKg} kg)
          </p>
        </div>
      {/if}
    </details>

    <!-- Node log — the CAN node's captured diagnostic log (RE probes etc.) -->
    <details class="card fw-card">
      <summary>Node log (diagnostics)</summary>
      <p class="sub dim">
        The gauge saves the sensor's diagnostic log (PID / DTC / gateway probes).
        Pull it as a text file to read in-car RE results offline.
      </p>
      {#if nlogBusy && nlogPct > 0}
        <div class="fw-bar"><div class="fw-fill" style="width:{nlogPct}%"></div></div>
      {/if}
      {#if nlogMsg}<p class="note">{nlogMsg}</p>{/if}
      <div class="fw-actions">
        <button class="fw-install up" onclick={downloadNodeLog} disabled={nlogBusy}>
          {nlogBusy ? `Pulling… ${nlogPct}%` : 'Download log (.txt)'}
        </button>
        <button class="ghost" onclick={eraseNodeLog} disabled={nlogBusy}>Erase</button>
      </div>
    </details>

    <!-- Bus capture — raw CAN logger over BLE → SavvyCAN CSV for RE -->
    <details class="card fw-card" ontoggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) refreshCanState(); }}>
      <summary>Bus capture (RE)</summary>
      <p class="sub dim">
        Records <b>every CAN frame</b> on the car's OBD port to reverse-engineer signals.
        Start, drive, then download a <b>SavvyCAN CSV</b>. (Only OBD-port traffic — internal
        buses are gateway-isolated.)
      </p>
      <div class="dtc-row">
        <button class="ghost" style={canCapturing ? 'color:#e24b4a' : ''} onclick={toggleCanCapture} disabled={canBusy}>
          {canCapturing ? '● Stop capture' : 'Start capture'}
        </button>
        <button class="ghost" onclick={downloadCanCsv} disabled={canBusy}>Download CSV</button>
      </div>
      {#if canBusy && canPct > 0}<div class="fw-bar"><div class="fw-fill" style="width:{canPct}%"></div></div>{/if}
      {#if canMsg}<p class="note">{canMsg}</p>{/if}
      <div class="dtc-row"><button class="ghost" onclick={eraseCanLog} disabled={canBusy}>Erase capture</button></div>
    </details>
  {/if}

  <!-- ---- sticky save bar ---- -->
  <div class="savebar">
    {#if demo}
      <span class="save-msg dim">Demo — connect a gauge to save</span>
    {:else if saveResult === 'ok'}
      <span class="save-msg ok">✓ Saved to monitor</span>
    {:else if saveResult === 'rejected'}
      {#if cfgNeedsNewerMon}
        <span class="save-msg bad">✕ Update the gauge to v0.7.2 to use these channels</span>
      {:else}
        <span class="save-msg bad">✕ Rejected — check values</span>
      {/if}
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

  /* Cars + fault-code lookup */
  .car-select {
    width: 100%; margin: var(--s-2) 0;
    padding: 8px 10px; border-radius: var(--r-1);
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
    font-size: 15px;
  }
  .dt-adv { margin-top: var(--s-3); border-top: 1px solid var(--border); padding-top: var(--s-2); }
  .dt-adv > summary {
    cursor: pointer; list-style: none; font-size: 13px; color: var(--muted);
    padding: var(--s-1) 0;
  }
  .dt-adv > summary::-webkit-details-marker { display: none; }
  .dt-adv > summary::before { content: '⌁ '; color: var(--accent); }
  .exh-modes { display: flex; gap: var(--s-2); margin: var(--s-3) 0 var(--s-2); }
  .exh-mode { flex: 1; padding: 10px 0; font-size: 14px; font-weight: 600; cursor: pointer;
              background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); border-radius: 10px; }
  .exh-mode.on { background: var(--accent); color: #000; border-color: var(--accent); }
  .exh-mode:disabled { opacity: .5; cursor: default; }
  .exh-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; font-size: 14px; }
  .exh-row input[type=number] { width: 40%; text-align: right; }

  .dtc-row { display: flex; gap: var(--s-2); margin: var(--s-2) 0; }
  .dtc-input { flex: 1; text-transform: uppercase; }

  /* Rich fault-code card */
  .rc {
    margin-top: var(--s-2); padding: var(--s-3) 14px;
    border: 1px solid var(--border); border-left: 3px solid var(--sev);
    border-radius: var(--r-1); background: var(--bg);
  }
  .rc-top { display: flex; align-items: center; gap: var(--s-2); }
  .rc-code { font-family: var(--font-mono); font-size: 19px; font-weight: 700; color: var(--fg); }
  .rc-badge {
    font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px;
    color: var(--sev); border: 1px solid var(--sev);
  }
  .rc-headline { margin: 7px 0 2px; font-size: 16px; font-weight: 600; line-height: 1.35; }
  .rc-sys { margin: 0; font-size: 12px; color: var(--muted); }
  .rc-section { margin: 13px 0 5px; font-size: 12px; font-weight: 600; color: var(--muted); }
  .rc-list { margin: 0; padding-left: 18px; }
  .rc-list li { font-size: 14px; line-height: 1.55; margin: 3px 0; }
  .rc-drive {
    margin: 12px 0 2px; padding: 10px 12px; font-size: 13.5px; line-height: 1.5;
    border-radius: var(--r-1); border: 1px solid var(--sev); background: var(--surface-2); color: var(--fg);
  }
  .rc-causes { list-style: none; margin: 0; padding: 0; }
  .rc-causes li { display: flex; align-items: center; gap: 10px; font-size: 14px; margin: 6px 0; }
  .rc-fixes { list-style: none; margin: 0; padding: 0; }
  .rc-fixes li {
    position: relative; padding-left: 24px; font-size: 14px; line-height: 1.5; margin: 7px 0;
  }
  .rc-fixes li::before {
    content: '✓'; position: absolute; left: 0; top: 0;
    color: var(--sev); font-weight: 700;
  }
  .rc-num {
    flex: none; width: 20px; height: 20px; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 600; color: #fff; background: var(--accent);
  }
  .rc-ai {
    width: 100%; margin-top: 14px; padding: 10px; font-size: 14px; cursor: pointer;
    border: 1px solid var(--border); border-radius: var(--r-1);
    background: var(--surface-2); color: var(--fg);
  }
  .acc-tbl { width: 100%; border-collapse: collapse; margin-top: var(--s-2); }
  .acc-tbl td { padding: 7px 2px; font-size: 14px; border-bottom: 0.5px solid var(--border); }
  .acc-tbl .acc-h { font-size: 12px; color: var(--muted); font-weight: 500; padding-top: 12px; border-bottom: none; }
  .acc-tbl .acc-v { text-align: right; font-family: var(--font-mono); color: var(--fg); }
  .rc-chips { display: flex; flex-wrap: wrap; gap: var(--s-2); margin: var(--s-2) 0; }
  .rc-chip {
    font-size: 12px; padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--muted); background: var(--bg);
  }
  h3 { margin: 0 0 var(--s-2); font-size: 18px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 var(--s-3); }
  .sub.dim { opacity: 0.7; }

  /* ---- unit pickers ---- */
  .unit-system { display: flex; gap: 8px; margin: 10px 0 4px; }
  .unit-row { display: flex; align-items: center; justify-content: space-between;
              gap: 10px; padding: 7px 0; border-top: 0.5px solid var(--border); }
  .unit-lbl { font-size: 14px; color: var(--fg); }
  .unit-opts { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 600;
          background: var(--surface-2); color: var(--muted); border: 1px solid var(--border);
          cursor: pointer; white-space: nowrap; }
  .chip.sm { padding: 5px 11px; font-size: 12px; }
  .chip.on { background: var(--accent); color: #000; border-color: var(--accent); }
  .unit-system .chip { flex: 1; }
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
  /* arc/needle-1 · needle-2 (NEEDLE only) · text — sit together in the page head */
  .sw-row { display: flex; gap: 6px; align-items: center; }
  /* the text swatch reads as a letter so it isn't mistaken for another arc colour */
  .swatch.txt::after {
    content: 'A'; position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 12px; font-weight: 700; color: rgba(0,0,0,.55); pointer-events: none;
  }

  .pages { display: flex; flex-direction: column; gap: var(--s-3); }
  .page-card { padding: var(--s-3) var(--s-4); }
  .lay-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0 2px; }
  .page-controls { display: flex; align-items: center; justify-content: center; gap: 18px; margin: 4px 0 2px; }
  .pg-btn { width: 40px; height: 40px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--surface-2); color: var(--fg); font-size: 22px; font-weight: 700; cursor: pointer; line-height: 1; }
  .pg-btn:disabled { opacity: .35; cursor: default; }
  .pg-count { font-size: 14px; color: var(--muted); min-width: 64px; text-align: center; }
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
  .page-body.single { display: block; }

  /* single big preview + page dots */
  .ed-top { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: var(--s-4); }
  .ed-preview { display: flex; justify-content: center; }
  .ed-name { font: 600 12px var(--font-mono, ui-monospace); letter-spacing: .1em; color: var(--accent); text-transform: uppercase; }
  .ed-pages { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .pv-dot { width: 30px; height: 30px; border-radius: 999px; border: 1px solid var(--border);
            background: var(--bg); color: var(--muted); font-size: 13px; cursor: pointer; }
  .pv-dot.on { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--bg)); }

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
