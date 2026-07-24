/**
 * content.js — CrediBytes
 * Detects OLA ads on Facebook, runs SEC matching, injects badges/floating widget.
 *
 * v1.1 changes:
 *   - isOLAAd() now accepts advertiserName as 3rd arg; catches "message us"
 *     style ads where the page name itself signals a lending entity
 *   - Unified OLA_KEYWORDS list (removed strong/secondary split — the
 *     advertiserName signal handles false-positive reduction)
 *   - ML badge text reworded to risk_desc from backend (human-readable tier)
 *   - Fuzzy SEC suggestion displayed in badge detail panel when unverified
 *   - SAVE_SCAN payload includes isStoreUrl, riskLabel, riskDesc,
 *     officialUrl, suggestion (fixes popup.js getBadgeClass "danger" tier)
 */

(function () {
  "use strict";

  const BADGE_CLASS = "credibytes-badge";
  const PROCESSED   = "credibytes-processed";

  // ── OLA keyword detection ───────────────────────────────────────────────────
  // Single unified list — advertiserName is now also checked, so the
  // strong/secondary split is no longer needed. Any keyword hit anywhere
  // in adText + landingUrl + advertiserName qualifies the ad for scanning.

  const OLA_KEYWORDS = [
    // Explicit lending phrases
    "online lending", "lending app", "loan app", "cash loan", "personal loan",
    "instant loan", "quick loan", "pautang online", "online pautang",
    "borrow money", "borrow cash", "mag-apply ng loan", "apply for loan",
    "loan approval", "fast approval loan", "no collateral loan",
    "lending corporation", "lending inc", "lending company", "lending corp",
    "financing inc", "financing corp", "finance corp", "finance inc",
    "utang online", "pera agad", "cash agad", "loan agad",
    "ola app", "lending platform",
    // Generic but valid in this context (covered by advertiserName check below)
    "loan", "lending", "borrow", "pautang", "utang",
  ];

  // Store URL hosts — Play/App Store links pointing to apps
  const STORE_HOSTS = ["play.google.com", "apps.apple.com"];

  function isOLAAd(adText, landingUrl, advertiserName = "") {
    const haystack = (adText + " " + landingUrl + " " + advertiserName).toLowerCase();

    // Any keyword match anywhere is sufficient
    if (OLA_KEYWORDS.some(kw => haystack.includes(kw))) return true;

    // Bare store URL with no keyword — probably not an OLA
    return false;
  }

  // ── Ad detection ────────────────────────────────────────────────────────────

  function findAdElements() {
    const candidates = new Set();

    document.querySelectorAll('[aria-label="Sponsored"]').forEach(el => {
      const root = el.closest('[role="article"], [data-pagelet]') || el.parentElement;
      if (root && !root.hasAttribute(PROCESSED)) candidates.add(root);
    });

    document.querySelectorAll("span").forEach(span => {
      if (span.textContent.trim() === "Sponsored") {
        const root = span.closest('[role="article"], [data-pagelet], div[class]');
        if (root && !root.hasAttribute(PROCESSED)) candidates.add(root);
      }
    });

    return [...candidates];
  }

  // ── Advertiser name extraction ───────────────────────────────────────────────
  // Facebook's sponsored post structure has the page name as the first
  // strong link near the top of the article. We try multiple selectors
  // in priority order since Facebook's HTML changes frequently.

  function getAdvertiserName(adEl) {
    const selectors = [
      "h2 a[role='link']",
      "h3 a[role='link']",
      "a[role='link'] > span[dir='auto']",
      "a[href*='facebook.com/'] strong",
      "strong",
    ];

    for (const sel of selectors) {
      const el = adEl.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text && text.length > 1 && text.length < 100 && text !== "Sponsored") {
        return text;
      }
    }
    return "";
  }

  function getAppName(adEl) {
    const el = adEl.querySelector("h3, h4, [data-ad-preview='message']");
    const text = el?.textContent?.trim();
    return text && text !== "Sponsored" ? text.slice(0, 100) : "";
  }

  function unwrapFBRedirect(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "l.facebook.com") {
        const inner = u.searchParams.get("u");
        if (inner) return decodeURIComponent(inner);
      }
      return url;
    } catch { return url; }
  }

  function extractAdData(adEl) {
    const links = [...adEl.querySelectorAll("a[href]")]
      .map(a => a.href)
      .filter(href =>
        href.startsWith("http") &&
        !href.includes("facebook.com/ads/") &&
        !href.includes("l.facebook.com/l.php?u=https%3A%2F%2Fwww.facebook.com")
      );

    return {
      landingUrl:     unwrapFBRedirect(links[0] || ""),
      adText:         adEl.innerText || "",
      claimedAppName: getAppName(adEl),
      advertiserName: getAdvertiserName(adEl),
    };
  }

  // ── Backend call via background.js ──────────────────────────────────────────

  function requestStage1Prediction(advertiserName, appName) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "PREDICT", payload: { companyName: advertiserName, platformName: appName } },
          (response) => {
            if (chrome.runtime.lastError) {
              void chrome.runtime.lastError;
              resolve(null);
              return;
            }
            resolve(response?.prediction ?? null);
          }
        );
      } catch (_err) {
        resolve(null);
      }
    });
  }

  // ── Badge injection (createElement — no innerHTML) ───────────────────────────

  function injectBadge(adEl, matchResult, stage1Result, advertiserName) {
    adEl.querySelector("." + BADGE_CLASS)?.remove();

    const { legitimacy, reason, ref, status, suggestion } = matchResult;
    const store      = window.CrediBytesMatcher.isStoreUrl(matchResult._adUrl || "");
    const riskLabel  = stage1Result?.risk_label  ?? null;
    const riskDesc   = stage1Result?.risk_desc   ?? null;
    const isApp      = stage1Result?.is_app      ?? null;
    const prob       = stage1Result?.probability ?? null;

    let badgeClass, icon, label;
    if (legitimacy === "legitimate") {
      badgeClass = "cb-legitimate"; icon = "✅"; label = "SEC Verified";
    } else if (legitimacy === "likely_legitimate") {
      badgeClass = "cb-likely";     icon = "🔍"; label = "Likely Legitimate";
    } else if (status === "no_reference_match" && store) {
      badgeClass = "cb-danger";     icon = "🚨"; label = "Unregistered App";
    } else {
      badgeClass = "cb-unverified"; icon = "⚠️"; label = "Unverified";
    }

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS + " " + badgeClass;

    const iconSpan = document.createElement("span");
    iconSpan.className = "cb-icon";
    iconSpan.textContent = icon;

    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-label";
    labelSpan.textContent = label;

    const toggle = document.createElement("span");
    toggle.className = "cb-toggle";
    toggle.title = "Details";
    toggle.textContent = "▼";

    const detail = document.createElement("div");
    detail.className = "cb-detail";
    detail.hidden = true;

    const addLine = (text) => {
      const p = document.createElement("p");
      p.textContent = text;
      detail.appendChild(p);
    };

    // Primary verdict reason (Stage 2)
    addLine(reason);

    // SEC registration details (when matched)
    if (ref) {
      addLine("SEC No.: " + ref.sec);
      if (ref.appName) addLine("Registered as: " + ref.appName);
      if (ref.websiteUrl) addLine("Official site: " + ref.websiteUrl);
    }

    // Fuzzy suggestion for unverified ads
    if (!ref && suggestion) {
      addLine("─────────────────────");
      addLine("Possible match (not verified):");
      addLine(suggestion.company);
      addLine("SEC No.: " + suggestion.sec);
      if (suggestion.websiteUrl) addLine("Official site: " + suggestion.websiteUrl);
    }

    // Stage 1 ML risk signal (reworded — human-readable tier from backend)
    if (riskDesc) {
      addLine("─────────────────────");
      addLine(riskDesc);
    } else if (isApp !== null) {
      // Fallback for older backend responses that don't yet return risk_desc
      const pct = Math.round((prob ?? 0) * 100);
      addLine("Profile score: " + pct + "% — " +
        (isApp ? "profile matches patterns of SEC-registered OLA platforms."
               : "profile does not match typical patterns of SEC-registered OLA platforms."));
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? "▼" : "▲";
    });

    badge.appendChild(iconSpan);
    badge.appendChild(labelSpan);
    badge.appendChild(toggle);
    badge.appendChild(detail);
    adEl.insertBefore(badge, adEl.firstChild);

    // ── Save via background.js (single storage writer) ──────────────────────
    // isStoreUrl is included so popup.js getBadgeClass() can apply "danger"
    // correctly without needing to re-derive it from the URL.
    chrome.runtime.sendMessage({
      type: "SAVE_SCAN",
      payload: {
        ts:             Date.now(),
        legitimacy,
        status,
        label,
        reason,
        advertiserName: advertiserName || "",
        company:        ref?.company      || "",
        sec:            ref?.sec          || "",
        officialUrl:    ref?.websiteUrl   || "",
        isStoreUrl:     store,
        isApp,
        prob,
        riskLabel:      riskLabel || null,
        riskDesc:       riskDesc  || null,
        suggestion:     suggestion
          ? { company: suggestion.company, sec: suggestion.sec, websiteUrl: suggestion.websiteUrl || "" }
          : null,
      },
    });
  }

  // ── Floating widget ─────────────────────────────────────────────────────────

  function ensureFloatingWidget() {
    if (document.getElementById("cb-floating")) return;

    const widget = document.createElement("div");
    widget.id = "cb-floating";

    const header = document.createElement("div");
    header.id = "cb-float-header";

    const title = document.createElement("span");
    title.textContent = "🛡 CrediBytes";

    const closeBtn = document.createElement("button");
    closeBtn.id = "cb-float-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => {
      widget.style.display = "none";
      chrome.storage.local.set({ floatingOpen: false });
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement("div");
    content.id = "cb-float-content";
    content.textContent = "Scanning for OLA ads...";

    widget.appendChild(header);
    widget.appendChild(content);
    document.body.appendChild(widget);

    // Drag logic
    let isDragging = false, startX, startY, origLeft, origTop;
    header.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origLeft = widget.offsetLeft;
      origTop  = widget.offsetTop;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      widget.style.left   = (origLeft + e.clientX - startX) + "px";
      widget.style.top    = (origTop  + e.clientY - startY) + "px";
      widget.style.right  = "auto";
      widget.style.bottom = "auto";
    });
    document.addEventListener("mouseup", () => { isDragging = false; });

    updateFloatingContent();
  }

  function updateFloatingContent() {
    const content = document.getElementById("cb-float-content");
    if (!content) return;

    chrome.storage.local.get("scans", (data) => {
      const scans = (data.scans || []).slice(0, 5);
      if (scans.length === 0) {
        content.textContent = "No OLA ads detected yet.";
        return;
      }
      content.textContent = "";
      scans.forEach(scan => {
        const row = document.createElement("div");
        row.className = "cb-float-row cb-float-" + (
          scan.legitimacy === "legitimate"        ? "legit"      :
          scan.legitimacy === "likely_legitimate" ? "likely"     : "unverified"
        );
        const icon = scan.legitimacy === "legitimate"        ? "✅" :
                     scan.legitimacy === "likely_legitimate" ? "🔍" : "⚠️";
        const name = scan.advertiserName || scan.company || "Unknown";
        row.textContent = icon + " " + name;
        content.appendChild(row);
      });
    });
  }

  function injectFloatingStyles() {
    if (document.getElementById("cb-float-styles")) return;
    const s = document.createElement("style");
    s.id = "cb-float-styles";
    s.textContent = `
      #cb-floating {
        position: fixed; bottom: 80px; right: 16px;
        width: 220px; background: #1a1a2e;
        border-radius: 10px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        z-index: 999999; font-family: system-ui, sans-serif;
        color: #fff; overflow: hidden; user-select: none;
      }
      #cb-float-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; font-size: 13px; font-weight: 700;
        cursor: grab; background: #16213e;
      }
      #cb-float-header:active { cursor: grabbing; }
      #cb-float-close {
        background: none; border: none; color: #aaa;
        cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
      }
      #cb-float-close:hover { color: #e63946; }
      #cb-float-content {
        padding: 8px 10px; font-size: 12px; max-height: 180px;
        overflow-y: auto; color: #ccc;
      }
      .cb-float-row {
        padding: 4px 0; border-bottom: 1px solid #2a2a4a;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .cb-float-row:last-child { border-bottom: none; }
      .cb-float-legit      { color: #69f0ae; }
      .cb-float-likely     { color: #ffd740; }
      .cb-float-unverified { color: #ff6e40; }
    `;
    document.head.appendChild(s);
  }

  // ── Badge styles ─────────────────────────────────────────────────────────────

  function injectBadgeStyles() {
    if (document.getElementById("credibytes-styles")) return;
    const style = document.createElement("style");
    style.id = "credibytes-styles";
    style.textContent = `
      .credibytes-badge {
        display:flex; align-items:center; gap:6px;
        padding:6px 10px; margin:6px 0; border-radius:6px;
        font-family:system-ui,sans-serif; font-size:13px; font-weight:600;
        cursor:default; border:1.5px solid transparent;
        position:relative; z-index:10;
      }
      .cb-legitimate  { background:#e6f4ea; border-color:#2e7d32; color:#1b5e20; }
      .cb-likely      { background:#fff8e1; border-color:#f9a825; color:#6d4c00; }
      .cb-unverified  { background:#fff3e0; border-color:#e65100; color:#bf360c; }
      .cb-danger      { background:#fce4ec; border-color:#b71c1c; color:#7f0000; }
      .cb-icon  { font-size:15px; }
      .cb-label { flex:1; }
      .cb-toggle { cursor:pointer; font-size:11px; opacity:0.7; user-select:none; }
      .cb-detail {
        position:absolute; top:100%; left:0; right:0;
        background:#fff; border:1px solid #ccc; border-radius:6px;
        padding:8px 10px; font-size:12px; font-weight:400;
        line-height:1.6; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,0.15);
      }
      .cb-detail p { margin:2px 0; }
    `;
    document.head.appendChild(style);
  }

  // ── Main pipeline ───────────────────────────────────────────────────────────

  async function processAd(adEl) {
    adEl.setAttribute(PROCESSED, "1");

    const { landingUrl, adText, claimedAppName, advertiserName } = extractAdData(adEl);
    if (!isOLAAd(adText, landingUrl, advertiserName)) return;

    const matchResult = window.CrediBytesMatcher.matchUrl(
      landingUrl, claimedAppName, advertiserName
    );
    matchResult._adUrl = landingUrl;

    const stage1Result = await requestStage1Prediction(advertiserName, claimedAppName);

    chrome.storage.local.get("settings", (data) => {
      const mode = data.settings?.displayMode || "badge";
      if (mode === "badge" || mode === "sidepanel") {
        injectBadge(adEl, matchResult, stage1Result, advertiserName);
      }
      if (mode === "floating") {
        // Floating mode still saves the scan (via injectBadge path is skipped,
        // so we save directly here to keep history consistent)
        const { legitimacy, reason, ref, status, suggestion } = matchResult;
        const store     = window.CrediBytesMatcher.isStoreUrl(landingUrl);
        const riskLabel = stage1Result?.risk_label  ?? null;
        const riskDesc  = stage1Result?.risk_desc   ?? null;
        const isApp     = stage1Result?.is_app      ?? null;
        const prob      = stage1Result?.probability ?? null;

        let label;
        if (legitimacy === "legitimate")              label = "SEC Verified";
        else if (legitimacy === "likely_legitimate")  label = "Likely Legitimate";
        else if (status === "no_reference_match" && store) label = "Unregistered App";
        else                                          label = "Unverified";

        chrome.runtime.sendMessage({
          type: "SAVE_SCAN",
          payload: {
            ts: Date.now(), legitimacy, status, label, reason,
            advertiserName: advertiserName || "",
            company:        ref?.company    || "",
            sec:            ref?.sec        || "",
            officialUrl:    ref?.websiteUrl || "",
            isStoreUrl:     store,
            isApp, prob, riskLabel, riskDesc,
            suggestion: suggestion
              ? { company: suggestion.company, sec: suggestion.sec, websiteUrl: suggestion.websiteUrl || "" }
              : null,
          },
        });
        updateFloatingContent();
      }
    });
  }

  function scanPage() {
    findAdElements().forEach(el => processAd(el));
  }

  // ── Debounced MutationObserver ───────────────────────────────────────────────

  let debounceTimer;
  function debouncedScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanPage, 300);
  }

  // ── Initialise ───────────────────────────────────────────────────────────────

  function init() {
    injectBadgeStyles();

    chrome.storage.local.get(["settings", "floatingOpen"], (data) => {
      const mode = data.settings?.displayMode || "badge";
      if (mode === "floating") {
        injectFloatingStyles();
        ensureFloatingWidget();
        if (data.floatingOpen !== false) {
          const w = document.getElementById("cb-floating");
          if (w) w.style.display = "block";
        }
      }
    });

    scanPage();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(m => m.addedNodes.length > 0)) debouncedScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();