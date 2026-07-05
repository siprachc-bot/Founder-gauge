// =====================================================================
//  founderGaugeCfg.ts — BLE client + 46-byte packed serialization for the
//  AXIS CAN MONITOR's "Custom Gauge" (Founder Gauge app).
//
//  This is NOT the gauge_fw's rich JSON config. The MONITOR stores a flat
//  packed struct (src/ui/GaugeConfig.h): version + 4 pages × (layout + 4 ch +
//  arcColor u16 + peak f32) + global brightness. sizeof == CFG_BYTES == 46.
//  We send exactly those 46 bytes over one ATT write (GATT Long Write on iOS).
//
//  KEEP IN SYNC with:
//    axis_can_monitor/src/BleGaugeCfg.cpp   (svc 7e1c0201 / cfg 0202 / ack 0203)
//    axis_can_monitor/src/ui/GaugeConfig.h  (struct layout + version)
//    axis_can_monitor/src/ui/GaugeChannels.h (Channel enum values = wire IDs)
// =====================================================================
import { BleClient as CapBle, type ScanResult } from '@capacitor-community/bluetooth-le';

// New service base for the MONITOR — distinct from knob (7e1c000x) and
// gauge_fw (7e1c010x). Must match axis_can_monitor/src/BleGaugeCfg.cpp.
export const MON_SVC  = '7e1c0201-9b3a-4f8e-8a5b-9d2e1f3a7c6d';
const CFG_CHAR        = '7e1c0202-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // read+write, 46-byte struct
const ACK_CHAR        = '7e1c0203-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // notify, 1 byte apply result
const BRIGHT_CHAR     = '7e1c0204-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // write, 1 byte live brightness
const OTA_CHAR        = '7e1c0205-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // firmware OTA (write chunks + notify)
const VER_CHAR        = '7e1c0206-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // read, 8-byte version report
const OTA_CHUNK       = 224;   // MUST match the monitor's ESP-NOW relay chunk (OtaTx CHUNK)

// OTA targets — byte 1 of the BEGIN packet. Must match OtaTx::Tgt on the monitor.
export const OTA_TARGET_NODE    = 0;   // relay to the CAN node over ESP-NOW
export const OTA_TARGET_MONITOR = 1;   // the monitor self-flashes its own ota_1

/** A firmware version triple {major,minor,patch} the monitor reports over BLE. */
export interface FwVersion { major: number; minor: number; patch: number; }
export interface DeviceVersions { monitor: FwVersion; node: FwVersion | null; }
export const verStr = (v: FwVersion | null | undefined) =>
  v ? `v${v.major}.${v.minor}.${v.patch}` : 'unknown';
/** Compare two version triples: >0 if a newer than b, 0 equal, <0 older. */
export function verCmp(a: FwVersion, b: FwVersion): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

// ---- Wire constants (mirror GaugeChannels.h Channel enum — APPEND ONLY) ----
export enum Ch {
  NONE = 0, RPM, SPEED, COOLANT, OILTEMP, INTAKE, LOAD,
  THROTTLE, BOOST, VOLT, SOC, FUELRATE,          // 1..11 (unchanged)
  // ---- v3 catalogue (append-only; MUST match GaugeChannels.h) ----
  MAF, BARO, TIMING, STFT, LTFT, AMBIENT, FUELLVL, CATTEMP, CMDTHR,
  RUNTIME, MAP_ABS, GEAR, DISTMIL, DISTCLR,      // 12..25
  COUNT,
}
export enum Layout { HERO = 0, BARS = 1 }

export const CFG_VERSION   = 3;         // must equal GaugeCfg.version in defaultCfg() (v3 = per-page colour+peak, brightness, expanded channels)
export const GAUGE_PAGES   = 4;
export const SLOTS_PER_PAGE = 4;        // HERO:[0]=primary [1]=support ; BARS:[0..3]
export const BRIGHT_DEFAULT = 200;      // matches firmware GAUGE_BRIGHT_DEFAULT

// Arc / accent colour (RGB565). Default = warm amber, matches the firmware
// GAUGE_ARC_DEFAULT (0xFDA0). The device is RGB565-native; convert to/from the
// #RRGGBB the app's colour input uses.
export const ARC_DEFAULT = 0xFDA0;
export function rgb565ToHex(v: number): string {
  const r5 = (v >> 11) & 0x1f, g6 = (v >> 5) & 0x3f, b5 = v & 0x1f;
  const r = (r5 << 3) | (r5 >> 2), g = (g6 << 2) | (g6 >> 4), b = (b5 << 3) | (b5 >> 2);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function hexToRgb565(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)) & 0xffff;
}

// Channel catalog for the picker. `label` = friendly picker text; `short` =
// the exact heading the MONITOR draws on-screen (mirrors GaugeChannels.h
// channelInfo labels) so the layout preview matches the device; `id` is the
// wire value written into the struct. Order here is UI order, not wire order.
// label = picker text; short = device heading (preview, mirrors GaugeChannels.h);
// min/max = native range (peak input hint); peak = sensible default redline
// (0 = none); group = optgroup for the (now long) dropdown.
export interface ChannelDef {
  id: Ch; label: string; short: string; unit: string;
  min: number; max: number; peak?: number; group: string;
}
export const CHANNELS: ChannelDef[] = [
  { id: Ch.NONE,     label: '— empty —',  short: '--',    unit: '',     min: 0,   max: 1,     group: '' },
  // Engine
  { id: Ch.RPM,      label: 'RPM',        short: 'RPM',   unit: '',     min: 0,   max: 8000,  peak: 6800, group: 'Engine' },
  { id: Ch.SPEED,    label: 'Speed',      short: 'SPEED', unit: 'km/h', min: 0,   max: 240,   group: 'Engine' },
  { id: Ch.LOAD,     label: 'Engine load',short: 'LOAD',  unit: '%',    min: 0,   max: 100,   group: 'Engine' },
  { id: Ch.THROTTLE, label: 'Throttle',   short: 'THR',   unit: '%',    min: 0,   max: 100,   group: 'Engine' },
  { id: Ch.CMDTHR,   label: 'Cmd throttle',short:'CTHR',  unit: '%',    min: 0,   max: 100,   group: 'Engine' },
  { id: Ch.BOOST,    label: 'Boost',      short: 'BOOST', unit: 'bar',  min: -1,  max: 2,     peak: 1.6,  group: 'Engine' },
  { id: Ch.MAP_ABS,  label: 'Manifold press',short:'MAP', unit: 'kPa',  min: 0,   max: 255,   group: 'Engine' },
  { id: Ch.MAF,      label: 'Air flow (MAF)',short:'MAF', unit: 'g/s',  min: 0,   max: 400,   group: 'Engine' },
  { id: Ch.TIMING,   label: 'Spark advance',short:'ADV',  unit: '°',    min: -20, max: 50,    group: 'Engine' },
  { id: Ch.GEAR,     label: 'Gear (calc)',short: 'GEAR',  unit: '',     min: 0,   max: 8,     group: 'Engine' },
  // Temps
  { id: Ch.COOLANT,  label: 'Water temp', short: 'WTEMP', unit: '°C',   min: 40,  max: 120,   peak: 110,  group: 'Temps' },
  { id: Ch.OILTEMP,  label: 'Oil temp',   short: 'OIL T', unit: '°C',   min: 40,  max: 150,   peak: 125,  group: 'Temps' },
  { id: Ch.INTAKE,   label: 'Intake air', short: 'IAT',   unit: '°C',   min: 0,   max: 90,    group: 'Temps' },
  { id: Ch.AMBIENT,  label: 'Ambient air',short: 'AMB',   unit: '°C',   min: -40, max: 50,    group: 'Temps' },
  { id: Ch.CATTEMP,  label: 'Catalyst temp',short:'CAT',  unit: '°C',   min: -40, max: 1000,  peak: 900,  group: 'Temps' },
  // Fuel
  { id: Ch.FUELRATE, label: 'Fuel rate',  short: 'FUEL',  unit: 'L/h',  min: 0,   max: 40,    group: 'Fuel' },
  { id: Ch.FUELLVL,  label: 'Fuel level', short: 'FUEL%', unit: '%',    min: 0,   max: 100,   group: 'Fuel' },
  { id: Ch.STFT,     label: 'Short fuel trim',short:'STFT',unit: '%',   min: -25, max: 25,    group: 'Fuel' },
  { id: Ch.LTFT,     label: 'Long fuel trim',short:'LTFT', unit: '%',   min: -25, max: 25,    group: 'Fuel' },
  // Electric
  { id: Ch.VOLT,     label: 'Voltage',    short: 'VOLTS', unit: 'V',    min: 10,  max: 16,    group: 'Electric' },
  { id: Ch.SOC,      label: 'Battery SOC',short: 'SOC',   unit: '%',    min: 0,   max: 100,   group: 'Electric' },
  // Trip / diagnostic
  { id: Ch.BARO,     label: 'Barometric', short: 'BARO',  unit: 'kPa',  min: 0,   max: 130,   group: 'Trip' },
  { id: Ch.RUNTIME,  label: 'Run time',   short: 'RUN',   unit: 's',    min: 0,   max: 65535, group: 'Trip' },
  { id: Ch.DISTMIL,  label: 'Dist. MIL on',short:'dMIL',  unit: 'km',   min: 0,   max: 65535, group: 'Trip' },
  { id: Ch.DISTCLR,  label: 'Dist. cleared',short:'dCLR', unit: 'km',   min: 0,   max: 65535, group: 'Trip' },
];
export function channelDef(id: number): ChannelDef | undefined {
  return CHANNELS.find(c => c.id === id);
}
export function channelLabel(id: number): string { return channelDef(id)?.label ?? `#${id}`; }
// Short device-style heading for the preview (e.g. SOC, WTEMP, THR).
export function channelShort(id: number): string { return channelDef(id)?.short ?? '--'; }
// Ordered optgroup names for the picker.
export const CHANNEL_GROUPS = ['Engine', 'Temps', 'Fuel', 'Electric', 'Trip'];

export interface PageCfg {
  layout: Layout;
  ch: number[];           // ch.length == SLOTS_PER_PAGE
  arcColor: number;       // RGB565 arc/accent colour, PER PAGE
  peak: number;           // primary redline in native units; 0 = off
}
export interface GaugeCfg {
  version: number;
  pages: PageCfg[];       // pages.length == GAUGE_PAGES
  brightness: number;     // 0..255 global AMOLED brightness
}

// Factory default — mirrors GaugeConfig.h defaultCfg() so the app "New" state
// matches a fresh monitor even before the first read.
export function defaultCfg(): GaugeCfg {
  return {
    version: CFG_VERSION,
    pages: [
      { layout: Layout.HERO, ch: [Ch.BOOST,    Ch.COOLANT, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 1.6  },
      { layout: Layout.HERO, ch: [Ch.RPM,      Ch.SPEED,   Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 6800 },
      { layout: Layout.HERO, ch: [Ch.THROTTLE, Ch.COOLANT, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 0    },
      { layout: Layout.HERO, ch: [Ch.SOC,      Ch.VOLT,    Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 0    },
    ],
    brightness: BRIGHT_DEFAULT,
  };
}

// ---- 46-byte packed (de)serialization — byte-exact with the packed struct ----
//  [0] version | 4 pages of { layout(1), ch[0..3](4), arcColor u16 LE(2), peak
//  f32 LE(4) } = 4×11 | brightness(1)
export const CFG_BYTES = 1 + GAUGE_PAGES * (1 + SLOTS_PER_PAGE + 2 + 4) + 1; // 46

export function encodeCfg(c: GaugeCfg): Uint8Array {
  const b  = new Uint8Array(CFG_BYTES);
  const dv = new DataView(b.buffer);
  let o = 0;
  b[o++] = c.version & 0xff;
  for (let p = 0; p < GAUGE_PAGES; p++) {
    const pg = c.pages[p];
    b[o++] = pg.layout & 0xff;
    for (let s = 0; s < SLOTS_PER_PAGE; s++) b[o++] = (pg.ch[s] ?? Ch.NONE) & 0xff;
    dv.setUint16(o, (pg.arcColor ?? ARC_DEFAULT) & 0xffff, true); o += 2;
    dv.setFloat32(o, pg.peak ?? 0, true);                        o += 4;
  }
  b[o++] = (c.brightness ?? BRIGHT_DEFAULT) & 0xff;
  return b;
}

export function decodeCfg(v: DataView): GaugeCfg {
  const version = v.getUint8(0);
  const pages: PageCfg[] = [];
  let o = 1;
  for (let p = 0; p < GAUGE_PAGES; p++) {
    const layout = v.getUint8(o++) as Layout;
    const ch: number[] = [];
    for (let s = 0; s < SLOTS_PER_PAGE; s++) ch.push(v.getUint8(o++));
    const arcColor = v.getUint16(o, true); o += 2;
    const peak     = v.getFloat32(o, true); o += 4;
    pages.push({
      layout: layout > Layout.BARS ? Layout.HERO : layout,
      ch,
      arcColor: arcColor || ARC_DEFAULT,
      // round off float32 storage noise (1.6f -> 1.6000000238) so the peak
      // input shows a clean number and the dirty-check stays stable.
      peak: (Number.isFinite(peak) && peak > 0) ? Math.round(peak * 100) / 100 : 0,
    });
  }
  const brightness = (o < v.byteLength) ? v.getUint8(o) : BRIGHT_DEFAULT;
  return { version, pages, brightness };
}

// Client-side mirror of firmware cfgValid() — block a bad SAVE before it goes.
export function cfgValid(c: GaugeCfg): boolean {
  if (c.version === 0) return false;
  if (c.pages.length !== GAUGE_PAGES) return false;
  for (const pg of c.pages) {
    if (pg.layout > Layout.BARS) return false;
    if (pg.ch.length !== SLOTS_PER_PAGE) return false;
    for (const ch of pg.ch) if (ch < 0 || ch >= Ch.COUNT) return false;
    if (!Number.isFinite(pg.peak) || pg.peak < 0) return false;
    if (!(pg.arcColor >= 0 && pg.arcColor <= 0xffff)) return false;
  }
  if (!(c.brightness >= 0 && c.brightness <= 255)) return false;
  return true;
}

let bleReady: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!bleReady) bleReady = CapBle.initialize({ androidNeverForLocation: true });
  return bleReady;
}
const dec = new TextDecoder();

export interface MonScanHit { id: string; name: string; rssi?: number; }

export class MonitorBleClient {
  constructor(public readonly deviceId: string) {}

  static async isAvailable(): Promise<boolean> {
    try { await ensureReady(); return true; } catch { return false; }
  }

  /** Open the OS device chooser and let the user pick the monitor. Works on
   *  EVERY platform (iOS/Android Capacitor + desktop/Android Chrome) with no
   *  experimental flag — unlike requestLEScan, which desktop Chrome gates
   *  behind chrome://flags. Returns the chosen deviceId. Filtered to AXIS
   *  devices; the monitor shows as "AXIS Monitor". Throws if cancelled. */
  static async pick(): Promise<string> {
    await ensureReady();
    const d = await CapBle.requestDevice({ namePrefix: 'AXIS', optionalServices: [MON_SVC] });
    return d.deviceId;
  }

  /** Last-resort chooser: NO name filter → the OS lists EVERY nearby BLE device
   *  (empty filter set makes the plugin pass acceptAllDevices on web / no scan
   *  filter on native). Use when pick()'s namePrefix filter turns up empty — e.g.
   *  the monitor's advertised name is arriving intermittently under ESP-NOW
   *  coexistence. There is no client-side predicate that can fail here, so the
   *  device WILL be listed as long as it radiates at all. Keep optionalServices
   *  so getServices()/read() to 7e1c0201 still works after connecting. */
  static async pickAll(): Promise<string> {
    await ensureReady();
    const d = await CapBle.requestDevice({ optionalServices: [MON_SVC] });
    return d.deviceId;
  }

  /** Scan for "AXIS Monitor". Name is in the primary packet; svc UUID in the
   *  scan response. Match client-side on /monitor/i OR the monitor svc UUID so
   *  we don't cross-connect the knob ("AXIS") or the gauge ("AXIS Gauge"). */
  static async scan(onHit: (h: MonScanHit) => void, durationMs = 6000): Promise<void> {
    await ensureReady();
    const seen = new Set<string>();
    try {
      const connected = await CapBle.getConnectedDevices([MON_SVC]);
      for (const d of connected) {
        if (seen.has(d.deviceId)) continue;
        seen.add(d.deviceId);
        onHit({ id: d.deviceId, name: d.name || 'AXIS Monitor', rssi: 0 });
      }
    } catch { /* platform may not support it */ }

    await CapBle.requestLEScan(
      { services: [], allowDuplicates: false },
      (r: ScanResult) => {
        const id = r.device.deviceId;
        if (seen.has(id)) return;
        const name  = r.localName || r.device.name || '';
        const uuids = (r.uuids ?? []).map(u => u.toLowerCase());
        const isMon = /monitor/i.test(name) || uuids.includes(MON_SVC.toLowerCase());
        if (!isMon) return;
        seen.add(id);
        onHit({ id, name: name || 'AXIS Monitor', rssi: r.rssi });
      });
    return new Promise(resolve => {
      setTimeout(async () => { try { await CapBle.stopLEScan(); } catch {} resolve(); }, durationMs);
    });
  }

  async connect(onDisconnect?: () => void): Promise<void> {
    await ensureReady();
    await CapBle.connect(this.deviceId, () => onDisconnect?.());
  }
  async disconnect(): Promise<void> {
    try { await CapBle.disconnect(this.deviceId); } catch {}
  }

  /** Subscribe to the apply-ack notify: 1 byte, 1 = applied+persisted, 0 = rejected. */
  async onAck(cb: (ok: boolean) => void): Promise<void> {
    await CapBle.startNotifications(this.deviceId, MON_SVC, ACK_CHAR,
      (v: DataView) => cb(v.byteLength > 0 && v.getUint8(0) === 1));
  }
  async offAck(): Promise<void> {
    try { await CapBle.stopNotifications(this.deviceId, MON_SVC, ACK_CHAR); } catch {}
  }

  /** Read the 46-byte struct off the monitor and decode it. */
  async config(): Promise<GaugeCfg> {
    // Precise error if the monitor svc wasn't discovered (wrong device, or the
    // deferred BLE hasn't come up ~2 s after boot).
    let services: Array<{ uuid?: string }> = [];
    try { services = await CapBle.getServices(this.deviceId); } catch {}
    if (services.length &&
        !services.some(s => s.uuid?.toLowerCase() === MON_SVC.toLowerCase())) {
      const seen = services.map(s => s.uuid).filter(Boolean).join(', ') || 'none';
      throw new Error(
        `Monitor config service (7e1c0201) not found. Discovered: ${seen}. ` +
        `If this is the AXIS Monitor, power-cycle it (BLE starts ~2 s after ` +
        `boot); otherwise it's the knob or gauge, not the monitor.`);
    }
    const v = await CapBle.read(this.deviceId, MON_SVC, CFG_CHAR);
    // Need the 4 pages block (45 B) to decode; brightness (byte 46) is filled
    // in by decodeCfg if a shorter blob is on the other end.
    if (v.byteLength < 45) throw new Error(`short config read: ${v.byteLength}B`);
    return decodeCfg(v);
  }

  /** Write the full 46-byte struct. Firmware validates + persists to NVS and
   *  fires the ack notify. */
  async setConfig(c: GaugeCfg): Promise<void> {
    const bytes = encodeCfg(c);
    await CapBle.write(this.deviceId, MON_SVC, CFG_CHAR, new DataView(bytes.buffer));
  }

  /** Live-dim the AMOLED (1-byte write to 7e1c0204) as the slider drags —
   *  applied immediately on the device, persisted only when setConfig() saves. */
  async setBrightness(v: number): Promise<void> {
    const b = new Uint8Array([Math.max(0, Math.min(255, Math.round(v)))]);
    await CapBle.writeWithoutResponse(this.deviceId, MON_SVC, BRIGHT_CHAR, new DataView(b.buffer));
  }

  /** Read the device firmware versions (char 7e1c0206, 8 bytes):
   *  [0..2] monitor {maj,min,patch} · [3..5] node · [6] nodeSeen. The sensor
   *  (node) is `null` until it has broadcast at least one 0xAD hello. */
  async readVersions(): Promise<DeviceVersions> {
    const v = await CapBle.read(this.deviceId, MON_SVC, VER_CHAR);
    if (v.byteLength < 7) throw new Error(`short version read: ${v.byteLength}B`);
    const nodeSeen = v.getUint8(6) === 1;
    return {
      monitor: { major: v.getUint8(0), minor: v.getUint8(1), patch: v.getUint8(2) },
      node: nodeSeen ? { major: v.getUint8(3), minor: v.getUint8(4), patch: v.getUint8(5) } : null,
    };
  }

  /** Flash a firmware image over BLE (char 7e1c0205). `target` selects where it
   *  goes — OTA_TARGET_NODE (0): the monitor relays it to the CAN node over
   *  ESP-NOW then reboots the node; OTA_TARGET_MONITOR (1): the monitor self-
   *  flashes its own ota_1 slot via Update.h then reboots. Use the app-only
   *  .bin (NOT merged.bin) either way. Stop-and-wait: each chunk waits for the
   *  monitor's notify (0=ready 1=done 2=error) before the next. onProgress
   *  (pct 0..100) drives a progress bar. */
  async flash(target: number, bin: Uint8Array, onProgress?: (pct: number) => void): Promise<void> {
    let resolve: ((s: number) => void) | null = null;
    let reject:  ((e: Error) => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const nextNotify = () => new Promise<number>((res, rej) => {
      resolve = res; reject = rej;
      timer = setTimeout(() => { resolve = reject = null; rej(new Error('monitor timeout')); }, 8000);
    });
    await CapBle.startNotifications(this.deviceId, MON_SVC, OTA_CHAR, (v: DataView) => {
      const status = v.byteLength > 0 ? v.getUint8(0) : 2;
      const pct    = v.byteLength > 1 ? v.getUint8(1) : 0;
      onProgress?.(pct);
      if (timer) { clearTimeout(timer); timer = null; }
      if (resolve) { const r = resolve; resolve = reject = null; r(status); }
    });
    const write = (bytes: Uint8Array) =>
      CapBle.write(this.deviceId, MON_SVC, OTA_CHAR, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let done = false;   // true once the device confirmed + is rebooting (→ no ABORT)
    try {
      // BEGIN [0x00, target u8, size u32 LE]
      const beg = new Uint8Array(6); beg[0] = 0x00; beg[1] = target & 0xff;
      new DataView(beg.buffer).setUint32(2, bin.length, true);
      await write(beg);
      if ((await nextNotify()) !== 0) throw new Error('device rejected the update');
      // DATA [0x01, payload…] — chunk by chunk; the monitor auto-ENDs on the last
      let off = 0;
      while (off < bin.length) {
        const end = Math.min(off + OTA_CHUNK, bin.length);
        const p = new Uint8Array(1 + (end - off)); p[0] = 0x01; p.set(bin.subarray(off, end), 1);
        await write(p);
        off = end;
        const s = await nextNotify();
        if (s === 1) { done = true; return; }  // done — device rebooting
        if (s === 2) throw new Error('device reported a write error');
        // s === 0 → ready for the next chunk
      }
      // all bytes sent but no "done" yet — wait one more (auto-END in flight)
      if ((await nextNotify()) !== 1) throw new Error('device did not confirm');
      done = true;
    } finally {
      // If we bailed mid-transfer (timeout / write error / user left), tell the
      // device to ABORT (0x03) — else it sits frozen in RD_CHUNK waiting for the
      // next chunk, and the gauge render stays frozen (App::loop early-returns
      // while an OTA is active). Skip on success (device is already rebooting).
      if (!done) { try { await write(new Uint8Array([0x03])); } catch {} }
      try { await CapBle.stopNotifications(this.deviceId, MON_SVC, OTA_CHAR); } catch {}
    }
  }

  /** Flash the CAN node (sensor) — app fetches the .bin, monitor relays it. */
  flashNode(bin: Uint8Array, onProgress?: (pct: number) => void): Promise<void> {
    return this.flash(OTA_TARGET_NODE, bin, onProgress);
  }
  /** Flash the monitor (gauge) itself over BLE self-OTA. */
  flashMonitor(bin: Uint8Array, onProgress?: (pct: number) => void): Promise<void> {
    return this.flash(OTA_TARGET_MONITOR, bin, onProgress);
  }
}
