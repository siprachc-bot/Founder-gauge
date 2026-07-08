// =====================================================================
//  carProfiles.ts — named "car" profiles for the Founder Gauge app.
//
//  A profile is just a saved snapshot of the whole GaugeCfg (page layout +
//  colours + the per-car calc-gear/tyre drivetrain params + brightness) with
//  a friendly name. The AXIS Monitor only ever holds ONE active config, so
//  "multi-car" management lives here in the app (localStorage): switch car →
//  push that profile's cfg to the device over the existing config path.
//
//  No firmware change, no wire change — the device already accepts + persists
//  a full GaugeCfg write.
// =====================================================================
import type { GaugeCfg } from './founderGaugeCfg';

export interface CarProfile {
  id: string;
  name: string;
  cfg: GaugeCfg;
}

const LS_KEY = 'foundergauge.cars';

/** A stable-ish unique id (crypto.randomUUID where available, else time+counter). */
let idSeq = 0;
export function newProfileId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* not available */ }
  return `car_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;
}

/** Deep-clone a cfg so a stored profile can't alias the live editor object. */
export function cloneCfg(cfg: GaugeCfg): GaugeCfg {
  return JSON.parse(JSON.stringify(cfg));
}

export function loadProfiles(): CarProfile[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // Keep only well-formed entries (a corrupt/old blob shouldn't crash the app).
    return list.filter(
      (p): p is CarProfile =>
        p && typeof p.id === 'string' && typeof p.name === 'string' && p.cfg && Array.isArray(p.cfg.pages),
    );
  } catch {
    return [];
  }
}

export function saveProfiles(list: CarProfile[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — the profiles just won't persist */
  }
}

/** Add a new profile (snapshot of `cfg`) and return the updated list + new id. */
export function addProfile(list: CarProfile[], name: string, cfg: GaugeCfg): { list: CarProfile[]; id: string } {
  const id = newProfileId();
  const next = [...list, { id, name: name.trim() || 'My car', cfg: cloneCfg(cfg) }];
  saveProfiles(next);
  return { list: next, id };
}

export function renameProfile(list: CarProfile[], id: string, name: string): CarProfile[] {
  const next = list.map(p => (p.id === id ? { ...p, name: name.trim() || p.name } : p));
  saveProfiles(next);
  return next;
}

/** Overwrite a profile's stored cfg with the current one (name kept). */
export function updateProfileCfg(list: CarProfile[], id: string, cfg: GaugeCfg): CarProfile[] {
  const next = list.map(p => (p.id === id ? { ...p, cfg: cloneCfg(cfg) } : p));
  saveProfiles(next);
  return next;
}

export function deleteProfile(list: CarProfile[], id: string): CarProfile[] {
  const next = list.filter(p => p.id !== id);
  saveProfiles(next);
  return next;
}

/** Last-selected profile id (so the app remembers which car you're on). */
const LS_ACTIVE = 'foundergauge.cars.active';
export function loadActiveId(): string {
  try { return localStorage.getItem(LS_ACTIVE) ?? ''; } catch { return ''; }
}
export function saveActiveId(id: string): void {
  try { localStorage.setItem(LS_ACTIVE, id); } catch { /* ignore */ }
}
