// =====================================================================
//  driveLog.ts — parse the AXIS CAN MONITOR's on-device drive recorder
//  file (pulled over BLE, char 7e1c0207) and export it as CSV.
//
//  KEEP IN SYNC with axis_can_monitor/src/system/Datalogger.h:
//    header 20 B:  magic[4]="AXL1", version u16, sampleBytes u16,
//                  startedAtMs u32, sampleCount u32, reserved u32
//    sample 24 B:  tMs u32, rpm u16, speedX10 u16, coolant i16,
//                  boostKpa i16, cmVoltMv u16, afrLambdaX1000 u16,
//                  catTemp i16, throttle u8, load u8, gear u8,
//                  hybBatt u8, fuelLvl u8, flags u8
//  All little-endian (ESP32). Scaled ints → we rescale to human units here.
// =====================================================================

export interface DriveLogHeader {
  magic: string;
  version: number;
  sampleBytes: number;
  startedAtMs: number;
  sampleCount: number;
}

export interface DriveSample {
  tSec: number;
  rpm: number;
  speedKmh: number;
  coolantC: number;
  boostBar: number;
  battV: number;
  afrLambda: number;
  catC: number;
  throttlePct: number;
  loadPct: number;
  gear: string; // 0xFF → "EV", else the numeric gear
  hybSocPct: number;
  fuelPct: number;
}

export interface DriveLog {
  header: DriveLogHeader;
  samples: DriveSample[];
}

const HEADER_BYTES = 20;

/** Parse the raw drive-log file bytes (header + samples). Throws on a bad magic. */
export function parseDriveLog(buf: Uint8Array): DriveLog {
  if (buf.byteLength < HEADER_BYTES) throw new Error('drive log too short');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== 'AXL1') throw new Error(`not an AXIS drive log (magic "${magic}")`);

  const header: DriveLogHeader = {
    magic,
    version: dv.getUint16(4, true),
    sampleBytes: dv.getUint16(6, true) || 24, // stride; fall back to the known size
    startedAtMs: dv.getUint32(8, true),
    sampleCount: dv.getUint32(12, true),
  };

  const stride = header.sampleBytes;
  const samples: DriveSample[] = [];
  for (let o = HEADER_BYTES; o + stride <= buf.byteLength; o += stride) {
    const gearRaw = dv.getUint8(o + 20);
    samples.push({
      tSec: dv.getUint32(o + 0, true) / 1000,
      rpm: dv.getUint16(o + 4, true),
      speedKmh: dv.getUint16(o + 6, true) / 10,
      coolantC: dv.getInt16(o + 8, true),
      boostBar: dv.getInt16(o + 10, true) / 100,
      battV: dv.getUint16(o + 12, true) / 1000,
      afrLambda: dv.getUint16(o + 14, true) / 1000,
      catC: dv.getInt16(o + 16, true),
      throttlePct: dv.getUint8(o + 18),
      loadPct: dv.getUint8(o + 19),
      gear: gearRaw === 0xff ? 'EV' : String(gearRaw),
      hybSocPct: dv.getUint8(o + 21),
      fuelPct: dv.getUint8(o + 22),
    });
  }
  return { header, samples };
}

const CSV_COLS = [
  'time_s', 'rpm', 'speed_kmh', 'coolant_c', 'boost_bar', 'batt_v',
  'afr_lambda', 'cat_c', 'throttle_pct', 'load_pct', 'gear', 'hyb_soc_pct', 'fuel_pct',
];

/** Serialise a parsed drive log to CSV text (one header row + one row per sample). */
export function toCsv(log: DriveLog): string {
  const rows = [CSV_COLS.join(',')];
  for (const s of log.samples) {
    rows.push([
      s.tSec.toFixed(3), s.rpm, s.speedKmh.toFixed(1), s.coolantC,
      s.boostBar.toFixed(2), s.battV.toFixed(2), s.afrLambda.toFixed(3),
      s.catC, s.throttlePct, s.loadPct, s.gear, s.hybSocPct, s.fuelPct,
    ].join(','));
  }
  return rows.join('\n');
}

/** Filename for the export. The device has no RTC, so we tag with the on-device
 *  drive duration + sample count rather than a wall-clock date. */
export function driveLogName(log: DriveLog, ext = 'csv'): string {
  const dur = log.samples.length ? Math.round(log.samples[log.samples.length - 1].tSec) : 0;
  return `axis-drive-${dur}s-${log.samples.length}samples.${ext}`;
}

/** Save text to a file cross-platform, dependency-free:
 *   1) Web Share Level 2 (share a File) — the path that works inside iOS WKWebView.
 *   2) <a download> — desktop Chrome + Android.
 *  If the user cancels the iOS share sheet we do NOT also download. */
export async function saveTextFile(name: string, mime: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], name, { type: mime });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.canShare?.({ files: [file] }) && typeof navigator.share === 'function') {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return; // user cancelled — don't double-save
      // any other share failure → fall through to the anchor download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
