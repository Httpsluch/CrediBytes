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

// ── Keeping the fallback backend warm ───────────────────────────────────────
// Stage 1 normally runs locally (see stage1.js), so the backend is only the
// fallback. But Render's free tier spins down after ~15 minutes idle, and a
// cold start costs 30-60s — the fallback would be useless exactly when needed.
//
// A cheap GET on the health endpoint when the user lands on Facebook wakes it
// in the background, so it is usually ready before any ad is scanned. Rate
// limited to at most one wake per WARM_INTERVAL_MS, and only for Facebook tabs,
// so this is not a keep-alive ping loop — it warms on genuine intent to use.

const WARM_INTERVAL_MS = 10 * 60 * 1000;
let lastWarmAt = 0;

async function warmBackend() {
  const now = Date.now();
  if (now - lastWarmAt < WARM_INTERVAL_MS) return;
  lastWarmAt = now;
  try {
    await fetch(`${BACKEND_URL}/`, { method: "GET", cache: "no-store" });
  } catch (_e) {
    // Offline or still spinning up — the local model covers Stage 1 anyway.
  }
}

const isFacebook = (url) => typeof url === "string" && /^https:\/\/(www\.)?facebook\.com\//.test(url);

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && isFacebook(tab.url)) warmBackend();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isFacebook(tab.url)) warmBackend();
  } catch (_e) { /* tab vanished */ }
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

// Reached only when the bundled Stage 1 model failed to load, so it is worth
// waiting through a cold start rather than giving up immediately.
//
// A first attempt on a spun-down free-tier instance usually times out while
// the container boots; the retry then lands on a warm instance. The old code
// made a single attempt and returned null on any failure, which is why a cold
// start was indistinguishable from a broken backend.
const FIRST_TRY_TIMEOUT_MS = 8000;
const RETRY_TIMEOUT_MS     = 45000;   // Render cold starts can run 30-60s

async function postPredict(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: payload.companyName,
        platform_name: payload.platformName,
        // Backend defaults this to 0 if absent, so an older content.js still works.
        has_official_website: payload.hasOfficialWebsite ? 1 : 0,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return { ...json, source: "remote" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrediction(payload) {
  try {
    return await postPredict(payload, FIRST_TRY_TIMEOUT_MS);
  } catch (_first) {
    // Likely a cold start. Nudge the instance and wait longer for one retry.
    warmBackend();
    try {
      return await postPredict(payload, RETRY_TIMEOUT_MS);
    } catch (_second) {
      return null;   // content.js renders the badge without the profile line
    }
  }
}
