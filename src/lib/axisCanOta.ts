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

// Served from the PUBLIC repo via the jsDelivr CDN (cdn.jsdelivr.net/gh/…),
// NOT raw.githubusercontent.com. raw.* is not a CDN: it aggressively rate-
// limits (HTTP 429) and streams binaries slowly, which broke OTA downloads.
// jsDelivr is a real multi-CDN with edge PoPs (incl. Bangkok), CORS `*` (so
// the native iOS webview at capacitor://localhost reaches it like the web PWA),
// and mirrors the exact repo path. Absolute https for the same webview reason.
// resolveCanUrl() strips back past /firmware/ so entry `url`s resolve under
// .../public/firmware/. Owner `siprachc-bot`.
//
// FRESHNESS — WHY WE PIN A COMMIT SHA, NOT @main:
// jsDelivr caches the branch→commit map for `@main` (~12 h s-maxage) and
// purge.jsdelivr.net clears the FILE cache but NOT that stale branch-head
// resolution. After a few rapid pushes the app kept reading an OLD axis-can.json
// even though the versioned .bin files (new filenames) were fresh (2026-07-10).
// FIX: resolve the latest commit SHA from the GitHub API and pull EVERYTHING from
// the IMMUTABLE `@<sha>` path — always fresh, no branch cache. Falls back to `@main`
// if the API is unreachable/rate-limited (api.github.com, not the 429-happy raw.*).
const CAN_REPO = 'siprachc-bot/Founder-gauge';
const CAN_SITE_ROOT_MAIN = `https://cdn.jsdelivr.net/gh/${CAN_REPO}@main/public/`;

// Back-compat export (@main manifest URL). fetchCanManifest resolves a fresher
// @<sha> URL at runtime; this constant stays for any external reference/logging.
export const CAN_MANIFEST_URL = `${CAN_SITE_ROOT_MAIN}firmware/axis-can.json`;

// Site root the current session resolves manifest + bins against. Set by
// fetchCanManifest() to the @<sha> path once resolved so downloadFirmware() pulls
// the matching commit's .bin. Defaults to @main until the first manifest fetch.
let g_canSiteRoot = CAN_SITE_ROOT_MAIN;

/** Latest commit SHA on main via the GitHub API (null on any failure → caller
 *  falls back to @main). Tiny `application/vnd.github.sha` response. */
async function ghLatestSha(timeoutMs = 6000): Promise<string | null> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${CAN_REPO}/commits/main`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github.sha' },
    });
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

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
  // Resolve against the SAME @<sha> (or @main) site root the manifest came from,
  // so the .bin is pulled from the exact commit we read the manifest at.
  return new URL(relativeOrAbsolute, g_canSiteRoot).toString();
}

/** Fetch the CAN firmware manifest (cache-busted so a fresh publish is seen). */
export async function fetchCanManifest(timeoutMs = 8000): Promise<CanManifest> {
  // Resolve the newest commit first and pin the immutable @<sha> path (no branch
  // cache lag); fall back to @main if the GitHub API can't be reached.
  const sha = await ghLatestSha();
  g_canSiteRoot = sha
    ? `https://cdn.jsdelivr.net/gh/${CAN_REPO}@${sha}/public/`
    : CAN_SITE_ROOT_MAIN;
  const manifestUrl = `${g_canSiteRoot}firmware/axis-can.json`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${manifestUrl}?t=${Date.now()}`, {
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
