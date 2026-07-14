<script lang="ts">
  import {
    signUpOrIn, currentSession, signOut, sendReset, updatePassword, onAuth,
    getMyProfile, saveProfile, submitTime, leaderboard,
    RUN_KINDS, KIND_LABEL, KIND_IS_DIST, type RunKind, type Profile, type TimeRow,
  } from '../lib/community/communityClient';
  import { store } from '../lib/store.svelte';
  import { onDestroy } from 'svelte';

  // A best time pulled from the connected gauge (AccelTimes), ready to post.
  interface MyRecord { kind: RunKind; ms: number; trapKmh?: number; }

  type View = 'loading' | 'auth' | 'recovery' | 'profile' | 'ready';
  let view = $state<View>('loading');
  let busy = $state(false);
  let err  = $state<string | null>(null);
  let info = $state<string | null>(null);

  // auth inputs
  let email = $state('');
  let pass  = $state('');
  let newPass = $state('');

  // profile
  let profile = $state<Profile | null>(null);
  let handle = $state('');
  let car    = $state('');
  let consent = $state(false);

  // leaderboard
  let kind = $state<RunKind>('0-100');
  let board = $state<TimeRow[]>([]);
  let msg   = $state<string | null>(null);

  // my best times, auto-pulled from the connected gauge
  let myRecords = $state<MyRecord[]>([]);
  let timesLoading = $state(false);
  let posting = $state<string | null>(null);   // kind currently being posted
  const monConnected = () => !!store.monClient;

  const fmt = (ms: number) => (ms / 1000).toFixed(2) + 's';

  // Pull the gauge's saved bests (AccelTimes) → only the records that exist.
  async function loadMyTimes() {
    if (!store.monClient) { myRecords = []; return; }
    timesLoading = true;
    try {
      const t = await store.monClient.readAccelTimes();
      const sK: RunKind[] = ['0-100', '100-200', '200-300'];
      const dK: RunKind[] = ['60ft', '201m', '402m'];
      const recs: MyRecord[] = [];
      t.speed.forEach((e, i) => { if (e.ms != null) recs.push({ kind: sK[i], ms: e.ms }); });
      t.dist.forEach((e, i) => { if (e.ms != null) recs.push({ kind: dK[i], ms: e.ms, trapKmh: e.trapKmh }); });
      myRecords = recs;
    } catch (e) { /* gauge may be busy; leave empty */ myRecords = []; }
    finally { timesLoading = false; }
  }

  async function postRecord(r: MyRecord) {
    err = null; msg = null; posting = r.kind;
    try {
      await submitTime(profile!.handle, car, r.kind, r.ms);
      msg = `Posted ${KIND_LABEL[r.kind]} ${fmt(r.ms)}!`;
      kind = r.kind; await refresh();     // jump the board to what we just posted
    } catch (e) { err = String((e as Error).message ?? e); }
    finally { posting = null; }
  }

  async function boot() {
    try {
      const s = await currentSession();
      if (!s) { view = 'auth'; return; }
      profile = await getMyProfile();
      if (!profile) { view = 'profile'; return; }
      handle = profile.handle; car = profile.car ?? '';
      await refresh();
      view = 'ready';
      loadMyTimes();     // pull the gauge's saved bests (best-effort, non-blocking)
    } catch (e) { err = String((e as Error).message ?? e); view = 'auth'; }
  }
  boot();
  // Catch the reset-link redirect: Supabase fires PASSWORD_RECOVERY → show the
  // "set a new password" view instead of the normal signed-in flow.
  const stop = onAuth((event) => { if (event === 'PASSWORD_RECOVERY') { view = 'recovery'; } });
  onDestroy(stop);

  async function doAuth() {
    err = null; info = null; busy = true;
    try {
      if (pass.length < 6) throw new Error('Password must be at least 6 characters');
      await signUpOrIn(email, pass);
      pass = '';
      await boot();
    } catch (e) { err = String((e as Error).message ?? e); }
    finally { busy = false; }
  }

  async function doReset() {
    err = null; info = null;
    if (!email.includes('@')) { err = 'Enter your email first'; return; }
    busy = true;
    try {
      await sendReset(email);
      info = `Password-reset link sent to ${email}. Open it on this device to set a new password.`;
    } catch (e) { err = String((e as Error).message ?? e); }
    finally { busy = false; }
  }

  async function doSetNewPassword() {
    err = null; info = null; busy = true;
    try {
      if (newPass.length < 6) throw new Error('Password must be at least 6 characters');
      await updatePassword(newPass);
      newPass = ''; info = 'Password updated.';
      await boot();
    } catch (e) { err = String((e as Error).message ?? e); }
    finally { busy = false; }
  }
  async function doSaveProfile() {
    err = null; busy = true;
    try {
      if (handle.trim().length < 2) throw new Error('Pick a handle (2+ chars)');
      profile = await saveProfile(handle, car, consent);
      await refresh(); view = 'ready';
      loadMyTimes();
    } catch (e) { err = String((e as Error).message ?? e); }
    finally { busy = false; }
  }
  async function refresh() { board = await leaderboard(kind, car || undefined); }
  async function onKind(k: RunKind) { kind = k; await refresh(); }
  async function doSignOut() { await signOut(); profile = null; email = ''; pass = ''; myRecords = []; view = 'auth'; }
</script>

<div class="wrap">
  <h2>AXIS Community <span class="beta">beta</span></h2>

  {#if err}<p class="err">{err}</p>{/if}
  {#if info}<p class="ok">{info}</p>{/if}

  {#if view === 'loading'}
    <p class="dim">Loading…</p>

  {:else if view === 'auth'}
    <p class="dim">Sign in (or create an account) to post times and join the leaderboard.</p>
    <input type="email" placeholder="you@email.com" bind:value={email} autocomplete="email" />
    <input type="password" placeholder="password (6+ chars)" bind:value={pass} autocomplete="current-password" />
    <button class="primary" onclick={doAuth} disabled={busy || !email.includes('@') || pass.length < 6}>Continue</button>
    <div class="row-between">
      <span class="dim" style="font-size:11px;">New here? Just pick a password — account is created automatically.</span>
      <button class="link" onclick={doReset} disabled={busy}>Forgot password?</button>
    </div>

  {:else if view === 'recovery'}
    <p class="dim">Set a new password for your account.</p>
    <input type="password" placeholder="new password (6+ chars)" bind:value={newPass} autocomplete="new-password" />
    <button class="primary" onclick={doSetNewPassword} disabled={busy || newPass.length < 6}>Save new password</button>

  {:else if view === 'profile'}
    <p class="dim">One-time setup.</p>
    <label>Handle<input type="text" placeholder="e.g. snmotorsports" bind:value={handle} /></label>
    <label>Your car<input type="text" placeholder="e.g. Volvo V60 T8" bind:value={car} /></label>
    <label class="check"><input type="checkbox" bind:checked={consent} /> Send me AXIS news & promotions</label>
    <button class="primary" onclick={doSaveProfile} disabled={busy}>Save & continue</button>

  {:else if view === 'ready'}
    <div class="row-between">
      <span class="dim">Hi <b>{profile?.handle}</b>{#if car} · {car}{/if}</span>
      <button class="link" onclick={doSignOut}>sign out</button>
    </div>

    <!-- MY BEST TIMES — auto-pulled from the gauge; only the records you have -->
    <div class="row-between">
      <span class="section">Your best times</span>
      {#if monConnected()}<button class="link" onclick={loadMyTimes} disabled={timesLoading}>{timesLoading ? '…' : 'refresh'}</button>{/if}
    </div>

    {#if !monConnected()}
      <p class="dim">Connect your gauge in the <b>Gauge</b> tab to pull your saved times automatically.</p>
    {:else if timesLoading && myRecords.length === 0}
      <p class="dim">Reading times from your gauge…</p>
    {:else if myRecords.length === 0}
      <p class="dim">No saved runs yet — do an acceleration run on your gauge, then come back.</p>
    {:else}
      <div class="cards">
        {#each myRecords as r}
          <!-- accel result-style card: label · big time · post -->
          <div class="tcard">
            <span class="tlabel">{KIND_LABEL[r.kind]}</span>
            <span class="ttime">{(r.ms / 1000).toFixed(2)}<small>s</small></span>
            {#if r.trapKmh}<span class="ttrap">TRAP {r.trapKmh} km/h</span>{/if}
            <button class="primary sm" onclick={() => postRecord(r)} disabled={posting === r.kind}>
              {posting === r.kind ? 'Posting…' : 'Post to leaderboard'}
            </button>
          </div>
        {/each}
      </div>
    {/if}
    {#if msg}<p class="ok">{msg}</p>{/if}

    <!-- LEADERBOARD -->
    <span class="section" style="margin-top:6px;">Leaderboard</span>
    <div class="kinds">
      {#each RUN_KINDS as k}
        <button class="chip" class:on={kind === k} onclick={() => onKind(k)}>{k}</button>
      {/each}
    </div>
    <div class="board">
      {#if board.length === 0}
        <p class="dim">No {KIND_LABEL[kind]} times yet{#if car} for {car}{/if} — be the first!</p>
      {:else}
        {#each board as t, i}
          <div class="brow" class:me={t.handle === profile?.handle}>
            <span class="rank">{i + 1}</span>
            <span class="who">{t.handle}{#if t.car && !car} · <span class="dim">{t.car}</span>{/if}</span>
            <span class="time">{fmt(t.ms)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 12px; }
  h2 { margin: 0; font-size: 20px; display: flex; align-items: center; gap: 8px; }
  .beta { font-size: 10px; font-weight: 700; color: #000; background: var(--accent);
          padding: 2px 7px; border-radius: 999px; }
  .dim { color: var(--muted); font-size: 13px; margin: 0; }
  .err { color: #e24b4a; font-size: 13px; margin: 0; }
  .ok  { color: var(--success, #3ecf8e); font-size: 13px; margin: 0; }
  input[type=email], input[type=text], input[type=password] { width: 100%; padding: 11px 13px; border-radius: var(--r-1, 10px);
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 15px; box-sizing: border-box; }
  label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
  label.check { flex-direction: row; align-items: center; gap: 8px; }
  button.primary { padding: 12px; border: 0; border-radius: var(--r-1, 10px); background: var(--accent);
    color: #000; font-weight: 700; font-size: 15px; cursor: pointer; }
  button.primary:disabled { opacity: .5; }
  button.primary.sm { padding: 9px 14px; font-size: 13px; width: 100%; margin-top: 4px; }
  button.link { background: none; border: 0; color: var(--muted); font-size: 13px; cursor: pointer; align-self: flex-start; padding: 4px 0; }
  button.link:disabled { opacity: .5; }
  .row-between { display: flex; justify-content: space-between; align-items: center; }
  .section { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }

  /* accel result-style cards (mirror the gauge's time card) */
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .tcard { display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 16px 14px; border-radius: 16px; background: var(--surface-2);
    border: 1px solid var(--border); }
  .tlabel { font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--accent); }
  .ttime { font-family: var(--font-mono, monospace); font-size: 44px; font-weight: 800; line-height: 1; color: var(--fg); }
  .ttime small { font-size: 18px; font-weight: 600; color: var(--muted); margin-left: 2px; }
  .ttrap { font-size: 12px; color: var(--accent); font-weight: 600; }
  .kinds { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { padding: 6px 13px; border-radius: 999px; font-size: 13px; font-weight: 600; background: var(--surface-2);
    color: var(--muted); border: 1px solid var(--border); cursor: pointer; }
  .chip.on { background: var(--accent); color: #000; border-color: var(--accent); }
  .board { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
  .brow { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; background: var(--surface-2); }
  .brow.me { outline: 1px solid var(--accent); }
  .rank { width: 22px; text-align: center; color: var(--muted); font-size: 13px; }
  .who { flex: 1; font-size: 14px; }
  .time { font-family: var(--font-mono, monospace); font-weight: 700; }
</style>
