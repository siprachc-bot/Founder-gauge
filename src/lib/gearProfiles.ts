// =====================================================================
//  gearProfiles.ts — Push-A car gear-decode dictionary + 38-byte encoder.
//
//  "Push-A" lets AXIS support ANY car's REAL gear by DATA instead of a
//  firmware reflash: the user picks their car here → the app encodes that
//  car's gear-decode spec into a 38-byte GearProfile → writes it to the
//  monitor (BLE char 7e1c0208) → the monitor forwards it VERBATIM to the
//  node over ESP-NOW (byte[0]==0xC0) → the node applies it + persists to NVS.
//
//  KEEP THE 38-BYTE LAYOUT IN LOCKSTEP WITH:
//    axis_can_node/GearProfile.h            (struct GearProfile, gearExtract)
//    axis_can_monitor/src/BleGaugeCfg.cpp   (GEAR_PROFILE_BYTES == 38, relay)
//
//  Wire contract (little-endian, packed, 38 bytes):
//    [0]  magic 0xC0        [1]  ver = 1          [2]  canFd (1=CAN-FD bus)
//    [3]  selN (1..8)       [4-7]  sel.canId u32  [8]  sel.ext (1=29-bit)
//    [9]  sel.startBit      [10] sel.len          [11] sel.motorola (0=Intel/LE)
//    [12-19] selRaw[8]      [20-27] selLabel[8] (ASCII 'P','R','N','D','B','S','L')
//    [28-31] eng.canId u32  [32] eng.ext          [33] eng.startBit
//    [34] eng.len           [35] eng.motorola     [36] engLo  [37] engHi
//
//  selector: extract sel field → look up in selRaw[i] → selLabel[i] (P/R/N/D/…).
//  engaged : a nibble whose raw value in [engLo..engHi] IS the numeric gear 1..8
//            (node prefers it in D; canId 0 = none → node uses rpm/speed calc).
// =====================================================================

/** One CAN signal field, DBC-style. Mirrors GearSig in GearProfile.h. */
export interface GearSig {
  canId: number;      // CAN identifier (0 = signal unused)
  ext: boolean;       // true = 29-bit extended id
  startBit: number;   // DBC start bit (byteIndex*8 + bit for Intel/LE)
  len: number;        // bit length 1..32
  motorola: boolean;  // false = Intel/little-endian, true = Motorola/big-endian
}

/** A whole car's gear-decode spec. Encodes to the 38-byte node GearProfile. */
export interface CarGearProfile {
  id: string;              // stable key (used by the dropdown)
  name: string;            // human label, e.g. "Volvo V60 T8 (2019–2025)"
  platform: string;        // short platform tag shown as a sub-label
  verified: boolean;       // true = confirmed in-car; false = researched, needs RE
  pushable: boolean;       // false = listed for roadmap only, cannot be sent yet
  canFd: boolean;          // true = gear bus is CAN-FD (node's classic TWAI can't read)
  note?: string;           // one-line caveat shown in the UI
  sel: GearSig;            // selector signal
  selMap: { raw: number; label: string }[];   // raw value → P/R/N/D/B/S/L
  eng?: GearSig;           // engaged-gear signal (omit = none → calc fallback)
  engLo?: number;          // engaged raw in [engLo..engHi] → numeric gear = raw
  engHi?: number;
}

export const GEAR_PROFILE_BYTES = 38;   // MUST match the firmware on both sides
const MAGIC = 0xc0;
const VER = 1;

// ---------------------------------------------------------------------
//  Car dictionary. Add a car by appending one entry. Only set pushable:true
//  once the selector CAN id + start bit + raw→label map is CONFIRMED in-car
//  (the ~10-min controlled plateau-shift test) — a wrong spec just shows a
//  wrong/blank gear (node is read-only/passive → zero risk), but we don't
//  ship guesses as if they were verified.
// ---------------------------------------------------------------------
export const GEAR_PROFILES: CarGearProfile[] = [
  {
    // ★ In-car RE-verified 2026-07-09 (controlled P→R→N→D→B shift test on the
    //   owner's car). This is also the node's compiled-in default.
    id: 'volvo_v60_t8_spa',
    name: 'Volvo V60 T8',
    platform: 'SPA PHEV · 2019–2025',
    verified: true,
    pushable: true,
    canFd: false,
    note: 'Verified in-car — P/R/N/D/B selector on 0x1FFF00A0 byte 6.',
    // 0x1FFF00A0 byte[6] = 0x38+idx. byte 6 → startBit 48 (6*8), len 8, Intel/LE.
    sel: { canId: 0x1fff00a0, ext: true, startBit: 48, len: 8, motorola: false },
    selMap: [
      { raw: 0x38, label: 'P' },
      { raw: 0x39, label: 'R' },
      { raw: 0x3a, label: 'N' },
      { raw: 0x3b, label: 'D' },
      { raw: 0x3c, label: 'B' },   // B = PHEV regen mode
    ],
    // No engaged-gear broadcast on this car → the monitor derives 1..8 in D from
    // rpm/speed (calc-gear). engLo/Hi still sent as the generic 1..8 bound.
    engLo: 1,
    engHi: 8,
  },

  // ---- Roadmap (researched, OBD-reachable, but NOT yet in-car confirmed) ----
  // Listed so the owner of one of these can see it's on the path; NOT pushable
  // until the selector byte/bit is confirmed with the controlled shift test.
  // Sources: opendbc + community DBC repos (see reference_axis_zf_gear memory).
  {
    id: 'fca_pre2018',
    name: 'Chrysler / Dodge / Jeep / Ram (pre-2018)',
    platform: 'FCA pre-SGW · CAN-C on OBD',
    verified: false,
    pushable: false,
    canFd: false,
    note: 'PRND on 0x2EA (1=P…5=L). Needs in-car RE to confirm the byte/bit.',
    sel: { canId: 0x2ea, ext: false, startBit: 0, len: 8, motorola: false },
    selMap: [
      { raw: 1, label: 'P' },
      { raw: 2, label: 'R' },
      { raw: 3, label: 'N' },
      { raw: 4, label: 'D' },
      { raw: 5, label: 'L' },
    ],
    engLo: 1,
    engHi: 8,
  },
  {
    id: 'jlr_eucd_08_15',
    name: 'Jaguar XF / XJ (2008–2015)',
    platform: 'JLR EUCD · HS-CAN on OBD',
    verified: false,
    pushable: false,
    canFd: false,
    note: '0x3F3 byte 6 is a P/R/N/D/S bitmask — needs in-car RE to map the bits.',
    sel: { canId: 0x3f3, ext: false, startBit: 48, len: 8, motorola: false },
    selMap: [
      { raw: 0, label: 'P' },
      { raw: 0, label: 'R' },
      { raw: 0, label: 'N' },
      { raw: 0, label: 'D' },
    ],
  },
  {
    // Present so the user knows their car needs different hardware, not that it's
    // "unsupported by AXIS". Never pushable over the classic-TWAI node.
    id: 'canfd_generic',
    name: 'BMW G-series · Audi MLBevo · Ram DT 2023+',
    platform: 'CAN-FD powertrain (needs FD hardware)',
    verified: false,
    pushable: false,
    canFd: true,
    note: 'Gear is on a CAN-FD bus behind the gateway — needs an MCP2518FD tap, not the OBD node.',
    sel: { canId: 0, ext: false, startBit: 0, len: 8, motorola: false },
    selMap: [],
  },
];

/** Look up a profile by id (undefined if unknown). */
export function gearProfileById(id: string): CarGearProfile | undefined {
  return GEAR_PROFILES.find((p) => p.id === id);
}

/** The car pushed by default / the node's compiled-in fallback. */
export const DEFAULT_GEAR_PROFILE_ID = 'volvo_v60_t8_spa';

/**
 * Encode a car profile into the exact 38-byte GearProfile the node expects.
 * Little-endian, packed — byte layout documented at the top of this file.
 * Throws if the profile can't be pushed (CAN-FD or an incomplete selector map).
 */
export function encodeGearProfile(p: CarGearProfile): Uint8Array {
  if (p.canFd) throw new Error(`${p.name}: gear is on a CAN-FD bus — the OBD node can't read it.`);
  if (!p.selMap.length) throw new Error(`${p.name}: no selector map defined.`);
  if (p.selMap.length > 8) throw new Error(`${p.name}: selector map exceeds 8 entries.`);

  const b = new Uint8Array(GEAR_PROFILE_BYTES);
  const dv = new DataView(b.buffer);

  b[0] = MAGIC;
  b[1] = VER;
  b[2] = p.canFd ? 1 : 0;
  b[3] = p.selMap.length;

  // selector signal
  dv.setUint32(4, p.sel.canId >>> 0, true);
  b[8] = p.sel.ext ? 1 : 0;
  b[9] = p.sel.startBit & 0xff;
  b[10] = p.sel.len & 0xff;
  b[11] = p.sel.motorola ? 1 : 0;

  // selRaw[8] + selLabel[8] (unused slots stay 0)
  for (let i = 0; i < p.selMap.length; i++) {
    b[12 + i] = p.selMap[i].raw & 0xff;
    b[20 + i] = p.selMap[i].label.charCodeAt(0) & 0xff;
  }

  // engaged-gear signal (canId 0 = none → node uses calc)
  const eng = p.eng ?? { canId: 0, ext: false, startBit: 0, len: 0, motorola: false };
  dv.setUint32(28, eng.canId >>> 0, true);
  b[32] = eng.ext ? 1 : 0;
  b[33] = eng.startBit & 0xff;
  b[34] = eng.len & 0xff;
  b[35] = eng.motorola ? 1 : 0;
  b[36] = (p.engLo ?? 1) & 0xff;
  b[37] = (p.engHi ?? 8) & 0xff;

  return b;
}
