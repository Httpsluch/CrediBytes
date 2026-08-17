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

  // ── SEC revoked / suspended list ───────────────────────────────────────────
  // Panel 1 and Panel 3 both asked for the SEC blacklist to reach users. The
  // obstacle is evidential: of 1,413 revoked and suspended entries, 3 carry a
  // SEC registration number. The rest are a company name and a date.
  //
  // So this list can only be reached by NAME — the one thing this file refuses
  // to treat as proof anywhere else. The refusal is kept, and made symmetric:
  //
  //   A name must not VERIFY an ad     (Pass 3 → name_match_only, not legitimate)
  //   A name must not CONDEMN a company (a match here → advisory, not a verdict)
  //
  // The second half matters more than it looks. Every other verdict errs toward
  // "we could not confirm this", which is safe to be wrong about. A revocation
  // notice is the first claim made AGAINST a named business, so a false positive
  // tells users a currently-licensed lender lost its authority. Two companies
  // sharing a name is enough to cause that.
  //
  // Only ref.revoked — written into the registry after a person checked the
  // registration numbers — is allowed to change a badge, and it is reached
  // through a declared URL, so the revocation attaches to a registrant the ad
  // already proved it belongs to.

  // Codes map to translation KEYS; the wording lives in i18n.js.
  // Translation shim. i18n.js loads before this file in the manifest; the guard
  // exists because a matcher that throws would take the whole verdict with it,
  // and an untranslated key on screen is far better than no badge at all.
  const T = (key, params, lang) => {
    const I = window.CrediBytesI18n;
    return I ? I.t(key, params, lang) : key;
  };

  // Codes map to translation KEYS; the wording lives in i18n.js.
  const REVOKED_CATEGORY = {
    RL: "revoked.RL", RF: "revoked.RF", SL: "revoked.SL",
    RP: "revoked.RP", RT: "revoked.RT", CD: "revoked.CD",
  };

  // Map<normalisedName, entry>. Mirrors normalise() in build_revoked_reference.py
  // — the two must agree or the shipped keys are unreachable.
  const revokedIndex = new Map();

  const REVOKED_SUFFIX = new Set([
    "inc", "incorporated", "corp", "corporation", "co", "company", "ltd",
    "limited", "llc", "ph", "philippines", "philippine", "the",
  ]);
  const REVOKED_DBA =
    /\b(doing business|operating under|formerly|dba|under the (?:business )?name)\b/;

  function normalizeRevoked(value) {
    let s = String(value || "").toLowerCase();
    s = s.split(REVOKED_DBA)[0];
    s = s.replace(/[^a-z0-9\s]/g, " ");
    return s.split(/\s+/).filter(w => w && !REVOKED_SUFFIX.has(w)).join(" ").trim();
  }

  if (typeof REVOKED_REFERENCE !== "undefined") {
    for (const e of REVOKED_REFERENCE) revokedIndex.set(e.k, e);
  }

  // Exact normalised match only. Fuzzy matching is deliberately absent: the
  // suggestion engine above can afford a near-miss because it labels itself a
  // suggestion, and this cannot.
  function lookupRevoked(name) {
    const key = normalizeRevoked(name);
    if (key.length < 6) return null;   // short keys collide with ordinary words
    return revokedIndex.get(key) || null;
  }

  // Company names on the SEC list frequently end in an abbreviation ("Corp.",
  // "Inc."), and every template that interpolates one also ends the sentence —
  // which rendered "declared by Wefund Lending Corp.." on a live badge.
  function nm(company) {
    return String(company || "").replace(/\.\s*$/, "");
  }

  // Returns a DESCRIPTOR, not a sentence: { key, params } that i18n resolves at
  // render time. Baking the wording in here would freeze the clause in whichever
  // language was active when the scan was saved.
  function revokedDescriptor(entry) {
    return {
      key: entry.d ? "revoked.on" : "revoked.noDate",
      params: { what: { key: REVOKED_CATEGORY[entry.c] || "revoked.fallback" },
                date: entry.d },
    };
  }

  // Convenience for callers that want it rendered now (badge detail rows).
  function revokedWording(entry, lang) {
    const d = revokedDescriptor(entry);
    return T(d.key, d.params, lang);
  }

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

  // The advertiser name and the claimed app name are INDEPENDENT pieces of
  // evidence, so they are scored separately and the best is taken. Concatenating
  // them first meant one could bury the other.
  //
  // Measured on a live Cashalo advertisement. Facebook renders a link-preview
  // headline ("Convenient application") which getAppName() picks up, so the
  // query became "Convenient application Cashalo" -> {convenient, application,
  // cashalo}. Against Cashalo's own registry entry {cashalo, paloo} that is
  // 1/min(3,2) = 0.50, under the 0.60 threshold — and the suggestion vanished
  // even though the advertiser name alone scores 1.00.
  //
  // That is the Kviku problem again (see tokenOverlap above), arriving through
  // the query instead of the reference: a distinctive brand matched exactly and
  // was discarded because something wordier was bolted onto it. Containment
  // fixed the reference side; scoring the fields apart fixes the query side.
  //
  // Recall is the right thing to buy here. This function only ever produces a
  // SUGGESTION, rendered under a "Possible match" heading — Pass 3 still refuses
  // to verify on a name, so nothing about the verdict is loosened.
  function findClosestSecEntry(claimedAppName, claimedCompany) {
    const queries = [
      tokenize(String(claimedAppName || "").trim()),
      tokenize(String(claimedCompany || "").trim()),
      tokenize((claimedAppName + " " + claimedCompany).trim()),
    ].filter(q => q.length);
    if (!queries.length) return null;

    let bestRef   = null;
    let bestScore = 0;

    for (const ref of SEC_REFERENCE) {
      const refTokens = tokenize((ref.appName + " " + ref.company).trim());
      let score = 0;
      for (const q of queries) score = Math.max(score, tokenOverlap(q, refTokens));
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

  // The revoked-list checks are applied here rather than inside runMatch() so
  // they cannot be reached by any code path that skips them, and so the twelve
  // `return result(...)` sites below stay unaware of them — nothing in the
  // matching logic should be able to consult a revocation while deciding.
  function matchUrl(adUrl, claimedAppName = "", claimedCompany = "", fixedAppleUrl = "") {
    const out = runMatch(adUrl, claimedAppName, claimedCompany, fixedAppleUrl);
    const trail = out.evidence;

    // Path A — VERDICT. The ad was matched to this registrant through a declared
    // channel, and that registrant is flagged revoked in the registry after a
    // human check. The revocation is a fact about an entity already identified,
    // so it may change the badge.
    if (out.ref && out.ref.revoked && out.legitimacy === "legitimate") {
      const e = out.ref.revoked;
      const pA = { company: nm(out.ref.company), status: revokedDescriptor(e) };
      trail.push({ state: "fail", key: "ev.revokedVerdict", params: pA,
                   text: T("ev.revokedVerdict", pA) });
      const rp = { company: out.ref.company, sec: out.ref.sec, status: revokedDescriptor(e) };
      return {
        ...out,
        legitimacy: "revoked",
        status: "registrant_revoked",
        revoked: { ...e, company: out.ref.company, verdict: true },
        reasonKey: "reason.revoked", reasonParams: rp,
        reason: T("reason.revoked", rp),
      };
    }

    // Path B — ADVISORY. The advertiser's NAME matches a revoked entry. Nothing
    // ties the ad to that entity beyond the name, so this is recorded and shown,
    // and the verdict is returned exactly as the matcher decided it.
    const advisory = lookupRevoked(claimedCompany) || lookupRevoked(claimedAppName);
    if (advisory && !(out.ref && out.ref.revoked)) {
      const pB = { name: advisory.n, status: revokedDescriptor(advisory) };
      trail.push({ state: "info", key: "ev.revokedAdvisory", params: pB,
                   text: T("ev.revokedAdvisory", pB) });
      return { ...out, revoked: { ...advisory, verdict: false } };
    }

    return out;
  }

  function runMatch(adUrl, claimedAppName = "", claimedCompany = "", fixedAppleUrl = "") {
    // Running record of what was actually checked, in the order it was checked.
    // The badge used to state a conclusion and nothing else; this lets it show
    // its working, so a reader can see which signals were available, which
    // matched, and which were deliberately skipped. Purely descriptive — nothing
    // here influences the verdict.
    const trail = [];
    // Entries carry a KEY and PARAMS, not a sentence. `text` is rendered
    // alongside them so existing readers keep working, but content.js and
    // popup.js re-render from key+params at display time — which is what lets a
    // scan recorded months ago read in whatever language is selected now.
    const note = (state, key, params) => {
      trail.push({ state, key, params: params || null, text: T(key, params) });
    };

    if (!adUrl) {
      note("fail", "ev.noDestination");
      return result("no_url", null, "broken_or_missing_link",
        "reason.noUrl", null, null, trail);
    }

    const adPlayId  = playPackageId(adUrl);
    const adAppleId = appleAppId(adUrl) || appleAppId(fixedAppleUrl);
    const adHost    = normHost(adUrl);
    const store     = isStoreUrl(adUrl);

    note("info", "ev.destination", { host: adHost || adUrl });

    // Pass 1 — O(1) exact store ID lookups via Maps
    if (adPlayId) {
      const ref = playIndex.get(adPlayId);
      if (ref) {
        note("pass", "ev.playDeclared", { pkg: adPlayId, company: nm(ref.company) });
        return result("exact_play_store_package_match", ref, "legitimate",
          "reason.playMatch", { app: ref.appName || ref.company, sec: ref.sec }, null, trail);
      }
      note("fail", "ev.playNotFound", { pkg: adPlayId });
    }
    if (adAppleId) {
      const ref = appleIndex.get(adAppleId);
      if (ref) {
        note("pass", "ev.appleDeclared", { id: adAppleId, company: nm(ref.company) });
        return result("exact_app_store_id_match", ref, "legitimate",
          "reason.appleMatch", { app: ref.appName || ref.company, sec: ref.sec }, null, trail);
      }
      note("fail", "ev.appleNotFound", { id: adAppleId });
    }

    // Store URL with no ID match → definitively unregistered, skip remaining passes
    if (store) {
      const suggestion = findClosestSecEntry(claimedAppName, claimedCompany);
      note("info", "ev.storeSkipName");
      return result("no_reference_match", null, "unverified",
        "reason.storeNoMatch", null, suggestion, trail);
    }

    // Pass 2 — domain / subdomain match via Map (non-store only)
    if (adHost) {
      // Exact host match
      const ref = domainIndex.get(adHost);
      if (ref) {
        note("pass", "ev.websiteDeclared", { host: adHost, company: nm(ref.company) });
        return result("same_domain_match", ref, "legitimate",
          "reason.domainMatch", { company: ref.company, sec: ref.sec }, null, trail);
      }

      // Subdomain match: walk up the hostname and check each suffix
      const parts = adHost.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join(".");
        const parentRef = domainIndex.get(suffix);
        if (parentRef) {
          note("pass", "ev.subdomainDeclared",
               { host: adHost, suffix, company: nm(parentRef.company) });
          return result("same_domain_match", parentRef, "legitimate",
            "reason.subdomainMatch", { company: parentRef.company, sec: parentRef.sec }, null, trail);
        }
      }
    }

    // Pass 3 — exact normalized name match via Maps (non-store only)
    if (adHost) note("fail", "ev.hostNotDeclared", { host: adHost });

    const normApp     = normalizeName(claimedAppName);
    const normCompany = normalizeName(claimedCompany);
    const social      = isSocialUrl(adUrl);
    if (social) note("info", "ev.socialDestination");

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
    // `whatKey` names WHICH text matched, and is itself translated — the phrase
    // is a grammatical subject in both languages, so it cannot be concatenated.
    const nameMatchOnly = (ref, whatKey) => (
      note("fail", "ev.nameNotChannel", { what: T(whatKey), company: nm(ref.company) }),
      result(
        "name_match_only", ref, "name_match_only",
        "reason.nameMatchOnly",
        { what: T(whatKey), company: ref.company, sec: ref.sec,
          dest: T(social ? "dest.social" : "dest.other") },
        null, trail));

    if (normApp) {
      const candidates = appNameIndex.get(normApp) || [];
      for (const ref of candidates) {
        const refCompany = normalizeName(ref.company);
        if (normCompany && refCompany && normCompany === refCompany) {
          return nameMatchOnly(ref, "what.appAndCompany");
        }
        // App name matches but the company differs — weaker still, and kept as
        // "likely legitimate" only when the link is at least a real site rather
        // than a social page.
        if (social) return nameMatchOnly(ref, "what.appName");
        note("info", "ev.appNameCompanyDiffers", { company: nm(ref.company) });
        return result("app_name_match", ref, "likely_legitimate",
          "reason.appNameMatch", { company: ref.company, sec: ref.sec }, null, trail);
      }
    }

    if (normCompany && !normApp) {
      const candidates = companyIndex.get(normCompany) || [];
      for (const ref of candidates) {
        if (!normalizeName(ref.appName)) {
          return nameMatchOnly(ref, "what.companyName");
        }
      }
    }

    // No match — run fuzzy suggestion before returning unverified
    if (normApp || normCompany) {
      note("fail", "ev.nameNoMatch");
    }
    const suggestion = findClosestSecEntry(claimedAppName, claimedCompany);
    return result("no_reference_match", null, "unverified",
      "reason.noMatch", null, suggestion, trail);
  }

  // 4th/5th args: reasonKey + reasonParams — a translation key and its
  //   substitutions, NOT a sentence. `reason` is rendered from them so existing
  //   readers keep working, while content.js and popup.js re-render at display
  //   time in whatever language is selected.
  // 6th arg: suggestion — closest SEC entry by name overlap, or null
  // 7th arg: evidence   — ordered record of what was checked (see matchUrl)
  function result(status, ref, legitimacy, reasonKey, reasonParams, suggestion, evidence) {
    return {
      status, ref, legitimacy,
      reasonKey, reasonParams: reasonParams || null,
      reason: T(reasonKey, reasonParams),
      suggestion, evidence: evidence || [],
    };
  }

  window.CrediBytesMatcher = { matchUrl, playPackageId, appleAppId, normHost, isStoreUrl, isSocialUrl,
                               mentionsKnownRegistrant, lookupRevoked, revokedWording,
                               revokedCount: revokedIndex.size };

})();
