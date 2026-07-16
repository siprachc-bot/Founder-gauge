// =====================================================================
//  Global state — Svelte 5 runes, no external store library needed.
//
//  Founder Gauge is a SINGLE-feature app: configure the AXIS Monitor's
//  "Custom Gauge" (4 pages × channels) over BLE. So the store is tiny —
//  just the live BLE client (held here so it survives any re-render) and
//  the last-connected device id for one-tap reconnect.
// =====================================================================
import type { MonitorBleClient } from './founderGaugeCfg';
import type { GaugeTheme } from './themes';

const LS_DEV_KEY = 'foundergauge.device';
const LS_OWNED_KEY = 'foundergauge.owned';   // theme ids the user has unlocked/bought

// Only one screen — kept as a type so PageHeader (shared with axis-companion)
// still type-checks its optional `back` prop.
export type Page = 'setup';

// True inside a Capacitor native wrapper (iOS/Android). Capacitor injects
// window.Capacitor synchronously before the app loads. On iPhone this is the
// ONLY path that has Web Bluetooth (Safari has no navigator.bluetooth); the
// @capacitor-community/bluetooth-le plugin polyfills it here and on Android/
// desktop Chrome.
export const IS_CAPACITOR =
  typeof (globalThis as any).Capacitor !== 'undefined';

// Replaced at build time by Vite (see vite.config.ts define). Unused for real
// hosting here (the monitor doesn't serve a PWA) but kept so the shared build
// config stays identical to axis-companion.
export const IS_DEVICE_BUILD =
  typeof __DEVICE_BUILD__ !== 'undefined' && __DEVICE_BUILD__;

class Store {
  page = $state<Page>('setup');

  // The live BLE link to the monitor. Held here (not page-local) so it
  // survives re-renders — MonitorSetup reuses it on mount instead of
  // re-scanning. Null until the user connects.
  monClient = $state<MonitorBleClient | null>(null);

  // Last device id, for one-tap auto-reconnect on next launch.
  lastDeviceId = $state<string>(loadDev());

  setLastDevice(id: string) {
    this.lastDeviceId = id;
    try { localStorage.setItem(LS_DEV_KEY, id); } catch {}
  }

  // ---- Theme store handoff ---------------------------------------------
  // The Store tab and the Gauge editor are separate tabs, so applying a theme
  // there can't touch the editor's cfg directly. Instead the Store sets
  // pendingTheme + requests the Gauge tab; MonitorSetup consumes it (applies to
  // cfg, then clears) and App switches the visible tab.
  pendingTheme = $state<GaugeTheme | null>(null);
  wantGaugeTab = $state(0);                      // bump to ask App to show Gauge

  // Owned/unlocked theme ids (built-ins are free; paid ones land here after a
  // purchase completes). Persisted locally for now — a real store would verify
  // entitlements server-side / via the platform receipt.
  owned = $state<string[]>(loadOwned());
  isOwned(id: string) { return this.owned.includes(id); }
  markOwned(id: string) {
    if (this.owned.includes(id)) return;
    this.owned = [...this.owned, id];
    try { localStorage.setItem(LS_OWNED_KEY, JSON.stringify(this.owned)); } catch {}
  }

  applyTheme(t: GaugeTheme) {
    this.pendingTheme = t;
    this.wantGaugeTab += 1;
  }
}

function loadDev(): string {
  try { return localStorage.getItem(LS_DEV_KEY) ?? ''; }
  catch { return ''; }
}

function loadOwned(): string[] {
  try { const v = JSON.parse(localStorage.getItem(LS_OWNED_KEY) ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

export const store = new Store();
