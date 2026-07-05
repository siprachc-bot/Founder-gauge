import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.snmotorsports.foundergauge',
  appName: 'Founder Gauge',
  // Capacitor serves the webview from capacitor://localhost/, so the bundle
  // must be built with base '/' (NOT '/axis-companion/' which the github.io
  // build uses). The existing `npm run build:device` target already builds
  // with base '/' and outputs to dist-device/ — Capacitor reuses that bundle.
  // If anything diverges from "device" build later, switch to a dedicated
  // VITE_TARGET=app + dist-app/ output.
  webDir: 'dist-device'
};

export default config;
