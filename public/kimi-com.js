/* kimi.com-style chrome script — injects the top nav (brand + hamburger
   menu), rebrands the sidebar, and keeps the light theme applied. All DOM
   access is guarded; a MutationObserver re-applies the chrome after
   re-renders.

   CRITICAL: the observer callback must never write the theme attributes
   (data-color-scheme / data-accent). The app watches those attributes and
   fights back — writing them from a MutationObserver callback creates an
   endless mutation ping-pong that stalls page load in chromium. Theme
   forcing therefore happens only in one-shot paths (startup, DOMContentLoaded,
   delayed fallbacks), never in the observer.

   Top bar: brand + hamburger menu button. All entries (Kimi Code, Kimi Work,
   Kimi Claw, Get App, About Us, Get Help) live inside the menu dropdown.
   Kimi Work / Kimi Claw open in-app in a full-screen iframe so the user
   stays on this service; a "Naya tab me kholo" link is always available
   as a fallback in case the remote site refuses to be framed. */
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

  var MENU_ITEMS = [
    { label: "Kimi Code", action: "local", href: "/" },
    { label: "Kimi Work", action: "embed", href: "https://www.kimi.com" },
    { label: "Kimi Claw", action: "embed", href: "https://www.kimi.com/claw" },
    { divider: true },
    { label: "Get App", action: "external", href: "https://www.kimi.com/download" },
    { label: "About Us", action: "external", href: "https://www.kimi.com/about" },
    { label: "Get Help", action: "external", href: "https://www.kimi.com/help" },
  ];

  function forceLight() {
    var el = document.documentElement;
    el.dataset.colorScheme = "light";
    el.dataset.accent = "blue";
  }

  function toggleMenu(force) {
    var menu = qs(".kc-menu");
    if (!menu) return;
    var open = force !== undefined ? !!force : !menu.classList.contains("kc-open");
    menu.classList.toggle("kc-open", open);
  }

  /* Full-screen in-app embed (Kimi Work / Kimi Claw) */
  function openEmbed(title, url) {
    var ov = qs(".kc-embed");
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "kc-embed";
      ov.innerHTML =
        '<div class="kc-embed-head">' +
        '<span class="kc-embed-title"></span>' +
        '<div class="kc-embed-actions">' +
        '<a class="kc-embed-ext" target="_blank" rel="noopener">Naya tab me kholo</a>' +
        '<button class="kc-embed-close" aria-label="Close">&times;</button>' +
        "</div></div>" +
        '<iframe class="kc-embed-frame" allow="fullscreen; autoplay; clipboard-write" ' +
        'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>';
      ov.querySelector(".kc-embed-close").addEventListener("click", closeEmbed);
      ov.addEventListener("click", function (e) {
        if (e.target === ov) closeEmbed();
      });
      document.body.appendChild(ov);
    }
    ov.querySelector(".kc-embed-title").textContent = title;
    ov.querySelector(".kc-embed-ext").href = url;
    ov.querySelector(".kc-embed-frame").src = url;
    ov.classList.add("kc-open");
  }

  function closeEmbed() {
    var ov = qs(".kc-embed");
    if (!ov) return;
    ov.classList.remove("kc-open");
    ov.querySelector(".kc-embed-frame").src = "about:blank";
  }

  function ensureTopbar() {
    if (qs(".kc-topbar")) return;
    var tb = document.createElement("div");
    tb.className = "kc-topbar";

    var brand = document.createElement("a");
    brand.className = "kc-brand";
    brand.href = "/";
    brand.innerHTML = EYES_SVG + "<span>Kimi</span>";

    var menuBtn = document.createElement("button");
    menuBtn.className = "kc-menu-btn";
    menuBtn.setAttribute("aria-label", "Menu");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.innerHTML = '<span></span><span></span><span></span>';
    menuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleMenu();
    });

    var menu = document.createElement("div");
    menu.className = "kc-menu";
    MENU_ITEMS.forEach(function (item) {
      if (item.divider) {
        var d = document.createElement("div");
        d.className = "kc-menu-divider";
        menu.appendChild(d);
        return;
      }
      var a = document.createElement("a");
      a.textContent = item.label;
      a.href = item.href || "#";
      if (item.action === "embed") {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          toggleMenu(false);
          openEmbed(item.label, item.href);
        });
      } else if (item.action === "local") {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          toggleMenu(false);
          window.location.href = item.href;
        });
      } else {
        a.target = "_blank";
        a.rel = "noopener";
        a.addEventListener("click", function () {
          toggleMenu(false);
        });
      }
      menu.appendChild(a);
    });

    tb.appendChild(brand);
    tb.appendChild(menuBtn);
    tb.appendChild(menu);
    document.body.insertBefore(tb, document.body.firstChild);

    document.addEventListener("click", function (e) {
      if (e.target.closest && !e.target.closest(".kc-menu-btn") && !e.target.closest(".kc-menu")) {
        toggleMenu(false);
      }
    });
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
