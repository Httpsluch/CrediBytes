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

// Must carry ?panel=1 — panel-init.js keys the side-panel layout off it, and a
// setOptions() call without it overrides the manifest default_path and loads
// the panel with popup sizing. Mirrors the constant in popup.js.
const PANEL_PATH = "src/popup.html?panel=1";

const DEFAULT_SETTINGS = {
  scanningEnabled: true,
  // Two independent settings, not one three-way value. See the migration in
  // onInstalled below for why they were split.
  sidePanel: false,
  displayResult: "badge",
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
  const stored = { ...(data.settings || {}) };
  // MIGRATION, run once on update. The old displayMode conflated where the
  // extension's own UI opens with what is drawn on the page: "sidepanel" meant
  // "badges PLUS the panel", so it was never a peer of "badge" and "floating".
  // An old value is translated rather than dropped, then removed so it cannot
  // resurrect the previous choice later.
  if (typeof stored.displayMode === "string") {
    if (stored.sidePanel === undefined) stored.sidePanel = stored.displayMode === "sidepanel";
    if (stored.displayResult === undefined) {
      stored.displayResult = stored.displayMode === "floating" ? "floating" : "badge";
    }
    delete stored.displayMode;
  }
  patch.settings = { ...DEFAULT_SETTINGS, ...stored };

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
async function applyActionBehaviour(settings) {
  // Accepts the settings object, not a mode string. displayMode used to be a
  // single three-way value; it is now displayMode(panel bool) + displayResult.
  // A stored legacy "sidepanel" still resolves, so an existing user keeps the
  // behaviour they chose.
  const s = settings || {};
  const useSidePanel = typeof s.sidePanel === "boolean"
    ? s.sidePanel
    : s.displayMode === "sidepanel";
  // ORDER MATTERS, and getting it wrong produced a toolbar button that did
  // nothing at all.
  //
  // Clearing the popup is what lets a click reach the side panel, but between
  // clearing it and enabling the panel behaviour there is a window in which
  // neither is configured — and a click in that window opens nothing. Worse,
  // the old code cleared the popup FIRST and then caught a setPanelBehavior
  // failure with a comment saying the popup remained as a fallback. It did not:
  // it had already been removed, so a failure left the button permanently dead.
  //
  // So: turning the panel ON, enable the behaviour before removing the popup.
  // Turning it OFF, restore the popup before disabling the behaviour. Whichever
  // way it goes, at every instant at least one of the two is live.
  try {
    if (useSidePanel) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      await chrome.action.setPopup({ popup: "" });
    } else {
      await chrome.action.setPopup({ popup: "src/popup.html" });
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
  } catch (_e) {
    // Older Chrome without setPanelBehavior, or the call failed. NOW the popup
    // is genuinely the fallback, because this restores it rather than assuming
    // it survived.
    try { await chrome.action.setPopup({ popup: "src/popup.html" }); } catch (_e2) {}
  }
}

// Safety net. With the popup cleared, a click normally opens the panel without
// firing this at all — it fires only when the panel behaviour is NOT in effect,
// which is exactly the state that used to swallow the click silently.
//
// Re-enabling first matters: turning the toggle off calls setOptions({enabled:
// false}) for that tab, and open() on a disabled panel throws.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (_e) {
    // Nothing further to try: if the panel will not open, restoring the popup
    // at least makes the next click work.
    try { await chrome.action.setPopup({ popup: "src/popup.html" }); } catch (_e2) {}
  }
});

async function syncActionBehaviour() {
  const data = await chrome.storage.local.get("settings");
  await applyActionBehaviour(data.settings || {});
}

chrome.runtime.onStartup.addListener(syncActionBehaviour);
chrome.runtime.onInstalled.addListener(syncActionBehaviour);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    applyActionBehaviour(changes.settings.newValue || {});
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
// filtering could only surface the 3 still inside the window.
//
// The cap is NOT about the storage quota. chrome.storage.local allows ~10 MB
// and a scan record measures ~1.3 KB, so quota alone would permit thousands.
// It exists because appendScan is read-modify-write: the WHOLE array is
// serialised and rewritten on every single scan, and scans arrive in bursts
// while scrolling. 2000 records is ~2.6 MB per write, which stays fast; 10000
// would be ~13 MB per write and would make the serialised queue crawl.
//
// Rendering is no longer capped at all — popup.js draws in batches as the feed
// is scrolled, so nothing stored is unreachable.
const MAX_SCANS = 2000;
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
const EMPTY_TOTALS = { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0, revoked: 0 };

function enqueueScan(payload) {
  scanWriteQueue = scanWriteQueue.then(() => appendScan(payload)).catch(() => {});
  return scanWriteQueue;
}

// Mirrors verdictOf() in content.js for records saved before `tier` existed.
function tierOf(scan) {
  if (scan.tier) return scan.tier;
  if (scan.legitimacy === "revoked")           return "revoked";
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

// ── Stage 3, on request: read an advertised app's store listing ────────────
//
// Deliberately NOT automatic — see the header of stage3.js for why, and for why
// the Play side reads the page's embedded structured data rather than regexing
// its visible HTML.
//
// importScripts, not import: this is a classic service worker, and the model is
// a plain window/self assignment.
importScripts("stage3_model.js", "stage3.js");

const listingCache = new Map();      // storeKey -> { listing, pct }, FIFO
const LISTING_CACHE_MAX = 120;

function storeKeyOf(url) {
  const m = /[?&]id=([^&]+)/.exec(url) || /\/(id\d+)/.exec(url);
  return m ? m[1] : "";
}

async function readListing(url, advertiserName) {
  const key = storeKeyOf(url);
  if (!key) throw new Error("not a store url");
  const cacheKey = `${key}|${advertiserName || ""}`;
  if (listingCache.has(cacheKey)) return listingCache.get(cacheKey);

  const S3 = globalThis.CrediBytesStage3;
  const L = S3.assertReadable(
    /^id\d+$/i.test(key) ? await S3.fetchApple(key.slice(2))
                         : await S3.fetchPlay(key));

  const feats = S3.buildFeatures3(L, advertiserName);
  const p = S3.score3(feats);

  // Flat, NOT wrapped in { listing: ... }. The message handler already wraps
  // this as { ok, listing }, so returning a wrapper here produced
  // res.listing.listing and every field read undefined — the card rendered a
  // single "Privacy policy: none listed" row, because that label is a constant
  // string while everything else was missing.
  const out = {
    developer: L.developer,
    // Play publishes installs AND a rating count; Apple publishes only the
    // rating count, because Apple does not disclose installs at all. Showing
    // one OR the other used to hide Play's rating count behind its install
    // count, so the row said "installs" under a heading reading "Ratings".
    //
    // Each field is sent separately and the card omits whichever is absent —
    // an unavailable install count is not a zero (section 3.15).
    installs: L.installs !== undefined ? L.installs.toLocaleString() : "",
    ratings: L.reviews !== undefined ? L.reviews.toLocaleString() : "",
    // Rounded to one decimal: the raw value carries full float precision
    // (4.6711235), which reads as false precision on a store rating.
    stars: typeof L.rating === "number" ? L.rating.toFixed(1) : "",
    updated: L.updatedMs !== undefined
      ? new Date(L.updatedMs).toISOString().slice(0, 10) : "",
    // null = we did not look (Apple's lookup API exposes no policy field).
    // The card omits the row entirely rather than claiming "none listed".
    privacy: L.policy === undefined ? null : !!L.policy,
    privacyFree: L.policy === undefined ? null
      : (!!L.policy && /(blogspot|wordpress\.com|sites\.google|weebly|wixsite|github\.io|firebaseapp|000webhost|blogger)/i.test(L.policy)),
    // Rounded for display only; the model saw the exact value.
    pct: p === null ? null : Math.round(p * 100),
    // Play only, and never allowed to break the listing. It is a SECOND page,
    // so it can fail on its own — and a data-safety fetch that fails means we
    // do not know what the developer declared, which is not the same as the
    // developer declaring nothing. null keeps those apart, exactly as the
    // privacy-policy field above does.
    dataSafety: null,
  };

  if (L.isPlay) {
    // Play publishes this on a separate page, so it is a second fetch and is
    // caught on its own. Apple publishes it in the listing page fetchApple()
    // already read, so it arrives on L with no extra request.
    try { out.dataSafety = await S3.fetchDataSafety(key); }
    catch (_e) { out.dataSafety = null; }
  } else {
    out.dataSafety = L.dataSafety || null;
  }

  if (listingCache.size >= LISTING_CACHE_MAX) {
    listingCache.delete(listingCache.keys().next().value);
  }
  listingCache.set(cacheKey, out);
  return out;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "CHECK_LISTING") {
    // The advertiser name feeds dev_matches_advertiser, one of the 15 features.
    readListing(message.url, message.advertiserName)
      .then(listing => sendResponse({ ok: true, listing }))
      .catch(() => sendResponse({ ok: false, listing: null }));
    return true;
  }

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
