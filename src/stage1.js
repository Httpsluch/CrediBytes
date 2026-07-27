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

  /**
   * Build the feature vector in the exact order the model was trained on.
   * Order matters: the exported trees address features by index.
   */
  function buildFeatures(companyName, platformName, hasOfficialWebsite) {
    const company  = String(companyName  || "");
    const platform = String(platformName || "");
    const p = platform.toLowerCase();

    return {
      platform_name_length:      platform.length,
      company_name_length:       company.length,
      platform_has_loan_keyword: p.includes("loan") ? 1 : 0,
      platform_has_cash_keyword: p.includes("cash") ? 1 : 0,
      platform_has_peso_keyword: p.includes("peso") ? 1 : 0,
      platform_has_url:          URL_PATTERN.test(platform) ? 1 : 0,
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

    let raw = 0;
    for (const tree of model.trees) raw += walk(tree, values);

    const probability = sigmoid(raw);
    const [label, desc] = riskLabel(probability);

    return {
      is_app:      probability >= 0.5,
      probability: Math.round(probability * 10000) / 10000,
      pct:         Math.round(probability * 100),
      risk_label:  label,
      risk_desc:   desc,
      company:     String(companyName || ""),
      source:      "local",     // "remote" when the backend answered instead
    };
  }

  window.CrediBytesStage1 = { predict, isReady, buildFeatures, riskLabel };
})();
