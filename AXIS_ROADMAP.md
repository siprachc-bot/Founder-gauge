# AXIS — Engineering Roadmap

Generated from the full R&D analysis (2026-07-08). Reference car: 2023 Volvo V60 T8 (SPA/iCUP).
Ecosystem = **node** (ArtronShop ESP-OBD2, OBD→ESP-NOW) + **monitor** (Waveshare 1.32 AMOLED gauge) + **app** (founder-gauge, Svelte/Capacitor, BLE config + OTA).

**Status legend**
- ✅ **DONE** — shipped + published to OTA
- 🟢 **SHIP-READY** — built + published this session (verify on car when reconnected)
- 🟡 **STAGED** — code written, needs **real-car data/verification** before publishing an OTA bin
- 🔵 **PLANNED** — designed, not yet built (build order below)

---

## Recently shipped

| Ver | What |
|---|---|
| ✅ node v0.4.3 | Un-gate the hidden channels — force-poll the verified-readable Mode-01 set (bitmap hides 39/40) |
| ✅ node v0.4.4 / mon v0.7.2 | Phase B channels: measured λ 0x34, abs load 0x43, pedal 0x49, fuel rail 0x59, rel throttle 0x45, DTC count 0x01 |
| 🟢 **node v0.4.5 / mon v0.7.3** | **Engine-off false-alert fix** — node broadcasts a `0xAE` sleep packet before deep-sleep; gauge force-clears alarms on link-lost/sleep, WARNING arms only on fresh data. Kills the false LOW FUEL on the frozen last frame. **(published this session; verify on car)** |

---

## 1. Universal cross-brand hidden-data scan  🔵 / 🟡

Goal: auto-discover readable PIDs/DIDs on any car/brand, not just the V60.
- 🟡 **ISO-TP multi-frame receiver** (node) — the single biggest gap. `requestPid_`/`requestDid22_` accept SINGLE-FRAME only, so VIN (F190) + long UDS 0x22 DIDs + Mode 03 DTC can't be read. Add: accept First Frame → send Flow Control `0x30 00 00` to the ECU's physical addr → collect Consecutive Frames. **Blocker: verify it works through the SPA gateway on the real car.** *(scaffolded behind `DTC_SCAN_EN` — see §3)*
- 🔵 **Promote `scanPids()` to a persisted discovery stage** — record reply source-address per PID; union with (never filter by) the bitmap; persist to NVS keyed by VIN hash. Gate the full sweep behind a "bitmap looks suspicious" spot-check so non-gated cars don't eat ~11s/boot.
- 🔵 **`BusProfile` struct in NVS** (replaces the `addr29_` bool) — bitrate + addressing + live-ECU list + VIN hash → a known car skips the whole scan.
- 🔵 **Shipped per-brand DID dictionary** (firmware + app-updatable) — live discovery finds *which* DIDs answer; the dictionary supplies *meaning* (DID→formula, per WMI). New-brand support ships as a DATA update, not a firmware rewrite.
- ⛔ Out of scope: MS-CAN (Ford pins 3/11 = separate bus, hardware). Safety: reads only; extended session `0x10 03` stationary+physical+3E only; **never** `0x27`/write/functional-session.

## 2. Engine-off false alerts  🟢 SHIPPED (this session)

- 🟢 node `0xAE` sleep packet + gauge force-clear-on-stale + WARNING fresh-arm gate + `clearAll()` on sleep transition. Kills false LOW FUEL after key-off.
- 🟡 **Fuel-value sanity** — 0x2F un-gated but its live value not yet confirmed sane on a real fuel change (could false-fire LOW FUEL if it decodes garbage). **Blocker: watch the live % on a real drive; add a sane floor if needed.**

## 3. DTC dictionary — gauge WARNING + app full-detail  🟢 (Mode-03 verified) / 🔵

- ✅ **Mode 03 read VERIFIED IN-CAR (2026-07-08)** — flashed DTC_SCAN_EN on the V60 T8: the SPA gateway **DOES** serve Mode-03 (ECU answered `43 00` → 0 codes). `recvMode03_` ISO-TP receiver works. DTC-on-gauge is reachable from OBD on this car. ⚠️ only the Single-Frame path is exercised (0 codes); the multi-frame FF+FlowControl+CF path awaits a car with ≥3 stored codes. Node reverted to clean v0.4.5.
- 🔵 **`0xD0` DTC-list ESP-NOW packet** (node→gauge) — send the read codes when scanned (separate from the hot telemetry frame). Then bump node→v0.4.6 with `scanDtc()` on a dtcCount-rising-edge trigger (not per-boot).
- 🔵 **Gauge DTC WARNING** — reuse `AlertOverlay` (AlertSev::WARNING, amber): "CHECK ENGINE · P0128 · Powertrain · see app". Decode 2-byte → letter+category **offline**; P1xxx → "see app". Optionally map known-severe codes (misfire P0300 / overheat) → DANGER.
- 🔵 **Gauge generic DTC dictionary** in SPIFFS (~85 KB generic, +Volvo P1xxx ~145 KB; 1.97 MB free). Sorted 2-byte-key → short-desc, binary search. Swappable data file (Thai/English), NOT compiled into the image.
- 🔵 **App full-detail screen** — code list + human title + cause/what-to-do (bundled JSON) + **AI DTC explainer** (RAG + live context, disclaimer). Matches the earlier mockup.
- 🔵 **Known-codes whitelist → suppress on gauge** (no ECU write) — for CATless / GPF-delete cars (P0420/P042E). Sidesteps the coding auth wall entirely; still alerts on NEW codes. *(iCUP may block Mode-04 clear anyway → suppress is the right answer.)*
- ⛔ **No Mode 04 clear** in the consumer path (readiness reset / freeze-frame wipe / liability). Optional Pro-only, app-only, heavily gated.

## 4. Gear position — calc-gear dictionary  🔵

True engaged gear is NOT on the V60 OBD (gateway-blocked, not broadcast). Ship calc-gear everywhere.
- 🔵 **De-bake `GEAR_TABLE`** → store raw `{ratios[], final_drive, tyre}`; compute k on-device (portable, app-settable).
- 🔵 **App "pick your car" → send profile over BLE** (reuse GaugeCfg svc) → removes gearbox-detection ambiguity. Gearbox library ships in the app.
- 🔵 **TC-slip handling** — steady-state gate (low accel + pedal/throttle not moving, using Phase-B pedal 0x49/throttle 0x11), asymmetric tolerance (slip only inflates rk → bias up), `tc_lockup_min_gear`, publish debounce (2-3 samples), confidence byte (gear faded until locked). **Threshold tuning needs a real drive log.** 🟡
- 🔵 Probe Mode-01 `0xA4` free per car (returns ratio, still needs lookup). Internal-CAN tap = enthusiast accessory only, not baseline.

## 5. Market-gap features (roadmap by impact/effort)  🔵

| # | Feature | Leverage | Notes |
|---|---|---|---|
| **1** | **Datalogging + CSV/GPX export** | ⭐⭐⭐ | 🟢 **Device-side SHIPPED (mon v0.8.0).** `Datalogger` → LittleFS `/drivelog.bin` (`AXL1` header + 24-byte, 5 Hz samples), armed from the on-gauge menu → RECORD, red dot on the gauge, auto-saves + finalises count on key-off. One-file-per-drive (newest wins). 🔵 **NEXT: BLE pull (char `7e1c0207`, chunked GET_INFO/GET_CHUNK/ERASE) + app `driveLog.ts` (parse→CSV/GPX) + MonitorSetup "Drive log" card** → v0.8.1. Data already flows through the frame. **Biggest spec-sheet gap closed.** |
| **2** | **0-100 / 0-60 timing (OBD-speed)** | ⭐⭐⭐ | Auto-arm at standstill → detect launch → time to target → store best. Uses speed we already read (0x1FFF0120). Attacks Dragy. "OBD-timed" (≈200-500 ms latency, honest). |
| **3** | **Multi-car profile DB** | ⭐⭐ | Save each brute-scan/VIN profile → app "your car" picker. Turns the "one car" weakness into a moat. Foundational for §1/§4. |
| 4 | Wired-power option for the gauge | ⭐⭐ | 12V/USB-C harness or piggyback the OBD node. Removes the "2 devices need power" friction; keeps wireless DATA. |
| 5 | AI DTC explainer (§3) | ⭐ | app-side, RAG on bundled JSON. |
| 6 | Boost/AFR "enthusiast pack" pages | ⭐ | measured λ 0x34 + abs load 0x43 + fuel rail 0x59 + boost — already force-polled. New hero-page templates. Opens the tuner segment. |
| 7 | HUD / windshield mirror mode | ⭐ | one mirrored high-contrast render mode + reflective film. |
| 8 | Community car-profile sharing | ⭐ | upload/download scan profiles + layouts. Network effect. Depends on #3. |

## 6. Personal / founder-only (not for sale)  🔵

- Volvo SPA coding tweaks (start/stop default, ambient, region, etc.) — **NOT via the AXIS node** (0x27 CEM-PIN + iCUP VGM wall; writes return NRC 0x33; brick risk). Use DiCE/VXDIAG clone + Orbit/VDASH (if Sensus) or online VIDA/dealer (if iCUP). Node stays read-only. See `reference_v60_coding`.
- CATless / GPF-delete pops tune → throws P0420/GPF DTCs → the §3 whitelist-suppress makes the gauge stop nagging (the one AXIS-side thing that helps a modified car).

---

## Build order (recommendation)

1. **Verify** node v0.4.5 / mon v0.7.3 on the car (false-alert fix) + confirm fuel 0x2F live value.
2. **ISO-TP multi-frame + `scanDtc()`** (§1/§3) — flip `DTC_SCAN_EN`, in-car RE whether Mode 03 works through the gateway. → unlocks DTC + VIN + universal scan.
3. **Datalogging + 0-100 timing** (§5.1/§5.2) — highest leverage, no new car data needed, uses the existing frame. Can build fully offline.
4. **Calc-gear de-bake + app car-picker + TC-slip** (§4) — tune thresholds against the datalog from step 3.
5. **Multi-car profile DB** (§5.3) + per-brand DID dictionary (§1) — the moat.

> Anything marked 🟡 must not publish an OTA bin until verified on the real car (the analysis can't tell if the gatewayed V60 serves Mode 03, or whether 0x2F's live value is sane).
