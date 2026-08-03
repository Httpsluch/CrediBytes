/**
 * popup.js — CrediBytes popup / side panel
 *
 * Renders the scan feed, the stat tiles, and Settings. The same file serves
 * both surfaces; panel-init.js marks which one via ?panel=1.
 *
 * No innerHTML anywhere. Advertiser names come from Facebook and are untrusted,
 * so every node is built with createElement + textContent.
 */

// ── Verdict presentation ──────────────────────────────────────────────────────
// Mirrors verdictOf() in content.js. Kept as data rather than an if/else chain
// so the badge, the tiles and the cards cannot drift apart again.

const TIERS = {
  legitimate: { cls: "legitimate", mark: "✓", label: "Verified" },
  likely:     { cls: "likely",     mark: "?", label: "Likely" },
  namematch:  { cls: "namematch",  mark: "≈", label: "Name only" },
  danger:     { cls: "danger",     mark: "!", label: "Unregistered" },
  unverified: { cls: "unverified", mark: "⚠", label: "Unverified" },
};

// Records saved before `tier` existed have to be re-derived.
function tierOf(scan) {
  if (scan.tier && TIERS[scan.tier]) return scan.tier;
  if (scan.legitimacy === "legitimate")        return "legitimate";
  if (scan.legitimacy === "likely_legitimate") return "likely";
  if (scan.legitimacy === "name_match_only")   return "namematch";
  if (scan.status === "no_reference_match" && scan.isStoreUrl) return "danger";
  return "unverified";
}

// Which tiers each tile filters to. Additive OR; clicking the active tile clears.
const FILTER_TIERS = {
  verified:     ["legitimate"],
  unverified:   ["unverified", "likely", "namematch"],
  unregistered: ["danger"],
};

// Rendered in batches as the feed is scrolled rather than capped. The old fixed
// RENDER_LIMIT existed because drawing every stored row at once stutters during
// active scanning; batching solves that without hiding anything.
const BATCH = 40;

let activeFilter  = null;
let lastScans     = [];
let currentTotals = null;
let rendered      = 0;      // how many of the filtered list are in the DOM
let filtered      = [];
let io            = null;   // IntersectionObserver driving the next batch

// ── Tiles ─────────────────────────────────────────────────────────────────────

function renderTotals(totals, fallback) {
  const t = totals || fallback;
  // Unverified, Likely and Name-only share a tile; they are all "not confirmed".
  const unver = (t.unverified || 0) + (t.likely || 0) + (t.namematch || 0);
  document.getElementById("count-legit").textContent      = t.legitimate || 0;
  document.getElementById("count-unverified").textContent = unver;
  document.getElementById("count-danger").textContent     = t.danger || 0;
}

function syncFilterButtons() {
  document.querySelectorAll(".stat[data-filter]").forEach(btn => {
    btn.setAttribute("aria-pressed", String(btn.dataset.filter === activeFilter));
  });
}

function setFilter(name) {
  activeFilter = activeFilter === name ? null : name;   // click again to clear
  syncFilterButtons();
  renderScans(lastScans);
}

document.querySelectorAll(".stat[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => setFilter(btn.dataset.filter));
});

document.getElementById("see-all").addEventListener("click", () => {
  activeFilter = null;
  syncFilterButtons();
  renderScans(lastScans);
  document.getElementById("feed").scrollTo({ top: 0, behavior: "smooth" });
});

// ── Small builders ────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Second-level for the first minute. Collapsing that to a flat "just now" makes
// the live ticker pointless — a panel left open during a scan should visibly
// show time passing, which is the whole reason it updates.
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5)     return "just now";
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Circular progress ring for the Stage 1 profile score.
 *
 * The ring is coloured by VERDICT, not by score. Colouring it by score would
 * put a green ring on an unregistered app that happens to score well, which is
 * exactly the confusion this redesign is meant to remove — Stage 2 decides,
 * Stage 1 only describes.
 */
function buildGauge(pct, tierCls) {
  const wrap = el("div", "gauge");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "54"); svg.setAttribute("height", "54");
  svg.setAttribute("viewBox", "0 0 54 54");

  const R = 23, C = 2 * Math.PI * R;
  for (const kind of ["gauge-track", "gauge-fill"]) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", "27"); c.setAttribute("cy", "27"); c.setAttribute("r", String(R));
    c.setAttribute("fill", "none"); c.setAttribute("stroke-width", "5");
    c.setAttribute("class", kind);
    if (kind === "gauge-fill") {
      c.setAttribute("stroke", `var(--v-${tierCls})`);
      c.setAttribute("stroke-dasharray", String(C));
      c.setAttribute("stroke-dashoffset", String(C * (1 - Math.max(0, Math.min(100, pct)) / 100)));
    }
    svg.appendChild(c);
  }
  wrap.appendChild(svg);
  wrap.appendChild(el("div", "gauge-num", String(pct)));
  return wrap;
}

// ── Expanded analysis (Options A and B) ───────────────────────────────────────

function buildDetail(scan) {
  const d = el("div", "scan-detail");

  // A — what was actually checked, in order.
  if (Array.isArray(scan.evidence) && scan.evidence.length) {
    d.appendChild(el("p", "detail-h", "How this was checked"));
    const ul = el("ul", "ev-list");
    for (const e of scan.evidence) {
      const li = el("li", `ev-item ev-${e.state || "info"}`);
      li.appendChild(el("span", "ev-icon",
        e.state === "pass" ? "✓" : e.state === "fail" ? "✕" : "•"));
      li.appendChild(el("span", null, e.text));
      ul.appendChild(li);
    }
    d.appendChild(ul);
  } else if (scan.reason) {
    d.appendChild(el("p", "detail-h", "Result"));
    d.appendChild(el("div", "contrib-note", scan.reason));
  }

  // The registrant this ad resolved to, if any.
  if (scan.company || scan.sec || scan.officialUrl) {
    d.appendChild(el("p", "detail-h", "SEC registrant"));
    const dl = el("dl", "kv");
    const put = (k, v, link) => {
      if (!v) return;
      dl.appendChild(el("dt", null, k));
      const dd = el("dd");
      if (link) {
        const a = document.createElement("a");
        a.href = v; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = v;
        dd.appendChild(a);
      } else dd.textContent = v;
      dl.appendChild(dd);
    };
    put("Company", scan.company);
    put("SEC No.", scan.sec);
    put("Official site", scan.officialUrl, true);
    d.appendChild(dl);
  }

  // A fuzzy name suggestion is NEVER a verification — labelled as such.
  if (!scan.sec && scan.suggestion && scan.suggestion.company) {
    d.appendChild(el("p", "detail-h", "Closest registry entry — not a match"));
    const dl = el("dl", "kv");
    dl.appendChild(el("dt", null, "Company"));
    dl.appendChild(el("dd", null, scan.suggestion.company));
    if (scan.suggestion.sec) {
      dl.appendChild(el("dt", null, "SEC No."));
      dl.appendChild(el("dd", null, scan.suggestion.sec));
    }
    d.appendChild(dl);
  }

  // B — why the profile score is what it is.
  if (scan.prob != null) {
    d.appendChild(el("p", "detail-h", "Profile signal — supplementary"));
    if (Array.isArray(scan.contributions) && scan.contributions.length) {
      const box = el("div", "contrib");
      for (const c of scan.contributions.slice(0, 4)) {
        const row = el("div", `contrib-row ${c.points >= 0 ? "contrib-pos" : "contrib-neg"}`);
        row.appendChild(el("span", "contrib-pts", `${c.points > 0 ? "+" : ""}${c.points}`));
        row.appendChild(el("span", "contrib-label", c.label));
        box.appendChild(row);
      }
      d.appendChild(box);
    }
    d.appendChild(el("div", "contrib-note",
      "Points show how far each signal moves the score against a typical " +
      "registrant. This score describes the advertiser's name profile only — " +
      "it never decides the verdict above."));
  }

  return d;
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function buildCard(scan) {
  const tier = tierOf(scan);
  const T = TIERS[tier];

  const item = el("div", `scan-item ${T.cls}`);
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-expanded", "false");

  const head = el("div", "scan-head");
  const main = el("div", "scan-main");

  main.appendChild(el("div", "scan-title", scan.advertiserName || scan.company || "Unknown advertiser"));
  if (scan.reason) main.appendChild(el("div", "scan-reason", scan.reason));

  if (!scan.sec && scan.suggestion && scan.suggestion.company) {
    main.appendChild(el("div", "scan-hint",
      `Possible match (unverified): ${scan.suggestion.company}` +
      (scan.suggestion.sec ? ` · SEC ${scan.suggestion.sec}` : "")));
  }
  // data-ts lets the ticker below refresh the text in place. Re-rendering the
  // whole feed once a minute would tear down every expanded card the user had
  // open, and costs far more than rewriting a handful of strings.
  const time = el("div", "scan-time", timeAgo(scan.ts));
  time.dataset.ts = String(scan.ts);
  main.appendChild(time);
  head.appendChild(main);

  // Gauge when a profile score exists, verdict mark when it does not.
  const side = el("div", "scan-side");
  if (scan.prob != null) {
    side.appendChild(buildGauge(Math.round(scan.prob * 100), T.cls));
    side.appendChild(el("span", "gauge-cap", "Profile"));
  } else {
    side.appendChild(el("div", "scan-mark", T.mark));
    side.appendChild(el("span", "scan-mark-label", T.label));
  }
  head.appendChild(side);
  item.appendChild(head);

  let open = null;
  const toggle = () => {
    if (open) { open.remove(); open = null; item.setAttribute("aria-expanded", "false"); return; }
    open = buildDetail(scan);
    item.appendChild(open);
    item.setAttribute("aria-expanded", "true");
  };
  item.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;      // let registrant links through
    toggle();
  });
  item.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  return item;
}

// ── Feed ──────────────────────────────────────────────────────────────────────

function renderBatch() {
  const feed = document.getElementById("feed");
  feed.querySelector(".feed-sentinel")?.remove();

  const slice = filtered.slice(rendered, rendered + BATCH);
  for (const scan of slice) feed.appendChild(buildCard(scan));
  rendered += slice.length;

  if (rendered < filtered.length) {
    const sentinel = el("div", "feed-sentinel");
    feed.appendChild(sentinel);
    io?.observe(sentinel);
  }
}

function renderScans(scans) {
  const feed  = document.getElementById("feed");
  const empty = document.getElementById("empty-state");
  const count = document.getElementById("scan-count");

  lastScans = scans || [];
  io?.disconnect();
  io = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) renderBatch();
  }, { root: feed, rootMargin: "200px" });

  feed.querySelectorAll(".scan-item, .filter-empty, .feed-sentinel").forEach(n => n.remove());

  count.textContent = `${lastScans.length} scan${lastScans.length === 1 ? "" : "s"}`;

  if (!lastScans.length) {
    empty.style.display = "block";
    document.getElementById("see-all").hidden = true;
    renderTotals(currentTotals, { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0 });
    return;
  }
  empty.style.display = "none";

  // Tiles report totals since the last clear, so they are never derived from
  // the filtered view — a filtered tile that changed its own number would be
  // reporting on itself.
  const counts = { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0 };
  for (const s of lastScans) counts[tierOf(s)]++;
  renderTotals(currentTotals, counts);

  filtered = activeFilter
    ? lastScans.filter(s => FILTER_TIERS[activeFilter].includes(tierOf(s)))
    : lastScans.slice();
  rendered = 0;

  if (!filtered.length) {
    feed.appendChild(el("div", "filter-empty",
      `No ${activeFilter} results among the last ${lastScans.length} scans.`));
  } else {
    renderBatch();
  }

  document.getElementById("see-all").hidden = !activeFilter;
}

// ── Live timestamps ───────────────────────────────────────────────────────────
// "4m ago" going stale while the panel sits open looks broken. Only the text
// nodes are touched, so nothing re-renders and open cards stay open.

function tickTimestamps() {
  document.querySelectorAll(".scan-time[data-ts]").forEach(node => {
    const ts = Number(node.dataset.ts);
    if (!Number.isNaN(ts)) node.textContent = timeAgo(ts);
  });
}
// Once a second, and only the text of already-rendered rows — the feed renders
// in batches, so this touches a few dozen nodes at most.
setInterval(tickTimestamps, 1000);

// ── Theme ─────────────────────────────────────────────────────────────────────
// light / dark / system. chrome.storage is the source of truth so the choice is
// shared between popup and panel; it is mirrored into localStorage because
// panel-init.js runs before first paint and can only read something synchronous.

const THEMES = ["light", "dark", "system"];

function applyTheme(theme) {
  const root = document.documentElement;
  // "system" removes the override and lets prefers-color-scheme decide, rather
  // than hard-coding whichever palette happens to be current.
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");

  document.querySelectorAll(".seg-btn[data-theme]").forEach(btn => {
    btn.setAttribute("aria-checked", String(btn.dataset.theme === theme));
  });
}

function setTheme(theme) {
  if (!THEMES.includes(theme)) theme = "system";
  applyTheme(theme);
  try { localStorage.setItem("cb-theme", theme); } catch (_e) { /* private mode */ }
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    s.theme = theme;
    chrome.storage.local.set({ settings: s });
  });
}

document.querySelectorAll(".seg-btn[data-theme]").forEach(btn => {
  btn.addEventListener("click", () => setTheme(btn.dataset.theme));
});

// ── Clear ─────────────────────────────────────────────────────────────────────
// Routes through background.js, the single writer, to avoid racing live scans.

function clearScans() {
  chrome.runtime.sendMessage({ type: "CLEAR_SCANS" }, () => {
    currentTotals = { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0 };
    renderScans([]);
  });
}
document.getElementById("clear-btn-settings")?.addEventListener("click", clearScans);

// ── Tabs ──────────────────────────────────────────────────────────────────────

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

// ── Settings ──────────────────────────────────────────────────────────────────

function loadSettings() {
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    document.getElementById("toggle-scanning").checked = s.scanningEnabled !== false;
    // Reconcile with what panel-init.js applied from the localStorage mirror;
    // storage wins if the two ever diverge.
    applyTheme(THEMES.includes(s.theme) ? s.theme : "system");
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
// default_path, loading the panel with popup sizing and dead space below.
const PANEL_PATH = "src/popup.html?panel=1";

const MODE_LABELS = {
  badge:     "Inline badges enabled — reload is not required.",
  floating:  "Floating widget enabled — look for it on the page.",
  sidepanel: "Side panel enabled — badges also stay on ads.",
};

function flashStatus(text) {
  const el2 = document.getElementById("mode-status");
  if (!el2) return;
  el2.textContent = text;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => { el2.textContent = ""; }, 2600);
}

document.querySelectorAll("input[name='display-mode']").forEach(radio => {
  radio.addEventListener("change", () => {
    chrome.storage.local.get("settings", (data) => {
      const s = data.settings || {};
      s.displayMode = radio.value;

      // content.js listens on storage.onChanged, so writing here is what
      // actually switches the on-page surface.
      chrome.storage.local.set({ settings: s }, () => {
        flashStatus(MODE_LABELS[radio.value] || "Display mode updated.");
      });

      // Dismiss the popup after a choice: every mode's result is on the page or
      // in the panel, so a 360px card left open just covers it. Guarded, because
      // when this page IS the panel, closing would shut what was just chosen.
      if (!runningAsSidePanel) {
        setTimeout(() => window.close(), radio.value === "sidepanel" ? 250 : 900);
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab) return;
        if (radio.value === "sidepanel") {
          // Re-enable first: switching away disables the panel for this tab, and
          // open() on a disabled panel throws.
          chrome.sidePanel.setOptions({ tabId: tab.id, path: PANEL_PATH, enabled: true }).catch(() => {});
          // Must stay in the user-gesture call stack, so not nested in storage.
          chrome.sidePanel.open({ tabId: tab.id });
        } else {
          chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false }).catch(() => {});
        }
      });
    });
  });
});

// ── Side panel ────────────────────────────────────────────────────────────────
// Safety net for a panel opened without ?panel=1 — Chrome persists sidePanel
// options per tab, so a path stored by an older build can outlive the fix.
// Secondary to the query parameter, never primary: the popup is capped at 600px
// tall, so a viewport meaningfully taller than that can only be the panel.
function ensurePanelClassFallback() {
  const html = document.documentElement;
  if (html.classList.contains("is-sidepanel")) return;
  if (window.innerHeight > 620) html.classList.add("is-sidepanel");
}
ensurePanelClassFallback();
window.addEventListener("resize", ensurePanelClassFallback);

const runningAsSidePanel = document.documentElement.classList.contains("is-sidepanel");
if (runningAsSidePanel) document.getElementById("expand-btn")?.remove();

document.getElementById("expand-btn")?.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.sidePanel.setOptions({ tabId: tabs[0].id, path: PANEL_PATH, enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId: tabs[0].id });
    window.close();   // popup and panel side by side would be redundant
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

try {
  const v = chrome.runtime.getManifest().version;
  document.getElementById("app-version").textContent = `CrediBytes v${v}`;
} catch (_e) { /* leave the static text */ }

chrome.storage.local.get(["scans", "totals"], (data) => {
  currentTotals = data.totals || null;
  renderScans(data.scans || []);
});
loadSettings();

chrome.storage.onChanged.addListener((changes) => {
  // totals and scans are written together, so read totals first — otherwise the
  // tiles lag the feed by one scan.
  if (changes.totals) currentTotals = changes.totals.newValue || null;
  if (changes.scans)  renderScans(changes.scans.newValue || []);
  else if (changes.totals) {
    renderTotals(currentTotals, { legitimate: 0, likely: 0, namematch: 0, unverified: 0, danger: 0 });
  }
});
