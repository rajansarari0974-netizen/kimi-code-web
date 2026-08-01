/* kimi.com-style boot: force light theme before the app bundle loads.
   Runs right after /boot.js (render-blocking). The app bundle mirrors
   data-color-scheme from localStorage, so persist the choice first.
   Also marks the app as onboarded so the "Welcome to Kimi Web" dialog
   never blocks the UI, and pre-seeds the server credential so the
   "Sign in to Kimi Code" screen never appears (the app's stored
   credential normally expires after 7 days — we set a ~10 year one). */
(function () {
  try {
    localStorage.setItem("kimi-web.color-scheme", "light");
  } catch (e) {
    /* ignore */
  }
  try {
    localStorage.setItem("kimi-web.onboarded", "1");
  } catch (e) {
    /* ignore */
  }
  try {
    localStorage.setItem(
      "kimi-web.server-credential",
      JSON.stringify({
        version: 1,
        credential: "VNE1wpc7gqGD1THY-Np6WRPYdU5LlOrk3ICvxsy_N58",
        expiresAt: Date.now() + 315360000000, /* ~10 years */
      })
    );
  } catch (e) {
    /* ignore */
  }
  try {
    document.documentElement.dataset.colorScheme = "light";
    document.documentElement.dataset.accent = "blue";
  } catch (e) {
    /* ignore */
  }
})();
