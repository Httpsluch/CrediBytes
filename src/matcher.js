/**
 * matcher.js — CrediBytes
 * SEC OLA reference lookup — JavaScript port of match_ad_links.py
 *
 * OPTIMIZED: SEC_REFERENCE array is pre-indexed into Maps on load,
 * turning all Pass 1 lookups from O(N) loops into O(1) Map.get() calls.
 * Only Pass 2 (domain) and Pass 3 (name) still iterate — both are
 * skipped entirely for store URLs, keeping the common path fast.
 *
 * v1.1 additions:
 *   - findClosestSecEntry()  — token-overlap fuzzy suggestion (≥40% threshold)
 *   - result() now accepts 5th argument: suggestion (may be null)
 *   - Both no_reference_match returns include a fuzzy suggestion when possible
 */

(function () {

  // ── Helpers ────────────────────────────────────────────────────────────────

  function normHost(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function isStoreUrl(url) {
    const h = normHost(url);
    return h === "play.google.com" || h === "apps.apple.com" || h === "itunes.apple.com";
  }

  // Social and messaging destinations. These can never be SEC-declared digital
  // channels — a registrant declares apps and websites, not a Facebook page —
  // so a name match against one of these cannot verify an advertisement.
  const SOCIAL_HOSTS = [
    "facebook.com", "fb.com", "fb.me", "m.me", "messenger.com",
    "instagram.com", "wa.me", "whatsapp.com", "t.me", "telegram.me",
    "tiktok.com", "viber.com",
  ];

  function isSocialUrl(url) {
    const h = normHost(url);
    if (!h) return false;
    return SOCIAL_HOSTS.some(d => h === d || h.endsWith("." + d));
  }

  function playPackageId(url) {
    try {
      const u = new URL(url);
      if (normHost(url) !== "play.google.com") return "";
      return (u.searchParams.get("id") || "").toLowerCase();
    } catch { return ""; }
  }

  function appleAppId(url) {
    try {
      const h = normHost(url);
      if (h !== "apps.apple.com" && h !== "itunes.apple.com") return "";
      for (const p of new URL(url).pathname.split("/").filter(Boolean)) {
        if (p.startsWith("id") && /^\d+$/.test(p.slice(2))) return p.toLowerCase();
      }
      return "";
    } catch { return ""; }
  }

  function normalizeName(value) {
    return (value || "").toLowerCase()
      .replace(/\./g, "").replace(/,/g, "").replace(/-/g, " ").trim();
  }

  // ── O(1) indexes built once at load time ───────────────────────────────────

  // Map<playPackageId, ref>
  const playIndex = new Map();
  // Map<appleAppId, ref>
  const appleIndex = new Map();
  // Map<hostname, ref>   — one entry per unique host
  const domainIndex = new Map();
  // Map<normalizedAppName, ref[]>
  const appNameIndex = new Map();
  // Map<normalizedCompanyName, ref[]>
  const companyIndex = new Map();

  function buildIndexes() {
    for (const ref of SEC_REFERENCE) {
      if (ref.playPkg)  playIndex.set(ref.playPkg, ref);
      if (ref.appleId)  appleIndex.set(ref.appleId, ref);
      if (ref.website && !domainIndex.has(ref.website)) {
        domainIndex.set(ref.website, ref);
      }

      const na = normalizeName(ref.appName);
      if (na) {
        if (!appNameIndex.has(na)) appNameIndex.set(na, []);
        appNameIndex.get(na).push(ref);
      }

      const nc = normalizeName(ref.company);
      if (nc) {
        if (!companyIndex.has(nc)) companyIndex.set(nc, []);
        companyIndex.get(nc).push(ref);
      }
    }
  }

  buildIndexes();

  // ── Fuzzy suggestion (token overlap ≥ 40%) ────────────────────────────────
  // Used only for unverified results to surface the closest SEC entry by name.
  // Explicitly labeled as a suggestion, never as a verification.

  // Stop-words for fuzzy suggestion only. Beyond corporate suffixes this now
  // drops generic lending vocabulary, because those words are shared by most
  // entries in the registry and so carry no identifying signal. Leaving them in
  // caused both misses and false hits: "Online Cash Loan Fast" used to match an
  // unrelated registrant purely on the word "cash".
  const SUGGEST_STOP = new Set([
    // corporate suffixes / geography
    "inc", "corp", "corporation", "company", "co", "the", "of", "and",
    "lending", "finance", "financing", "services", "group", "technologies",
    "tech", "ph", "philippine", "philippines",
    // generic product vocabulary
    "online", "loan", "loans", "app", "apps", "cash", "credit", "money",
    "pera", "peso", "pesos", "lend", "borrow",
    // generic marketing adjectives
    "fast", "quick", "instant", "easy", "mobile",
  ]);

  function tokenize(str) {
    return str.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1 && !SUGGEST_STOP.has(t));
  }

  // Containment (intersection / smaller set), not Jaccard.
  //
  // Jaccard divides by the union, so a short advertiser name is punished for
  // the registry entry being wordier. "Kviku Philippines" reduces to {kviku};
  // against {kviku, online, loans} that is 1/3 = 0.33 and fell under the old
  // 0.40 threshold — the brand name matched exactly and was still discarded.
  // Containment scores that 1.0. Generic words are removed by SUGGEST_STOP
  // first, so a match here means the distinctive tokens genuinely coincide.
  function tokenOverlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let common = 0;
    for (const t of setA) { if (setB.has(t)) common++; }
    return common / Math.min(setA.size, setB.size);
  }

  function findClosestSecEntry(claimedAppName, claimedCompany) {
    const queryTokens = tokenize((claimedAppName + " " + claimedCompany).trim());
    if (queryTokens.length === 0) return null;

    let bestRef   = null;
    let bestScore = 0;

    for (const ref of SEC_REFERENCE) {
      const refTokens = tokenize((ref.appName + " " + ref.company).trim());
      const score = tokenOverlap(queryTokens, refTokens);
      if (score > bestScore) {
        bestScore = score;
        bestRef   = ref;
      }
    }

    // 0.60 on containment. Higher than the old 0.40 because containment scores
    // more generously; combined with the wider stop-list this raised recall
    // (Kviku, Cashbee and Tala were all being missed) while removing a false
    // positive on purely generic advertiser names.
    return bestScore >= 0.60 ? bestRef : null;
  }

  // ── Registry brand recognition ─────────────────────────────────────────────
  // Distinctive brand tokens drawn from every registered app and company name,
  // used to recognise an OLA advertisement that contains no lending vocabulary
  // at all. A JuanHand ad reading "Relate na relate kami, Donna Cariaga! Good
  // thing, nandiyan si JuanHand para sa'yo!" has no keyword to match, yet
  // JuanHand is a registered platform of Wefund Lending Corp.
  //
  // Tokens shorter than four characters are dropped: they collide with ordinary
  // words far too easily, and a false positive here pulls unrelated ads into
  // the scanner.
  // Brands are matched whole, not token by token.
  //
  // Matching individual tokens was far too loose: "digital" (First Digital
  // Finance), "pocket" (Peso Pocket) and "star" are ordinary words, so
  // "Only Digital Library", "Pocket Toons" and "Star Runner Comics" all looked
  // like registrants. It also MISSED real ones, because advertisers close up
  // the spaces the registry uses — "MegaPeso" tokenises to {megapeso}, which
  // matches neither {mega} nor {peso}.
  //
  // Comparing compacted strings (letters and digits only) handles both: spacing
  // and punctuation stop mattering, and a 5-character minimum keeps generic
  // fragments out.
  const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // Only corporate suffixes and geography are stripped here — NOT the product
  // vocabulary that SUGGEST_STOP removes. Those words are part of the brand:
  // strip "peso" from "Peso Pocket" and the key collapses to the generic
  // "pocket", which then matched "Pocket Toons - Fantasy & Action"; strip it
  // from "Mega Peso" and there is nothing left to match "MegaPeso" against.
  const BRAND_STOP = new Set([
    "inc", "corp", "corporation", "company", "co", "the", "of", "and",
    "lending", "finance", "financing", "services", "group", "technologies",
    "tech", "ph", "philippine", "philippines", "incorporated", "limited", "ltd",
  ]);

  function brandWords(str) {
    return String(str || "").toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 1 && !BRAND_STOP.has(t));
  }

  const REGISTRY_BRANDS = new Set();
  for (const ref of SEC_REFERENCE) {
    for (const source of [ref.appName, ref.company]) {
      const words = brandWords(source);
      if (!words.length) continue;
      // Whole name and its leading two words: the registry writes
      // "Mega Peso-Fast Cash Easy Loan" where an advertiser just says "MegaPeso".
      // Five characters is the floor — "Kviku Lending Co. Inc." reduces to the
      // single word "kviku", and a stricter bound silently dropped it.
      for (const cand of [words.join(""), words.slice(0, 2).join("")]) {
        if (cand.length >= 5) REGISTRY_BRANDS.add(cand);
      }
      // The leading word alone, at a higher bar. "JuanHand-online cash loan App"
      // is advertised as plain "JuanHand", which matches neither the full name
      // nor its first two words.
      //
      // Seven characters, not six: "Pocket Cash - Digital Loan" contributed the
      // head "pocket", which then matched "Pocket Toons - Fantasy & Action".
      // Ordinary nouns tend to be short, so the length bound is doing the work
      // a curated blocklist otherwise would.
      if (words[0].length >= 7) REGISTRY_BRANDS.add(words[0]);
    }
  }

  function mentionsKnownRegistrant(text) {
    const hay = compact(text);
    if (hay.length < 5) return false;
    for (const brand of REGISTRY_BRANDS) {
      if (hay.includes(brand)) return true;
    }
    return false;
  }

  // ── Main matcher ───────────────────────────────────────────────────────────

  function matchUrl(adUrl, claimedAppName = "", claimedCompany = "", fixedAppleUrl = "") {
    if (!adUrl) {
      return result("no_url", null, "broken_or_missing_link",
        "No redirect URL found in this ad.", null);
    }

    const adPlayId  = playPackageId(adUrl);
    const adAppleId = appleAppId(adUrl) || appleAppId(fixedAppleUrl);
    const adHost    = normHost(adUrl);
    const store     = isStoreUrl(adUrl);

    // Pass 1 — O(1) exact store ID lookups via Maps
    if (adPlayId) {
      const ref = playIndex.get(adPlayId);
      if (ref) return result("exact_play_store_package_match", ref, "legitimate",
        `Play Store package ID matches SEC-registered app: "${ref.appName || ref.company}" (${ref.sec}).`, null);
    }
    if (adAppleId) {
      const ref = appleIndex.get(adAppleId);
      if (ref) return result("exact_app_store_id_match", ref, "legitimate",
        `App Store ID matches SEC-registered app: "${ref.appName || ref.company}" (${ref.sec}).`, null);
    }

    // Store URL with no ID match → definitively unregistered, skip remaining passes
    if (store) {
      const suggestion = findClosestSecEntry(claimedAppName, claimedCompany);
      return result("no_reference_match", null, "unverified",
        "This app's package ID or Apple ID has no SEC registration — it may be an undeclared or illegal lending application.",
        suggestion);
    }

    // Pass 2 — domain / subdomain match via Map (non-store only)
    if (adHost) {
      // Exact host match
      const ref = domainIndex.get(adHost);
      if (ref) return result("same_domain_match", ref, "legitimate",
        `Domain matches SEC-registered website of "${ref.company}" (${ref.sec}).`, null);

      // Subdomain match: walk up the hostname and check each suffix
      const parts = adHost.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join(".");
        const parentRef = domainIndex.get(suffix);
        if (parentRef) return result("same_domain_match", parentRef, "legitimate",
          `Subdomain matches SEC-registered website of "${parentRef.company}" (${parentRef.sec}).`, null);
      }
    }

    // Pass 3 — exact normalized name match via Maps (non-store only)
    const normApp     = normalizeName(claimedAppName);
    const normCompany = normalizeName(claimedCompany);
    const social      = isSocialUrl(adUrl);

    // A Facebook page, profile or Messenger thread is never a SEC-declared
    // digital channel, so matching text alone must not verify the ad.
    //
    // Previously it did: matchUrl("https://m.me/snapcashph", "", "Snapcash
    // Lending Inc.") returned "legitimate" and rendered a green SEC Verified
    // badge. Anyone can put a registered company's name on a page, which is
    // exactly the impersonation pattern reported.
    //
    // The verdict is deliberately neutral rather than accusatory: legitimate
    // Philippine lenders do run "message us" campaigns, so a Messenger link is
    // not evidence of fraud — it is simply not something we can verify. The
    // matched ref is still returned so the UI can show the entity's real
    // declared channels for the user to compare against.
    // Reaching Pass 3 means the URL already failed every declared-channel
    // check, so a matching name CANNOT verify it — the name says who the ad
    // claims to be, the link says where it actually goes, and only the link is
    // something the SEC has on record.
    //
    // Restricting this to social URLs was not enough. A lookalike domain such
    // as acom-loans-ph.xyz is not social, matched no declared channel, and
    // still earned a green "SEC Verified" badge purely because the advertiser
    // typed a registered company's name — the same spoof as the Messenger case
    // but harder to spot.
    const nameMatchOnly = (ref, what) => result(
      "name_match_only", ref, "name_match_only",
      `${what} matches SEC-registered "${ref.company}" (${ref.sec}), but this ad links to ` +
      (social
        ? "a social or messaging page, which is not a SEC-declared channel."
        : "a destination that is not among that registrant's SEC-declared channels.") +
      " Verify via the official links below.",
      null);

    if (normApp) {
      const candidates = appNameIndex.get(normApp) || [];
      for (const ref of candidates) {
        const refCompany = normalizeName(ref.company);
        if (normCompany && refCompany && normCompany === refCompany) {
          return nameMatchOnly(ref, "App and company name");
        }
        // App name matches but the company differs — weaker still, and kept as
        // "likely legitimate" only when the link is at least a real site rather
        // than a social page.
        if (social) return nameMatchOnly(ref, "App name");
        return result("app_name_match", ref, "likely_legitimate",
          `App name matches SEC registry entry for "${ref.company}" (${ref.sec}), but company name differs ` +
          `and the link is not a declared channel.`, null);
      }
    }

    if (normCompany && !normApp) {
      const candidates = companyIndex.get(normCompany) || [];
      for (const ref of candidates) {
        if (!normalizeName(ref.appName)) {
          return nameMatchOnly(ref, "Company name");
        }
      }
    }

    // No match — run fuzzy suggestion before returning unverified
    const suggestion = findClosestSecEntry(claimedAppName, claimedCompany);
    return result("no_reference_match", null, "unverified",
      "No matching SEC-registered OLA found for this ad link.", suggestion);
  }

  // 5th arg: suggestion — closest SEC entry by name overlap, or null
  function result(status, ref, legitimacy, reason, suggestion) {
    return { status, ref, legitimacy, reason, suggestion };
  }

  window.CrediBytesMatcher = { matchUrl, playPackageId, appleAppId, normHost, isStoreUrl, isSocialUrl,
                               mentionsKnownRegistrant };

})();
