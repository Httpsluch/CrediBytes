/**
 * background.js — CrediBytes
 * Manifest V3 service worker.
 *
 * Handles ALL network requests to the FastAPI backend.
 * Content scripts cannot fetch external origins due to Facebook's
 * strict Content Security Policy — service workers are exempt.
 *
 * Also owns chrome.storage writes for scan history to prevent
 * race conditions with content.js.
 */

const BACKEND_URL = 'https://credibytes-backend.onrender.com'

const DEFAULT_SETTINGS = {
  scanningEnabled: true,
  displayMode: "badge",
};

// onInstalled fires on UPDATE as well as first install, so this must not
// clobber what is already stored — the previous version reset scans to [] and
// settings to defaults on every version bump, silently wiping the user's
// history and their chosen display mode.
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["scans", "settings"]);
  const patch = {};

  if (!Array.isArray(data.scans)) patch.scans = [];
  // Merge so a newly added setting gets its default without discarding
  // existing choices.
  patch.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

  await chrome.storage.local.set(patch);
});

// ── Toolbar-click behaviour follows the display mode ────────────────────────
// With a "default_popup" in the manifest Chrome always opens the popup and
// never fires action.onClicked, so "Side panel" mode used to be contradictory:
// the user picked side panel, then clicking the icon gave them the popup
// anyway. Clearing the popup at runtime lets the click open the panel instead.
//
// The 360px popup is also cramped for a long scan list; the panel is
// full-height, which is why this mode is worth wiring up properly.
async function applyActionBehaviour(mode) {
  const useSidePanel = mode === "sidepanel";
  try {
    // Empty string disables the popup so the click reaches the side panel.
    await chrome.action.setPopup({ popup: useSidePanel ? "" : "src/popup.html" });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: useSidePanel });
  } catch (_e) {
    // Older Chrome without setPanelBehavior — keep the popup as the fallback.
  }
}

async function syncActionBehaviour() {
  const data = await chrome.storage.local.get("settings");
  await applyActionBehaviour(data.settings?.displayMode || "badge");
}

chrome.runtime.onStartup.addListener(syncActionBehaviour);
chrome.runtime.onInstalled.addListener(syncActionBehaviour);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    applyActionBehaviour(changes.settings.newValue?.displayMode || "badge");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // ── Stage 1: ML prediction via FastAPI backend ──────────────────────────
  if (message.type === "PREDICT") {
    fetchPrediction(message.payload)
      .then(prediction => sendResponse({ ok: true, prediction }))
      .catch(() => sendResponse({ ok: false, prediction: null }));
    return true; // keep message channel open for async response
  }

  // ── Save scan result to storage (single writer — no race conditions) ─────
  if (message.type === "SAVE_SCAN") {
    chrome.storage.local.get("scans", (data) => {
      const scans = data.scans || [];
      scans.unshift(message.payload);
      chrome.storage.local.set({ scans: scans.slice(0, 50) });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "CLEAR_SCANS") {
    chrome.storage.local.set({ scans: [] }, () => sendResponse({ ok: true }));
    return true;
  }
});

async function fetchPrediction({ companyName, platformName, hasOfficialWebsite }) {
  try {
    const res = await fetch(`${BACKEND_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: companyName,
        platform_name: platformName,
        // Backend defaults this to 0 if absent, so an older content.js still works.
        has_official_website: hasOfficialWebsite ? 1 : 0,
      }),
    });
    if (!res.ok) return null;
    return await res.json(); // { is_app: bool, probability: float }
  } catch {
    return null; // Backend unreachable — content.js degrades gracefully
  }
}
