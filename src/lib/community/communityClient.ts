// =====================================================================
//  AXIS Community client — thin wrapper over Supabase for Phase 0 +
//  leaderboard. Email OTP sign-in (captures a real, verified email),
//  a one-time profile (handle + car + marketing consent), submit a time,
//  read the public leaderboard.
// =====================================================================
import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';

export interface Profile {
  id: string;
  handle: string;
  car: string | null;
  marketing_consent: boolean;
}
export interface TimeRow {
  id: number;
  handle: string;
  car: string | null;
  kind: string;
  ms: number;
  created_at: string;
}

// Aligned 1:1 with the gauge's AccelTimes (speed[0..2] + dist[0..2]) so the app
// can pull the saved bests straight onto the leaderboard.
export const RUN_KINDS = ['0-100', '100-200', '200-300', '60ft', '201m', '402m'] as const;
export type RunKind = typeof RUN_KINDS[number];
export const KIND_LABEL: Record<RunKind, string> = {
  '0-100': '0-100 km/h', '100-200': '100-200 km/h', '200-300': '200-300 km/h',
  '60ft': '60 ft', '201m': '201 m · 1/8 mi', '402m': '402 m · 1/4 mi',
};
export const KIND_IS_DIST: Record<RunKind, boolean> = {
  '0-100': false, '100-200': false, '200-300': false, '60ft': true, '201m': true, '402m': true,
};

// ---- auth (email + password) ----
// One "Continue" for both new + returning users: try sign-in; if there's no
// account yet, sign up. With "Confirm email" turned OFF in Supabase, signUp
// returns a live session immediately — no email is ever sent (no rate limit).
// (Emails are captured but UNVERIFIED until custom SMTP + confirmation is added.)
export async function signUpOrIn(email: string, password: string): Promise<void> {
  const em = email.trim();
  const inRes = await supabase.auth.signInWithPassword({ email: em, password });
  if (!inRes.error) return;                               // returning user, correct password

  // Supabase returns the same "Invalid login credentials" for wrong-password AND
  // no-such-user (anti-enumeration), so try to register: success = new user;
  // "already registered" = the email exists ⇒ the password was wrong.
  const upRes = await supabase.auth.signUp({ email: em, password });
  if (upRes.error) {
    if (/registered|already/i.test(upRes.error.message)) throw new Error('Wrong password for this email');
    throw upRes.error;
  }
  if (!upRes.data.session) {
    // No session after signUp ⇒ "Confirm email" is still ON in Supabase.
    throw new Error('Turn OFF "Confirm email" in Supabase → Auth → Email to sign in without a confirmation email.');
  }
}
export async function currentSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}
export async function signOut(): Promise<void> { await supabase.auth.signOut(); }

// ---- password reset (email-based) ----
// Sends a reset LINK; clicking it reopens the app in recovery mode (a
// PASSWORD_RECOVERY auth event) → call updatePassword() with the new one.
// NOTE: this sends an email → needs working email (built-in is rate-limited;
// reliable once custom SMTP is configured).
export async function sendReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.href.split('#')[0],
  });
  if (error) throw error;
}
export async function updatePassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}
// Fire cb on auth changes — used to catch the PASSWORD_RECOVERY event after the
// reset link redirect. Returns an unsubscribe fn.
export function onAuth(cb: (event: string, session: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}

// ---- profile ----
export async function getMyProfile(): Promise<Profile | null> {
  const s = await currentSession();
  if (!s) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}
export async function saveProfile(handle: string, car: string, marketing: boolean): Promise<Profile> {
  const s = await currentSession();
  if (!s) throw new Error('Not signed in');
  const row = {
    id: s.user.id,
    handle: handle.trim(),
    car: car.trim() || null,
    marketing_consent: marketing,
    consent_at: marketing ? new Date().toISOString() : null,
  };
  const { data, error } = await supabase.from('profiles').upsert(row).select().single();
  if (error) throw error;
  return data as Profile;
}

// ---- times ----
export async function submitTime(handle: string, car: string, kind: RunKind, ms: number): Promise<void> {
  const s = await currentSession();
  if (!s) throw new Error('Not signed in');
  const { error } = await supabase.from('times')
    .insert({ user_id: s.user.id, handle, car: car || null, kind, ms });
  if (error) throw error;
}
export async function leaderboard(kind: RunKind, car?: string): Promise<TimeRow[]> {
  let q = supabase.from('times').select('*').eq('kind', kind).order('ms', { ascending: true }).limit(50);
  if (car) q = q.eq('car', car);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as TimeRow[];
}
