/**
 * panel-init.js — CrediBytes
 *
 * popup.html is used for BOTH the toolbar popup and the side panel, but the
 * two need different sizing: the popup is a fixed-height card, the panel must
 * fill its host window.
 *
 * Detection is by query parameter, not width. The side panel is user-resizable
 * and is commonly narrower than the popup — a `@media (min-width: 400px)` rule
 * silently failed on a 360px-wide panel, leaving the body stuck at its fixed
 * popup height with dead space below it. The manifest points the panel at
 * popup.html?panel=1, so the surface identifies itself.
 *
 * Loaded from <head> WITHOUT defer so the class lands before first paint and
 * the layout never flashes at the wrong size. It must therefore not touch the
 * DOM body, which does not exist yet. (MV3 forbids inline scripts, so this
 * cannot be a <script> block in the HTML.)
 */
if (new URLSearchParams(location.search).has("panel")) {
  document.documentElement.classList.add("is-sidepanel");
}

// Theme, applied before first paint for the same reason.
//
// chrome.storage holds the real setting so it is shared between the popup and
// the side panel, but its reads are async — by the time one resolved the page
// would already have painted, flashing the wrong palette on every open. popup.js
// mirrors each change into localStorage, which is synchronous, purely so this
// can run early. "system" writes no attribute, leaving prefers-color-scheme in
// charge.
try {
  const theme = localStorage.getItem("cb-theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  }
} catch (_e) {
  /* localStorage unavailable — fall back to the OS preference. */
}

// Language, mirrored into localStorage for exactly the same reason as the theme.
//
// Without this the popup paints in English and then rewrites every string once
// chrome.storage resolves, which reads as a flicker on every open — worse than
// the theme flash, because the text reflows as it changes. Setting it here means
// popup.js's first translate pass is already a no-op.
try {
  const lang = localStorage.getItem("cb-lang");
  if (window.CrediBytesI18n && window.CrediBytesI18n.has(lang)) {
    window.CrediBytesI18n.setLang(lang);
    document.documentElement.lang = lang;
  }
} catch (_e) {
  /* localStorage unavailable — English remains the default. */
}
