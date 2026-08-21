/**
 * stage3.js — CrediBytes
 *
 * Reads an advertised app's store listing and scores it with the Stage 3 model:
 * given a store-linked advertisement, does this listing look like the ones SEC
 * registrants actually declare?
 *
 * Runs in the service worker, not the page — Facebook's CSP blocks cross-origin
 * fetch from content scripts, and MV3 workers are exempt.
 *
 * ON REQUEST, NEVER AUTOMATICALLY
 * -------------------------------
 * Fetching a listing for every store-linked ad a user scrolls past would mean
 * hundreds of requests per session, which Google rate limits, and would have the
 * browser quietly contacting Google about every app a user sees. A deliberate
 * click per card removes both, needs no cache warming, has no latency budget to
 * blow, and turns a failed read into something visible rather than silent.
 *
 * WHY NOT REGEX THE PAGE
 * ----------------------
 * There is no public Google Play API for app metadata — the Android Publisher
 * API covers only apps you own. But Play embeds the page's OWN structured data
 * in AF_initDataCallback blocks, keyed ds:0..ds:N, and indexes into it by
 * numeric path. That is what actually feeds the render, so it is language and
 * layout independent:
 *
 *     regex the visible HTML     structured blob
 *     "10,000,000+"       ->     17392132   (exact)
 *     "4.7"               ->     4.6711235  (full precision)
 *     "Updated on Jan 5"  ->     1785324705 (unix, language-free)
 *
 * It also fails differently, which matters more. The v1.0 enrichment bug was
 * regexes that matched NOTHING and reported zeros as if they were measurements.
 * A missing path here returns undefined, which becomes NaN — and Stage 3 was
 * trained with missing values present (49/130 missing installs, 87/130 missing
 * review counts), so LightGBM learned a real direction for them. NaN is the
 * honest encoding here, unlike Stage 1 where no missing values existed in
 * training and NaN would have routed arbitrarily.
 */

// Paths into the ds:5 dataset. Lifted from the same specification the
// google-play-scraper library uses, and verified against a live listing.
const PLAY_SPEC = {
  title:         [1, 2, 0, 0],
  realInstalls:  [1, 2, 13, 2],
  score:         [1, 2, 51, 0, 1],
  ratings:       [1, 2, 51, 2, 1],
  reviews:       [1, 2, 51, 3, 1],
  developer:     [1, 2, 68, 0],
  privacyPolicy: [1, 2, 99, 0, 5, 2],
  contentRating: [1, 2, 9, 0],
  updated:       [1, 2, 145, 0, 1, 0],
};

// Policies parked on a free host are a documented signal — a lender that has
// not bothered with its own domain for a legal document.
const FREE_POLICY_HOST =
  /(blogspot|wordpress\.com|sites\.google|weebly|wixsite|github\.io|firebaseapp|000webhost|blogger)/i;

const DAY_MS = 86400000;

function pathGet(root, path) {
  let n = root;
  for (const i of path) {
    if (n === null || n === undefined) return undefined;
    n = n[i];
  }
  return n === null ? undefined : n;
}

/** Pull every AF_initDataCallback dataset out of a Play listing page. */
function parsePlayDatasets(html) {
  const out = {};
  const blocks = html.match(/AF_initDataCallback[\s\S]*?<\/script/g) || [];
  for (const b of blocks) {
    const k = /(ds:.*?)'/.exec(b);
    const v = /data:([\s\S]*?), sideChannel: \{\}\}\);<\//.exec(b);
    if (!k || !v) continue;
    try { out[k[1]] = JSON.parse(v[1]); } catch (_e) { /* skip a malformed block */ }
  }
  return out;
}

// The fields that make a dataset the APP RECORD rather than something that
// merely has a string where the title lives.
const CORE_FIELDS = ["title", "developer", "realInstalls", "ratings", "updated"];

/**
 * Find the dataset holding the app record.
 *
 * NOT hardcoded to ds:5 — that index is Google's internal ordering and a
 * renumbering would empty every field while the card still rendered.
 *
 * But "first dataset with a string title" is not enough either, and that was a
 * live bug: on most listings ds:11 carries the single letter "i" at exactly the
 * title path, so it won the scan and produced a card showing one row and a
 * confident percentage. Measured on the same page:
 *
 *     ds:5    6/6 fields   'Cashify PH-Fast and Safe Cash'  3,199,675 installs
 *     ds:11   1/6 fields   'i'
 *
 * So SCORE the candidates and take the richest, requiring the title to be
 * corroborated by at least one other core field. A coincidental string cannot
 * out-score a real record, and if the paths ever genuinely stop resolving we
 * throw instead of reporting a listing built from one accident.
 */
function findAppDataset(ds) {
  let best = null, bestScore = 0;
  for (const key of Object.keys(ds)) {
    const d = ds[key];
    const title = pathGet(d, PLAY_SPEC.title);
    if (typeof title !== "string" || !title.trim()) continue;
    let score = 0;
    for (const f of CORE_FIELDS) if (pathGet(d, PLAY_SPEC[f]) !== undefined) score++;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

async function fetchPlay(pkg) {
  const r = await fetch(
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=PH`);
  // Play answers 403 to a request carrying Sec-Fetch-Mode: cors, which is what
  // fetch() sends. Surface it rather than letting an empty body parse to a
  // listing full of blanks that still scores.
  if (!r.ok) throw new Error(`play ${r.status}`);
  const ds = parsePlayDatasets(await r.text());
  const d = findAppDataset(ds);
  if (!d) throw new Error("no listing data");

  const g = (k) => pathGet(d, PLAY_SPEC[k]);
  const policy = g("privacyPolicy");
  const updated = g("updated");                       // unix seconds
  return {
    isPlay: 1,
    title: g("title") || "",
    developer: g("developer") || "",
    installs: typeof g("realInstalls") === "number" ? g("realInstalls") : undefined,
    rating: typeof g("score") === "number" ? g("score") : undefined,
    reviews: typeof g("ratings") === "number" ? g("ratings") : undefined,
    updatedMs: typeof updated === "number" ? updated * 1000 : undefined,
    policy: policy || "",
    contentRating: g("contentRating") || "",
  };
}

/**
 * Refuse to report a listing we could not actually read.
 *
 * Without this, a page that parsed but yielded nothing produced a panel with a
 * single row and a confident percentage — worse than an error, because it looks
 * like a measurement. Same failure the v1.0 enrichment had.
 */
function assertReadable(L) {
  if (!String(L.title || "").trim() && !String(L.developer || "").trim()) {
    throw new Error("listing unreadable");
  }
  return L;
}

/* ── Data safety ──────────────────────────────────────────────────────────────
 *
 * Panel 3 asked whether lending apps harvest phone numbers, contacts and social
 * media (P3-6a). Play requires every developer to declare exactly that, and
 * publishes it as a Data safety section — so the answer is the developer's own
 * statement to Google, not our inference. That is why this is DISPLAYED and is
 * NOT a Stage 3 feature: it is a compliance disclosure to report, not a signal
 * for guessing whether the SEC registered someone.
 *
 * It lives on a separate page from the listing, so this is a second fetch. A
 * failure here must never take down the listing panel that already works.
 *
 * PARSING: the categories are a fixed vocabulary Google publishes, and the page
 * marks up sections as <h2> and categories as <h3>. Both are anchors that mean
 * something. The CSS classes on those tags (aFEzEb, fozKzd) are obfuscated build
 * output and would churn without warning — the same reason the listing itself
 * reads structured data instead of rendered text.
 *
 * Service workers have no DOMParser, hence regex over tags rather than a tree
 * walk. Bounded to tag names, so it degrades to "nothing declared" rather than
 * to something wrong.
 */
const DS_CATEGORIES = new Set([
  "Location", "Personal info", "Financial info", "Health and fitness",
  "Messages", "Photos and videos", "Audio files", "Audio", "Files and docs",
  "Calendar", "Contacts", "App activity", "Web browsing",
  "App info and performance", "Device or other IDs",
]);

// The categories the NPC guidance and Panel 3 actually name. Personal info is
// handled separately — it is near-universal and only its "Phone number" subtype
// is the concern.
const DS_SENSITIVE = new Set([
  "Contacts", "Messages", "Location", "Photos and videos", "Calendar",
  "Audio files", "Audio", "Files and docs",
]);

const stripTags = (s) =>
  String(s).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function parseDataSafety(html) {
  const collected = [], shared = [];
  let section = null, encrypted = false, deletable = false, sawPage = false;

  // h2 = section, h3 = category. Matched in document order so a category is
  // attributed to the section it appears under.
  const re = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text) continue;

    if (tag === "h1") { if (/^data safety$/i.test(text)) sawPage = true; continue; }

    if (tag === "h2") {
      if (/^no data (shared|collected)/i.test(text)) section = null;
      else if (/^data shared/i.test(text)) section = shared;
      else if (/^data collected/i.test(text)) section = collected;
      else section = null;                       // "Security practices" and any future section
      continue;
    }

    // h3 under Security practices states the practice itself.
    if (/encrypted in transit/i.test(text)) { encrypted = true; continue; }
    if (/request that data be deleted/i.test(text)) { deletable = true; continue; }

    if (!section || !DS_CATEGORIES.has(text)) continue;
    // The subtypes sit in the div immediately after the heading.
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const d = /<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(after);
    section.push({ category: text, detail: d ? stripTags(d[1]) : "" });
  }

  if (!sawPage) return null;                     // page did not render — say nothing

  const flags = [];
  for (const e of collected.concat(shared)) {
    if (DS_SENSITIVE.has(e.category)) flags.push(e.category);
    // "Personal info" is declared by nearly every app; only the phone number
    // subtype is what Panel 3 asked about.
    else if (e.category === "Personal info" && /phone number/i.test(e.detail)) {
      flags.push("Phone number");
    }
  }
  return {
    store: "play",
    collected, shared, encrypted, deletable,
    sensitive: [...new Set(flags)],
  };
}

async function fetchDataSafety(pkg) {
  const r = await fetch(
    `https://play.google.com/store/apps/datasafety?id=${encodeURIComponent(pkg)}&hl=en&gl=PH`);
  if (!r.ok) throw new Error(`datasafety ${r.status}`);
  return parseDataSafety(await r.text());
}

/* ── Apple's App Privacy labels ────────────────────────────────────────────────
 *
 * Apple requires the same kind of declaration Google does, and publishes it on
 * the store page as embedded JSON rather than as a separate page. So P3-6a is
 * answerable on BOTH stores, not just Play.
 *
 * The structures do not line up exactly and are not forced to:
 *
 *   Play    "Data shared" / "Data collected", 14 categories
 *   Apple   DATA_USED_TO_TRACK_YOU / DATA_LINKED_TO_YOU / DATA_NOT_LINKED_TO_YOU
 *
 * Apple's tracking bucket has no Play equivalent and is reported on its own —
 * "used to track you across apps owned by other companies" is a stronger
 * statement than "collected", and flattening it into the collected list would
 * lose the part a reader most needs.
 *
 * DATA_NOT_COLLECTED is Apple stating the developer declared nothing. That is a
 * real observation and must stay distinct from a page we could not read, which
 * returns null — the same rule as everywhere else (section 3.15).
 */
const APPLE_SENSITIVE = /^(Contacts|Location|Sensitive Info|User Content|Browsing History|Search History)$/i;
const APPLE_PHONE = /phone number/i;

function parseAppleDataSafety(html) {
  const m = /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (_e) { return null; }

  const types = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (o.$kind === "PrivacyType") types.push(o);
    for (const v of Object.values(o)) walk(v);
  })(data);
  if (!types.length) return null;

  const linked = [], notLinked = [], tracking = [];
  const seen = new Set();
  for (const pt of types) {
    if (seen.has(pt.identifier)) continue;      // the page repeats each block
    seen.add(pt.identifier);
    const cats = [];
    (function wc(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { for (const v of o) wc(v); return; }
      if (o.$kind === "PrivacyCategory") {
        cats.push({ category: String(o.title || ""),
                    detail: (o.dataTypes || []).join(", ") });
      }
      for (const v of Object.values(o)) wc(v);
    })(pt);
    // Apple's three buckets are kept apart, because the distinction IS the
    // disclosure. Merging them printed "Identifiers - User ID, Device ID" twice
    // on a live card (once from each bucket) and, worse, lost the difference
    // between data tied to your identity and data that is not.
    if (pt.identifier === "DATA_USED_TO_TRACK_YOU") tracking.push(...cats);
    else if (pt.identifier === "DATA_LINKED_TO_YOU") linked.push(...cats);
    else if (pt.identifier === "DATA_NOT_LINKED_TO_YOU") notLinked.push(...cats);
    // DATA_NOT_COLLECTED contributes nothing by design: it is the developer
    // declaring an empty set, which is a real observation, not a failed read.
  }

  const flags = [];
  for (const e of linked.concat(notLinked, tracking)) {
    if (APPLE_SENSITIVE.test(e.category)) flags.push(e.category);
    else if (/^contact info$/i.test(e.category) && APPLE_PHONE.test(e.detail)) {
      flags.push("Phone number");
    }
  }
  return {
    store: "apple",
    // `collected` stays the primary list so the renderer needs no special case;
    // for Apple that means the data Apple says is LINKED to your identity.
    collected: linked, notLinked, shared: [], tracking,
    // Apple publishes no equivalent of Play's encryption/deletion practices.
    // undefined, not false: we did not look, rather than looked and found none.
    encrypted: undefined, deletable: undefined,
    sensitive: [...new Set(flags)],
  };
}

async function fetchApple(appId) {
  const r = await fetch(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=ph`);
  if (!r.ok) throw new Error(`apple ${r.status}`);
  const j = await r.json();
  const a = j.results && j.results[0];
  if (!a) throw new Error("not in the PH storefront");
  const extras = await applePage(appId);
  return {
    isPlay: 0,
    title: a.trackName || "",
    developer: a.sellerName || a.artistName || "",
    // Apple never publishes install counts. Left undefined -> NaN, which is
    // exactly how the 49 Apple rows looked during training.
    installs: undefined,
    rating: typeof a.averageUserRating === "number" ? a.averageUserRating : undefined,
    reviews: typeof a.userRatingCount === "number" ? a.userRatingCount : undefined,
    updatedMs: a.currentVersionReleaseDate
      ? Date.parse(a.currentVersionReleaseDate) : undefined,
    // The iTunes lookup API has no privacyPolicyUrl key at all — confirmed
    // against the live API. So it is read from the store PAGE instead, which is
    // what enrich_model_features.py does and where training's values for all 38
    // Apple rows (26 with a policy, 12 without) came from.
    //
    // undefined when the page cannot be read: UNKNOWN, not absent. Sending ""
    // here is what previously told the model every Apple app lacks a policy and
    // printed "Privacy policy: none listed" for apps that plainly have one.
    policy: extras ? extras.policy : undefined,
    dataSafety: extras ? extras.dataSafety : null,
    contentRating: a.contentAdvisoryRating || "",
  };
}

// Apple and Google each render their OWN privacy links on every app page, ahead
// of the developer's, so "first href mentioning privacy" returns Apple's policy
// for every app on the store. Same list and same ranking as
// extract_privacy_policy() in enrich_model_features.py.
const PLATFORM_PP_HOSTS =
  /(^|\.)(apple\.com|cdn-apple\.com|google\.com|gstatic\.com|googleusercontent\.com|googleapis\.com)$/i;

function extractPrivacyPolicy(html) {
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m, exact = "", loose = "";
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[2]).toLowerCase();
    if (!text.includes("privacy")) continue;
    const href = m[1].replace(/&amp;/g, "&").trim();
    if (!/^https?:\/\//i.test(href)) continue;
    let host = "";
    try { host = new URL(href).hostname; } catch (_e) { continue; }
    if (PLATFORM_PP_HOSTS.test(host)) continue;
    if (text.includes("privacy policy")) { if (!exact) exact = href; }
    else if (!loose) loose = href;
  }
  return exact || loose;
}

// One fetch, two extractions. The policy and the privacy labels live on the
// same page, and fetching it twice would double the button's network cost for
// no reason.
async function applePage(appId) {
  try {
    const r = await fetch(
      `https://apps.apple.com/ph/app/id${encodeURIComponent(appId)}`);
    if (!r.ok) return null;                        // could not look
    const html = await r.text();
    return { policy: extractPrivacyPolicy(html),   // "" means looked, found none
             dataSafety: parseAppleDataSafety(html) };
  } catch (_e) {
    return null;
  }
}

/** Same containment formula as tokenOverlap() in matcher.js. */
const DEV_STOP = new Set(["inc", "incorporated", "corp", "corporation", "co", "company",
  "ltd", "limited", "llc", "ph", "philippines", "philippine", "the", "lending",
  "financing", "finance", "technology", "technologies", "app", "online"]);

function devMatches(developer, advertiser) {
  const tok = (s) => new Set(String(s || "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w && !DEV_STOP.has(w)));
  const a = tok(developer), b = tok(advertiser);
  if (!a.size || !b.size) return undefined;          // unknown, not "no"
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.min(a.size, b.size) >= 0.6 ? 1 : 0;
}

/**
 * The 15 features, in the order the exported trees address them.
 *
 * undefined becomes NaN in the vector. That is deliberate everywhere it
 * appears: the model saw missing values for these columns in training and
 * learned where to send them.
 */
function buildFeatures3(L, advertiserName) {
  const title = String(L.title || "").toLowerCase();
  const days = L.updatedMs !== undefined
    ? Math.max(0, Math.round((Date.now() - L.updatedMs) / DAY_MS)) : undefined;

  return {
    is_play_store: L.isPlay,
    install_count_num: L.installs,
    rating_num: L.rating,
    review_count_num: L.reviews,
    days_since_last_update: days,
    // undefined means "not looked at"; "" means "looked, and there is none".
    // Collapsing the two is how every Apple app came to report no policy.
    has_privacy_policy: L.policy === undefined ? undefined : (L.policy ? 1 : 0),
    privacy_policy_is_free_host: L.policy === undefined ? undefined
      : (L.policy ? (FREE_POLICY_HOST.test(L.policy) ? 1 : 0) : 0),
    developer_name_length: String(L.developer || "").length,
    app_title_length: String(L.title || "").length,
    dev_matches_advertiser: devMatches(L.developer, advertiserName),
    title_has_loan_keyword: title.includes("loan") ? 1 : 0,
    title_has_cash_keyword: title.includes("cash") ? 1 : 0,
    title_has_peso_keyword: title.includes("peso") ? 1 : 0,
    content_rating_is_everyone: /everyone|rated for 3/i.test(L.contentRating || "") ? 1 : 0,
    // The fetch succeeded, so the listing resolves.
    listing_live: 1,
  };
}

// Identical evaluator to stage1.js: internal nodes are arrays, leaves are plain
// numbers, and defaultLeft honours the direction LightGBM learned for missing
// values.
function walk3(node, values) {
  while (Array.isArray(node)) {
    const [feature, threshold, defaultLeft, left, right] = node;
    const v = values[feature];
    if (v === undefined || v === null || Number.isNaN(v)) node = defaultLeft ? left : right;
    else node = v <= threshold ? left : right;
  }
  return node;
}

function score3(named) {
  // globalThis: this file is imported by the service worker (self) and loaded
  // into a page by the test harness (window). globalThis is both.
  const model = globalThis.CrediBytesStage3Model;
  if (!model || !Array.isArray(model.trees)) return null;
  const values = model.features.map(f => {
    const v = named[f];
    return v === undefined || v === null ? NaN : v;
  });
  let raw = 0;
  for (const t of model.trees) raw += walk3(t, values);
  return 1 / (1 + Math.exp(-raw));
}

globalThis.CrediBytesStage3 = {
  fetchPlay, fetchApple, buildFeatures3, score3, parsePlayDatasets, devMatches,
  findAppDataset, assertReadable, fetchDataSafety, parseDataSafety,
  extractPrivacyPolicy, parseAppleDataSafety,
};
