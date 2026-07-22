// =============================================================================
//  ecuProfile.ts — build a STANDALONE-ECU CAN profile and push it to the node.
//
//  A profile tells the node how to decode an aftermarket ECU's broadcast stream
//  (Haltech / Link / ECUMaster / Emtron / MAXXECU …). The firmware knows nothing
//  about any brand — it just applies this table — so adding an ECU is a data
//  change from the app, never a firmware release.
//
//  Semantics deliberately mirror a DBC signal (id / start / length / byte order /
//  factor / offset) so a published DBC can be converted 1:1.
//
//  ⚠️ A wrong map makes the gauge LIE (bad boost/AFR wrecks engines). Values must
//  come from the ECU vendor's CAN document or the user's own ECU configuration —
//  never guessed.
//
//  Wire layout — MUST match axis_can_node/EcuProfile.h exactly (packed, little-endian):
//    EcuProfileHdr : magic u8 (0xE0) · version u8 (1) · count u8 · flags u8 · bitrate u32   = 8 B
//    EcuSignal     : canId u16 · extIdHi u16 · startByte u8 · bits u8 · flags u8 ·
//                    channel u8 · scale f32 · offset f32                                    = 16 B
// =============================================================================
import { Ch } from './founderGaugeCfg';

export const ECU_MAGIC = 0xe0;
export const ECU_VERSION = 1;
export const ECU_MAX_SIGNALS = 24;          // must match MAX_SIGNALS in the firmware

/** EcuSignal.flags bits — must match the firmware's SIG_* */
export const SIG_BIG_ENDIAN = 1 << 0;       // Motorola order (first byte = MSB)
export const SIG_SIGNED     = 1 << 1;       // two's-complement
export const SIG_EXT_ID     = 1 << 2;       // 29-bit CAN id

export interface EcuSignal {
  canId: number;            // 11-bit id, or the full 29-bit id when extended
  extended?: boolean;
  startByte: number;        // 0..7
  bits: 8 | 16 | 24 | 32;
  bigEndian?: boolean;
  signed?: boolean;
  channel: number;          // Ch.*
  scale: number;
  offset: number;
}

export interface EcuProfile {
  bitrate: number;          // 500000 | 1000000 — the ECU's CAN speed
  enabled: boolean;
  signals: EcuSignal[];
}

/** Only the channels a profile can target — i.e. the ones the node can write. */
export const ECU_TARGET_CHANNELS: number[] = [
  Ch.RPM, Ch.SPEED, Ch.COOLANT, Ch.OILTEMP, Ch.INTAKE, Ch.LOAD, Ch.THROTTLE,
  Ch.BOOST, Ch.VOLT, Ch.SOC, Ch.FUELRATE, Ch.MAF, Ch.TIMING, Ch.STFT, Ch.LTFT,
  Ch.AMBIENT, Ch.FUELLVL, Ch.CATTEMP, Ch.CMDTHR, Ch.MAP_ABS, Ch.GEAR,
  Ch.AFR, Ch.AFR_M, Ch.PEDAL, Ch.FRP, Ch.MOTOR_TQ, Ch.OILPRESS,
];

/**
 * The unit the node stores each channel in — the scale/offset must produce THIS,
 * not the display unit. Shown in the editor so the author can't get it wrong.
 */
export const CHANNEL_NATIVE_UNIT: Record<number, string> = {
  [Ch.RPM]: 'rev/min', [Ch.SPEED]: 'km/h', [Ch.COOLANT]: '°C', [Ch.OILTEMP]: '°C',
  [Ch.INTAKE]: '°C', [Ch.LOAD]: '%', [Ch.THROTTLE]: '%',
  [Ch.BOOST]: 'kPa gauge (negative = vacuum)', [Ch.VOLT]: 'millivolts',
  [Ch.SOC]: '%', [Ch.FUELRATE]: 'L/h ×10', [Ch.MAF]: 'g/s ×10',
  [Ch.TIMING]: '° (signed)', [Ch.STFT]: '% (signed)', [Ch.LTFT]: '% (signed)',
  [Ch.AMBIENT]: '°C', [Ch.FUELLVL]: '%', [Ch.CATTEMP]: '°C', [Ch.CMDTHR]: '%',
  [Ch.MAP_ABS]: 'kPa absolute', [Ch.GEAR]: '1..8',
  [Ch.AFR]: 'λ ×1000 (1000 = λ1.000)', [Ch.AFR_M]: 'λ ×1000',
  [Ch.PEDAL]: '%', [Ch.FRP]: 'kPa', [Ch.MOTOR_TQ]: 'Nm (signed)',
  [Ch.OILPRESS]: 'kPa gauge',
};

export function validateSignal(s: EcuSignal): string | null {
  if (![8, 16, 24, 32].includes(s.bits)) return 'bits must be 8, 16, 24 or 32';
  if (s.startByte < 0 || s.startByte > 7) return 'start byte must be 0..7';
  if (s.startByte + s.bits / 8 > 8) return 'signal runs past the end of the 8-byte frame';
  const maxId = s.extended ? 0x1fffffff : 0x7ff;
  if (s.canId < 0 || s.canId > maxId) return `CAN id out of range (max 0x${maxId.toString(16)})`;
  if (!Number.isFinite(s.scale) || !Number.isFinite(s.offset)) return 'scale/offset must be numbers';
  if (!ECU_TARGET_CHANNELS.includes(s.channel)) return 'that channel cannot be written by a profile';
  return null;
}

export function validateProfile(p: EcuProfile): string | null {
  if (p.signals.length === 0) return 'add at least one signal';
  if (p.signals.length > ECU_MAX_SIGNALS) return `at most ${ECU_MAX_SIGNALS} signals`;
  if (p.bitrate !== 500000 && p.bitrate !== 1000000) return 'bitrate must be 500k or 1M';
  for (let i = 0; i < p.signals.length; i++) {
    const err = validateSignal(p.signals[i]);
    if (err) return `signal ${i + 1}: ${err}`;
  }
  return null;
}

/** Encode to the exact packed little-endian layout the firmware expects. */
export function encodeProfile(p: EcuProfile): Uint8Array {
  const bytes = new Uint8Array(8 + p.signals.length * 16);
  const dv = new DataView(bytes.buffer);
  dv.setUint8(0, ECU_MAGIC);
  dv.setUint8(1, ECU_VERSION);
  dv.setUint8(2, p.signals.length);
  dv.setUint8(3, p.enabled ? 1 : 0);
  dv.setUint32(4, p.bitrate, true);
  p.signals.forEach((s, i) => {
    const o = 8 + i * 16;
    const ext = !!s.extended;
    dv.setUint16(o + 0, ext ? (s.canId & 0xffff) : s.canId, true);
    dv.setUint16(o + 2, ext ? (s.canId >>> 16) & 0xffff : 0, true);
    dv.setUint8(o + 4, s.startByte);
    dv.setUint8(o + 5, s.bits);
    dv.setUint8(o + 6, (s.bigEndian ? SIG_BIG_ENDIAN : 0) |
                       (s.signed ? SIG_SIGNED : 0) |
                       (ext ? SIG_EXT_ID : 0));
    dv.setUint8(o + 7, s.channel);
    dv.setFloat32(o + 8, s.scale, true);
    dv.setFloat32(o + 12, s.offset, true);
  });
  return bytes;
}

/**
 * Split the encoded profile into `0xC4` chunks for the relay characteristic:
 *   [0]=0xC4 [1]=chunkIdx [2]=chunkCount [3..]=payload
 * The monitor forwards each write verbatim over ESP-NOW; the node reassembles,
 * validates and commits to NVS on its loop.
 */
export function chunkProfile(encoded: Uint8Array, payloadPerChunk = 180): Uint8Array[] {
  const total = Math.max(1, Math.ceil(encoded.length / payloadPerChunk));
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const slice = encoded.subarray(i * payloadPerChunk, (i + 1) * payloadPerChunk);
    const pkt = new Uint8Array(3 + slice.length);
    pkt[0] = 0xc4; pkt[1] = i; pkt[2] = total;
    pkt.set(slice, 3);
    out.push(pkt);
  }
  return out;
}

/** A cleared profile — one empty header with enabled=0 sends the node back to OBD-only. */
export function encodeClear(): Uint8Array {
  return encodeProfile({ bitrate: 500000, enabled: false, signals: [] });
}
