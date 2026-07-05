// =====================================================================
//  axisCanOta — SN-AXIS-style "fetch firmware from GitHub" for the AXIS
//  CAN ecosystem (the monitor + the CAN node sensor).
//
//  Mirrors axis-companion/src/lib/api.ts: a JSON manifest hosted on THIS
//  app's own GitHub Pages site (founder-gauge/public/firmware/) is the single
//  source of truth for "latest firmware". The phone (which has internet)
//  fetches the manifest,
//  compares to what the DEVICES report over BLE (MonitorBleClient.read-
//  Versions), downloads the .bin, then flashes it over BLE:
//    · node    → monitor relays it to the sensor over ESP-NOW
//    · monitor → monitor self-flashes its own ota_1 slot (Update.h)
//
//  Two separate release streams (the monitor and the node build indepen-
//  dently), so this manifest has a `monitor` array and a `node` array
//  instead of the knob manifest's single `releases`.
// =====================================================================
import type { FwVersion } from './founderGaugeCfg';

/** One published firmware build for one target. `url` is relative to the
 *  Pages SITE ROOT (e.g. "firmware/axis_can_monitor-v0.2.0.bin"). */
export interface CanReleaseEntry {
  /** Numeric build, matched against what the device reports over BLE. */
  version: string;           // "0.2.0"
  date: string;
  notes: string;
  url: string;               // relative-to-site-root or absolute https
  size_bytes: number;
}

export interface CanManifest {
  _schema: string;           // "axis-can-firmware/v1"
  monitor: CanReleaseEntry[];
  node: CanReleaseEntry[];
}

// Self-hosted on THIS app's own GitHub Pages (founder-gauge/public/firmware/).
// Absolute https so the native iOS webview (capacitor://localhost) reaches it
// the same as the web PWA — a relative URL would resolve to capacitor://
// localhost and fail. Served straight from the PUBLIC repo via raw.github-
// usercontent.com (CORS `*`, no GitHub Pages needed — Pages requires a paid
// plan for this account). resolveCanUrl() strips back past /firmware/ so the
// entry `url`s resolve under .../main/public/firmware/. Owner `siprachc-bot`.
export const CAN_MANIFEST_URL =
  'https://raw.githubusercontent.com/siprachc-bot/Founder-gauge/main/public/firmware/axis-can.json';

/** Parse a "0.2.0" version string into a comparable triple. */
export function parseVer(s: string): FwVersion {
  const [a, b, c] = String(s).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  return { major: a || 0, minor: b || 0, patch: c || 0 };
}

/** The newest entry in a release list (by numeric version), or null if empty. */
export function latest(entries: CanReleaseEntry[]): CanReleaseEntry | null {
  if (!entries?.length) return null;
  return [...entries].sort((x, y) => {
    const a = parseVer(x.version), b = parseVer(y.version);
    return (b.major - a.major) || (b.minor - a.minor) || (b.patch - a.patch);
  })[0];
}

/** Resolve a manifest entry's `url` (relative to the Pages site root) to an
 *  absolute URL — same rule as axis-companion: strip back past /firmware/. */
export function resolveCanUrl(relativeOrAbsolute: string): string {
  if (/^https?:\/\//.test(relativeOrAbsolute)) return relativeOrAbsolute;
  const siteRoot = CAN_MANIFEST_URL.replace(/\/firmware\/[^/]+$/, '/');
  return new URL(relativeOrAbsolute, siteRoot).toString();
}

/** Fetch the CAN firmware manifest (cache-busted so a fresh publish is seen). */
export async function fetchCanManifest(timeoutMs = 8000): Promise<CanManifest> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CAN_MANIFEST_URL}?t=${Date.now()}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const m = (await res.json()) as CanManifest;
    if (!m || !Array.isArray(m.monitor) || !Array.isArray(m.node)) {
      throw new Error('malformed manifest');
    }
    return m;
  } finally {
    clearTimeout(tid);
  }
}

/** Download a firmware .bin as bytes for flashing over BLE. */
export async function downloadFirmware(
  entry: CanReleaseEntry,
  timeoutMs = 30000
): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(resolveCanUrl(entry.url), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`firmware HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`firmware too small (${buf.length}B)`);
    return buf;
  } finally {
    clearTimeout(tid);
  }
}
