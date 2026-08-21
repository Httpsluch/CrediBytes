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
  // `labelKey` rather than a literal: the module loads once, but the language can
  // change while the popup is open, so the text has to be resolved at render.
  legitimate: { cls: "legitimate", mark: "✓", labelKey: "ui.tierVerified" },
  likely:     { cls: "likely",     mark: "?", labelKey: "ui.tierLikely" },
  namematch:  { cls: "namematch",  mark: "≈", labelKey: "ui.tierNamematch" },
  danger:     { cls: "danger",     mark: "!", labelKey: "ui.tierDanger" },
  unverified: { cls: "unverified", mark: "⚠", labelKey: "ui.tierUnverified" },
  revoked:    { cls: "revoked",    mark: "⊘", labelKey: "ui.tierRevoked" },
};

// One shape, derived from TIERS. This literal was written out four separate
// times, and one of them is incremented per scan (`counts[tierOf(s)]++`) — so a
// tier missing from the literal did not read as zero, it read as NaN and blanked
// the tile. Deriving it means a new verdict state cannot be half-added again.
const EMPTY_TOTALS = Object.fromEntries(Object.keys(TIERS).map(k => [k, 0]));

// Records saved before `tier` existed have to be re-derived.
function tierOf(scan) {
  if (scan.tier && TIERS[scan.tier]) return scan.tier;
  if (scan.legitimacy === "revoked")           return "revoked";
  if (scan.legitimacy === "legitimate")        return "legitimate";
  if (scan.legitimacy === "likely_legitimate") return "likely";
  if (scan.legitimacy === "name_match_only")   return "namematch";
  if (scan.status === "no_reference_match" && scan.isStoreUrl) return "danger";
  return "unverified";
}

// Which tiers each tile filters to. Additive OR; clicking the active tile clears.
// The third tile covers both red states. They are distinct verdicts and the
// cards keep them apart, but as a filter they answer the same user question —
// "what here should I not act on" — and the mockup has three tiles, so adding a
// fourth for a state most sessions never see would cost more than it explains.
const FILTER_TIERS = {
  verified:     ["legitimate"],
  unverified:   ["unverified", "likely", "namematch"],
  unregistered: ["danger", "revoked"],
};

// Rendered in batches as the feed is scrolled rather than capped. The old fixed
// RENDER_LIMIT existed because drawing every stored row at once stutters during
// active scanning; batching solves that without hiding anything.
// Drawn in the round/triangle badge on the right of each card.
const VERDICT_MARK = { verified: "✓", unverified: "?", flagged: "!" };

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
  // Matches FILTER_TIERS.unregistered — the tile and its filter must agree, or
  // clicking a "3" produces four rows.
  document.getElementById("count-danger").textContent     = (t.danger || 0) + (t.revoked || 0);
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
  if (s < 5)     return T("time.justNow");
  if (s < 60)    return T("time.sec",  { n: s });
  if (s < 3600)  return T("time.min",  { n: Math.floor(s / 60) });
  if (s < 86400) return T("time.hour", { n: Math.floor(s / 3600) });
  return T("time.day", { n: Math.floor(s / 86400) });
}

// The Stage 1 profile gauge lived here. Removed with the card redesign: a
// percentage beside a verdict reads as the verdict's confidence, which it never
// was. Stage 1 still runs and is still recorded in each scan — it is simply no
// longer drawn as though it decided anything.

// ── Expanded analysis (Options A and B) ───────────────────────────────────────

function buildDetail(scan) {
  const V = window.CrediBytesVerdictView;
  const view = V.present(scan, I18N ? I18N.getLang() : "en");
  const d = el("div", "scan-detail");

  // ── HOW THIS WAS CHECKED ──────────────────────────────────────────────────
  // Three fixed rows, always the same three questions: where does the link go,
  // is the app declared, does the name match. The variable-length evidence trail
  // this replaces was accurate but assumed the reader knew what a package id
  // was — Panel 1 asked how a digitally or financially illiterate user would be
  // informed, and a constant shape is learnable in a way a variable one is not.
  d.appendChild(el("p", "detail-h", T("card.howChecked")));
  const ul = el("ul", "check-list");
  for (const line of view.checks) ul.appendChild(el("li", "check-item", line));
  d.appendChild(ul);

  // ── WHAT THIS MEANS ───────────────────────────────────────────────────────
  d.appendChild(el("p", "detail-h", T("card.whatMeans")));
  d.appendChild(el("div", "detail-body", view.means));

  // ── RECOMMENDED ACTION ────────────────────────────────────────────────────
  d.appendChild(el("p", "detail-h", T("card.action")));
  d.appendChild(el("div", "detail-body", view.action));

  // ── SEC REGISTRATION ──────────────────────────────────────────────────────
  // The registrant's real declared channels, so a user can compare the ad in
  // front of them against where the genuine article lives. This is the whole
  // point of naming a registrant at all, and it belongs on both surfaces — the
  // inline badge has always carried it.
  //
  // Shown for a possible match too, under its own heading. It was briefly
  // withheld there on the reasoning that a SEC number beside an unconfirmed
  // match makes a guess look like a finding; the heading carries that instead,
  // and a user comparing an ad against the real channels is exactly who needs
  // them most.
  const named = scan.company || scan.sec || scan.officialUrl;
  const confirmed = view.tier === "legitimate" || view.tier === "revoked";
  const sugg = (!scan.company && scan.suggestion) ? scan.suggestion : null;

  if (named || sugg) {
    d.appendChild(el("p", "detail-h",
      T(confirmed ? "sec.secRegistration" : "sec.possibleMatch")));
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
    put(T("row.secNo"), sugg ? sugg.sec : scan.sec);
    put(T("row.registrant"), sugg ? sugg.company : scan.company);
    put(T("row.officialSite"), sugg ? sugg.websiteUrl : scan.officialUrl, true);
    if (dl.childElementCount) d.appendChild(dl);
  }

  // ── SEC revoked list ──────────────────────────────────────────────────────
  // Kept verbatim from before: the two paths must stay distinguishable, because
  // one reports a fact about this ad and the other a coincidence of names.
  if (scan.revoked) {
    const rv = scan.revoked;
    d.appendChild(el("p", "detail-h",
      T(rv.verdict ? "sec.revokedList" : "sec.revokedNameOnly")));
    const dl = el("dl", "kv");
    if (rv.n) { dl.appendChild(el("dt", null, T("row.listedAs"))); dl.appendChild(el("dd", null, rv.n)); }
    if (rv.d) { dl.appendChild(el("dt", null, T("row.date")));      dl.appendChild(el("dd", null, rv.d)); }
    d.appendChild(dl);
    d.appendChild(el("div", "contrib-note",
      T(rv.verdict ? "note.revokedVerdict" : "note.revokedAdvisory")));
  }

  // ── Stage 3, on request ───────────────────────────────────────────────────
  // Only for store links, and only when the user asks. Fetching a store listing
  // for every ad scrolled past would mean hundreds of requests per session,
  // which Google rate-limits, and would have the browser silently contacting
  // Google about every app a user sees. One deliberate click removes both
  // problems, and makes a failed read visible instead of silent.
  if (scan.isStoreUrl && scan.destUrl) {
    const wrap = el("div", "listing-check");
    const btn = el("button", "listing-btn", T("btn.checkListing"));
    btn.type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();                       // never toggle the card
      btn.disabled = true;
      btn.textContent = T("btn.checking");

      const go = () => chrome.runtime.sendMessage(
        { type: "CHECK_LISTING", url: scan.destUrl, advertiserName: scan.advertiserName || scan.company || "" },
        (res) => {
          btn.remove();
          wrap.appendChild(res && res.ok ? buildListing(res.listing)
                                         : el("div", "listing-fail", T("btn.failed")));
        });

      // Store access is an OPTIONAL permission, requested here rather than held
      // from install. The extension has no business reaching play.google.com
      // until a user asks it to read a specific listing, and Chrome shows the
      // prompt at the moment the reason for it is on screen. Declining leaves
      // everything else working.
      // apps.apple.com is separate from itunes.apple.com: the lookup API lives on
      // one host and the store page carrying the privacy policy on the other.
      const origins = ["https://play.google.com/*", "https://itunes.apple.com/*",
                       "https://apps.apple.com/*"];
      if (chrome.permissions && chrome.permissions.request) {
        chrome.permissions.request({ origins }, (granted) => {
          if (granted) return go();
          btn.remove();
          wrap.appendChild(el("div", "listing-fail", T("btn.failed")));
        });
      } else {
        go();
      }
    });
    wrap.appendChild(btn);
    d.appendChild(wrap);
  }

  return d;
}

/** Renders whatever the store actually returned. */
function buildListing(L) {
  const box = el("div", "listing");
  box.appendChild(el("p", "detail-h", T("listing.heading")));
  const ul = el("ul", "check-list");
  const add = (key, value) => { if (value != null && value !== "") ul.appendChild(el("li", "check-item", T(key, { value }))); };
  add("listing.developer", L.developer);
  // Three separate rows. Apple publishes no install count, so that row simply
  // does not appear there rather than reading zero.
  add("listing.installs", L.installs);
  add("listing.ratings", L.ratings);
  add("listing.stars", L.stars);
  add("listing.updated", L.updated);
  // Omitted entirely when unknown. Printing "none listed" for a store whose API
  // does not expose the field states something false about the app.
  if (L.privacy !== null && L.privacy !== undefined) {
    add("listing.privacy", T(L.privacyFree ? "listing.privacyFree"
                              : L.privacy ? "listing.privacyOk" : "listing.privacyNone"));
  }
  box.appendChild(ul);
  if (typeof L.pct === "number") {
    box.appendChild(el("div", "detail-body", T("listing.verdict", { pct: L.pct })));
  }
  box.appendChild(el("div", "contrib-note", T("listing.note")));
  // Only when the developer actually declared something. null means the
  // declaration could not be read, and an empty section would read as "this app
  // collects nothing" — the opposite of the truth.
  if (L.dataSafety) box.appendChild(buildDataSafety(L.dataSafety));
  return box;
}

/**
 * The developer's own Data safety declaration, quoted rather than judged.
 *
 * Every line here is a statement the developer made to Google. The extension
 * adds no inference: it does not say collecting contacts is illegitimate, only
 * that the developer declared it. Whether that breaches NPC guidance is the
 * regulator's call, and the wording keeps it that way — the same discipline the
 * revoked-list advisory uses (section 2.15).
 */
function buildDataSafety(DS) {
  const box = el("div", "datasafety");
  box.appendChild(el("p", "detail-h", T("ds.heading")));

  if (DS.sensitive && DS.sensitive.length) {
    box.appendChild(el("div", "ds-flag",
      T("ds.sensitive", { list: DS.sensitive.join(", ") })));
  }

  const ul = el("ul", "check-list");
  const line = (e) => el("li", "check-item",
    e.detail ? `${e.category} — ${e.detail}` : e.category);
  if (DS.collected.length) {
    // Apple names its primary bucket "Data Linked to You"; Play just says
    // collected. Using each store's own wording keeps this a quotation.
    ul.appendChild(el("li", "check-sub",
      T(DS.store === "apple" ? "ds.linked" : "ds.collected")));
    for (const e of DS.collected) ul.appendChild(line(e));
  } else if (!(DS.notLinked && DS.notLinked.length)) {
    ul.appendChild(el("li", "check-item", T("ds.noneCollected")));
  }
  if (DS.notLinked && DS.notLinked.length) {
    ul.appendChild(el("li", "check-sub", T("ds.notLinked")));
    for (const e of DS.notLinked) ul.appendChild(line(e));
  }
  if (DS.shared.length) {
    ul.appendChild(el("li", "check-sub", T("ds.shared")));
    for (const e of DS.shared) ul.appendChild(line(e));
  }
  // Apple only. "Used to track you across apps owned by other companies" is a
  // stronger statement than "collected" and has no Play equivalent, so it is
  // reported separately rather than folded into the list above.
  if (DS.tracking && DS.tracking.length) {
    ul.appendChild(el("li", "check-sub", T("ds.tracking")));
    for (const e of DS.tracking) ul.appendChild(line(e));
  }
  box.appendChild(ul);

  const sec = [];
  if (DS.encrypted) sec.push(T("ds.encrypted"));
  if (DS.deletable) sec.push(T("ds.deletable"));
  if (sec.length) box.appendChild(el("div", "detail-body", sec.join(" · ")));

  box.appendChild(el("div", "contrib-note",
    T("ds.note", { store: T(DS.store === "apple" ? "ds.storeApple" : "ds.storePlay") })));
  return box;
}

function buildCard(scan) {
  const V = window.CrediBytesVerdictView;
  const view = V.present(scan, I18N ? I18N.getLang() : "en");
  const tier = view.tier;

  const item = el("div", `scan-item ${TIERS[tier].cls} ${view.cls}`);
  item.tabIndex = 0;
  item.setAttribute("role", "button");
  item.setAttribute("aria-expanded", "false");

  const head = el("div", "scan-head");
  const main = el("div", "scan-main");

  main.appendChild(el("div", "scan-title",
    scan.advertiserName || scan.company || "Unknown advertiser"));

  // Two labelled lines instead of a prose sentence. The old card led with the
  // matcher's reason, which is precise but assumes the reader knows what a
  // package id is; Panel 1 asked how a digitally or financially illiterate user
  // would be informed. Registration status and company are the two things such
  // a user is actually deciding on.
  const reg = el("div", "scan-line");
  reg.appendChild(el("span", "scan-line-k", view.regLabel));
  reg.appendChild(el("span", "scan-line-v", " " + view.status));
  main.appendChild(reg);

  const co = el("div", "scan-line");
  co.appendChild(el("span", "scan-line-k", view.companyLabel));
  co.appendChild(el("span", "scan-line-v", " " + view.company));
  main.appendChild(co);

  // The one-line instruction, which is what the short card exists to deliver.
  main.appendChild(el("div", "scan-advice", view.action));

  // data-ts lets the ticker below refresh the text in place. Re-rendering the
  // whole feed once a minute would tear down every expanded card the user had
  // open, and costs far more than rewriting a handful of strings.
  const time = el("div", "scan-time", timeAgo(scan.ts));
  time.dataset.ts = String(scan.ts);
  main.appendChild(time);
  head.appendChild(main);

  // Icon plus word. The profile-score gauge that used to sit here was removed:
  // it invited the reading the whole system is built to avoid — a number next to
  // a verdict looks like the verdict's confidence, and it is not. Stage 1 still
  // runs and is still recorded; it is simply no longer shown as though it
  // decided anything.
  const side = el("div", "scan-side");
  // The glyph is a child so the flagged triangle can colour it independently —
  // clip-path fills the shape, so the mark has to invert against it.
  const icon = el("div", "verdict-icon " + view.cls);
  icon.appendChild(el("span", "verdict-glyph", VERDICT_MARK[view.state]));
  side.appendChild(icon);
  side.appendChild(el("span", "verdict-word " + view.cls, view.stateLabel));
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

  count.textContent = T("ui.scans", { n: lastScans.length });

  if (!lastScans.length) {
    empty.style.display = "block";
    document.getElementById("see-all").hidden = true;
    renderTotals(currentTotals, { ...EMPTY_TOTALS });
    return;
  }
  empty.style.display = "none";

  // Tiles report totals since the last clear, so they are never derived from
  // the filtered view — a filtered tile that changed its own number would be
  // reporting on itself.
  const counts = { ...EMPTY_TOTALS };
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

// ── Language ─────────────────────────────────────────────────────────────────
// Same shape as the theme, and mirrored into localStorage for the same reason:
// panel-init.js applies it before first paint, so the popup never renders in
// English and then rewrites itself.
//
// Storing it in `settings` is what makes the choice reach the badges too —
// content.js watches storage.onChanged and rebuilds them.

const I18N = window.CrediBytesI18n;
const T = (key, params) => (I18N ? I18N.t(key, params) : key);
const TE = (entry) => (I18N ? I18N.render(entry) : (entry && entry.text) || "");

/** Replace the text of every [data-i18n] element from the current language. */
function translateStatic() {
  if (!I18N) return;
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = I18N.t(el.dataset.i18n);
  });
}

function applyLang(lang) {
  if (!I18N || !I18N.has(lang)) lang = I18N ? I18N.DEFAULT_LANG : "en";
  I18N && I18N.setLang(lang);
  document.documentElement.lang = lang;
  document.querySelectorAll(".seg-btn[data-lang]").forEach(btn => {
    btn.setAttribute("aria-checked", String(btn.dataset.lang === lang));
  });
  translateStatic();
  // The feed is built from stored key+params, so re-rendering re-translates
  // every card — including scans recorded before the language was changed.
  renderScans(lastScans);
}

function setLang(lang) {
  applyLang(lang);
  try { localStorage.setItem("cb-lang", lang); } catch (_e) { /* private mode */ }
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    s.lang = lang;
    chrome.storage.local.set({ settings: s });
  });
}

document.querySelectorAll(".seg-btn[data-lang]").forEach(btn => {
  btn.addEventListener("click", () => setLang(btn.dataset.lang));
});

// ── Clear ─────────────────────────────────────────────────────────────────────
// Routes through background.js, the single writer, to avoid racing live scans.

function clearScans() {
  chrome.runtime.sendMessage({ type: "CLEAR_SCANS" }, () => {
    currentTotals = { ...EMPTY_TOTALS };
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

// One reading of the stored shape, old or new. Kept in a single place because
// four call sites need it and a disagreement between them would silently put
// the toggle and the page surface out of step.
function normaliseSettings(s) {
  const legacy = s.displayMode;
  const sidePanel = typeof s.sidePanel === "boolean"
    ? s.sidePanel
    : legacy === "sidepanel";
  const displayResult = s.displayResult ||
    (legacy === "floating" ? "floating" : "badge");
  return { sidePanel, displayResult };
}

function loadSettings() {
  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    document.getElementById("toggle-scanning").checked = s.scanningEnabled !== false;
    // Reconcile with what panel-init.js applied from the localStorage mirror;
    // storage wins if the two ever diverge.
    applyTheme(THEMES.includes(s.theme) ? s.theme : "system");
    // Same reconciliation as the theme: panel-init.js already applied the
    // localStorage mirror pre-paint, storage wins if they diverge.
    applyLang(s.lang || (I18N ? I18N.DEFAULT_LANG : "en"));
    // MIGRATION. displayMode used to be a single three-way value
    // (badge | floating | sidepanel), which conflated two independent
    // questions: where CrediBytes' own UI opens, and what appears on the page.
    // "sidepanel" actually meant "badges PLUS the panel", so it was never a
    // peer of the other two.
    //
    // Split into displayMode (panel on/off) and displayResult (badge|floating).
    // An old "sidepanel" therefore becomes panel ON + badge, which is exactly
    // what it did before. Reading it here rather than only at install means a
    // user who never triggers onInstalled still lands somewhere valid.
    const view = normaliseSettings(s);
    const panel = document.getElementById("sidepanel-toggle");
    if (panel) panel.checked = view.sidePanel;
    const radio = document.querySelector(
      `input[name="display-result"][value="${view.displayResult}"]`);
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
  badge:    "Inline badges enabled — reload is not required.",
  floating: "Floating widget enabled — look for it on the page.",
};

function flashStatus(id, text) {
  const el2 = document.getElementById(id);
  if (!el2) return;
  el2.textContent = text;
  clearTimeout(flashStatus["_t_" + id]);
  flashStatus["_t_" + id] = setTimeout(() => { el2.textContent = ""; }, 2600);
}

// ── Display Result: what appears on the Facebook page ────────────────────────
document.querySelectorAll("input[name='display-result']").forEach(radio => {
  radio.addEventListener("change", () => {
    chrome.storage.local.get("settings", (data) => {
      const s = data.settings || {};
      s.displayResult = radio.value;
      // The legacy key is cleared, not left behind: normaliseSettings() falls
      // back to it, so a stale value would keep resurrecting the old choice.
      delete s.displayMode;
      // content.js listens on storage.onChanged, so writing here is what
      // actually switches the on-page surface.
      chrome.storage.local.set({ settings: s }, () => {
        flashStatus("mode-status", MODE_LABELS[radio.value] || "Display updated.");
      });
    });
  });
});

// ── Display Mode: where CrediBytes itself opens ──────────────────────────────
// The toolbar-click behaviour is applied by background.js, which watches this
// setting. Opening/closing the panel here is the immediate feedback for the
// flip itself.
// The active tab, resolved at load so the toggle does not have to look it up.
//
// THIS IS THE WHOLE FIX. sidePanel.open() may only be called while a user
// gesture is still in scope, and a chrome.tabs.query callback is a later task —
// the gesture is gone by the time it runs. So the previous version threw on
// every flip, and because it threw, the window.close() two lines below never
// ran either: the panel did not open AND the popup stayed put, which is exactly
// what the toggle looked like from the outside.
//
// Resolving the tab id in advance lets open() run synchronously inside the
// change handler, where the gesture is still live.
let activeTabId = null;
// Guarded. An unguarded call here throws when chrome.tabs is absent, and a
// module-level throw takes every statement below it with it — including the
// panel-layout fallback, which is how one missing API silently broke the
// popup's sizing as well as its settings.
try {
  chrome.tabs?.query?.({ active: true, currentWindow: true }, (tabs) => {
    activeTabId = tabs && tabs[0] ? tabs[0].id : null;
  });
} catch (_e) { /* no tabs API in this context */ }

document.getElementById("sidepanel-toggle")?.addEventListener("change", (e) => {
  const on = e.target.checked;

  // ORDER IS THE WHOLE FIX, AND IT DIFFERS PER DIRECTION.
  //
  // Both of the interesting calls here DESTROY THE PAGE THAT IS RUNNING THEM:
  // window.close() ends the popup, and setOptions({enabled:false}) tears down
  // the side panel — and the panel is this very page when the toggle is flipped
  // from inside it. chrome.storage.local.set is asynchronous, so doing either
  // one first loses the write.
  //
  // That is why the toggle appeared to "default to on": switching it OFF from
  // inside the panel closed the panel before the write landed, so sidePanel
  // stayed true in storage and the next open read back ON. Nothing reset it —
  // the OFF was simply never saved.
  //
  // So: the gesture-bound call runs first and synchronously, because
  // sidePanel.open() is only valid while the gesture is live. Everything that
  // destroys a page waits for the write to complete.
  if (on && activeTabId != null) {
    // Re-enable before opening: turning the toggle off disables the panel for
    // this tab, and open() on a disabled panel throws.
    try {
      chrome.sidePanel.setOptions({ tabId: activeTabId, path: PANEL_PATH, enabled: true })
        .catch(() => {});
      chrome.sidePanel.open({ tabId: activeTabId });
    } catch (_e) { /* Chrome reports its own refusal */ }
  }

  chrome.storage.local.get("settings", (data) => {
    const s = data.settings || {};
    s.sidePanel = on;
    delete s.displayMode;
    chrome.storage.local.set({ settings: s }, () => {
      flashStatus("panel-status", T(on ? "ui.panelOn" : "ui.panelOff"));

      if (activeTabId == null) return;
      if (on) {
        // Popup and panel side by side are redundant. Guarded: when this page
        // IS the panel, closing would shut what was just chosen.
        if (!runningAsSidePanel) setTimeout(() => window.close(), 150);
      } else {
        // Safe only now. This closes the panel, and the panel may be this page.
        chrome.sidePanel.setOptions({ tabId: activeTabId, enabled: false }).catch(() => {});
      }
    });
  });
});

// Self-heal. If this popup is open at all while the side-panel setting is ON,
// the toolbar behaviour is stale — the click should have opened the panel. That
// happens if a setPopup call was lost, or the worker restarted mid-write.
// Re-applying costs nothing and fixes the NEXT click rather than hijacking this
// one, which would yank the window out from under the user.
try {
  chrome.storage.local.get("settings", (data) => {
    if (normaliseSettings(data.settings || {}).sidePanel && !runningAsSidePanel) {
      chrome.runtime.sendMessage({ type: "SYNC_ACTION_BEHAVIOUR" },
        () => void chrome.runtime.lastError);
    }
  });
} catch (_e) { /* no runtime in this context */ }

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

// The header's "->" button is gone. It duplicated the Side Panel toggle in
// Settings, and two controls for one preference can disagree — the button
// opened the panel without recording that the user wanted it, so the next
// toolbar click went back to the popup.
const runningAsSidePanel = document.documentElement.classList.contains("is-sidepanel");

// ── Report a bug ──────────────────────────────────────────────────────────────
//
// Opens a Google Form in a new tab with the diagnostic fields already filled.
// Replace BUG_FORM with the "Get pre-filled link" URL from the form, keeping
// the entry.N ids below in step with it — nothing else needs to change.
//
// WHAT IS DEPARTS FROM THIS MACHINE, AND WHAT IS NOT
// Version, browser, OS, the two display settings and a scan count. NOT the
// current tab's URL and NOT any advertiser name: an Ad Library URL carries the
// user's search terms and a feed URL identifies their session, so sending
// either would put their browsing into a third-party form to debug a badge.
// Nothing here identifies a person or a page they looked at.
const BUG_FORM = {
  url: "https://docs.google.com/forms/d/e/FORM_ID_HERE/viewform",
  fields: {
    version:  "entry.100000001",
    browser:  "entry.100000002",
    platform: "entry.100000003",
    display:  "entry.100000004",
    scans:    "entry.100000005",
  },
};

function bugReportUrl(info) {
  const u = new URL(BUG_FORM.url);
  u.searchParams.set("usp", "pp_url");
  for (const [k, entry] of Object.entries(BUG_FORM.fields)) {
    if (info[k] != null && info[k] !== "") u.searchParams.set(entry, String(info[k]));
  }
  return u.toString();
}

document.getElementById("report-bug-btn")?.addEventListener("click", () => {
  chrome.storage.local.get(["settings", "totals", "scans"], (data) => {
    const s = data.settings || {};
    const view = normaliseSettings(s);
    let version = "";
    try { version = chrome.runtime.getManifest().version; } catch (_e) {}
    // The UA string names the browser and OS and nothing about the user.
    const ua = navigator.userAgent || "";
    const chromeVer = (/Chrome\/([\d.]+)/.exec(ua) || [, "unknown"])[1];
    const info = {
      version,
      browser: `Chrome ${chromeVer}`,
      platform: navigator.platform || "unknown",
      display: `${view.sidePanel ? "side panel" : "popup"} / ${view.displayResult}` +
               `${s.scanningEnabled === false ? " / scanning off" : ""}` +
               ` / ${s.lang || "en"}`,
      scans: String((data.scans || []).length),
    };
    if (BUG_FORM.url.includes("FORM_ID_HERE")) {
      // Its own status line. This pointed at lang-status, an id that does not
      // exist, so the one case that needs feedback — no form configured yet —
      // failed silently and the button looked broken.
      flashStatus("bug-status", T("ui.reportBugUnset"));
      return;
    }
    chrome.tabs.create({ url: bugReportUrl(info) });
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
    renderTotals(currentTotals, { ...EMPTY_TOTALS });
  }
});
