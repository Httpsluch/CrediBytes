/**
 * stage1.js — CrediBytes
 *
 * Runs the Stage 1 LightGBM triage model locally, in the page, instead of
 * calling the FastAPI backend.
 *
 * WHY LOCAL
 * ---------
 * The backend is hosted on Render's free tier, which spins the instance down
 * after ~15 minutes of inactivity. The next request then pays a 30-60s cold
 * start, and the profile score silently went missing from the badge for exactly
 * the users who waited longest. The model is 100 trees at max_depth 3 — about
 * 11 KB exported — so evaluating it here is instant, works offline, and cannot
 * cold-start at all.
 *
 * EXACTNESS
 * ---------
 * This is not an approximation of the backend. It walks the same thresholds and
 * sums the same leaf values LightGBM produced, so it reproduces predict_proba
 * to floating-point precision. Feature construction below mirrors
 * build_features() in main.py field for field; the risk tiers mirror
 * get_risk_label(). CrediBytes-Backend/verify_export.py asserts both against the
 * training set.
 *
 * The backend remains the fallback when the model fails to load, and stays the
 * deployment target for anything that genuinely needs a server.
 */
(function () {
  "use strict";

  // Mirrors URL_PATTERN in main.py.
  const URL_PATTERN = /https?:\/\/|www\.|\.com|\.ph|\.net|\.org/i;

  // Training-set median for the continuous features and mode for the binary ones
  // (dataset_output/ph_ola_model_ready.csv, n=185).
  //
  // Declared once because it does TWO jobs that must never drift apart: it is the
  // ablation baseline in explain(), and it is what buildFeatures() imputes when
  // the advertisement exposes no app name. Written out twice, one copy would
  // eventually be updated without the other — the failure this file has already
  // seen in verdictOf() and the SAVE_SCAN payload.
  const TYPICAL = {
    platform_name_length:      9,
    company_name_length:       31,
    platform_has_loan_keyword: 0,
    platform_has_cash_keyword: 0,
    platform_has_url:          0,
    platform_name_is_single_word: 1,
    has_official_website:      1,
  };

  /**
   * Build the feature vector in the exact order the model was trained on.
   * Order matters: the exported trees address features by index.
   */
  function buildFeatures(companyName, platformName, hasOfficialWebsite) {
    const company  = String(companyName  || "");
    const platform = String(platformName || "");
    const p = platform.toLowerCase();
    // Many ads expose no app name at all — a news-feed post linking to a website,
    // or a card whose title could not be read. "" is not a short app name; it is
    // the absence of one.
    const named = platform.trim().length > 0;

    return {
      // IMPUTED when the app name is unknown, and this is a train/serve fix.
      //
      // Every one of the 185 training rows carries a real platform name, minimum
      // length 4, so the model never saw 0 and never learned what it means. Worse,
      // platform_name_is_single_word = 0 was learned as "a genuine multi-word
      // descriptive phrase" (67 rows) — feeding it for an ad with NO app name
      // asserts something false and lets the trees read signal that is not there.
      // A live JuanHand badge scored 89% on branches partly driven by an app name
      // that was never extracted; imputing typical values gives 63%, which is what
      // the actual evidence (advertiser name + known website) supports.
      //
      // Same defect as has_official_website being hardcoded to 0 (section 3.1):
      // an unknown encoded as a confident, extreme observation.
      //
      // Imputing TYPICAL rather than NaN is deliberate. LightGBM only learns a
      // missing-value direction from missing values it saw in training, and there
      // were none for this feature, so NaN routes arbitrarily — measured, it
      // scores identically to 0 and fixes nothing. TYPICAL makes the feature
      // contribute ~0, which is the honest answer, and explain() then omits these
      // rows entirely rather than reporting a signal it does not have.
      platform_name_length: named ? platform.length : TYPICAL.platform_name_length,
      company_name_length:  company.length,
      // Keyword flags are genuinely 0 for an absent name — "no 'loan' in the app
      // name" is true when there is no app name — and 0 is also their typical
      // value, so they need no special case.
      platform_has_loan_keyword: p.includes("loan") ? 1 : 0,
      platform_has_cash_keyword: p.includes("cash") ? 1 : 0,
      platform_has_url:          URL_PATTERN.test(platform) ? 1 : 0,
      // Replaced platform_has_peso_keyword (2026-08-07), which the model never
      // split on: "peso" marks the sector, and every training row is a lender,
      // so it was constant in the dimension that mattered. A compacted brand
      // ("Pocketcash") and a descriptive phrase ("Peso Cash Loan") are different
      // objects that platform_name_length alone cannot separate.
      platform_name_is_single_word: named
        ? (platform.trim().split(/\s+/).filter(Boolean).length === 1 ? 1 : 0)
        : TYPICAL.platform_name_is_single_word,
      // 0 is correct for advertisers absent from the SEC reference: there,
      // "no known official website" is a true statement, not a missing value.
      has_official_website:      hasOfficialWebsite ? 1 : 0,
    };
  }

  function walk(node, values) {
    // Internal nodes are arrays, leaves are plain numbers.
    while (Array.isArray(node)) {
      const [feature, threshold, defaultLeft, left, right] = node;
      const v = values[feature];
      if (v === undefined || v === null || Number.isNaN(v)) {
        node = defaultLeft ? left : right;      // honour LightGBM's missing-value direction
      } else {
        node = v <= threshold ? left : right;
      }
    }
    return node;
  }

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  // Mirrors get_risk_label() in main.py. These strings must match the backend's
  // character for character — a user switching between the local and fallback
  // paths must not see the badge reword itself. verify_export.py diffs them.
  function riskLabel(probability) {
    const pct = Math.round(probability * 100);
    if (probability >= 0.70) {
      return ["High",
        `Profile score: ${pct}% — profile strongly matches patterns of SEC-registered OLA platforms.`];
    }
    if (probability >= 0.45) {
      return ["Moderate",
        `Profile score: ${pct}% — profile partially matches patterns of SEC-registered OLA platforms.`];
    }
    return ["Low",
      `Profile score: ${pct}% — profile does not match typical patterns of SEC-registered OLA platforms.`];
  }

  function isReady() {
    const m = window.CrediBytesStage1Model;
    return !!(m && Array.isArray(m.trees) && m.trees.length && Array.isArray(m.features));
  }

  // ── Score attribution ──────────────────────────────────────────────────────
  //
  // A bare "Profile score: 23%" is not an explanation, and it invites exactly
  // the wrong reading. A MegaPeso ad that Stage 2 had verified outright by Apple
  // ID showed 23%, which looked like the extension contradicting itself; the
  // real cause was that its registrant had no website on record, and that single
  // feature is worth ~55 points to this model.
  //
  // Each contribution is measured by ABLATION: recompute the probability with
  // one feature moved to its dataset-typical value and report the difference.
  // The result is exact for the question asked ("what is this feature worth
  // HERE, holding the rest fixed") and needs no extra data at inference — it is
  // 7 extra passes over 100 depth-3 trees, which is nothing.
  //
  // This is not TreeSHAP. Contributions do not sum to the prediction and are not
  // claimed to; they are a per-feature sensitivity, which is what a reader of
  // the badge actually wants to know.
  //
  // The baseline IS the imputation target — see TYPICAL at the top of the file.
  // One declaration, so a future change to the training set cannot move the
  // ablation reference without also moving what an unknown app name becomes.
  const BASELINE = TYPICAL;

  // Plain-language names. The badge is read by people checking a loan advert,
  // not by anyone who knows what "platform_name_is_single_word" means.
  //
  // These take the VALUE, and that is the whole point of the shape. They used to
  // be fixed strings naming the feature, which meant a row could assert the
  // opposite of the input: an advertiser with no website on record rendered
  //
  //     -25   known official website
  //
  // and a multi-word app name rendered "+32 app name is a single word". Both
  // read as statements of fact about the ad, and both were false — the number is
  // what the feature is worth HERE, and for a binary feature that is usually the
  // value being ABSENT. A reader has no way to tell which from the label alone.
  //
  // Reported from a live badge (WealthKites, Pinansyal na Tagapayo): two of the
  // four rows on each card stated the reverse of the truth. `value` was already
  // being computed and returned by explain(); it was simply never used.
  const FEATURE_LABEL = {
    platform_name_length:      v => `app name length (${v} chars)`,
    company_name_length:       v => `advertiser name length (${v} chars)`,
    platform_has_loan_keyword: v => v ? "“loan” in the app name"
                                      : "no “loan” in the app name",
    platform_has_cash_keyword: v => v ? "“cash” in the app name"
                                      : "no “cash” in the app name",
    platform_has_url:          v => v ? "a web address in the app name"
                                      : "no web address in the app name",
    platform_name_is_single_word: v => v ? "app name is a single word"
                                         : "app name is several words",
    has_official_website:      v => v ? "known official website"
                                      : "no official website on record",
  };

  function labelFor(feature, value) {
    const fn = FEATURE_LABEL[feature];
    return fn ? fn(value) : feature;
  }

  function scoreProbability(values) {
    const model = window.CrediBytesStage1Model;
    let raw = 0;
    for (const tree of model.trees) raw += walk(tree, values);
    return sigmoid(raw);
  }

  /**
   * Per-feature contributions, largest absolute effect first.
   * @returns [{ feature, label, value, points }] where `points` is the
   *          percentage-point change this feature's actual value causes
   *          relative to a typical registrant. Empty if the model is missing.
   */
  function explain(companyName, platformName, hasOfficialWebsite) {
    if (!isReady()) return [];

    const model = window.CrediBytesStage1Model;
    const named = buildFeatures(companyName, platformName, hasOfficialWebsite);
    const values = model.features.map(f => named[f]);
    const base   = scoreProbability(values);

    const out = [];
    model.features.forEach((f, i) => {
      if (!(f in BASELINE)) return;
      if (named[f] === BASELINE[f]) return;          // already typical, no story
      const swapped = values.slice();
      swapped[i] = BASELINE[f];
      const points = Math.round((base - scoreProbability(swapped)) * 100);
      if (points !== 0) {
        out.push({ feature: f, label: labelFor(f, named[f]), value: named[f], points });
      }
    });

    return out.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  }

  /**
   * @returns the same shape the backend's /predict returns, so callers cannot
   *          tell the two apart, or null if the model is unavailable.
   */
  function predict(companyName, platformName, hasOfficialWebsite) {
    if (!isReady()) return null;

    const model = window.CrediBytesStage1Model;
    const named = buildFeatures(companyName, platformName, hasOfficialWebsite);

    // Positional vector, ordered by the model's own feature list.
    const values = model.features.map(f => named[f]);

    const probability = scoreProbability(values);
    const [label, desc] = riskLabel(probability);

    return {
      is_app:      probability >= 0.5,
      probability: Math.round(probability * 10000) / 10000,
      pct:         Math.round(probability * 100),
      risk_label:  label,
      risk_desc:   desc,
      company:     String(companyName || ""),
      source:      "local",     // "remote" when the backend answered instead
      // Why the score is what it is — see explain(). The backend does not
      // return this, so content.js computes it locally either way.
      contributions: explain(companyName, platformName, hasOfficialWebsite),
    };
  }

  window.CrediBytesStage1 = { predict, isReady, buildFeatures, riskLabel, explain };
})();
