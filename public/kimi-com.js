/* kimi.com-style chrome script — injects the top nav, rebrands the
   sidebar, and keeps the light theme applied. All DOM access is
   guarded; a MutationObserver re-applies the chrome after re-renders.

   CRITICAL: the observer callback must never write the theme attributes
   (data-color-scheme / data-accent). The app watches those attributes and
   fights back — writing them from a MutationObserver callback creates an
   endless mutation ping-pong that stalls page load in chromium. Theme
   forcing therefore happens only in one-shot paths (startup, DOMContentLoaded,
   delayed fallbacks), never in the observer. */
(function () {
  "use strict";

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* Kimi eyes logo (same shape as the app's ch-logo) */
  var EYES_SVG =
    '<svg width="22" height="22" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi">' +
    '<defs><mask id="kcTopEyes" maskUnits="userSpaceOnUse">' +
    '<rect x="0" y="0" width="32" height="22" fill="#fff"></rect>' +
    '<g fill="#000"><rect class="kc-eye" x="11.8" y="7" width="2.8" height="8" rx="1.4"></rect>' +
    '<rect class="kc-eye" x="17.4" y="7" width="2.8" height="8" rx="1.4"></rect></g>' +
    '</mask></defs>' +
    '<rect x="1" y="1" width="30" height="20" rx="6" fill="#1783ff" mask="url(#kcTopEyes)"></rect></svg>';

  function forceLight() {
    var el = document.documentElement;
    el.dataset.colorScheme = "light";
    el.dataset.accent = "blue";
  }

  function ensureTopbar() {
    if (qs(".kc-topbar")) return;
    var tb = document.createElement("div");
    tb.className = "kc-topbar";

    var brand = document.createElement("a");
    brand.className = "kc-brand";
    brand.href = "https://www.kimi.com";
    brand.target = "_blank";
    brand.rel = "noopener";
    brand.innerHTML = EYES_SVG + "<span>Kimi</span>";

    var nav = document.createElement("nav");
    nav.className = "kc-nav";
    nav.innerHTML =
      '<a href="https://www.kimi.com" target="_blank" rel="noopener">Kimi Work</a>' +
      '<a href="/" class="kc-active">Kimi Code</a>' +
      '<a href="https://www.kimi.com/claw" target="_blank" rel="noopener">Kimi Claw</a>';

    var right = document.createElement("div");
    right.className = "kc-right";
    right.innerHTML =
      '<a href="https://www.kimi.com/download" target="_blank" rel="noopener">Get App</a>' +
      '<a href="https://www.kimi.com/about" target="_blank" rel="noopener">About Us</a>' +
      '<a href="https://www.kimi.com/help" target="_blank" rel="noopener">Get Help</a>';

    tb.appendChild(brand);
    tb.appendChild(nav);
    tb.appendChild(right);
    document.body.insertBefore(tb, document.body.firstChild);
  }

  function ensureBrand() {
    var name = qs(".ch-brand .ch-name");
    if (name && name.textContent !== "Kimi") {
      name.textContent = "Kimi";
    }
  }

  function ensurePlaceholder() {
    var ta = qs("textarea.ph");
    if (ta && ta.placeholder !== "Ask anything, or task an agent…") {
      ta.placeholder = "Ask anything, or task an agent…";
    }
  }

  function ensureTitle() {
    if (document.title !== "Kimi") document.title = "Kimi";
  }

  /* Dismiss the first-run "Welcome to Kimi Web" dialog if it ever appears
     (belt-and-suspenders — kimi-com-boot.js pre-sets kimi-web.onboarded,
     so this normally never fires). Idempotent: one click, then done. */
  var dismissedOnboarding = false;
  function dismissOnboarding() {
    if (dismissedOnboarding) return;
    var btns = qsa("button");
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || "").trim();
      if (t === "Get started" || t === "Skip") {
        try {
          btns[i].click();
          dismissedOnboarding = true;
        } catch (e) {
          /* ignore */
        }
        return;
      }
    }
  }

  /* Chrome-only pass — safe to run from the observer: no theme writes. */
  function applyChrome() {
    try {
      ensureTopbar();
      ensureBrand();
      ensurePlaceholder();
      ensureTitle();
      dismissOnboarding();
    } catch (e) {
      /* ignore — app may still be mounting */
    }
  }

  /* Full pass — one-shot paths only (never from the observer). */
  function apply() {
    try {
      forceLight();
      applyChrome();
    } catch (e) {
      /* ignore — app may still be mounting */
    }
  }

  apply();
  document.addEventListener("DOMContentLoaded", apply);

  var observer = null;
  try {
    observer = new MutationObserver(function () {
      applyChrome();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    /* no MutationObserver — the one-shot fallbacks below still apply */
  }

  /* One-shot safety nets. A persistent setInterval here stalls the page in
     chromium (timers + module bundle), and the observer handles re-renders. */
  setTimeout(apply, 3000);
  setTimeout(apply, 15000);
})();
