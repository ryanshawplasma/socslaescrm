/*!
 * Dive launch splash — self-contained, dependency-free, vanilla JS.
 *
 * Usage (place right before </body>, after the config script):
 *   <script>window.DIVE_SPLASH = { video:'dive-launch.mp4', tail:5, autoMs:4400, once:false };</script>
 *   <script src="dive-splash.js"></script>
 *
 * Config (window.DIVE_SPLASH, or data- attrs on this <script> tag):
 *   video   — path to the mp4 (default 'dive-launch.mp4')
 *   tail    — seconds of the END of the clip to loop (default 5)
 *   autoMs  — ms to wait AFTER the intro before auto-dismissing; 0 = wait for tap/Enter only (default 4400)
 *   once    — true = only show once per browser session (sessionStorage) (default false)
 *
 * Exit hatches: tap/click anywhere on the splash, or press Enter, dismiss immediately.
 */
(function () {
  'use strict';

  // Guard against double-inclusion (e.g. the script tag ending up in the page twice).
  if (document.getElementById('dive-splash-overlay')) return;

  var SESSION_KEY = 'dive_splash_shown_v1';

  // ── Config resolution: window.DIVE_SPLASH wins, then data- attrs on this
  //    <script> tag, then hard defaults. ──────────────────────────────────
  function readConfig() {
    var fromAttrs = {};
    var scriptEl = document.currentScript;
    if (!scriptEl) {
      // Fallback for environments where document.currentScript isn't set
      // (shouldn't happen for a plain synchronous <script src>, but be safe).
      var all = document.getElementsByTagName('script');
      scriptEl = all[all.length - 1];
    }
    if (scriptEl && scriptEl.dataset) {
      if (scriptEl.dataset.video)  fromAttrs.video  = scriptEl.dataset.video;
      if (scriptEl.dataset.tail)   fromAttrs.tail    = parseFloat(scriptEl.dataset.tail);
      if (scriptEl.dataset.autoMs) fromAttrs.autoMs  = parseInt(scriptEl.dataset.autoMs, 10);
      if (scriptEl.dataset.once)   fromAttrs.once    = scriptEl.dataset.once === 'true';
    }
    var win = (window.DIVE_SPLASH && typeof window.DIVE_SPLASH === 'object') ? window.DIVE_SPLASH : {};
    function pick(key, fallback) {
      if (win[key] !== undefined && win[key] !== null) return win[key];
      if (fromAttrs[key] !== undefined && !isNaN(fromAttrs[key])) return fromAttrs[key];
      if (fromAttrs[key] !== undefined) return fromAttrs[key];
      return fallback;
    }
    return {
      video:  pick('video', 'dive-launch.mp4'),
      tail:   Number(pick('tail', 5)) || 5,
      autoMs: pick('autoMs', 4400),
      once:   !!pick('once', false),
    };
  }

  var cfg = readConfig();

  // ── "once per session" — bail out before touching the DOM at all. ──────
  if (cfg.once) {
    try {
      if (sessionStorage.getItem(SESSION_KEY) === '1') return;
    } catch (e) { /* storage may be unavailable (private mode) — just show it */ }
  }

  function init() {
    if (document.getElementById('dive-splash-overlay')) return;

    // ── Mark as shown for this session right away — "once" means the splash
    //    only ever starts once per session, not "once per successful dismiss". ──
    if (cfg.once) {
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {}
    }

    var reduceMotion = false;
    try {
      reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {}

    // ── Styles (scoped under #dive-splash-overlay, injected + removed as a unit) ──
    var style = document.createElement('style');
    style.id = 'dive-splash-styles';
    style.textContent = [
      '#dive-splash-overlay{',
      '  position:fixed; inset:0; z-index:999999999;',
      '  display:flex; align-items:flex-end; justify-content:center;',
      '  overflow:hidden; cursor:pointer; touch-action:manipulation;',
      '  -webkit-tap-highlight-color:transparent;',
      // Dark jungle-green gradient — the loading state AND the video-failure fallback,
      // since the video simply sits on top of it (absolutely positioned) once it plays.
      '  background:radial-gradient(140% 100% at 50% 0%, #123528 0%, #0a2018 45%, #04100c 100%);',
      '  transition:opacity .85s ease, transform .85s ease, filter .85s ease;',
      '  opacity:1; transform:scale(1); filter:blur(0);',
      '}',
      '#dive-splash-overlay.dive-out{ opacity:0; transform:scale(1.045); filter:blur(14px); pointer-events:none; }',
      '#dive-splash-video{',
      '  position:absolute; inset:0; width:100%; height:100%;',
      '  object-fit:cover; object-position:center center;',
      '  z-index:0; background:transparent;',
      '}',
      '#dive-splash-scrim{',
      '  position:absolute; inset:0; z-index:1; pointer-events:none;',
      '  background:linear-gradient(to top, rgba(3,10,7,.92) 0%, rgba(3,10,7,.64) 26%, rgba(3,10,7,.20) 52%, rgba(3,10,7,0) 74%);',
      '}',
      '#dive-splash-brand{',
      '  position:relative; z-index:2;',
      '  display:flex; flex-direction:column; align-items:center; text-align:center;',
      '  gap:clamp(4px, 1.2vmin, 10px);',
      '  padding:0 20px calc(clamp(34px, 9vmin, 84px) + env(safe-area-inset-bottom, 0px));',
      // IMPORTANT: opacity stays 1 at all times — the intro only animates `transform`,
      // driven by a setTimeout-toggled class (never rAF / animation-fill-mode), so the
      // brand can never get stuck invisible if the animation clock is throttled.
      '  opacity:1; transform:translateY(4.2vmin) scale(.92);',
      '  transition:transform .95s cubic-bezier(.19,1,.22,1);',
      '}',
      '#dive-splash-brand.dive-in{ transform:translateY(0) scale(1); }',
      '#dive-splash-logo{',
      '  width:clamp(46px, 12vmin, 84px); height:clamp(46px, 12vmin, 84px);',
      '  border-radius:54% 54% 54% 8%; transform:rotate(45deg);',
      '  background:linear-gradient(135deg, var(--primary, #F5B63C), var(--primary-lt, #FFE3A6));',
      '  box-shadow:0 0 clamp(18px,4vmin,40px) 0 color-mix(in srgb, var(--primary, #F5B63C) 55%, transparent),',
      '             0 6px 18px rgba(0,0,0,.35);',
      '  position:relative;',
      '}',
      '#dive-splash-logo::after{',
      '  content:""; position:absolute; top:14%; left:18%; width:32%; height:20%;',
      '  background:rgba(255,255,255,.55); border-radius:50%; filter:blur(1px);',
      '}',
      '#dive-splash-word{',
      '  font-family:Fraunces, Georgia, "Times New Roman", serif;',
      '  font-size:clamp(28px, 8vmin, 56px); font-weight:600; line-height:1;',
      '  color:#fff; margin:clamp(4px,1.4vmin,10px) 0 0; letter-spacing:.01em;',
      '  text-shadow:0 2px 24px rgba(0,0,0,.45);',
      '}',
      '#dive-splash-tag{',
      '  font-family:system-ui, -apple-system, "Segoe UI", sans-serif;',
      '  font-size:clamp(9px, 2.6vmin, 13px); letter-spacing:.32em; text-transform:uppercase;',
      '  color:rgba(255,255,255,.72); margin:0;',
      '}',
      '#dive-splash-enter{',
      '  margin-top:clamp(16px, 4.4vmin, 28px);',
      '  padding:clamp(10px,2.6vmin,14px) clamp(22px,5.4vmin,32px);',
      '  border:none; border-radius:999px; cursor:pointer;',
      '  font:600 clamp(12px,3vmin,15px)/1 system-ui, -apple-system, "Segoe UI", sans-serif;',
      '  letter-spacing:.02em; color:#1a1206;',
      '  background:linear-gradient(135deg, var(--primary, #F5B63C), var(--primary-lt, #FFE3A6));',
      '  box-shadow:0 8px 24px -6px color-mix(in srgb, var(--primary, #F5B63C) 60%, transparent),',
      '             0 2px 8px rgba(0,0,0,.25);',
      '  opacity:0; transform:translateY(10px); pointer-events:none;',
      '  transition:opacity .5s ease, transform .5s ease, box-shadow .2s ease;',
      '}',
      '#dive-splash-enter.dive-cta-show{ opacity:1; transform:translateY(0); pointer-events:auto; }',
      '#dive-splash-enter:active{ transform:translateY(0) scale(.96); }',
      // Respect prefers-reduced-motion: kill all animated transitions on our elements so
      // every class toggle above resolves to its end state instantly. The setTimeout
      // schedule (and therefore the tap/Enter/auto-dismiss timing) is unchanged.
      '@media (prefers-reduced-motion: reduce){',
      '  #dive-splash-overlay, #dive-splash-brand, #dive-splash-enter{ transition:none !important; }',
      '}',
    ].join('\n');

    // ── Markup ───────────────────────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id = 'dive-splash-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Dive');

    var video = document.createElement('video');
    video.id = 'dive-splash-video';
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('muted', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');
    video.setAttribute('preload', 'metadata');
    video.setAttribute('disablePictureInPicture', '');
    video.setAttribute('disableRemotePlayback', '');
    video.setAttribute('tabindex', '-1');
    video.setAttribute('aria-hidden', 'true');

    var scrim = document.createElement('div');
    scrim.id = 'dive-splash-scrim';

    var brand = document.createElement('div');
    brand.id = 'dive-splash-brand';

    var logo = document.createElement('div');
    logo.id = 'dive-splash-logo';
    logo.setAttribute('aria-hidden', 'true');

    var word = document.createElement('div');
    word.id = 'dive-splash-word';
    word.textContent = 'Dive';

    var tag = document.createElement('div');
    tag.id = 'dive-splash-tag';
    tag.textContent = 'Smart Sales OS';

    var cta = document.createElement('button');
    cta.id = 'dive-splash-enter';
    cta.type = 'button';
    cta.textContent = 'Tap to enter →';

    brand.appendChild(logo);
    brand.appendChild(word);
    brand.appendChild(tag);
    brand.appendChild(cta);

    overlay.appendChild(video);
    overlay.appendChild(scrim);
    overlay.appendChild(brand);

    // ── Video: play only the last `tail` seconds, looping seamlessly ───────
    var tailStart = 0;
    function armTailLoop() {
      var d = video.duration;
      if (isFinite(d) && d > 0) {
        tailStart = Math.max(0, d - cfg.tail);
        try { video.currentTime = tailStart; } catch (e) {}
      } else {
        // Duration unknown (e.g. still streaming) — fall back to looping the
        // whole clip natively rather than doing nothing useful.
        video.loop = true;
      }
      var playPromise = video.play();
      if (playPromise && playPromise.catch) playPromise.catch(function () { /* autoplay blocked — gradient/poster still looks fine */ });
    }
    if (video.readyState >= 1 /* HAVE_METADATA */) {
      armTailLoop();
    } else {
      video.addEventListener('loadedmetadata', armTailLoop, { once: true });
    }
    // Manually loop just the tail window (video.loop stays false in this path).
    video.addEventListener('timeupdate', function () {
      var d = video.duration;
      if (!video.loop && isFinite(d) && d > 0 && video.currentTime >= d - 0.12) {
        try { video.currentTime = tailStart; } catch (e) {}
      }
    });
    // Video failed to load/decode — hide it so the gradient fallback shows through.
    video.addEventListener('error', function () {
      video.style.display = 'none';
    });
    video.src = cfg.video;

    // ── Reveal + dismiss orchestration — every state change is driven by
    //    setTimeout + classList (never rAF / CSS animation-fill-mode), so a
    //    throttled/backgrounded tab can never leave the splash stuck. ───────
    var dismissed = false;
    var timers = [];
    function schedule(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }

    var BRAND_IN_DELAY = 60;    // let the initial transform paint before transitioning
    var CTA_SHOW_DELAY = 1000;  // "~1s" logo intro, then the video takes over

    schedule(function () { brand.classList.add('dive-in'); }, BRAND_IN_DELAY);
    schedule(function () {
      cta.classList.add('dive-cta-show');
      try { cta.focus({ preventScroll: true }); } catch (e) { try { cta.focus(); } catch (e2) {} }
      // autoMs counts from the end of the intro (i.e. once the CTA is showing),
      // and 0 means "wait for tap/Enter only" — no timer at all.
      if (cfg.autoMs > 0) schedule(dismiss, cfg.autoMs);
    }, CTA_SHOW_DELAY);

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimers();
      overlay.style.pointerEvents = 'none';
      overlay.classList.add('dive-out');
      setTimeout(cleanup, 900); // > the .85s CSS exit transition
    }

    function cleanup() {
      document.removeEventListener('keydown', onKeydown, true);
      try { video.pause(); } catch (e) {}
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (style.parentNode) style.parentNode.removeChild(style);
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
      try { window.dispatchEvent(new CustomEvent('dive-splash:dismissed')); } catch (e) {}
    }

    // Tap/click anywhere on the splash, or press Enter — dismiss early.
    overlay.addEventListener('click', dismiss);
    function onKeydown(e) {
      if (e.key === 'Enter' || e.keyCode === 13) dismiss();
    }
    document.addEventListener('keydown', onKeydown, true);

    // ── Mount ────────────────────────────────────────────────────────────
    var prevHtmlOverflow = document.documentElement.style.overflow;
    var prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    document.head.appendChild(style);
    document.body.appendChild(overlay);

    // Small public hook, harmless and optional — lets the host app dismiss
    // the splash programmatically if it ever needs to (not required for the
    // documented integration).
    window.DiveSplash = { dismiss: dismiss };
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
