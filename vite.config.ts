import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// Two build targets:
//   - github.io           → base = "/founder-gauge/", output dist/
//   - device (LittleFS)   → base = "/",                output dist-device/
// Pick via VITE_TARGET=device|pages env var. Default = pages.
const TARGET = process.env.VITE_TARGET ?? 'pages';
const DEVICE = TARGET === 'device';
const BASE   = DEVICE ? '/' : '/founder-gauge/';
const OUTDIR = DEVICE ? 'dist-device' : 'dist';

export default defineConfig({
  base: BASE,
  build: { outDir: OUTDIR, emptyOutDir: true },
  define: { __DEVICE_BUILD__: JSON.stringify(DEVICE) },
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Founder Gauge',
        short_name: 'Founder Gauge',
        description: 'Configure your AXIS gauge display over Bluetooth.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: BASE,
        scope: BASE,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // Never cache the device JSON API — always go to network so we see
        // live state. Pattern matches /api/* whether served from device or
        // a separate origin.
        navigateFallback: BASE + 'index.html',
        runtimeCaching: [
          { urlPattern: /\/api\//,                handler: 'NetworkOnly' },
          { urlPattern: /^http:\/\/192\.168\.4\.1\//, handler: 'NetworkOnly' }
        ],
        // Activate the new service worker on the next page load instead of
        // waiting for every tab/standalone window to close. Necessary
        // because the PWA gets installed once and lives on the user's home
        // screen — without this, fresh deployments are invisible until
        // they fully kill+relaunch the app.
        skipWaiting: true,
        clientsClaim: true
      }
    })
  ],
  server: {
    port: 5173,
    host: true
  }
});
