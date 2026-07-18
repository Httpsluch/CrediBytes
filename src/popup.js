/**
 * popup.js — CrediBytes
 * Handles scan list rendering, clear button, settings tab, and display mode.
 */

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function getBadgeClass(scan) {
  if (scan.legitimacy === "legitimate")       return "legitimate";
  if (scan.legitimacy === "likely_legitimate") return "likely";
  if (scan.legitimacy === "unverified" &&
      (scan.status === "no_reference_match") &&
      scan.storeUrl) return "danger";
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
    document.getElementById("count-legit").textContent     = "0";
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

    // Top row: badge + time
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

    // Advertiser name — use actual page name, fall back to SEC company
    const name = document.createElement("div");
    name.className = "scan-name";
    name.textContent = scan.advertiserName || scan.company || "—";

    // Reason
    const reason = document.createElement("div");
    reason.className = "scan-reason";
    reason.textContent = scan.reason || "";

    item.appendChild(top);
    item.appendChild(name);
    item.appendChild(reason);

    // SEC number and ML — only if present
    if (scan.sec || scan.isApp !== null) {
      const meta = document.createElement("div");
      meta.className = "scan-meta";
      const parts = [];
      if (scan.sec) parts.push(`SEC: ${scan.sec}`);
      if (scan.isApp !== null) {
        parts.push(`ML: ${scan.isApp ? "App" : "No app"} (${Math.round((scan.prob || 0) * 100)}%)`);
      }
      meta.textContent = parts.join("  ·  ");
      item.appendChild(meta);
    }

    feed.appendChild(item);
  });

  document.getElementById("count-legit").textContent      = legit;
  document.getElementById("count-unverified").textContent  = unverified;
  document.getElementById("count-danger").textContent      = danger;
}

// ── Clear scans ────────────────────────────────────────────────────────────────
// Fix: send CLEAR_SCANS message to background.js, then re-render immediately.
// Previously, renderScans([]) ran before storage was actually cleared,
// causing the UI to re-populate on the next storage.onChanged event.

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

      // If switching to side panel, open it immediately
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
