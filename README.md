# Founder Gauge

Minimal companion app for the **AXIS Monitor** (Waveshare 1.32″ round AMOLED
OBD gauge). One job: configure the monitor's 4-page **Custom Gauge** over
Bluetooth — pick the *big* + *small* value shown on each page, hit save.

Cloned from the `axis-companion` shell (Vite + Svelte 5 + TS + Capacitor); the
knob / media / rich-gauge features are stripped out.

## How it talks to the gauge

- **Transport:** BLE, directly to the monitor (no relay through the CAN node).
- **Service:** `7e1c0201-…` · **config char** `7e1c0202` (read+write, 21-byte
  packed struct) · **ack char** `7e1c0203` (notify: 1 = applied+saved, 0 =
  rejected).
- **Wire format:** `src/lib/founderGaugeCfg.ts` — mirrors the firmware struct
  `axis_can_monitor/src/ui/GaugeConfig.h` (version + 4 pages × {layout, ch[4]}).
  **Keep these in sync**; the version byte gates NVS load and the firmware
  rejects any write that isn't exactly 21 bytes.

The monitor validates, persists to NVS (`axiscmon/gcfg`), re-renders, and — via
the focus feedback — immediately re-points the CAN node's fast poll at the new
page's channels.

## Run it

```bash
npm install
npm run dev            # local dev (Chrome / Android Chrome have Web Bluetooth)
npm run build          # GitHub Pages build  -> dist/  (base /founder-gauge/)
npm run build:device   # Capacitor build     -> dist-device/ (base /)
npx cap add ios        # first time only
npx cap copy ios && open ios/App/App.xcworkspace   # iPhone: Web Bluetooth needs the native app
```

**iPhone note:** Safari has no `navigator.bluetooth`, so the Pages URL can't do
BLE on iOS — build the Capacitor app in Xcode. Android Chrome / desktop Chrome
work straight from the Pages build. A **Preview the layout** button lets anyone
(no hardware) see the configurator with factory defaults.

## v1 scope

- HERO layout only: each page = 1 big arc value + 1 support value. The firmware
  struct also carries a `BARS` layout + 4 slots, so bars can be added later with
  no wire change.
