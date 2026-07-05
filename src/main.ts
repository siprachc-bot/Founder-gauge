import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('mount target #app not found');

mount(App, { target });

// -- Splash teardown ----------------------------------------------------
// The SN logo splash in index.html paints on the very first frame so the
// user sees branding instantly. Once Svelte has mounted we add the
// `.ready` class which fades the overlay's opacity to 0 (CSS handles the
// transition), then remove the node from the DOM so it can't ever
// intercept a touch.
//
// Floor on the visible time: even on a fast device the boot is so quick
// the logo would flash for a frame or two. 700 ms is short enough to
// feel snappy but long enough to register as "loading" rather than a
// glitch. The pop-in animation also lasts 700 ms so the user sees the
// full intro before we start dismissing it.
const SPLASH_MIN_MS = 700;
const SPLASH_FADE_MS = 400;
const splashStart = performance.now();
requestAnimationFrame(() => {
  // rAF defers until after Svelte's first paint — guarantees the real
  // UI is on-screen behind the overlay so the fade reveals it cleanly.
  const elapsed = performance.now() - splashStart;
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    const splash = document.getElementById('splash');
    if (!splash) return;
    splash.classList.add('ready');
    setTimeout(() => splash.remove(), SPLASH_FADE_MS);
  }, wait);
});
