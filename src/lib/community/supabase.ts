// =====================================================================
//  Supabase client for AXIS Community.
//
//  URL + publishable key are PUBLIC by design (they ship inside the client
//  bundle) — access is gated server-side by Row-Level Security, NOT by key
//  secrecy. Never put the service_role / secret key here.
// =====================================================================
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL  = 'https://zpwirdklgqwvxkqvredh.supabase.co';
export const SUPABASE_KEY  = 'sb_publishable_oLb47J5J6z6_ayF4MDkFAg_7xrGK-BI';  // publishable (client-safe)

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,       // keep the user signed in across app launches
    autoRefreshToken: true,
    detectSessionInUrl: true,   // needed to pick up the password-recovery token from the reset link
  },
});
