// =============================================================================
//  ecuPresets.ts — starter ECU profiles for the standalone-ECU CAN box.
//
//  A preset is a STARTING POINT the user picks from a dropdown, then verifies
//  against their own ECU before trusting the numbers. Every signal here is
//  transcribed from the vendor's PUBLISHED CAN protocol (or its de-facto
//  reference decoder), cited in `source` — NEVER guessed. A wrong boost/AFR map
//  makes the gauge lie and can wreck an engine.
//
//  Confidence tiers:
//    'verified'   — transcribed from the vendor's OWN CAN protocol document.
//    'community'  — from a well-established open-source decoder / DBC that the
//                   community treats as the reference (the vendor publishes the
//                   scaling only as a binary channel file, or gated the PDF).
//                   Very likely right; confirm against your ECU before trusting.
//    'configurable' — the ECU's CAN output is USER-DEFINED (no fixed factory
//                   stream), so there is no universal preset. We ship guidance,
//                   not numbers: read your own CAN config and map it by hand.
//
//  UNIT CONTRACT: each signal's scale/offset produces the channel's NATIVE frame
//  unit (see CHANNEL_NATIVE_UNIT in ecuProfile.ts):
//    RPM rev/min · SPEED km/h · temps °C · %-channels % · MAP_ABS kPa absolute
//    VOLT millivolts · AFR_M λ×1000 · FRP/OILPRESS kPa gauge · TIMING ° signed
//  so a vendor value in bar / Kelvin / volts / λ is CONVERTED to that here.
//
//  BOOST is deliberately not mapped: every one of these ECUs sends MAP
//  (absolute), and gauge boost = MAP − baro is a two-signal subtraction a
//  single-signal profile can't express. We map MAP_ABS honestly instead; the
//  monitor/app can derive boost from MAP + baro downstream if wanted.
// =============================================================================
import type { EcuProfile, EcuSignal } from './ecuProfile';
import { Ch } from './founderGaugeCfg';

export type PresetConfidence = 'verified' | 'community' | 'configurable';

export interface EcuPreset {
  id: string;
  vendor: string;
  model: string;
  confidence: PresetConfidence;
  source: string;
  notes: string;
  profile: EcuProfile | null;   // null for 'configurable' (no fixed stream)
}

// Terse signal builder to keep the tables auditable at a glance.
// s(canId, startByte, bits, channel, scale, offset, {be, signed, ext})
function s(
  canId: number, startByte: number, bits: 8 | 16 | 24 | 32,
  channel: number, scale: number, offset: number,
  opts: { be?: boolean; signed?: boolean; ext?: boolean } = {},
): EcuSignal {
  return {
    canId, startByte, bits, channel, scale, offset,
    bigEndian: !!opts.be, signed: !!opts.signed, extended: !!opts.ext,
  };
}

// =============================================================================
//  MaxxECU — "MaxxECU Default CAN output", protocol v1.3
//  500 kbit/s, 11-bit, LITTLE-ENDIAN signed int16, value = raw × scale (no offset).
//  Source: https://www.maxxecu.com/webhelp/can-default_maxxecu_protocol.html
//  ⚠️ Must be ENABLED in MTune (CAN → CAN outputs) — not on by default.
//  Native-unit conversions: VOLT 0.01 V → mV (×10); Lambda raw is already λ×1000.
// =============================================================================
const MAXXECU: EcuProfile = {
  bitrate: 500000,
  enabled: true,
  signals: [
    s(0x520, 0, 16, Ch.RPM,      1,   0, { signed: true }),   // rpm
    s(0x520, 2, 16, Ch.THROTTLE, 0.1, 0, { signed: true }),   // TPS %
    s(0x520, 4, 16, Ch.MAP_ABS,  0.1, 0, { signed: true }),   // MAP kPa abs
    s(0x520, 6, 16, Ch.AFR_M,    1,   0, { signed: true }),   // lambda (raw=λ×1000)
    s(0x521, 4, 16, Ch.TIMING,   0.1, 0, { signed: true }),   // ignition °
    s(0x522, 6, 16, Ch.SPEED,    0.1, 0, { signed: true }),   // km/h
    s(0x530, 0, 16, Ch.VOLT,     10,  0, { signed: true }),   // battery 0.01V → mV
    s(0x530, 4, 16, Ch.INTAKE,   0.1, 0, { signed: true }),   // IAT °C
    s(0x530, 6, 16, Ch.COOLANT,  0.1, 0, { signed: true }),   // ECT °C
    s(0x536, 0, 16, Ch.GEAR,     1,   0, { signed: true }),   // gear
    s(0x536, 4, 16, Ch.OILPRESS, 0.1, 0, { signed: true }),   // oil press kPa (v1.3)
    s(0x536, 6, 16, Ch.OILTEMP,  0.1, 0, { signed: true }),   // oil temp °C (v1.3)
    s(0x537, 0, 16, Ch.FRP,      0.1, 0, { signed: true }),   // fuel press kPa (v1.3)
  ],
};

// =============================================================================
//  ECUMaster EMU Black — "EMU stream", base ID 0x600 (8 frames 0x600–0x607)
//  500 kbit/s (or 1 Mbit), 11-bit, LITTLE-ENDIAN. Mixed 8/16-bit, mixed signed.
//  Scaling transcribed from the EMUcan reference library (designer2k2/EMUcan);
//  channel identities confirmed by ECUMaster's official ADU App Note (emuBlack.pdf).
//  ⚠️ Base ID is configurable in EMU software — if the tune changed it, shift
//  every id by the same delta. Enable "Send EMU stream over CAN-Bus".
//  Conversions: battery 0.027 V/bit → mV (×27); oil/fuel bar → kPa (×6.25);
//  lambda 0.0078125 λ/bit → λ×1000 (×7.8125).
// =============================================================================
const ECUMASTER_EMU_BLACK: EcuProfile = {
  bitrate: 500000,
  enabled: true,
  signals: [
    s(0x600, 0, 16, Ch.RPM,      1,      0),                  // rpm
    s(0x600, 2, 8,  Ch.THROTTLE, 0.5,    0),                  // TPS %
    s(0x600, 3, 8,  Ch.INTAKE,   1,      0, { signed: true }),// IAT °C (int8)
    s(0x600, 4, 16, Ch.MAP_ABS,  1,      0),                  // MAP kPa abs
    s(0x602, 0, 16, Ch.SPEED,    1,      0),                  // km/h
    s(0x602, 3, 8,  Ch.OILTEMP,  1,      0),                  // oil temp °C
    s(0x602, 4, 8,  Ch.OILPRESS, 6.25,   0),                  // oil press bar → kPa
    s(0x602, 5, 8,  Ch.FRP,      6.25,   0),                  // fuel press bar → kPa
    s(0x602, 6, 16, Ch.COOLANT,  1,      0, { signed: true }),// CLT °C (int16)
    s(0x603, 0, 8,  Ch.TIMING,   0.5,    0, { signed: true }),// ignition ° (int8)
    s(0x603, 2, 8,  Ch.AFR_M,    7.8125, 0),                  // lambda → λ×1000
    s(0x604, 0, 8,  Ch.GEAR,     1,      0),                  // gear
    s(0x604, 2, 16, Ch.VOLT,     27,     0),                  // battery 0.027V → mV
  ],
};

// =============================================================================
//  Haltech — "CAN Broadcast Protocol V2"
//  1 Mbit/s, 11-bit, BIG-ENDIAN (Motorola), unsigned. Pressures kPa, TEMPS in
//  KELVIN×10 (°C = raw×0.1 − 273.15), lambda raw×0.001 (→ λ×1000 = raw×1),
//  voltage raw×0.1 V (→ mV ×100), gauge pressures carry a −101.3 kPa offset.
//  Sources (community reference — the official V2.35 PDF is gated): FTY Racing
//  V2 writeup + Autosport Labs RaceCapture wiki + nextez/realdash_haltech XML.
//  RPM/MAP/TPS/CLT/IAT/battery/lambda/oil+fuel press = cross-confirmed (≥2 src);
//  TIMING/SPEED = single-source (verify before trusting).
// =============================================================================
const HALTECH_V2: EcuProfile = {
  bitrate: 1000000,
  enabled: true,
  signals: [
    s(0x360, 0, 16, Ch.RPM,      1,   0,       { be: true }),  // rpm
    s(0x360, 2, 16, Ch.MAP_ABS,  0.1, 0,       { be: true }),  // MAP kPa abs
    s(0x360, 4, 16, Ch.THROTTLE, 0.1, 0,       { be: true }),  // TPS %
    s(0x368, 0, 16, Ch.AFR_M,    1,   0,       { be: true }),  // lambda1 → λ×1000
    s(0x3e0, 0, 16, Ch.COOLANT,  0.1, -273.15, { be: true }),  // CLT K→°C
    s(0x3e0, 2, 16, Ch.INTAKE,   0.1, -273.15, { be: true }),  // IAT K→°C
    s(0x3e0, 6, 16, Ch.OILTEMP,  0.1, -273.15, { be: true }),  // oil temp K→°C
    s(0x361, 0, 16, Ch.FRP,      0.1, -101.3,  { be: true }),  // fuel press gauge kPa
    s(0x361, 2, 16, Ch.OILPRESS, 0.1, -101.3,  { be: true }),  // oil press gauge kPa
    s(0x372, 0, 16, Ch.VOLT,     100, 0,       { be: true }),  // battery 0.1V → mV
    s(0x362, 4, 16, Ch.TIMING,   0.1, 0,       { be: true }),  // ignition ° (1 src)
    s(0x370, 0, 16, Ch.SPEED,    0.1, 0,       { be: true }),  // km/h (1 src)
  ],
};

// =============================================================================
//  Link & Emtron — CONFIGURABLE, no fixed factory stream → no preset numbers.
//  Both let the tuner define their own CAN transmit frames (Link "CAN Setup"
//  generic dash / user streams; Emtron "CAN Transmit" templates), so IDs, bytes
//  and scales differ per tune. Shipping guessed numbers here would be exactly
//  the "gauge that lies" we refuse to build. The app shows this guidance and the
//  user hand-authors signals from their own CAN config in the custom mapper.
// =============================================================================

export const ECU_PRESETS: EcuPreset[] = [
  {
    id: 'maxxecu-default',
    vendor: 'MaxxECU',
    model: 'Default CAN output (v1.3)',
    confidence: 'verified',
    source: 'https://www.maxxecu.com/webhelp/can-default_maxxecu_protocol.html',
    notes:
      'Enable the CAN output in MTune (CAN → CAN outputs) — it is off by default. ' +
      'MAP is absolute (boost = MAP − baro). Lambda is λ, not AFR. Oil press/temp ' +
      'need protocol v1.3. Cross-check against MaxxECU’s official DBC before trusting ' +
      'boost/AFR alarms.',
    profile: MAXXECU,
  },
  {
    id: 'ecumaster-emu-black',
    vendor: 'ECUMaster',
    model: 'EMU Black — EMU stream (base 0x600)',
    confidence: 'community',
    source:
      'https://github.com/designer2k2/EMUcan (byte scaling) + ' +
      'https://www.ecumaster.com/files/ADU/AN/emuBlack.pdf (channel identities)',
    notes:
      'Enable "Send EMU stream over CAN-Bus". If your tune changed the stream base ' +
      'ID from 0x600, shift every id by the same delta. MAP is absolute; lambda is λ. ' +
      'Battery uses the unusual 0.027 V/bit constant — do not round it.',
    profile: ECUMASTER_EMU_BLACK,
  },
  {
    id: 'haltech-v2',
    vendor: 'Haltech',
    model: 'CAN Broadcast Protocol V2 (Elite/Nexus)',
    confidence: 'community',
    source:
      'https://ftyracing.com/tech/haltech-canbus-v2-protocol-info/ + ' +
      'https://wiki.autosportlabs.com/Haltech_PS1000_-_PS2000 + ' +
      'https://github.com/nextez/realdash_haltech',
    notes:
      'Big-endian, 1 Mbit/s. Temps arrive in Kelvin (converted here). MAP is ' +
      'absolute; boost = MAP − baro (baro on 0x372 byte 6). Ignition timing and ' +
      'vehicle speed are single-source — verify on the bus. The official V2.35 PDF ' +
      'is the authority if you can download it; diff this against your ECU firmware.',
    profile: HALTECH_V2,
  },
  {
    id: 'link-configurable',
    vendor: 'Link',
    model: 'G4+/G4X — user-defined CAN',
    confidence: 'configurable',
    source: 'https://www.linkecu.com (PCLink CAN Setup)',
    notes:
      'Link has no fixed factory broadcast — you define the transmit frames in ' +
      'PCLink (CAN Setup → user stream / generic dash). Open your CAN config and ' +
      'add each signal by hand in the mapper: copy its ID, start byte, size, byte ' +
      'order and multiplier exactly. Guessed numbers are not shipped, by design.',
    profile: null,
  },
  {
    id: 'emtron-configurable',
    vendor: 'Emtron',
    model: 'KV/SL — user-defined CAN',
    confidence: 'configurable',
    source: 'https://emtron.com.au (EMTUNE CAN Transmit)',
    notes:
      'Emtron CAN transmit is template/user-defined, so IDs and scaling depend on ' +
      'your tune. Open EMTUNE’s CAN Transmit setup and add each signal by hand in ' +
      'the mapper (ID, byte, size, endian, multiplier). No guessed numbers shipped.',
    profile: null,
  },
];

export function presetById(id: string): EcuPreset | undefined {
  return ECU_PRESETS.find((p) => p.id === id);
}
