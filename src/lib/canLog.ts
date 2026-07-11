// =====================================================================
//  canLog.ts — parse the monitor's /canlog.bin raw CAN capture and export
//  a SavvyCAN-compatible CSV for offline reverse-engineering.
//
//  File = CanLogHeader (16 B) then N × record (20 B), all little-endian.
//  Header : "AXCAN1"(6) · recBytes u16 @6 · startedAtMs u32 @8 · recCount u32 @12
//  Record : magic 0xCA @0 · flags u8 @1 (bit0 = extended/29-bit) · dlc u8 @2 ·
//           _pad @3 · id u32 @4 · data[8] @8 · tMs u32 @16
//  (matches axis_can_node RawCanPkt / axis_can_monitor CanLog — keep in sync.)
// =====================================================================

export interface CanFrame {
  tMs: number;        // node millis() at capture
  id: number;         // arbitration id
  extended: boolean;  // 29-bit
  dlc: number;        // 0..8
  data: number[];     // dlc bytes
}

const REC = 20;
const HDR = 16;

/** Parse /canlog.bin bytes → frames. Tolerant of a missing/short header. */
export function parseCanLog(buf: Uint8Array): CanFrame[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Skip the 16-B header if the "AXCAN1" magic is present.
  let off = 0;
  if (buf.byteLength >= HDR &&
      buf[0] === 0x41 && buf[1] === 0x58 && buf[2] === 0x43 && buf[3] === 0x41 && buf[4] === 0x4e && buf[5] === 0x31) {
    off = HDR;
  }
  const out: CanFrame[] = [];
  for (; off + REC <= buf.byteLength; off += REC) {
    if (buf[off] !== 0xca) continue;                 // per-record sync guard
    const flags = buf[off + 1];
    const dlc = Math.min(8, buf[off + 2]);
    const id = v.getUint32(off + 4, true);
    const data: number[] = [];
    for (let i = 0; i < dlc; i++) data.push(buf[off + 8 + i]);
    const tMs = v.getUint32(off + 16, true);
    out.push({ tMs, id, extended: (flags & 1) === 1, dlc, data });
  }
  return out;
}

/** SavvyCAN "Generic CSV": Time Stamp(µs),ID(hex),Extended,Dir,Bus,LEN,D1..D8(hex). */
export function toSavvyCanCsv(frames: CanFrame[]): string {
  const rows = ['Time Stamp,ID,Extended,Dir,Bus,LEN,D1,D2,D3,D4,D5,D6,D7,D8'];
  for (const f of frames) {
    const d = Array.from({ length: 8 }, (_, i) =>
      i < f.dlc ? f.data[i].toString(16).toUpperCase().padStart(2, '0') : '');
    rows.push([
      f.tMs * 1000,                                  // µs
      f.id.toString(16).toUpperCase(),               // hex id
      f.extended ? 'true' : 'false',
      'Rx',
      0,
      f.dlc,
      ...d,
    ].join(','));
  }
  return rows.join('\n');
}

/** Quick stats for the card: unique IDs + span. */
export function canLogStats(frames: CanFrame[]): { frames: number; ids: number; spanS: number } {
  if (!frames.length) return { frames: 0, ids: 0, spanS: 0 };
  const ids = new Set(frames.map((f) => f.id));
  const spanS = (frames[frames.length - 1].tMs - frames[0].tMs) / 1000;
  return { frames: frames.length, ids: ids.size, spanS: Math.max(0, Math.round(spanS)) };
}
