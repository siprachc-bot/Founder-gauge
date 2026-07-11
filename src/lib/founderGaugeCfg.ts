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
import { rawToDtc } from './dtcDict';

// New service base for the MONITOR — distinct from knob (7e1c000x) and
// gauge_fw (7e1c010x). Must match axis_can_monitor/src/BleGaugeCfg.cpp.
export const MON_SVC  = '7e1c0201-9b3a-4f8e-8a5b-9d2e1f3a7c6d';
const CFG_CHAR        = '7e1c0202-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // read+write, 46-byte struct
const ACK_CHAR        = '7e1c0203-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // notify, 1 byte apply result
const BRIGHT_CHAR     = '7e1c0204-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // write, 1 byte live brightness
const COLOR_CHAR      = '7e1c0209-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // write, [page, RGB565 LE] live arc colour
const OTA_CHAR        = '7e1c0205-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // firmware OTA (write chunks + notify)
const VER_CHAR        = '7e1c0206-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // read, 8-byte version report
const LOG_CHAR        = '7e1c0207-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // drive-log pull: WRITE cmd → READ reply
const GEAR_CHAR       = '7e1c0208-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // Push-A: 38-byte GearProfile relay → node
const DTC_CHAR        = '7e1c020a-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // DTC: READ live code list, WRITE[0x01] clear
const ACCEL_CHAR      = '7e1c020b-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // accel best-times blob (READ, ui::AccelTimes)
const NLOG_CHAR       = '7e1c020c-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // node-log text pull (WRITE cmd → READ reply)
const CAN_CHAR        = '7e1c020d-9b3a-4f8e-8a5b-9d2e1f3a7c6d'; // raw CAN-log pull + capture start/stop
const OTA_CHUNK       = 224;   // MUST match the monitor's ESP-NOW relay chunk (OtaTx CHUNK)

// OTA targets — byte 1 of the BEGIN packet. Must match OtaTx::Tgt on the monitor.
export const OTA_TARGET_NODE    = 0;   // relay to the CAN node over ESP-NOW
export const OTA_TARGET_MONITOR = 1;   // the monitor self-flashes its own ota_1

/** A firmware version triple {major,minor,patch} the monitor reports over BLE. */
export interface FwVersion { major: number; minor: number; patch: number; }
export interface DeviceVersions { monitor: FwVersion; node: FwVersion | null; }

/** The car's live stored trouble codes, read from the monitor (char 7e1c020a).
 *  `codes` are decoded to printed form ("P0301"); `mil` = check-engine lamp on.
 *  `conditions` = current RPM/coolant/load, if the monitor appended them. */
export interface DtcSnapshot {
  count: number;
  mil: boolean;
  codes: string[];
  conditions?: { rpm: number; coolant: number; load: number };
}

/** Best acceleration times, read from the monitor (char 7e1c020b). `ms` is null
 *  when that target has no recorded run yet. `trapKmh` = finish speed (drag only). */
export interface AccelTimeEntry { ms: number | null; trapKmh?: number; }
export interface AccelTimes { speed: AccelTimeEntry[]; dist: AccelTimeEntry[]; }
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
  AFR, LAMBDA,                                   // 26..27 air-fuel ratio (same data)
  // ---- Phase B (append-only; MUST match GaugeChannels.h) ----
  LAMBDA_M, AFR_M, ABSLOAD, PEDAL, FRP, RELTHR, DTC,  // 28..34
  COUNT,
}
export enum Layout { HERO = 0, BARS = 1 }

export const CFG_VERSION   = 6;         // MUST equal GaugeCfg.version in the firmware's defaultCfg() (v6 = ch[5] per page: HERO/BARS + a reserved 5th slot). Was 5/ch[4]=91B → the v6 firmware (95B) rejected every write.
export const GAUGE_PAGES   = 4;
export const SLOTS_PER_PAGE = 5;        // HERO:[0]=primary [1..3]=support ; BARS:[0..3] ; slot[4] reserved — matches firmware GaugeConfig.h
export const BRIGHT_DEFAULT = 200;      // matches firmware GAUGE_BRIGHT_DEFAULT
export const RPM_LIMIT_DEFAULT  = 6000; // redline for calc-gear (V60 T8); app-configurable per car
export const GEAR_COUNT_DEFAULT = 8;    // forward gears (Aisin AWF8 = 8-speed)
export const SHIFT_RPM_DEFAULT  = 5500; // shift-light trigger RPM (0 = off); app-configurable
// Drivetrain for the accurate calc-gear (AWF8 / V60 T8) — user-editable per car.
export const GEAR_RATIOS_DEFAULT = [5.250, 3.029, 1.950, 1.457, 1.221, 1.000, 0.809, 0.673];
export const FINAL_DRIVE_DEFAULT = 3.10;                         // reproduces the verified k≈24.5
export const TIRE_DEFAULT = { width: 235, aspect: 40, rim: 19 }; // 235/40R19

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
  { id: Ch.ABSLOAD,  label: 'Absolute load',short:'ALOAD',unit: '%',    min: 0,   max: 250,   group: 'Engine' },
  { id: Ch.PEDAL,    label: 'Accelerator pedal',short:'PEDAL',unit:'%', min: 0,   max: 100,   group: 'Engine' },
  { id: Ch.RELTHR,   label: 'Rel. throttle',short:'RTHR', unit: '%',    min: 0,   max: 100,   group: 'Engine' },
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
  { id: Ch.AFR,      label: 'A/F ratio (cmd)',short:'A/F', unit: ':1',   min: 10,  max: 20,    group: 'Fuel' },
  { id: Ch.LAMBDA,   label: 'Lambda (cmd)',short:'LAMBDA', unit: '',     min: 0.70,max: 1.30,  group: 'Fuel' },
  { id: Ch.AFR_M,    label: 'A/F actual (wideband)',short:'AF ACT',unit:':1',min:10,max: 20,   group: 'Fuel' },
  { id: Ch.LAMBDA_M, label: 'Lambda actual',short:'λ ACT', unit: '',     min: 0.70,max: 1.30,  group: 'Fuel' },
  { id: Ch.FRP,      label: 'Fuel rail pressure',short:'FRAIL',unit:'bar',min: 0,  max: 250,   group: 'Fuel' },
  // Electric
  { id: Ch.VOLT,     label: 'Voltage',    short: 'VOLTS', unit: 'V',    min: 10,  max: 16,    group: 'Electric' },
  { id: Ch.SOC,      label: 'Battery SOC',short: 'SOC',   unit: '%',    min: 0,   max: 100,   group: 'Electric' },
  // Trip / diagnostic
  { id: Ch.BARO,     label: 'Barometric', short: 'BARO',  unit: 'kPa',  min: 0,   max: 130,   group: 'Trip' },
  { id: Ch.RUNTIME,  label: 'Run time',   short: 'RUN',   unit: 's',    min: 0,   max: 65535, group: 'Trip' },
  { id: Ch.DISTMIL,  label: 'Dist. MIL on',short:'dMIL',  unit: 'km',   min: 0,   max: 65535, group: 'Trip' },
  { id: Ch.DISTCLR,  label: 'Dist. cleared',short:'dCLR', unit: 'km',   min: 0,   max: 65535, group: 'Trip' },
  { id: Ch.DTC,      label: 'Fault codes (count)',short:'DTC',unit: '',  min: 0,   max: 20,    group: 'Trip' },
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
  rpmLimit: number;       // redline (RPM) for the monitor's calc-gear (v4)
  gearCount: number;      // forward gears in the box, 1..8 (v4)
  shiftRpm: number;       // shift-light trigger RPM; 0 = off (v4)
  gearRatios: number[];   // per-gear ratio, 1st..8th (length 8) (v5)
  finalDrive: number;     // final-drive ratio (v5)
  tireWidth: number;      // tyre section width mm, e.g. 235 (v5)
  tireAspect: number;     // aspect ratio %, e.g. 40 (v5)
  tireRim: number;        // rim diameter inches, e.g. 19 (v5)
}

// Factory default — mirrors GaugeConfig.h defaultCfg() so the app "New" state
// matches a fresh monitor even before the first read.
export function defaultCfg(): GaugeCfg {
  return {
    version: CFG_VERSION,
    pages: [
      // ch.length MUST == SLOTS_PER_PAGE (5) — a short array trips client cfgValid.
      { layout: Layout.HERO, ch: [Ch.BOOST,    Ch.COOLANT, Ch.NONE, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 1.6  },
      { layout: Layout.HERO, ch: [Ch.RPM,      Ch.SPEED,   Ch.NONE, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 6800 },
      { layout: Layout.HERO, ch: [Ch.THROTTLE, Ch.COOLANT, Ch.NONE, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 0    },
      { layout: Layout.HERO, ch: [Ch.SOC,      Ch.VOLT,    Ch.NONE, Ch.NONE, Ch.NONE], arcColor: ARC_DEFAULT, peak: 0    },
    ],
    brightness: BRIGHT_DEFAULT,
    rpmLimit: RPM_LIMIT_DEFAULT,
    gearCount: GEAR_COUNT_DEFAULT,
    shiftRpm: SHIFT_RPM_DEFAULT,
    gearRatios: [...GEAR_RATIOS_DEFAULT],
    finalDrive: FINAL_DRIVE_DEFAULT,
    tireWidth: TIRE_DEFAULT.width,
    tireAspect: TIRE_DEFAULT.aspect,
    tireRim: TIRE_DEFAULT.rim,
  };
}

// ---- 95-byte packed (de)serialization — byte-exact with the firmware struct ----
//  [0] version | 4 pages of { layout(1), ch[0..4](5), arcColor u16 LE(2), peak
//  f32 LE(4) } = 4×12 | brightness(1) | rpmLimit u16 LE(2) | gearCount(1) |
//  shiftRpm u16 LE(2) | gearRatios 8×f32 LE(32) | finalDrive f32 LE(4) |
//  tireWidth u16 LE(2) | tireAspect(1) | tireRim(1)
export const CFG_BYTES = 1 + GAUGE_PAGES * (1 + SLOTS_PER_PAGE + 2 + 4) + 1 + 2 + 1 + 2
                           + 8 * 4 + 4 + 2 + 1 + 1; // 95 (SLOTS_PER_PAGE=5 → PageCfg 12)

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
  dv.setUint16(o, (c.rpmLimit ?? RPM_LIMIT_DEFAULT) & 0xffff, true); o += 2;
  b[o++] = (c.gearCount ?? GEAR_COUNT_DEFAULT) & 0xff;
  dv.setUint16(o, (c.shiftRpm ?? SHIFT_RPM_DEFAULT) & 0xffff, true); o += 2;
  for (let i = 0; i < 8; i++) { dv.setFloat32(o, c.gearRatios?.[i] ?? 0, true); o += 4; }
  dv.setFloat32(o, c.finalDrive ?? FINAL_DRIVE_DEFAULT, true);       o += 4;
  dv.setUint16(o, (c.tireWidth ?? TIRE_DEFAULT.width) & 0xffff, true); o += 2;
  b[o++] = (c.tireAspect ?? TIRE_DEFAULT.aspect) & 0xff;
  b[o++] = (c.tireRim ?? TIRE_DEFAULT.rim) & 0xff;
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
  const brightness = (o < v.byteLength) ? v.getUint8(o) : BRIGHT_DEFAULT; o += 1;
  // Length-guarded so an older 46-byte v3 blob (monitor not yet updated) still
  // decodes, defaulting the new fields.
  const rpmLimit  = (o + 1 < v.byteLength) ? v.getUint16(o, true) : RPM_LIMIT_DEFAULT; o += 2;
  const gearCount = (o < v.byteLength) ? v.getUint8(o) : GEAR_COUNT_DEFAULT; o += 1;
  const shiftRpm  = (o + 1 < v.byteLength) ? v.getUint16(o, true) : SHIFT_RPM_DEFAULT; o += 2;
  // v5 drivetrain — round float32 storage noise (3.0299999 → 3.03) so the inputs
  // show clean numbers and the dirty-check stays stable.
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const gearRatios: number[] = [];
  for (let i = 0; i < 8; i++) {
    gearRatios.push((o + 3 < v.byteLength) ? r3(v.getFloat32(o, true)) : (GEAR_RATIOS_DEFAULT[i] ?? 0));
    o += 4;
  }
  const finalDrive = (o + 3 < v.byteLength) ? r3(v.getFloat32(o, true)) : FINAL_DRIVE_DEFAULT; o += 4;
  const tireWidth  = (o + 1 < v.byteLength) ? v.getUint16(o, true) : TIRE_DEFAULT.width; o += 2;
  const tireAspect = (o < v.byteLength) ? v.getUint8(o) : TIRE_DEFAULT.aspect; o += 1;
  const tireRim    = (o < v.byteLength) ? v.getUint8(o) : TIRE_DEFAULT.rim;
  return { version, pages, brightness, rpmLimit, gearCount, shiftRpm,
           gearRatios, finalDrive, tireWidth, tireAspect, tireRim };
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
  if (!(c.rpmLimit >= 1000 && c.rpmLimit <= 12000)) return false;
  if (!(c.gearCount >= 0 && c.gearCount <= 8)) return false;   // 0 = CVT/eCVT (gauge shows "CVT")
  if (!(c.shiftRpm === 0 || (c.shiftRpm >= 1000 && c.shiftRpm <= 12000))) return false;
  if (!(c.finalDrive > 0.5 && c.finalDrive < 10)) return false;
  if (!(c.tireWidth >= 100 && c.tireWidth <= 400)) return false;
  if (!(c.tireAspect >= 20 && c.tireAspect <= 90)) return false;
  if (!(c.tireRim >= 10 && c.tireRim <= 26)) return false;
  for (let i = 0; i < c.gearCount && i < 8; i++)
    if (!(c.gearRatios[i] > 0 && c.gearRatios[i] < 20)) return false;
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

  /** Push-A: send a car's 38-byte gear-decode GearProfile (char 7e1c0208). The
   *  monitor forwards it VERBATIM to the CAN node over ESP-NOW (byte[0]==0xC0);
   *  the node applies it + persists to NVS so the car's REAL gear decodes without
   *  a firmware reflash. `bytes` MUST be exactly GEAR_PROFILE_BYTES (38) — build
   *  it with encodeGearProfile() from gearProfiles.ts. Resolves once the monitor
   *  NOTIFYs it relayed the blob (or after a short timeout — ESP-NOW is fire-and-
   *  forget, so the node's on-screen "gear profile set" log is the real proof). */
  async setGearProfile(bytes: Uint8Array): Promise<void> {
    if (bytes.length !== 38) throw new Error(`gear profile must be 38 bytes, got ${bytes.length}`);
    let relayed: (() => void) | null = null;
    const done = new Promise<void>((res) => (relayed = res));
    try {
      await CapBle.startNotifications(this.deviceId, MON_SVC, GEAR_CHAR, (v: DataView) => {
        if (v.byteLength > 0 && v.getUint8(0) === 1 && relayed) relayed();
      });
    } catch { /* NOTIFY optional — fall through to the write + timeout */ }
    await CapBle.write(this.deviceId, MON_SVC, GEAR_CHAR, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    await Promise.race([done, new Promise<void>((res) => setTimeout(res, 1500))]);
    try { await CapBle.stopNotifications(this.deviceId, MON_SVC, GEAR_CHAR); } catch { /* ignore */ }
  }

  /** Live-dim the AMOLED (1-byte write to 7e1c0204) as the slider drags —
   *  applied immediately on the device, persisted only when setConfig() saves. */
  async setBrightness(v: number): Promise<void> {
    const b = new Uint8Array([Math.max(0, Math.min(255, Math.round(v)))]);
    await CapBle.writeWithoutResponse(this.deviceId, MON_SVC, BRIGHT_CHAR, new DataView(b.buffer));
  }

  /** Live-recolour a page's arc (3-byte write to 7e1c0209: [page, RGB565 LE]) as the
   *  owner drags the colour picker. The gauge jumps to `page` and repaints its arc
   *  immediately; applied in RAM only, persisted when setConfig() Saves. */
  async setPageColor(page: number, color565: number): Promise<void> {
    const b = new Uint8Array([page & 0xff, color565 & 0xff, (color565 >> 8) & 0xff]);
    await CapBle.writeWithoutResponse(this.deviceId, MON_SVC, COLOR_CHAR, new DataView(b.buffer));
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

  /** Read the car's live stored trouble codes (char 7e1c020a). The monitor packs
   *  [count, mil, code0_hi, code0_lo, …] from the node's latest 0xAF list; we
   *  decode each raw 2-byte code to its printed form ("P0301"). Empty (count 0)
   *  means the car reported no codes; a short read means the monitor is on an
   *  older firmware (no DTC char) → treat as "not supported". */
  async readDtcCodes(): Promise<DtcSnapshot> {
    const v = await CapBle.read(this.deviceId, MON_SVC, DTC_CHAR);
    if (v.byteLength < 2) return { count: 0, mil: false, codes: [] };
    const count = v.getUint8(0);
    const mil = v.getUint8(1) === 1;
    const codes: string[] = [];
    for (let i = 0; i < count && 2 + i * 2 + 1 < v.byteLength; i++) {
      codes.push(rawToDtc(v.getUint8(2 + i * 2), v.getUint8(3 + i * 2)));
    }
    // Optional trailing current-conditions block (RPM u16 LE, coolant i16 LE, load u8).
    const condOff = 2 + count * 2;
    let conditions: DtcSnapshot['conditions'];
    if (v.byteLength >= condOff + 5) {
      conditions = {
        rpm: v.getUint16(condOff, true),
        coolant: v.getInt16(condOff + 2, true),
        load: v.getUint8(condOff + 4),
      };
    }
    return { count, mil, codes, conditions };
  }

  /** Clear the car's stored codes + check-engine light (char 7e1c020a WRITE[0x01]).
   *  The monitor relays it to the node, which runs Mode-04. Fire-and-forget — poll
   *  readDtcCodes() a few seconds later to confirm the codes dropped. */
  async clearDtcCodes(): Promise<void> {
    const b = new Uint8Array([0x01]);
    await CapBle.write(this.deviceId, MON_SVC, DTC_CHAR, new DataView(b.buffer));
  }

  /** Read the saved best acceleration times (char 7e1c020b). Raw ui::AccelTimes:
   *  [version, pad, speedMs[3] u32 LE, distMs[3] u32 LE, distTrap[3] u16 LE].
   *  0xFFFFFFFF ms = no run yet. */
  async readAccelTimes(): Promise<AccelTimes> {
    const v = await CapBle.read(this.deviceId, MON_SVC, ACCEL_CHAR);
    const NONE = 0xffffffff;
    const speed: AccelTimeEntry[] = [];
    const dist: AccelTimeEntry[] = [];
    if (v.byteLength >= 32) {
      for (let i = 0; i < 3; i++) {
        const ms = v.getUint32(2 + i * 4, true);
        speed.push({ ms: ms === NONE ? null : ms });
      }
      for (let i = 0; i < 3; i++) {
        const ms = v.getUint32(14 + i * 4, true);
        const trap = v.getUint16(26 + i * 2, true);
        dist.push({ ms: ms === NONE ? null : ms, trapKmh: trap || undefined });
      }
    }
    return { speed, dist };
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
    const writeNR = (bytes: Uint8Array) =>
      CapBle.writeWithoutResponse(this.deviceId, MON_SVC, OTA_CHAR, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    // Windowed self-OTA ONLY for the monitor (target 1): burst a batch of chunks
    // with no per-chunk ack, then one SYNC carrying the batch's chunk count as the
    // barrier. ~6× faster than a per-chunk round-trip. The node relay (target 0)
    // stays legacy stop-and-wait — its bottleneck is the ESP-NOW hop, not BLE.
    const windowed = target === OTA_TARGET_MONITOR;
    const WIN = 16;       // chunks per batch (matches monitor OTA_WIN_MAX)
    const WCHUNK = 180;   // WNR-safe: 1 (op) + 180 = 181 <= 185 (min iOS MTU) - 3
    let done = false;     // true once the device confirmed + is rebooting (→ no ABORT)
    try {
      if (windowed) {
        // BEGIN [0x00, target u8, size u32 LE, window u8]
        const beg = new Uint8Array(7); beg[0] = 0x00; beg[1] = target & 0xff;
        new DataView(beg.buffer).setUint32(2, bin.length, true); beg[6] = WIN;
        await write(beg);
        if ((await nextNotify()) !== 0) throw new Error('device rejected the update');
        let off = 0, naks = 0;
        while (off < bin.length) {
          const batchEnd = Math.min(off + WIN * WCHUNK, bin.length);
          let n = 0;
          for (let c = off; c < batchEnd; c += WCHUNK) {         // burst the batch, no per-chunk wait
            const e = Math.min(c + WCHUNK, batchEnd);
            const p = new Uint8Array(1 + (e - c)); p[0] = 0x01; p.set(bin.subarray(c, e), 1);
            await writeNR(p); n++;
          }
          await write(new Uint8Array([0x02, n & 0xff]));         // SYNC [count] — with-response barrier
          const s = await nextNotify();
          if (s === 1) { done = true; return; }                  // done — device rebooting
          if (s === 2) throw new Error('device reported a write error');
          if (s === 3) { if (++naks > 8) throw new Error('too many dropped batches'); continue; } // NAK: resend batch
          naks = 0; off = batchEnd;                              // s === 0: batch committed → advance
        }
        if ((await nextNotify()) !== 1) throw new Error('device did not confirm');
        done = true;
      } else {
        // ---- legacy stop-and-wait (node relay) ----
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
      }
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

  // ---- Drive-log pull (char 7e1c0207) ----
  // Request/response on one characteristic: WRITE a command, then READ the reply.
  // Must match axis_can_monitor/src/BleGaugeCfg.cpp LogCb + system/Datalogger.*.
  //   WRITE [0x00]              → READ [sizeLE(4)|countLE(4)|logVer|sampleBytes] (10 B)
  //   WRITE [0x01, offsetLE(4)] → READ up to ~180 raw log bytes @offset (0 B past EOF)
  //   WRITE [0x02]              → READ [status] (1=erased)

  private logWrite(bytes: Uint8Array): Promise<void> {
    return CapBle.write(this.deviceId, MON_SVC, LOG_CHAR, new DataView(bytes.buffer));
  }
  private logRead(): Promise<DataView> {
    return CapBle.read(this.deviceId, MON_SVC, LOG_CHAR);
  }

  /** GET_INFO: stored-log size (bytes, incl. 20-B header), sample count, format. */
  async logInfo(): Promise<{ size: number; count: number; ver: number; sampleBytes: number }> {
    await this.logWrite(new Uint8Array([0x00]));
    const v = await this.logRead();
    if (v.byteLength < 10) throw new Error(`short log info: ${v.byteLength}B`);
    return {
      size: v.getUint32(0, true),
      count: v.getUint32(4, true),
      ver: v.getUint8(8),
      sampleBytes: v.getUint8(9),
    };
  }

  /** Pull the whole drive-log file off the device (header + all samples). Loops
   *  GET_CHUNK, accumulating, driving onProgress (0..100). Throws if nothing recorded. */
  async pullLog(onProgress?: (pct: number) => void): Promise<Uint8Array> {
    const info = await this.logInfo();
    if (info.size <= 20 || info.count === 0)
      throw new Error('No drive recorded yet — tap RECORD on the gauge, take a drive, then pull the log.');

    const out = new Uint8Array(info.size);
    let off = 0, stall = 0;
    while (off < info.size) {
      const req = new Uint8Array(5);
      req[0] = 0x01;
      new DataView(req.buffer).setUint32(1, off, true);
      await this.logWrite(req);
      const chunk = await this.logRead();
      const n = chunk.byteLength;
      if (n === 0) { if (++stall > 3) break; continue; }   // EOF or a transient empty read
      stall = 0;
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, n), off);
      off += n;
      onProgress?.(Math.min(100, Math.round((off / info.size) * 100)));
    }
    return out.subarray(0, off);
  }

  /** ERASE the stored drive-log on the device. Returns true if it was deleted. */
  async eraseLog(): Promise<boolean> {
    await this.logWrite(new Uint8Array([0x02]));
    const v = await this.logRead();
    return v.byteLength > 0 && v.getUint8(0) === 1;
  }

  // ---- Node log (char 7e1c020c) — the CAN node's captured ESP-NOW log text ----
  // Same request/response protocol as the drive log: WRITE cmd → READ reply.
  private nlogWrite(bytes: Uint8Array): Promise<void> {
    return CapBle.write(this.deviceId, MON_SVC, NLOG_CHAR, new DataView(bytes.buffer));
  }
  private nlogRead(): Promise<DataView> {
    return CapBle.read(this.deviceId, MON_SVC, NLOG_CHAR);
  }

  /** Size (bytes) of the captured node-log text file. */
  async nodeLogInfo(): Promise<number> {
    await this.nlogWrite(new Uint8Array([0x00]));
    const v = await this.nlogRead();
    return v.byteLength >= 4 ? v.getUint32(0, true) : 0;
  }

  /** Pull the whole node-log file as text (loops GET_CHUNK). Empty string if none. */
  async pullNodeLog(onProgress?: (pct: number) => void): Promise<string> {
    const size = await this.nodeLogInfo();
    if (size === 0) return '';
    const out = new Uint8Array(size);
    let off = 0, stall = 0;
    while (off < size) {
      const req = new Uint8Array(5);
      req[0] = 0x01;
      new DataView(req.buffer).setUint32(1, off, true);
      await this.nlogWrite(req);
      const chunk = await this.nlogRead();
      const n = chunk.byteLength;
      if (n === 0) { if (++stall > 3) break; continue; }
      stall = 0;
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, n), off);
      off += n;
      onProgress?.(Math.min(100, Math.round((off / size) * 100)));
    }
    return new TextDecoder().decode(out.subarray(0, off));
  }

  /** ERASE the captured node log. Returns true if deleted. */
  async eraseNodeLog(): Promise<boolean> {
    await this.nlogWrite(new Uint8Array([0x02]));
    const v = await this.nlogRead();
    return v.byteLength > 0 && v.getUint8(0) === 1;
  }

  // ---- Raw CAN capture (char 7e1c020d) — bus RE ----
  // WRITE[0x00]=GET_INFO / [0x01,off]=GET_CHUNK / [0x02]=ERASE / [0x03]=START / [0x04]=STOP.
  private canWrite(bytes: Uint8Array): Promise<void> {
    return CapBle.write(this.deviceId, MON_SVC, CAN_CHAR, new DataView(bytes.buffer));
  }
  private canRead(): Promise<DataView> {
    return CapBle.read(this.deviceId, MON_SVC, CAN_CHAR);
  }
  /** GET_INFO: {size bytes (incl. 16-B header), frame count, record bytes, capturing}. */
  async canLogInfo(): Promise<{ size: number; count: number; recBytes: number; capturing: boolean }> {
    await this.canWrite(new Uint8Array([0x00]));
    const v = await this.canRead();
    if (v.byteLength < 10) return { size: 0, count: 0, recBytes: 20, capturing: false };
    return {
      size: v.getUint32(0, true),
      count: v.getUint32(4, true),
      recBytes: v.getUint8(8),
      capturing: v.getUint8(9) === 1,
    };
  }
  /** Pull the whole /canlog.bin (header + records) as bytes. */
  async pullCanLog(onProgress?: (pct: number) => void): Promise<Uint8Array> {
    const info = await this.canLogInfo();
    if (info.size <= 16) throw new Error('No CAN capture yet — start BUS LOG, drive, then pull.');
    const out = new Uint8Array(info.size);
    let off = 0, stall = 0;
    while (off < info.size) {
      const req = new Uint8Array(5);
      req[0] = 0x01;
      new DataView(req.buffer).setUint32(1, off, true);
      await this.canWrite(req);
      const chunk = await this.canRead();
      const n = chunk.byteLength;
      if (n === 0) { if (++stall > 3) break; continue; }
      stall = 0;
      out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, n), off);
      off += n;
      onProgress?.(Math.min(100, Math.round((off / info.size) * 100)));
    }
    return out.subarray(0, off);
  }
  async eraseCanLog(): Promise<boolean> {
    await this.canWrite(new Uint8Array([0x02]));
    const v = await this.canRead();
    return v.byteLength > 0 && v.getUint8(0) === 1;
  }
  /** Start/stop capture remotely (monitor relays 0xC3 to the node). */
  async setCanCapture(on: boolean): Promise<void> {
    await this.canWrite(new Uint8Array([on ? 0x03 : 0x04]));
  }
}
