/**
 * popup.js — CrediBytes
 * Handles scan list rendering, clear button, settings tab, and display mode.
 *
 * v1.1 changes:
 *   - getBadgeClass() now uses scan.isStoreUrl (saved by content.js) to
 *     correctly apply "danger" class — fixes missing field from old payload
 *   - renderScans() shows officialUrl for verified matches
 *   - renderScans() shows suggestion block for unverified ads
 *   - ML meta line now shows riskDesc from backend instead of old
 *     "ML: App/No app (X%)" text; falls back gracefully for older records
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5)     return "just now";
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── Live-ticking timestamps ────────────────────────────────────────────────────
// Cost is negligible: this touches only the .scan-time nodes, never re-renders
// the list, and writes only when the formatted string actually changed. History
// is capped at 50 records, so a tick is ~50 integer divisions and usually zero
// DOM writes — far cheaper than the re-render it replaces.
//
// The interval is also cleared on unload, which matters for the side panel:
// unlike the popup it is long-lived and is not torn down on every close.

function refreshTimes() {
  document.querySelectorAll(".scan-time").forEach(el => {
    const ts = Number(el.dataset.ts);
    if (!ts) return;
    const next = timeAgo(ts);
    if (el.textContent !== next) el.textContent = next;
  });
}

const timeTicker = setInterval(refreshTimes, 1000);
window.addEventListener("pagehide", () => clearInterval(timeTicker));

function getBadgeClass(scan) {
  if (scan.legitimacy === "legitimate")        return "legitimate";
  if (scan.legitimacy === "likely_legitimate") return "likely";
  // isStoreUrl is now saved in the payload by content.js v1.1
  // Graceful fallback: if the field is missing (older stored scan), treat as unverified
  if (scan.legitimacy === "unverified" &&
      scan.status === "no_reference_match" &&
      scan.isStoreUrl) return "danger";
  return "unverified";
}

// ── Render scan list ───────────────────────────────────────────────────────────

function renderScans(scans) {
  const feed    = document.getElementById("feed");
  const empty   = document.getElementById("empty-state");
  const countEl = document.getElementById("scan-count");

  // Remove all previous scan items (keep #empty-state)
  feed.querySelectorAll(".scan-item").forEach(el => el.remove());

  if (!scans || scans.length === 0) {
    empty.style.display = "block";
    countEl.textContent = "0 scans";
    document.getElementById("count-legit").textContent      = "0";
    document.getElementById("count-unverified").textContent = "0";
    document.getElementById("count-danger").textContent     = "0";
    return;
  }

  empty.style.display = "none";
  countEl.textContent = `${scans.length} scan${scans.length !== 1 ? "s" : ""}`;

  let legit = 0, unverified = 0, danger = 0;

  scans.forEach(scan => {
    const cls = getBadgeClass(scan);
    if (cls === "legitimate") legit++;
    else if (cls === "danger") danger++;
    else unverified++;

    const item = document.createElement("div");
    item.className = `scan-item ${cls}`;

    // ── Top row: badge chip + timestamp ──
    const top = document.createElement("div");
    top.className = "scan-top";

    const badge = document.createElement("span");
    badge.className = `scan-badge ${cls}`;
    badge.textContent = scan.label || cls;

    const time = document.createElement("span");
    time.className = "scan-time";
    time.dataset.ts = String(scan.ts);   // read back by refreshTimes()
    time.textContent = timeAgo(scan.ts);

    top.appendChild(badge);
    top.appendChild(time);

    // ── Advertiser name ──
    const name = document.createElement("div");
    name.className = "scan-name";
    name.textContent = scan.advertiserName || scan.company || "—";

    // ── Stage 2 reason ──
    const reason = document.createElement("div");
    reason.className = "scan-reason";
    reason.textContent = scan.reason || "";

    item.appendChild(top);
    item.appendChild(name);
    item.appendChild(reason);

    // ── Official URL (verified matches only) ──
    if (scan.officialUrl) {
      const urlEl = document.createElement("div");
      urlEl.className = "scan-meta";
      urlEl.textContent = "Official: " + scan.officialUrl;
      item.appendChild(urlEl);
    }

    // ── SEC number ──
    if (scan.sec) {
      const secEl = document.createElement("div");
      secEl.className = "scan-meta";
      secEl.textContent = "SEC: " + scan.sec;
      item.appendChild(secEl);
    }

    // ── Fuzzy suggestion (unverified only) ──
    if (!scan.sec && scan.suggestion) {
      const sugg = document.createElement("div");
      sugg.className = "scan-meta scan-suggestion";
      sugg.textContent = "Possible match (unverified): " + scan.suggestion.company +
        " · SEC: " + scan.suggestion.sec;
      item.appendChild(sugg);
    }

    // ── Stage 1 ML risk signal ──
    // v1.1: show riskDesc from backend (human-readable tier string).
    // Fallback: if riskDesc is absent (older scan record), show old-style text.
    const hasRiskDesc = scan.riskDesc && typeof scan.riskDesc === "string";
    const hasOldML    = scan.isApp !== null && scan.isApp !== undefined;

    if (hasRiskDesc || hasOldML) {
      const mlEl = document.createElement("div");
      mlEl.className = "scan-meta";
      if (hasRiskDesc) {
        mlEl.textContent = scan.riskDesc;
      } else {
        // Graceful fallback for pre-v1.1 stored scans
        const pct = Math.round((scan.prob || 0) * 100);
        mlEl.textContent = `Profile score: ${pct}% — ${scan.isApp ? "profile resembles" : "profile does not resemble"} typical SEC-registered OLA platforms.`;
      }
      item.appendChild(mlEl);
    }

    feed.appendChild(item);
  });

  document.getElementById("count-legit").textContent      = legit;
  document.getElementById("count-unverified").textContent = unverified;
  document.getElementById("count-danger").textContent     = danger;
}

// ── Clear scans ────────────────────────────────────────────────────────────────
// Routes through background.js (single writer) to prevent race conditions.

function clearScans() {
  chrome.runtime.sendMessage({ type: "CLEAR_SCANS" }, () => {
    renderScans([]);
  });
}

document.getElementById("clear-btn").addEventListener("click", clearScans);
document.getElementById("clear-btn-settings").addEventListener("click", clearScans);

// ── Tabs ───────────────────────────────────────────────────────────────────────

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ── Settings ───────────────────────────────────────────────────────────────────

function loadSettings() {
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    document.getElementById("toggle-scanning").checked = s.scanningEnabled !== false;

    const mode = s.displayMode || "badge";
    const radio = document.querySelector(`input[name="display-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
  });
}

document.getElementById("toggle-scanning").addEventListener("change", (e) => {
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    s.scanningEnabled = e.target.checked;
    chrome.storage.local.set({ settings: s });
  });
});

// Must carry ?panel=1 — panel-init.js keys the side-panel layout off it, and a
// setOptions() call without the query string overrides the manifest's
// default_path, loading the panel with popup sizing and leaving dead space
// below the footer.
const PANEL_PATH = "src/popup.html?panel=1";

const MODE_LABELS = {
  badge:     "Inline badges enabled — reload is not required.",
  floating:  "Floating widget enabled — look for it on the page.",
  sidepanel: "Side panel enabled — badges also stay on ads.",
};

function flashStatus(text) {
  const el = document.getElementById("mode-status");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => el.classList.remove("show"), 2600);
}

document.querySelectorAll("input[name='display-mode']").forEach(radio => {
  radio.addEventListener("change", () => {
    chrome.storage.local.get("settings", (data) => {
      const s = data.settings || {};
      s.displayMode = radio.value;

      // content.js has a storage.onChanged listener, so writing here is what
      // actually switches the on-page surface. It used to only persist the
      // value, which is why every mode except side panel looked broken —
      // side panel appeared to work solely because of the open() call below.
      chrome.storage.local.set({ settings: s }, () => {
        flashStatus(MODE_LABELS[radio.value] || "Display mode updated.");
      });

      // Dismiss the popup after a choice is made. Every mode's result is on
      // the page or in the panel — leaving a 360px card covering the feed just
      // hides the thing the user is trying to look at. Short delay so the
      // confirmation line is readable first.
      //
      // Guarded: when this page IS the side panel, closing would shut the panel
      // the user just selected.
      if (!runningAsSidePanel) {
        setTimeout(() => window.close(), radio.value === "sidepanel" ? 250 : 900);
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return;

        if (radio.value === "sidepanel") {
          // Re-enable first: switching away disables the panel for this tab,
          // and open() on a disabled panel throws.
          chrome.sidePanel
            .setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true })
            .catch(() => {});
          // Must stay in the user-gesture call stack, so this is not nested
          // inside the storage callback above.
          chrome.sidePanel.open({ tabId: tab.id });
        } else {
          // Leaving side-panel mode should also dismiss the panel, otherwise
          // it stays open and contradicts the setting.
          chrome.sidePanel
            .setOptions({ tabId: tab.id, enabled: false })
            .catch(() => {});
        }
      });
    });
  });
});

// ── Open in side panel ─────────────────────────────────────────────────────────
// popup.html is used for BOTH the popup and the side panel. When it is already
// the panel there is nothing to expand into, so hide the control. The panel is
// the wider of the two, so width is a reliable discriminator (the popup is
// pinned to 360px).

// panel-init.js already set the class from ?panel=1. Width is not usable here:
// the side panel is resizable and often narrower than the popup.
// Safety net for a panel opened without ?panel=1 — Chrome persists sidePanel
// options per tab, so a path stored by an older build can outlive the fix.
// Secondary to the query parameter, never primary: the popup is capped at
// 600px tall (body is 560), so a viewport meaningfully taller than that can
// only be the panel.
function ensurePanelClassFallback() {
  const html = document.documentElement;
  if (html.classList.contains("is-sidepanel")) return;
  if (window.innerHeight > 620) html.classList.add("is-sidepanel");
}
ensurePanelClassFallback();
window.addEventListener("resize", ensurePanelClassFallback);

const runningAsSidePanel =
  document.documentElement.classList.contains("is-sidepanel");

document.getElementById("expand-btn")?.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.sidePanel
      .setOptions({ tabId: tabs[0].id, path: PANEL_PATH, enabled: true })
      .catch(() => {});
    chrome.sidePanel.open({ tabId: tabs[0].id });
    window.close();   // popup and panel side by side would be redundant
  });
});

// ── Init ───────────────────────────────────────────────────────────────────────

chrome.storage.local.get("scans", (data) => renderScans(data.scans || []));
loadSettings();

// Live update when storage changes (e.g. new scan comes in while popup is open)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.scans) renderScans(changes.scans.newValue || []);
});
