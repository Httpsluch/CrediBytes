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

async function fetchPlay(pkg) {
  const r = await fetch(
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=PH`);
  if (!r.ok) throw new Error(`play ${r.status}`);
  const ds = parsePlayDatasets(await r.text());
  const d = ds["ds:5"];
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

async function fetchApple(appId) {
  const r = await fetch(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=ph`);
  if (!r.ok) throw new Error(`apple ${r.status}`);
  const j = await r.json();
  const a = j.results && j.results[0];
  if (!a) throw new Error("not in the PH storefront");
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
    // against the live API — so absence here says nothing either way.
    policy: "",
    contentRating: a.contentAdvisoryRating || "",
  };
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
    has_privacy_policy: L.policy ? 1 : 0,
    privacy_policy_is_free_host: L.policy ? (FREE_POLICY_HOST.test(L.policy) ? 1 : 0) : 0,
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
};
