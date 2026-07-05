// =====================================================================
//  Global state — Svelte 5 runes, no external store library needed.
//
//  Founder Gauge is a SINGLE-feature app: configure the AXIS Monitor's
//  "Custom Gauge" (4 pages × channels) over BLE. So the store is tiny —
//  just the live BLE client (held here so it survives any re-render) and
//  the last-connected device id for one-tap reconnect.
// =====================================================================
import type { MonitorBleClient } from './founderGaugeCfg';

const LS_DEV_KEY = 'foundergauge.device';

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
}

function loadDev(): string {
  try { return localStorage.getItem(LS_DEV_KEY) ?? ''; }
  catch { return ''; }
}

export const store = new Store();
