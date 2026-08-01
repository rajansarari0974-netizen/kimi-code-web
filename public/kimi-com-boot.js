/* kimi.com-style boot: force light theme before the app bundle loads.
   Runs right after /boot.js (render-blocking). The app bundle mirrors
   data-color-scheme from localStorage, so persist the choice first. */
(function () {
  try {
    localStorage.setItem("kimi-web.color-scheme", "light");
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
