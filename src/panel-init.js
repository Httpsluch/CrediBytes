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
