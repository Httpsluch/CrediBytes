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

// ── Scan history writes, serialised ─────────────────────────────────────────
// Saving a scan is read-modify-write: get the array, unshift, put it back.
// content.js processes ads concurrently (findAdElements().forEach, no await),
// so several SAVE_SCAN messages are in flight at once. Each handler used to
// read the array independently, and whichever set() landed last silently
// discarded the others' entries — badges appeared on the page with no matching
// row in the popup or side panel.
//
// Every write now queues behind the previous one, so each read sees the result
// of the write before it. The chain is a single promise, not a lock, so no
// request can block another indefinitely; a failed write is swallowed so it
// cannot wedge the queue.

// Feed depth. 50 was too shallow to filter against: a session scrolling the
// Meta Ad Library produced ~400 scans, so the tiles read 22 Unregistered while
// filtering could only surface the 3 that were still inside the window.
//
// chrome.storage.local allows ~10 MB and a scan record is well under 1 KB, so
// 500 is comfortable. Rendering is capped separately (RENDER_LIMIT in
// popup.js) — the cost is drawing thousands of rows, not storing them.
const MAX_SCANS = 500;
let scanWriteQueue = Promise.resolve();

// Running totals, kept separately from the feed.
//
// The stat tiles used to be derived from the stored `scans` array, which is
// capped at MAX_SCANS. Once that cap is reached every new scan evicts an old
// one, so a tile could go DOWN: scrolling the Ad Library took Verified from 22
// to 20 while Unverified rose, because two verified rows had aged out. The
// three tiles always summed to exactly 50, which is what gave it away.
//
// Totals now count every scan since the last clear; the feed stays a rolling
// window of the most recent MAX_SCANS.
const EMPTY_TOTALS = { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0 };

function enqueueScan(payload) {
  scanWriteQueue = scanWriteQueue.then(() => appendScan(payload)).catch(() => {});
  return scanWriteQueue;
}

// Mirrors verdictOf() in content.js for records saved before `tier` existed.
function tierOf(scan) {
  if (scan.tier) return scan.tier;
  if (scan.legitimacy === "legitimate")        return "legitimate";
  if (scan.legitimacy === "likely_legitimate") return "likely";
  if (scan.legitimacy === "name_match_only")   return "namematch";
  if (scan.status === "no_reference_match" && scan.isStoreUrl) return "danger";
  return "unverified";
}

async function appendScan(payload) {
  const { scans = [], totals = { ...EMPTY_TOTALS } } =
    await chrome.storage.local.get(["scans", "totals"]);

  const tier = tierOf(payload);
  const nextTotals = { ...EMPTY_TOTALS, ...totals };
  nextTotals[tier] = (nextTotals[tier] || 0) + 1;

  await chrome.storage.local.set({
    scans: [payload, ...scans].slice(0, MAX_SCANS),
    totals: nextTotals,
  });
}

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

// `force` bypasses the interval. A prediction that just timed out is direct
// evidence the instance is asleep, so throttling that particular wake-up would
// defeat the point — the rate limit exists to stop idle polling, not to block
// a request we know is needed.
async function warmBackend(force = false) {
  const now = Date.now();
  if (!force && now - lastWarmAt < WARM_INTERVAL_MS) return;
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
    fetchPredictionCached(message.payload)
      .then(prediction => sendResponse({ ok: true, prediction }))
      .catch(() => sendResponse({ ok: false, prediction: null }));
    return true; // keep message channel open for async response
  }

  // ── Save scan result to storage (single writer — no race conditions) ─────
  if (message.type === "SAVE_SCAN") {
    enqueueScan(message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "CLEAR_SCANS") {
    // Totals reset with the feed, otherwise "Clear all" would empty the list
    // while the tiles kept counting history the user just deleted. Queued
    // behind any in-flight save so a scan landing mid-clear cannot resurrect
    // a stale total.
    scanWriteQueue = scanWriteQueue
      .then(() => chrome.storage.local.set({ scans: [], totals: { ...EMPTY_TOTALS } }))
      .catch(() => {});
    scanWriteQueue.then(() => sendResponse({ ok: true }));
    return true;
  }
});

// The backend is the preferred source for Stage 1 so the deployed service
// receives real traffic (and its logs show it). content.js waits only
// BACKEND_WAIT_MS before falling back to the bundled model, so there is no
// point waiting longer than that here — a slow answer would arrive after the
// badge had already rendered.
//
// On failure we kick off a warm request. A spun-down free-tier instance takes
// 30-60s to boot, so the attempt that just timed out is what wakes it: this ad
// is served locally, the next one on the page is usually served remotely.
const PREDICT_TIMEOUT_MS = 2500;

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

// Predictions are pure: the same three inputs always give the same answer, and
// Stage 1 sees only the advertiser name, app name and website flag. Scrolling
// the Ad Library surfaces the same advertisers over and over — one operator ran
// six re-skinned apps in the collected data — so without a cache each repeat
// costs another round trip, and dozens of ads arriving together meant dozens of
// concurrent fetches. That is the lag.
//
// In-flight requests are cached too, so N ads for one advertiser share a single
// request instead of racing.
const predictionCache = new Map();
const PREDICTION_CACHE_MAX = 300;

function cacheKey(p) {
  return `${p.companyName} ${p.platformName} ${p.hasOfficialWebsite ? 1 : 0}`;
}

function fetchPredictionCached(payload) {
  const key = cacheKey(payload);
  if (predictionCache.has(key)) return predictionCache.get(key);

  const inflight = fetchPrediction(payload).then((result) => {
    // Only a real answer is worth keeping. Caching a null would pin the local
    // fallback in place for the rest of the session even once the instance woke.
    if (!result) predictionCache.delete(key);
    return result;
  }).catch(() => {
    predictionCache.delete(key);
    return null;
  });

  predictionCache.set(key, inflight);
  if (predictionCache.size > PREDICTION_CACHE_MAX) {
    predictionCache.delete(predictionCache.keys().next().value);   // oldest out
  }
  return inflight;
}

async function fetchPrediction(payload) {
  try {
    return await postPredict(payload, PREDICT_TIMEOUT_MS);
  } catch (_err) {
    // Timed out, offline, or the instance is still booting. Nudge it so the
    // next ad can be served remotely, and let content.js use the local model
    // for this one.
    warmBackend(true);
    return null;
  }
}
