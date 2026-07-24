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
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

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
        mlEl.textContent = `ML: ${scan.isApp ? "App" : "No app"} (${pct}%)`;
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
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
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

document.querySelectorAll("input[name='display-mode']").forEach(radio => {
  radio.addEventListener("change", () => {
    chrome.storage.local.get("settings", (data) => {
      const s = data.settings || {};
      s.displayMode = radio.value;
      chrome.storage.local.set({ settings: s });

      if (radio.value === "sidepanel") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) chrome.sidePanel.open({ tabId: tabs[0].id });
        });
      }
    });
  });
});

// ── Init ───────────────────────────────────────────────────────────────────────

chrome.storage.local.get("scans", (data) => renderScans(data.scans || []));
loadSettings();

// Live update when storage changes (e.g. new scan comes in while popup is open)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.scans) renderScans(changes.scans.newValue || []);
});
