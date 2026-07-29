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

  // ── Live settings ───────────────────────────────────────────────────────────
  // Settings are cached here and kept in sync by a storage.onChanged listener.
  //
  // Previously every read hit chrome.storage inline and nothing listened for
  // changes, so switching display mode did nothing until the page was reloaded.
  // Side panel appeared to work only because popup.js separately calls
  // chrome.sidePanel.open() — the page itself never reacted at all.
  const settings = {
    scanningEnabled: true,
    displayMode: "badge",
  };

  // ── Extension-context guards ────────────────────────────────────────────────
  // Reloading, updating, or disabling the extension orphans the content scripts
  // already injected into open tabs. Their `chrome` object is torn down, so
  // `chrome.runtime` reads back as undefined and every call throws
  // "Cannot read properties of undefined (reading 'sendMessage')".
  //
  // The page keeps running, and the MutationObserver keeps firing, so an
  // unguarded call throws once per detected ad and floods the console. These
  // wrappers fail quietly instead and shut the observer down on first detection.

  let contextDead = false;

  function extensionAlive() {
    if (contextDead) return false;
    try {
      // chrome.runtime.id is undefined precisely when the context is invalid.
      return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
    } catch (_err) {
      return false;
    }
  }

  function markContextDead() {
    if (contextDead) return;
    contextDead = true;
    try { observer?.disconnect(); } catch (_err) { /* nothing to do */ }
    clearTimeout(debounceTimer);
  }

  function safeSendMessage(message, cb) {
    if (!extensionAlive()) { markContextDead(); cb && cb(null); return; }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          void chrome.runtime.lastError;   // read it so Chrome stops warning
          cb && cb(null);
          return;
        }
        cb && cb(response);
      });
    } catch (_err) {
      markContextDead();
      cb && cb(null);
    }
  }

  function safeStorageGet(keys, cb) {
    if (!extensionAlive()) { markContextDead(); return; }
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) { void chrome.runtime.lastError; return; }
        cb(data || {});
      });
    } catch (_err) {
      markContextDead();
    }
  }

  function safeStorageSet(obj) {
    if (!extensionAlive()) { markContextDead(); return; }
    try {
      chrome.storage.local.set(obj, () => void chrome.runtime.lastError);
    } catch (_err) {
      markContextDead();
    }
  }

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

  // Product categories that are not lending but whose advertising copy trips the
  // generic keywords above — a romance serial about debt matches "utang", and
  // "borrow" appears in book promotions. Matched against the advertiser name and
  // app title only, never the body text: a genuine lending ad may well say
  // "book your loan today", and excluding on that would lose it.
  //
  // The batch collector (collect_ad_links.mjs) has always had a list like this;
  // the extension never did, which is why "Novels Lover" and "Romance Novel"
  // were being scanned.
  const NON_OLA_KEYWORDS = [
    "novel", "story", "stories", "chapter", "manga", "webtoon", "comic",
    "romance", "fiction", "ebook", "audiobook", "wattpad",
    "game", "gaming", "puzzle", "casino", "slot", "bet",
    "movie", "series", "anime", "music", "podcast",
    "pharmacy", "clinic", "vitamin", "supplement", "skincare", "cosmetic",
    "grocery", "restaurant", "food delivery", "fashion", "clothing",
  ];

  // Apps that present as a utility (a repayment calculator) while their ad copy
  // sells loans. Deliberately NOT in NON_OLA_KEYWORDS: Stage 2 analysis found
  // 30 of 69 undeclared advertised apps (43%) use this naming, so excluding
  // them would discard a documented finding.
  //
  // They are still scanned and still reported as undeclared — which is factually
  // true — but the badge says why the listing looks like a utility, because a
  // genuine calculator is not an OLA and has no duty to register. The user gets
  // the discrepancy rather than an unqualified accusation.
  const CALCULATOR_HINTS = ["calculator", "calc", "emi", "planner", "estimator", "budget tracker"];

  function looksLikeCalculator(claimedAppName) {
    const t = String(claimedAppName || "").toLowerCase();
    return CALCULATOR_HINTS.some(kw => t.includes(kw));
  }

  function looksNonOLA(advertiserName, claimedAppName) {
    const identity = `${advertiserName || ""} ${claimedAppName || ""}`.toLowerCase();
    return NON_OLA_KEYWORDS.some(kw => identity.includes(kw));
  }

  function isOLAAd(adText, landingUrl, advertiserName = "", claimedAppName = "") {
    // A registered brand name is decisive on its own. Plenty of real OLA ads
    // carry no lending vocabulary at all — "Relate na relate kami, Donna
    // Cariaga! Good thing, nandiyan si JuanHand para sa'yo!" was being skipped
    // even though JuanHand is a declared platform of Wefund Lending Corp.
    // Checked first so a registrant is never dropped by the exclusion below.
    const M = window.CrediBytesMatcher;
    if (M?.mentionsKnownRegistrant?.(`${advertiserName} ${claimedAppName}`)) return true;

    if (looksNonOLA(advertiserName, claimedAppName)) return false;

    const haystack = (adText + " " + landingUrl + " " + advertiserName).toLowerCase();
    return OLA_KEYWORDS.some(kw => haystack.includes(kw));
  }

  // ── Ad detection ────────────────────────────────────────────────────────────

  const AD_ROOT_SELECTOR = '[role="article"], [data-pagelet]';

  // A real ad container has a link and more text than just the word
  // "Sponsored". This is what stops us latching onto the tiny label wrapper.
  function isPlausibleAdRoot(el) {
    if (!el || el === document.body) return false;
    if (!el.querySelector("a[href]")) return false;
    return (el.innerText || "").trim().length > 40;
  }

  // Climb from the "Sponsored" marker to the real ad container.
  //
  // The old code used span.closest('[role="article"], [data-pagelet], div[class]').
  // On the search results page [role="article"] exists so it worked, but in the
  // news feed there is often no article ancestor, so `div[class]` matched the
  // nearest classed <div> — frequently just the wrapper around the word
  // "Sponsored". That element contains no page-name node, which is exactly why
  // the advertiser name came out blank in the feed but fine in search.
  function climbToAdRoot(start) {
    // [role="article"] / [data-pagelet] are genuine post containers, so the
    // nearest one is the right boundary — no size heuristic needed. Taking the
    // NEAREST matters: climbing further can swallow a neighbouring post and
    // then the advertiser name gets read off somebody else's post.
    let el = start;
    for (let i = 0; i < 14 && el && el !== document.body; i++) {
      if (el.matches?.(AD_ROOT_SELECTOR)) return el;
      el = el.parentElement;
    }
    // No post container (common in the news feed) — fall back to the nearest
    // ancestor that actually looks like a whole ad.
    el = start;
    for (let i = 0; i < 14 && el && el !== document.body; i++) {
      if (isPlausibleAdRoot(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Remembers which "Sponsored" label produced each ad root, so the advertiser
  // name can be looked up relative to it.
  const adMarkers = new WeakMap();

  function findAdElements() {
    const candidates = new Set();

    const consider = (marker) => {
      const root = climbToAdRoot(marker);
      if (root && !root.hasAttribute(PROCESSED)) {
        candidates.add(root);
        if (!adMarkers.has(root)) adMarkers.set(root, marker);
      }
    };

    document.querySelectorAll('[aria-label="Sponsored"]').forEach(consider);

    document.querySelectorAll("span, a").forEach(el => {
      const t = el.textContent.trim();
      // Facebook localises this and sometimes splits it across nodes.
      if (t === "Sponsored" || t === "Sponsored ·" || t === "Sponsored·") consider(el);
    });

    // Drop candidates that merely contain another candidate, so a single ad
    // does not get badged twice at two nesting levels.
    const roots = [...candidates];
    return roots.filter(r => !roots.some(other => other !== r && r.contains(other)));
  }

  // ── Advertiser name extraction ───────────────────────────────────────────────
  // Facebook's sponsored post structure has the page name as the first
  // strong link near the top of the article. We try multiple selectors
  // in priority order since Facebook's HTML changes frequently.

  // Facebook chrome that is never an advertiser name. Without this the old
  // bare "strong" selector happily returned "Like" or "Sponsored".
  const NAME_NOISE = new Set([
    "sponsored", "suggested for you", "follow", "like", "comment", "share",
    "see more", "learn more", "shop now", "sign up", "apply now", "download",
    "install", "open", "send message", "message", "contact us", "book now",
    "watch more", "play game", "get offer", "subscribe", "join", "paid partnership",
  ]);

  function looksLikeName(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2 || t.length > 80) return false;
    if (NAME_NOISE.has(t.toLowerCase())) return false;
    if (/^\d+$/.test(t)) return false;          // reaction counts
    if (/^https?:\/\//i.test(t)) return false;  // raw URLs
    if (!/[a-z]/i.test(t)) return false;        // emoji/punctuation only
    return true;
  }

  function findNameIn(scope) {
    for (const sel of NAME_SELECTORS) {
      for (const el of scope.querySelectorAll(sel)) {
        const text = el.textContent?.trim();
        if (looksLikeName(text)) return text;
      }
    }
    return "";
  }

  function getAdvertiserName(adEl, marker) {
    // Search outward from the "Sponsored" label first.
    //
    // The page name always sits in the same header block as that label, so the
    // nearest ancestor containing a name is the advertiser. Scanning the whole
    // ad instead let unrelated names win — a Kviku ad reported "Sherleen Toca",
    // a name picked up from the engagement/among-reactions area (or an adjacent
    // post) that happened to sit in an earlier-priority selector.
    if (marker && adEl.contains(marker)) {
      let el = marker.parentElement;
      for (let i = 0; i < 6 && el && adEl.contains(el); i++) {
        const name = findNameIn(el);
        if (name) return name;
        el = el.parentElement;
      }
    }
    return findNameIn(adEl);
  }

  // Ordered most-specific first. The feed renders the page name inside a link
  // to the page itself, the most reliable anchor across feed and search.
  const NAME_SELECTORS = [
      "h2 a[role='link'] span",
      "h3 a[role='link'] span",
      "h4 a[role='link'] span",
      "h2 a[role='link']",
      "h3 a[role='link']",
      "h4 a[role='link']",
      "h2 strong span", "h3 strong span", "h4 strong span",
      "a[role='link'] strong span",
      "a[role='link'] strong",
      "a[href*='facebook.com/'] strong",
      "a[role='link'] > span[dir='auto']",
      "strong span",
      "strong",
      // Last resort: any link to a Facebook page/profile whose text reads
      // like a name.
      "a[href*='facebook.com/']",
  ];

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

  // Rank candidate links instead of taking the first in DOM order.
  //
  // The old code used links[0], which is whatever markup happens to come first
  // — usually the advertiser's profile or avatar link, and in an Ad Library
  // card the "See ad details" control. The real destination sits later, on the
  // call-to-action. That is why a Cashify ad pointing at a Play Store package
  // the SEC *does* declare (com.cashola.loan.cash.peso, SunLoan Lending
  // Investors Corporation) was judged on a facebook.com URL and came back
  // unverified rather than SEC Verified.
  //
  // Store links rank first because they identify an exact app; an external
  // site next; a Facebook destination last, since it is never a declared
  // channel and only matters when there is nothing else.
  function rankLink(url) {
    const u = url.toLowerCase();
    if (u.includes("play.google.com/store/apps") ||
        u.includes("apps.apple.com") || u.includes("itunes.apple.com")) return 0;
    if (!u.includes("facebook.com") && !u.includes("fb.com") &&
        !u.includes("m.me") && !u.includes("messenger.com")) return 1;
    return 2;
  }

  function extractAdData(adEl) {
    const links = [...adEl.querySelectorAll("a[href]")]
      .map(a => unwrapFBRedirect(a.href))          // unwrap BEFORE ranking, so
      .filter(href =>                              // l.facebook.com wrappers are
        href.startsWith("http") &&                 // judged on their destination
        !href.includes("facebook.com/ads/library") &&
        !href.includes("/ads/archive")
      );

    // Stable sort keeps DOM order within a rank, so the first store link wins.
    const ranked = links
      .map((href, i) => ({ href, rank: rankLink(href), i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);

    return {
      landingUrl:     ranked[0]?.href || "",
      adText:         adEl.innerText || "",
      claimedAppName: getAppName(adEl),
      advertiserName: getAdvertiserName(adEl, adMarkers.get(adEl)),
    };
  }

  // ── Backend call via background.js ──────────────────────────────────────────

  // hasOfficialWebsite comes from the SEC record matcher.js resolved for this
  // ad. The model was trained with this signal, so omitting it at inference
  // (the previous behaviour — backend hardcoded 0) left the model operating in
  // a regime it was never trained on.
  // How long the badge waits on the backend before falling back locally.
  //
  // A warm Render instance answers in a few hundred milliseconds, so in normal
  // use the backend wins this race and its logs record the traffic. A spun-down
  // instance takes 30-60s to boot, which no badge should wait for — the local
  // model fills in immediately, and the request that just timed out is itself
  // what wakes the instance, so the next ad on the page is usually served
  // remotely.
  const BACKEND_WAIT_MS = 2500;

  function requestStage1Prediction(advertiserName, appName, hasOfficialWebsite) {
    const localResult = () =>
      window.CrediBytesStage1?.predict(advertiserName, appName, hasOfficialWebsite) ?? null;

    // No point waiting on the network if the context is already gone.
    if (!extensionAlive()) return Promise.resolve(localResult());

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      // Backend first, so the deployed service actually receives traffic.
      safeSendMessage(
        {
          type: "PREDICT",
          payload: {
            companyName: advertiserName,
            platformName: appName,
            hasOfficialWebsite: hasOfficialWebsite ? 1 : 0,
          },
        },
        (response) => {
          const remote = response?.prediction;
          // A null here means unreachable, cold, or context torn down — fall
          // back rather than dropping the profile score entirely.
          finish(remote || localResult());
        }
      );

      // Safety net: the callback may simply never fire while the instance boots.
      setTimeout(() => finish(localResult()), BACKEND_WAIT_MS);
    });
  }

  // ── Verdict mapping (single source of truth) ────────────────────────────────
  // The four badge states. Previously this if/else was written out twice — once
  // for the badge and once for the floating-mode save — and the copies had
  // already drifted apart.

  function verdictOf(legitimacy, status, isStoreUrl) {
    if (legitimacy === "legitimate") {
      return { cls: "cb-legitimate", icon: "✓", label: "SEC Verified" };
    }
    if (legitimacy === "likely_legitimate") {
      return { cls: "cb-likely", icon: "?", label: "Likely Legitimate" };
    }
    // The advertiser's name is in the registry, but the ad links to a social or
    // messaging page — never a SEC-declared channel, so the name proves
    // nothing on its own. Ranked above Unverified because we did identify a
    // registrant worth comparing against, and below Likely Legitimate because
    // the link itself carries no evidence.
    if (legitimacy === "name_match_only") {
      return { cls: "cb-namematch", icon: "≈", label: "Name Match Only" };
    }
    if (status === "no_reference_match" && isStoreUrl) {
      return { cls: "cb-danger", icon: "!", label: "Unregistered App" };
    }
    return { cls: "cb-unverified", icon: "!", label: "Unverified" };
  }

  // ── Badge injection (createElement — no innerHTML) ───────────────────────────

  function injectBadge(adEl, matchResult, stage1Result, advertiserName) {
    adEl.querySelector("." + BADGE_CLASS)?.remove();

    const { legitimacy, reason, ref, status, suggestion } = matchResult;
    const store      = window.CrediBytesMatcher.isStoreUrl(matchResult._adUrl || "");
    const claimedAppName = matchResult._claimedAppName || "";
    const riskDesc   = stage1Result?.risk_desc   ?? null;
    const isApp      = stage1Result?.is_app      ?? null;
    const prob       = stage1Result?.probability ?? null;

    const { cls: badgeClass, icon, label } = verdictOf(legitimacy, status, store);

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS + " " + badgeClass;
    badge.setAttribute("role", "status");

    const iconSpan = document.createElement("span");
    iconSpan.className = "cb-icon";
    iconSpan.textContent = icon;

    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-label";
    labelSpan.textContent = label;

    // A real <button>: focusable, Enter/Space activated, and announced by
    // screen readers. As a <span> it was mouse-only and invisible to a11y.
    const toggle = document.createElement("button");
    toggle.className = "cb-toggle";
    toggle.type = "button";
    toggle.title = "Show details";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Show CrediBytes details");
    toggle.textContent = "Details";

    const detail = document.createElement("div");
    detail.className = "cb-detail";
    detail.hidden = true;

    // Labelled key/value rows instead of a flat list of sentences — the old
    // version rendered "─────" strings as fake separators, which screen readers
    // read aloud character by character.
    const addRow = (labelText, valueText) => {
      const row = document.createElement("div");
      row.className = "cb-row";
      if (labelText) {
        const k = document.createElement("span");
        k.className = "cb-key";
        k.textContent = labelText;
        row.appendChild(k);
      }
      const v = document.createElement("span");
      v.className = "cb-val";
      v.textContent = valueText;
      row.appendChild(v);
      detail.appendChild(row);
    };

    const addSection = (titleText) => {
      const h = document.createElement("div");
      h.className = "cb-section";
      h.textContent = titleText;
      detail.appendChild(h);
    };

    addRow("", reason);

    // Every channel the registrant actually declared to the SEC. When the ad's
    // own link could not be verified, these are what the user should compare
    // against — "this is where the real one lives". Shown for a confirmed ref
    // and for a fuzzy suggestion alike, but the suggestion is labelled as
    // unverified so a near-miss is never mistaken for a match.
    const addDeclaredChannels = (entry) => {
      if (entry.playUrl)    addRow("Official Play Store", entry.playUrl);
      if (entry.appleUrl)   addRow("Official App Store", entry.appleUrl);
      if (entry.websiteUrl) addRow("Official site", entry.websiteUrl);
    };

    if (ref) {
      addSection(legitimacy === "name_match_only"
        ? "Registrant claimed — link not verified"
        : "SEC registration");
      addRow("SEC No.", ref.sec);
      if (ref.company) addRow("Registrant", ref.company);
      if (ref.appName) addRow("Registered as", ref.appName);
      addDeclaredChannels(ref);
    }

    if (!ref && suggestion) {
      addSection("Possible match — not verified");
      addRow("Company", suggestion.company);
      addRow("SEC No.", suggestion.sec);
      addDeclaredChannels(suggestion);
    }

    // Explains the discrepancy rather than leaving "Unregistered App" to imply
    // the app was obliged to register. A calculator genuinely is not an OLA;
    // one whose advertising sells loans is the pattern worth surfacing.
    if (!ref && store && looksLikeCalculator(claimedAppName)) {
      addSection("Listing type");
      addRow("", "This listing presents itself as a calculator or planning tool, " +
                 "but the advertisement offers loans. Utilities are not required " +
                 "to register with the SEC, so treat the absence of a declaration " +
                 "here as a mismatch to check rather than proof of wrongdoing.");
    }

    if (riskDesc) {
      addSection("Profile signal");
      addRow("", riskDesc);
    } else if (isApp !== null) {
      // Fallback for older backend responses that don't yet return risk_desc
      addSection("Profile signal");
      addRow("", "Profile score: " + Math.round((prob ?? 0) * 100) + "% — " +
        (isApp ? "profile matches patterns of SEC-registered OLA platforms."
               : "profile does not match typical patterns of SEC-registered OLA platforms."));
    }

    const setExpanded = (open) => {
      detail.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide" : "Details";
      toggle.title = open ? "Hide details" : "Show details";
    };

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      setExpanded(detail.hidden);
    });

    badge.appendChild(iconSpan);
    badge.appendChild(labelSpan);
    badge.appendChild(toggle);
    badge.appendChild(detail);
    adEl.insertBefore(badge, adEl.firstChild);
    // Persistence is handled by saveScan() in processAd(), so history is
    // identical across display modes.
  }

  // ── Floating widget ─────────────────────────────────────────────────────────

  function ensureFloatingWidget() {
    if (document.getElementById("cb-floating")) return;

    const widget = document.createElement("div");
    widget.id = "cb-floating";

    const header = document.createElement("div");
    header.id = "cb-float-header";

    const title = document.createElement("span");
    title.className = "cb-float-title";
    title.textContent = "CrediBytes";

    const count = document.createElement("span");
    count.id = "cb-float-count";
    count.className = "cb-float-count";
    count.textContent = "0";

    const spacer = document.createElement("span");
    spacer.className = "cb-float-spacer";

    const closeBtn = document.createElement("button");
    closeBtn.id = "cb-float-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close CrediBytes panel");
    closeBtn.addEventListener("click", () => {
      widget.style.display = "none";
      safeStorageSet({ floatingOpen: false });
    });

    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(spacer);
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

    safeStorageGet("scans", (data) => {
      const all   = data.scans || [];
      const scans = all.slice(0, 6);

      const countEl = document.getElementById("cb-float-count");
      if (countEl) countEl.textContent = String(all.length);

      content.textContent = "";

      if (scans.length === 0) {
        const empty = document.createElement("div");
        empty.className = "cb-float-empty";
        empty.textContent = "No OLA ads detected yet.";
        content.appendChild(empty);
        return;
      }

      scans.forEach(scan => {
        // Reuse the same four-state mapping as the badge so the floating
        // widget can't disagree with the badge about a verdict. The old code
        // had its own three-state map and never showed "Unregistered App".
        const v = verdictOf(scan.legitimacy, scan.status, scan.isStoreUrl);

        const row = document.createElement("div");
        row.className = "cb-float-row";

        const dot = document.createElement("span");
        dot.className = "cb-float-dot " + v.cls;
        dot.textContent = v.icon;

        const text = document.createElement("span");
        text.className = "cb-float-text";

        const name = document.createElement("span");
        name.className = "cb-float-name";
        name.textContent = scan.advertiserName || scan.company || "Unknown advertiser";

        const verdict = document.createElement("span");
        verdict.className = "cb-float-verdict";
        verdict.textContent = v.label;

        text.appendChild(name);
        text.appendChild(verdict);
        row.appendChild(dot);
        row.appendChild(text);
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
        position: fixed; bottom: 80px; right: 16px; width: 264px;
        background: #101322; color: #e8eaf2;
        border: 1px solid rgba(255,255,255,.08); border-radius: 14px;
        box-shadow: 0 12px 32px rgba(0,0,0,.4);
        z-index: 2147483000;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        overflow: hidden; user-select: none;
      }
      #cb-float-header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; cursor: grab;
        background: linear-gradient(180deg, #1a1f38, #151932);
        border-bottom: 1px solid rgba(255,255,255,.07);
      }
      #cb-float-header:active { cursor: grabbing; }
      .cb-float-title { font-size: 13px; font-weight: 700; letter-spacing: .2px; }
      .cb-float-count {
        font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
        background: rgba(255,255,255,.1); color: #c9cee6;
      }
      .cb-float-spacer { flex: 1; }
      #cb-float-close {
        background: none; border: none; color: #8b90a8; cursor: pointer;
        font-size: 19px; line-height: 1; padding: 0 2px; border-radius: 6px;
      }
      #cb-float-close:hover { color: #ff6b6b; background: rgba(255,107,107,.12); }
      #cb-float-close:focus-visible { outline: 2px solid #6ea8ff; outline-offset: 2px; }
      #cb-float-content { padding: 6px; max-height: 232px; overflow-y: auto; }
      .cb-float-empty {
        padding: 18px 10px; text-align: center; font-size: 12px; color: #767b94;
      }
      .cb-float-row {
        display: flex; align-items: center; gap: 9px;
        padding: 8px 8px; border-radius: 9px;
      }
      .cb-float-row:hover { background: rgba(255,255,255,.05); }
      .cb-float-dot {
        width: 19px; height: 19px; flex-shrink: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 800; color: #fff;
      }
      .cb-float-dot.cb-legitimate { background: #1a9c5b; }
      .cb-float-dot.cb-likely     { background: #c58a12; }
      .cb-float-dot.cb-unverified { background: #d1641c; }
      .cb-float-dot.cb-danger     { background: #cc2f38; }
      .cb-float-dot.cb-namematch  { background: #7a5cd6; }
      .cb-float-text { display: flex; flex-direction: column; min-width: 0; }
      .cb-float-name {
        font-size: 12px; font-weight: 600; color: #e8eaf2;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .cb-float-verdict { font-size: 10.5px; color: #868ca6; margin-top: 1px; }
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
        display: flex; align-items: center; gap: 8px;
        padding: 7px 10px; margin: 8px 0; border-radius: 10px;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13px; font-weight: 600; line-height: 1.3;
        border: 1px solid transparent; border-left-width: 3px;
        position: relative; z-index: 10; box-sizing: border-box;
      }
      /* Solid backgrounds: Facebook's own dark mode would otherwise show
         through a translucent badge and wreck the contrast. */
      .credibytes-badge.cb-legitimate { background:#e7f6ec; border-color:#1a9c5b; color:#0f5c36; }
      .credibytes-badge.cb-likely     { background:#fdf5e3; border-color:#c58a12; color:#6b4a05; }
      .credibytes-badge.cb-unverified { background:#fdeee2; border-color:#d1641c; color:#7d3708; }
      .credibytes-badge.cb-danger     { background:#fdeaec; border-color:#cc2f38; color:#7d151b; }
      /* Purple: deliberately not green (not verified) and not red (not an
         accusation) — a registrant was identified but the link proves nothing. */
      .credibytes-badge.cb-namematch  { background:#f1edfd; border-color:#7a5cd6; color:#3d2a7a; }

      .credibytes-badge .cb-icon {
        width: 18px; height: 18px; flex-shrink: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 800; color: #fff;
      }
      .cb-legitimate .cb-icon { background:#1a9c5b; }
      .cb-likely     .cb-icon { background:#c58a12; }
      .cb-unverified .cb-icon { background:#d1641c; }
      .cb-danger     .cb-icon { background:#cc2f38; }
      .cb-namematch  .cb-icon { background:#7a5cd6; }

      .credibytes-badge .cb-label { flex: 1; min-width: 0; }

      .credibytes-badge .cb-toggle {
        font: inherit; font-size: 11px; font-weight: 600;
        padding: 3px 9px; border-radius: 999px; cursor: pointer;
        background: rgba(0,0,0,.06); border: none; color: inherit;
        flex-shrink: 0; transition: background .12s;
      }
      .credibytes-badge .cb-toggle:hover { background: rgba(0,0,0,.12); }
      .credibytes-badge .cb-toggle:focus-visible {
        outline: 2px solid currentColor; outline-offset: 1px;
      }

      .credibytes-badge .cb-detail {
        position: absolute; top: calc(100% + 4px); left: 0; right: 0;
        background: #fff; color: #26282f;
        border: 1px solid #dfe1e8; border-radius: 10px;
        padding: 10px 12px; font-size: 12px; font-weight: 400;
        z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,.16);
        max-height: 280px; overflow-y: auto;
      }
      .credibytes-badge .cb-row {
        display: flex; gap: 8px; padding: 3px 0; line-height: 1.5;
      }
      .credibytes-badge .cb-key {
        flex-shrink: 0; min-width: 88px; color: #767b8a; font-weight: 600;
      }
      .credibytes-badge .cb-val { color: #26282f; word-break: break-word; }
      .credibytes-badge .cb-section {
        margin-top: 8px; padding-top: 7px; border-top: 1px solid #ebedf2;
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .5px; color: #969ab0;
      }
      .credibytes-badge .cb-row:first-child .cb-val { font-weight: 500; }
    `;
    document.head.appendChild(style);
  }

  // ── Main pipeline ───────────────────────────────────────────────────────────

  async function processAd(adEl) {
    adEl.setAttribute(PROCESSED, "1");

    const { landingUrl, adText, claimedAppName, advertiserName } = extractAdData(adEl);
    if (!isOLAAd(adText, landingUrl, advertiserName, claimedAppName)) return;

    const matchResult = window.CrediBytesMatcher.matchUrl(
      landingUrl, claimedAppName, advertiserName
    );
    matchResult._adUrl = landingUrl;
    matchResult._claimedAppName = claimedAppName;

    // Only a confirmed SEC match counts. matchResult.suggestion is a fuzzy
    // guess and must not be treated as a verified website.
    const hasOfficialWebsite = matchResult.ref?.websiteUrl ? 1 : 0;

    const stage1Result = await requestStage1Prediction(
      advertiserName, claimedAppName, hasOfficialWebsite
    );

    // The scan is always recorded, whatever the display mode — history in the
    // popup must not depend on which surface the user happens to be viewing.
    saveScan(matchResult, stage1Result, advertiserName, landingUrl);

    // Badge is the on-page surface for both "badge" and "sidepanel" modes;
    // sidepanel additionally mirrors the history in Chrome's panel.
    if (settings.displayMode === "badge" || settings.displayMode === "sidepanel") {
      injectBadge(adEl, matchResult, stage1Result, advertiserName);
    } else if (settings.displayMode === "floating") {
      updateFloatingContent();
    }
  }

  // Single place that builds the SAVE_SCAN payload. It used to be duplicated
  // between injectBadge() and the floating branch, which is how isStoreUrl went
  // missing from one copy and broke the popup's "Unregistered" tier.
  function saveScan(matchResult, stage1Result, advertiserName, landingUrl) {
    const { legitimacy, reason, ref, status, suggestion } = matchResult;
    const store = window.CrediBytesMatcher.isStoreUrl(landingUrl);

    safeSendMessage({
      type: "SAVE_SCAN",
      payload: {
        ts: Date.now(),
        legitimacy,
        status,
        label: verdictOf(legitimacy, status, store).label,
        // Tier the badge actually rendered, e.g. "legitimate" / "danger".
        // Stored so background.js can keep running totals and popup.js can
        // colour the row without either of them re-deriving the verdict — the
        // rules live in verdictOf() alone.
        tier: verdictOf(legitimacy, status, store).cls.replace(/^cb-/, ""),
        reason,
        advertiserName: advertiserName || "",
        company:        ref?.company    || "",
        sec:            ref?.sec        || "",
        officialUrl:    ref?.websiteUrl || "",
        isStoreUrl:     store,
        isApp:          stage1Result?.is_app      ?? null,
        prob:           stage1Result?.probability ?? null,
        riskLabel:      stage1Result?.risk_label  ?? null,
        riskDesc:       stage1Result?.risk_desc   ?? null,
        suggestion: suggestion
          ? { company: suggestion.company, sec: suggestion.sec, websiteUrl: suggestion.websiteUrl || "" }
          : null,
      },
    });
  }

  function scanPage() {
    // Bail before touching the DOM if the extension was reloaded — otherwise
    // every observed ad would attempt a doomed chrome.* call.
    if (!extensionAlive()) { markContextDead(); return; }
    if (!settings.scanningEnabled) return;
    findAdElements().forEach(el => processAd(el));
  }

  // ── Display-mode switching ──────────────────────────────────────────────────

  function removeAllBadges() {
    document.querySelectorAll("." + BADGE_CLASS).forEach(el => el.remove());
  }

  function removeFloatingWidget() {
    document.getElementById("cb-floating")?.remove();
  }

  // Ads are marked PROCESSED so the MutationObserver doesn't re-handle them.
  // That mark also prevents re-rendering when the mode changes, so clear it and
  // rescan — otherwise switching modes only affects ads loaded afterwards.
  function resetProcessedMarks() {
    document.querySelectorAll("[" + PROCESSED + "]").forEach(el =>
      el.removeAttribute(PROCESSED));
  }

  function applySettings() {
    removeAllBadges();
    // Cleared unconditionally: leaving marks on elements whose badges were just
    // removed is stale state, and it would stop those ads being re-checked if
    // scanning is switched back on without a reload.
    resetProcessedMarks();

    if (!settings.scanningEnabled) {
      removeFloatingWidget();
      return;
    }

    if (settings.displayMode === "floating") {
      injectFloatingStyles();
      ensureFloatingWidget();
      const w = document.getElementById("cb-floating");
      if (w) w.style.display = "block";
    } else {
      removeFloatingWidget();
    }

    scanPage();
  }

  // ── Debounced MutationObserver ───────────────────────────────────────────────

  // Module-scoped so markContextDead() can shut them down. Declared with `let`
  // (not `const` inside init) precisely because that guard has to reach them.
  let observer = null;
  let debounceTimer;
  function debouncedScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanPage, 300);
  }

  // ── Initialise ───────────────────────────────────────────────────────────────

  function init() {
    injectBadgeStyles();

    safeStorageGet(["settings", "floatingOpen"], (data) => {
      settings.scanningEnabled = data.settings?.scanningEnabled !== false;
      settings.displayMode     = data.settings?.displayMode || "badge";

      if (settings.scanningEnabled && settings.displayMode === "floating") {
        injectFloatingStyles();
        ensureFloatingWidget();
        if (data.floatingOpen !== false) {
          const w = document.getElementById("cb-floating");
          if (w) w.style.display = "block";
        }
      }

      scanPage();
    });

    // Apply setting changes immediately, without a page reload.
    //
    // This listener is the actual fix for "display mode only works when side
    // panel is clicked": nothing here previously observed storage, so a mode
    // change just sat in storage. Side panel looked like it worked because
    // popup.js separately calls chrome.sidePanel.open() on that one option.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      if (changes.settings) {
        const next = changes.settings.newValue || {};
        const prevMode     = settings.displayMode;
        const prevScanning = settings.scanningEnabled;

        settings.scanningEnabled = next.scanningEnabled !== false;
        settings.displayMode     = next.displayMode || "badge";

        if (settings.displayMode !== prevMode ||
            settings.scanningEnabled !== prevScanning) {
          applySettings();
        }
      }

      // Keep the floating list live as new scans arrive from any tab.
      if (changes.scans && settings.displayMode === "floating") {
        updateFloatingContent();
      }
    });

    observer = new MutationObserver((mutations) => {
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