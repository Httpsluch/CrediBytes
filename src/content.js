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
    // "system" | "light" | "dark". The injected UI CANNOT use
    // prefers-color-scheme alone: that follows the operating system, so picking
    // Light in Settings left the badge detail and the floating widget dark on a
    // dark OS. The popup solves this with a data-theme attribute on <html>, but
    // <html> here belongs to Facebook, so the resolved theme is stamped onto
    // each injected root instead (see applyTheme).
    theme: "system",
  };

  // Stamped on every injected root. Mirrors the popup's two-selector approach:
  // cb-dark forces dark, cb-light forces light, and neither leaves the
  // prefers-color-scheme media query in charge.
  function themeClass() {
    return settings.theme === "dark"  ? "cb-dark"
         : settings.theme === "light" ? "cb-light" : "";
  }

  function applyThemeTo(node) {
    if (!node) return;
    node.classList.remove("cb-dark", "cb-light");
    const c = themeClass();
    if (c) node.classList.add(c);
  }

  // Re-stamp everything already on the page when the choice changes, so the
  // switch is immediate rather than applying only to ads scanned afterwards.
  function refreshTheme() {
    document.querySelectorAll("." + BADGE_CLASS).forEach(applyThemeTo);
    applyThemeTo(document.getElementById("cb-floating"));
  }

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

  // Unambiguous lending phrases — one occurrence anywhere is enough.
  const STRONG_KEYWORDS = [
    "online lending", "lending app", "loan app", "cash loan", "personal loan",
    "instant loan", "quick loan", "pautang online", "online pautang",
    "borrow money", "borrow cash", "mag-apply ng loan", "apply for loan",
    "loan approval", "fast approval loan", "no collateral loan",
    "lending corporation", "lending inc", "lending company", "lending corp",
    "financing inc", "financing corp", "finance corp", "finance inc",
    "utang online", "pera agad", "cash agad", "loan agad",
    "ola app", "lending platform", "loan online", "apply now for a loan",
  ];

  // Single words that appear in plenty of non-lending copy. A comic promises
  // you can "borrow" a chapter; a library ad says "loan". These need
  // corroboration — see isOLAAd().
  //
  // v1.1 merged these into one list where any single hit qualified an ad, and
  // that is why "Pecular Eyewear", "Only Digital Library" and
  // "Pocket Toons - Fantasy & Action" were being scanned. A blocklist cannot
  // keep up with every unrelated product category, so the bar is raised
  // instead of the exclusions being extended indefinitely.
  const WEAK_KEYWORDS = ["loan", "lending", "borrow", "pautang", "utang", "sangla"];

  // Money words that identify a lender when they appear in the advertiser's OWN
  // name. Checked against identity only — in ad copy they are meaningless.
  const FINANCE_NAME_WORDS = [
    "peso", "piso", "pera", "cash", "credit", "money", "fund", "capital",
    "finance", "financing", "lend", "loan", "utang", "sangla", "salapi",
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

    const identity = `${advertiserName} ${claimedAppName}`.toLowerCase();
    const haystack = `${adText} ${landingUrl} ${advertiserName}`.toLowerCase();

    // An unambiguous phrase settles it.
    if (STRONG_KEYWORDS.some(kw => haystack.includes(kw))) return true;

    // A generic word is only meaningful when the advertiser or the app itself
    // is named for lending — that is the advertiser describing their own
    // product, not a word that happened to appear in the copy.
    if (WEAK_KEYWORDS.some(kw => identity.includes(kw))) return true;

    // Naming yourself after money is self-identification, and it is what most
    // undeclared operators do: Pesohere, MegaPeso, MoneyLoom, Quick Cash,
    // Ascend Finance. Those ads often carry no lending phrase at all — the brand
    // IS the pitch — and they are precisely the ones worth catching, since an
    // undeclared app cannot be recognised from the SEC registry.
    //
    // Restricted to the advertiser and app name: "cash" or "credit" in ad copy
    // means little, but in the advertiser's own name it is deliberate.
    if (FINANCE_NAME_WORDS.some(kw => identity.includes(kw))) return true;

    // Otherwise require more than one distinct generic term in the body. One
    // stray "loan" is noise; several different lending words together are not.
    const distinctWeak = WEAK_KEYWORDS.filter(kw => haystack.includes(kw)).length;
    return distinctWeak >= 2;
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

  // ── Meta Ad Library: a surface with no post containers at all ──────────────
  //
  // Measured in the live Ad Library: [role="article"] and [data-pagelet] appear
  // ZERO times. Every ad there was therefore rooted by isPlausibleAdRoot(),
  // which returns the FIRST ancestor with a link and 40+ characters — and the
  // card's header row clears that bar on its own ("ACOM Consumer Finance
  // Corporation" is 33 characters, plus "Sponsored"). The resulting root held
  // only the advertiser's Facebook page link, so:
  //   - the destination was judged to be facebook.com and came back social,
  //   - the ad body and the destination caption were both out of scope,
  //   - getAppName() found nothing, so the reason line read "Company name
  //     matches" rather than naming the app.
  // That is why four ACOM ads displaying WWW.ACOM.COM.PH — a domain the SEC has
  // on record — all showed "Name Match Only".
  //
  // Each card states its Library ID exactly once; the grid holding every card
  // states it once per card. So the LOWEST ancestor containing it exactly once
  // is precisely one card. Walking up from the Sponsored marker in a real card:
  //
  //   level  7-11   1282 chars   Library ID: no    <- ad preview, no ID yet
  //   level 12-13   1388 chars   Library ID: 1     <- the whole card
  //   level 14      53813 chars  Library ID: many  <- the grid, 49 captions
  //
  // Taking the LOWEST match rather than the highest matters: on a single-result
  // page the grid also contains exactly one Library ID, and preferring the
  // highest would hand back the entire page.
  const AD_LIBRARY_PATH = /^\/ads\/library/i;
  const LIBRARY_ID_TEXT = /Library ID/gi;

  function isAdLibrary() {
    return AD_LIBRARY_PATH.test(location.pathname);
  }

  function climbToAdLibraryCard(start) {
    let el = start;
    for (let i = 0; i < 20 && el && el !== document.body; i++) {
      // textContent, not innerText: innerText forces layout, and this runs for
      // every marker on every scan. The grid subtree is ~54 KB of text.
      const hits = (el.textContent.match(LIBRARY_ID_TEXT) || []).length;
      if (hits === 1) return el;
      if (hits > 1) return null;   // already past the card — let the caller fall back
      el = el.parentElement;
    }
    return null;
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
    // Ad Library first, and ONLY there. The news feed keeps the behaviour below
    // unchanged: its post containers are reliable, and the Library ID anchor
    // does not exist on that surface anyway.
    if (isAdLibrary()) {
      const card = climbToAdLibraryCard(start);
      if (card) return card;
      // No Library ID in range (a layout change, or a card still rendering) —
      // fall through rather than skipping the ad entirely.
    }

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

  // Facebook wraps outbound links through several hosts, not just l.facebook.com:
  // lm.facebook.com on mobile-rendered surfaces and l.messenger.com from
  // Messenger-origin ads. Missing one leaves the wrapper as the "destination",
  // so the ad looks like it points at Facebook itself.
  const FB_REDIRECT_HOSTS = new Set([
    "l.facebook.com", "lm.facebook.com", "l.messenger.com", "l.instagram.com",
  ]);

  function unwrapFBRedirect(url) {
    let current = String(url || "");
    // Wrappers occasionally nest (a shim around a shim); a small bounded loop
    // resolves those without risking a cycle.
    for (let i = 0; i < 3; i++) {
      try {
        const u = new URL(current);
        if (!FB_REDIRECT_HOSTS.has(u.hostname)) return current;
        const inner = u.searchParams.get("u") || u.searchParams.get("url");
        if (!inner) return current;
        current = decodeURIComponent(inner);
      } catch {
        return current;
      }
    }
    return current;
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

  // The Meta Ad Library preview carries no outbound anchor — its call to action
  // is an internal "See details" control, and the destination appears only as a
  // caption above the headline (WWW.ACOM.COM.PH). Without this, every Ad Library
  // ad is judged on the advertiser's Facebook page link, which is why ACOM ads
  // pointing at a domain the SEC has on record came back "Name Match Only".
  //
  // Only an element whose ENTIRE text is a bare domain counts. Scanning ad copy
  // for domain-shaped strings would be trivially spoofable — an impersonator
  // could write "acom.com.ph" in the body while linking elsewhere. Meta renders
  // this caption from the ad's real destination, so it is evidence; free text in
  // the body is not.
  const BARE_DOMAIN = /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

  function captionDomains(adEl) {
    const found = [];
    for (const el of adEl.querySelectorAll("div, span, a")) {
      if (el.children.length) continue;                 // leaf nodes only
      const t = (el.textContent || "").trim();
      if (t.length < 4 || t.length > 60 || /\s/.test(t)) continue;
      if (!BARE_DOMAIN.test(t)) continue;
      found.push("https://" + t.replace(/^www\./i, "").toLowerCase());
    }
    return found;
  }

  function extractAdData(adEl) {
    // Facebook stores an ad's true destination in data-lynx-uri, leaving href
    // as an internal redirect. Reading only href meant an ACOM ad pointing at
    // acom.com.ph — a domain the SEC has on record — was judged on a
    // facebook.com URL and came back "Name Match Only" instead of verified.
    const raw = [];
    for (const a of adEl.querySelectorAll("a[href], a[data-lynx-uri]")) {
      const lynx = a.getAttribute("data-lynx-uri");
      if (lynx) raw.push(lynx);      // first: it is the real destination
      if (a.href) raw.push(a.href);
    }

    const links = raw
      .map(unwrapFBRedirect)                       // unwrap BEFORE ranking, so
      .filter(href =>                              // redirect shims are judged
        href.startsWith("http") &&                 // on their destination
        !href.includes("facebook.com/ads/library") &&
        !href.includes("/ads/archive")
      );

    // Stable sort keeps DOM order within a rank, so the first store link wins.
    const ranked = links
      .map((href, i) => ({ href, rank: rankLink(href), i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);

    // Fall back to the displayed destination only when no real outbound link
    // exists — a resolved href always outranks a rendered caption.
    let landingUrl = ranked[0]?.href || "";
    let fromCaption = false;
    if (!landingUrl || rankLink(landingUrl) === 2) {
      const caption = captionDomains(adEl).find(u => rankLink(u) !== 2);
      if (caption) {
        landingUrl = caption;
        fromCaption = true;
      }
    }

    return {
      landingUrl,
      destinationFromCaption: fromCaption,
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

    // The backend's /predict returns only the score, so a remotely-served ad
    // arrived with no breakdown and the badge showed the explanatory note above
    // an empty list. Attribution is computed here instead of being added to the
    // API: the bundled model is a bit-for-bit copy of the deployed one
    // (verify_export.py asserts it), so the same inputs give the same
    // contributions either way, and this costs no round trip.
    const withContributions = (result) => {
      if (!result || (Array.isArray(result.contributions) && result.contributions.length)) {
        return result;
      }
      return {
        ...result,
        contributions:
          window.CrediBytesStage1?.explain(advertiserName, appName, hasOfficialWebsite) ?? [],
      };
    };

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
          finish(remote ? withContributions(remote) : localResult());
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
      return { cls: "cb-legitimate", icon: "✓", label: "SEC Verified", bar: "AD VERIFIED" };
    }
    if (legitimacy === "likely_legitimate") {
      return { cls: "cb-likely", icon: "?", label: "Likely Legitimate", bar: "AD LIKELY LEGITIMATE" };
    }
    // The advertiser's name is in the registry, but the ad links to a social or
    // messaging page — never a SEC-declared channel, so the name proves
    // nothing on its own. Ranked above Unverified because we did identify a
    // registrant worth comparing against, and below Likely Legitimate because
    // the link itself carries no evidence.
    if (legitimacy === "name_match_only") {
      return { cls: "cb-namematch", icon: "≈", label: "Name Match Only", bar: "AD NAME MATCH ONLY" };
    }
    if (status === "no_reference_match" && isStoreUrl) {
      return { cls: "cb-danger", icon: "!", label: "Unregistered App", bar: "AD UNREGISTERED!" };
    }
    return { cls: "cb-unverified", icon: "!", label: "Unverified", bar: "AD UNVERIFIED!" };
  }

  // ── Badge injection (createElement — no innerHTML) ───────────────────────────

  function injectBadge(adEl, matchResult, stage1Result, advertiserName) {
    adEl.querySelector("." + BADGE_CLASS)?.remove();

    const { legitimacy, reason, ref, status, suggestion } = matchResult;
    const store      = window.CrediBytesMatcher.isStoreUrl(matchResult._adUrl || "");
    const claimedAppName = matchResult._claimedAppName || "";
    const fromCaption    = !!matchResult._fromCaption;
    const landingHost    = window.CrediBytesMatcher.normHost(matchResult._adUrl || "");
    const riskDesc   = stage1Result?.risk_desc   ?? null;
    const isApp      = stage1Result?.is_app      ?? null;
    const prob       = stage1Result?.probability ?? null;

    const { cls: badgeClass, icon, label, bar } = verdictOf(legitimacy, status, store);

    const badge = document.createElement("div");
    badge.className = BADGE_CLASS + " " + badgeClass;
    applyThemeTo(badge);
    badge.setAttribute("role", "status");

    const iconSpan = document.createElement("span");
    iconSpan.className = "cb-icon";
    iconSpan.textContent = icon;

    const labelSpan = document.createElement("span");
    labelSpan.className = "cb-label";
    labelSpan.textContent = bar || label;

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

    // Option A: the ordered record of what the matcher checked. A verdict that
    // shows its working can be argued with; a bare sentence cannot.
    const trail = Array.isArray(matchResult.evidence) ? matchResult.evidence : [];
    if (trail.length) {
      addSection("How this was checked");
      for (const e of trail) {
        const mark = e.state === "pass" ? "✓ " : e.state === "fail" ? "✕ " : "• ";
        addRow("", mark + e.text);
      }
    } else {
      addRow("", reason);
    }

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

    // Provenance matters: this verdict rests on the destination the ad displays
    // rather than a link we resolved. Meta renders that caption from the real
    // target, but the distinction should be visible rather than implied.
    if (fromCaption && landingHost) {
      addSection("Destination");
      addRow("", `Read from the ad's displayed link (${landingHost}); this preview ` +
                 `exposes no clickable destination.`);
    }

    const contribs = stage1Result?.contributions || [];
    if (riskDesc) {
      addSection("Profile signal — supplementary");
      addRow("", riskDesc);
      // Option B: a bare "23%" invited exactly the wrong reading next to a
      // green verdict. These say which signal moved it and by how much.
      for (const c of contribs.slice(0, 3)) {
        addRow("", `${c.points > 0 ? "+" : ""}${c.points} pts   ${c.label}`);
      }
      if (contribs.length) {
        addRow("", "Points are relative to a typical registrant. This score " +
                   "describes the advertiser's name profile only — it never " +
                   "decides the verdict above.");
      }
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
    applyThemeTo(widget);

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
      /* Floating widget. Matches the popup's card language, but has to carry
         its own palette because it lives in Facebook's page and inherits
         nothing. Same three-state theming as the badge: forced light, forced
         dark, or follow the OS. */
      #cb-floating {
        --f-bg: #ffffff; --f-fg: #12141c; --f-border: #e2e5ec;
        --f-row: #f7f8fa; --f-sub: #5c6270; --f-mute: #969ba8;
        --f-chip-bg: #76b729; --f-chip-fg: #ffffff;
        --f-close-bg: #fdeaec; --f-close-fg: #d62839;
        --f-shadow: rgba(0,0,0,.22);
      }
      @media (prefers-color-scheme: dark) {
        #cb-floating:not(.cb-light) {
          --f-bg: #161922; --f-fg: #e9ebf2; --f-border: #272c39;
          --f-row: #1b1f2a; --f-sub: #9aa0b4; --f-mute: #6b7183;
          --f-chip-bg: #8ccf35; --f-chip-fg: #10160a;
          --f-close-bg: #351319; --f-close-fg: #f0616f;
          --f-shadow: rgba(0,0,0,.55);
        }
      }
      #cb-floating.cb-dark {
        --f-bg: #161922; --f-fg: #e9ebf2; --f-border: #272c39;
        --f-row: #1b1f2a; --f-sub: #9aa0b4; --f-mute: #6b7183;
        --f-chip-bg: #8ccf35; --f-chip-fg: #10160a;
        --f-close-bg: #351319; --f-close-fg: #f0616f;
        --f-shadow: rgba(0,0,0,.55);
      }

      #cb-floating {
        position: fixed; bottom: 80px; right: 16px; width: 280px;
        background: var(--f-bg); color: var(--f-fg);
        border: 1px solid var(--f-border); border-radius: 14px;
        box-shadow: 0 12px 32px var(--f-shadow);
        z-index: 2147483000;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        overflow: hidden; user-select: none;
        animation: cb-pop .18s ease-out;
      }
      #cb-float-header {
        display: flex; align-items: center; gap: 8px;
        padding: 11px 13px; cursor: grab;
        background: var(--f-bg); border-bottom: 1px solid var(--f-border);
      }
      #cb-float-header:active { cursor: grabbing; }
      .cb-float-title { font-size: 14px; font-weight: 800; letter-spacing: -.2px; }
      .cb-float-count {
        font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 999px;
        background: var(--f-chip-bg); color: var(--f-chip-fg);
        transition: background .18s ease;
      }
      .cb-float-spacer { flex: 1; }
      #cb-float-close {
        background: none; border: none; color: var(--f-mute); cursor: pointer;
        font-size: 19px; line-height: 1; padding: 0 2px; border-radius: 6px;
        transition: color .16s ease, background .16s ease, transform .16s ease;
      }
      #cb-float-close:hover {
        color: var(--f-close-fg); background: var(--f-close-bg); transform: rotate(90deg);
      }
      #cb-float-close:active { transform: rotate(90deg) scale(.9); }
      #cb-float-close:focus-visible { outline: 2px solid #76b729; outline-offset: 2px; }
      #cb-float-content { padding: 8px; max-height: 260px; overflow-y: auto; }
      .cb-float-empty {
        padding: 20px 10px; text-align: center; font-size: 12px; color: var(--f-mute);
      }
      .cb-float-row {
        display: flex; align-items: center; gap: 9px;
        padding: 9px 10px; border-radius: 10px; margin-bottom: 4px;
        background: var(--f-row); border-left: 3px solid var(--f-mute);
        transition: transform .14s ease, box-shadow .14s ease;
      }
      .cb-float-row:hover { transform: translateX(2px); box-shadow: 0 2px 8px var(--f-shadow); }
      .cb-float-row.cb-legitimate { border-left-color: #2e9e4f; }
      .cb-float-row.cb-likely     { border-left-color: #17868c; }
      .cb-float-row.cb-namematch  { border-left-color: #7a5cd6; }
      .cb-float-row.cb-unverified { border-left-color: #c98a15; }
      .cb-float-row.cb-danger     { border-left-color: #d62839; }
      .cb-float-dot {
        width: 20px; height: 20px; flex-shrink: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 800; color: #fff;
      }
      .cb-float-dot.cb-legitimate { background: #2e9e4f; }
      .cb-float-dot.cb-likely     { background: #17868c; }
      .cb-float-dot.cb-namematch  { background: #7a5cd6; }
      .cb-float-dot.cb-unverified { background: #c98a15; }
      .cb-float-dot.cb-danger     { background: #d62839; }
      .cb-float-text { display: flex; flex-direction: column; min-width: 0; }
      .cb-float-name {
        font-size: 12.5px; font-weight: 700; color: var(--f-fg);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .cb-float-verdict { font-size: 10.5px; color: var(--f-sub); margin-top: 1px; }
    `;
    document.head.appendChild(s);
  }

  // ── Badge styles ─────────────────────────────────────────────────────────────

  function injectBadgeStyles() {
    if (document.getElementById("credibytes-styles")) return;
    const style = document.createElement("style");
    style.id = "credibytes-styles";
    style.textContent = `
      /* Injected UI shares one entrance animation. Kept short — this appears
         over someone's feed, so it should register without delaying anything. */
      @keyframes cb-pop {
        from { opacity: 0; transform: translateY(-4px) scale(.985); }
        to   { opacity: 1; transform: none; }
      }

      /* Full-width verdict bar. Solid backgrounds throughout: Facebook's own
         dark mode would otherwise show through and wreck the contrast, and this
         element is injected into a page whose CSS we do not control, so nothing
         may be inherited. */
      .credibytes-badge {
        display: flex; align-items: center; gap: 10px;
        padding: 11px 14px; margin: 8px 0; border-radius: 10px;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 14px; font-weight: 800; letter-spacing: .3px; line-height: 1.25;
        border: none; position: relative; z-index: 10; box-sizing: border-box;
        color: #fff;
        animation: cb-pop .2s ease-out;
        transition: box-shadow .18s ease, transform .18s ease;
      }
      .credibytes-badge:hover { box-shadow: 0 3px 12px rgba(0,0,0,.18); }
      .credibytes-badge.cb-legitimate { background:#2e9e4f; }
      .credibytes-badge.cb-likely     { background:#17868c; }
      .credibytes-badge.cb-unverified { background:#e0aa26; color:#3d2c00; }
      .credibytes-badge.cb-danger     { background:#d62839; }
      /* Violet: deliberately not green (not verified) and not red (not an
         accusation) — a registrant was identified but the link proves nothing. */
      .credibytes-badge.cb-namematch  { background:#7a5cd6; }

      .credibytes-badge .cb-icon {
        width: 20px; height: 20px; flex-shrink: 0; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 800;
        background: rgba(255,255,255,.25); color: inherit;
      }
      .credibytes-badge.cb-unverified .cb-icon { background: rgba(0,0,0,.18); }

      .credibytes-badge .cb-label { flex: 1; min-width: 0; }

      .credibytes-badge .cb-toggle {
        font: inherit; font-size: 11px; font-weight: 800; letter-spacing: .5px;
        padding: 5px 14px; border-radius: 999px; cursor: pointer;
        background: rgba(255,255,255,.22); border: none; color: inherit;
        flex-shrink: 0;
        transition: background .16s ease, transform .16s ease;
      }
      .credibytes-badge .cb-toggle:active { transform: scale(.94); }
      .credibytes-badge.cb-unverified .cb-toggle { background: rgba(0,0,0,.14); }
      .credibytes-badge .cb-toggle:hover { background: rgba(255,255,255,.34); }
      .credibytes-badge.cb-unverified .cb-toggle:hover { background: rgba(0,0,0,.22); }
      .credibytes-badge .cb-toggle:focus-visible {
        outline: 2px solid currentColor; outline-offset: 2px;
      }

      /* The expanded analysis. Its own card regardless of the bar colour, so
         long-form text stays readable.

         The palette is held in custom properties on the badge root so the
         light/dark swap happens in ONE place. Three states, mirroring the
         popup: forced light (.cb-light), forced dark (.cb-dark), and neither —
         which leaves prefers-color-scheme in charge. An explicit choice must
         win in both directions, which a bare media query cannot do. */
      .credibytes-badge {
        --d-bg: #ffffff; --d-fg: #24262e; --d-border: #dfe1e8;
        --d-key: #767b8a; --d-sec: #969ab0; --d-line: #ebedf2;
      }
      @media (prefers-color-scheme: dark) {
        .credibytes-badge:not(.cb-light) {
          --d-bg: #171a24; --d-fg: #e9ebf2; --d-border: #2b3040;
          --d-key: #9aa0b4; --d-sec: #757b8f; --d-line: #262b38;
        }
      }
      .credibytes-badge.cb-dark {
        --d-bg: #171a24; --d-fg: #e9ebf2; --d-border: #2b3040;
        --d-key: #9aa0b4; --d-sec: #757b8f; --d-line: #262b38;
      }

      .credibytes-badge .cb-detail {
        position: absolute; top: calc(100% + 5px); left: 0; right: 0;
        background: var(--d-bg); color: var(--d-fg);
        border: 1px solid var(--d-border); border-radius: 12px;
        padding: 13px 15px; font-size: 12px; font-weight: 400;
        letter-spacing: 0; z-index: 100; box-shadow: 0 10px 28px rgba(0,0,0,.18);
        max-height: 320px; overflow-y: auto;
        animation: cb-pop .16s ease-out;
      }
      .credibytes-badge .cb-row {
        display: flex; gap: 8px; padding: 3px 0; line-height: 1.5;
      }
      .credibytes-badge .cb-key {
        flex-shrink: 0; min-width: 92px; color: var(--d-key); font-weight: 600;
      }
      .credibytes-badge .cb-val { color: var(--d-fg); word-break: break-word; }
      .credibytes-badge .cb-section {
        margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--d-line);
        font-size: 9.5px; font-weight: 800; text-transform: uppercase;
        letter-spacing: .7px; color: var(--d-sec);
      }
      .credibytes-badge .cb-section:first-child { margin-top: 0; padding-top: 0; border-top: none; }

      @media (prefers-reduced-motion: reduce) {
        .credibytes-badge, .credibytes-badge *, #cb-floating, #cb-floating * {
          animation: none !important; transition: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Main pipeline ───────────────────────────────────────────────────────────

  async function processAd(adEl) {
    adEl.setAttribute(PROCESSED, "1");

    const { landingUrl, adText, claimedAppName, advertiserName,
            destinationFromCaption } = extractAdData(adEl);
    if (!isOLAAd(adText, landingUrl, advertiserName, claimedAppName)) return;

    const matchResult = window.CrediBytesMatcher.matchUrl(
      landingUrl, claimedAppName, advertiserName
    );
    matchResult._adUrl = landingUrl;
    matchResult._claimedAppName = claimedAppName;
    matchResult._fromCaption = destinationFromCaption;

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
        // What the matcher actually checked, in order, and what each Stage 1
        // signal was worth. Stored rather than recomputed so a scan opened in
        // the popup days later shows the reasoning that produced it.
        evidence: Array.isArray(matchResult.evidence) ? matchResult.evidence : [],
        contributions: stage1Result?.contributions || [],
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
      settings.theme           = data.settings?.theme || "system";

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

        const prevTheme = settings.theme;

        settings.scanningEnabled = next.scanningEnabled !== false;
        settings.displayMode     = next.displayMode || "badge";
        settings.theme           = next.theme || "system";

        if (settings.theme !== prevTheme) refreshTheme();

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