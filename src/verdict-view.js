/**
 * verdict-view.js — CrediBytes
 *
 * Everything both surfaces need to DISPLAY a verdict, in one place.
 *
 * The inline badge (content.js) and the popup card (popup.js) render the same
 * information in the same words. Keeping the mapping here is not tidiness: the
 * badge and the popup have already drifted apart twice in this codebase — the
 * verdictOf() if/else was duplicated, and so was the SAVE_SCAN payload, which is
 * how isStoreUrl went missing from one copy and broke a whole tier of the popup.
 *
 * SIX INTERNAL STATES, THREE DISPLAYED ONES
 * -----------------------------------------
 * The matcher distinguishes six outcomes. Users get three:
 *
 *     legitimate                        -> VERIFIED     Confirmed
 *     likely_legitimate, name_match_only-> UNVERIFIED    Possible Match
 *     unverified                        -> UNVERIFIED    Not found
 *     danger  (unregistered app)        -> FLAGGED       Not found
 *     revoked                           -> FLAGGED       Revoked
 *
 * The internal tier is NOT collapsed — background.js counts by it and popup.js
 * filters by it, so it stays a six-valued identifier. Only the presentation
 * narrows, and the registration line preserves what the colour cannot: a revoked
 * registrant reads "Revoked", never "Not found", because it HAS a record and
 * saying otherwise would be false.
 */
(function () {
  "use strict";

  const T = (key, params, lang) => {
    const I = window.CrediBytesI18n;
    return I ? I.t(key, params, lang) : key;
  };

  // tier -> { state, cls, statusKey }
  const VIEW = {
    legitimate: { state: "verified",   cls: "cb-v-verified",   statusKey: "card.status.confirmed" },
    likely:     { state: "unverified", cls: "cb-v-unverified", statusKey: "card.status.possible" },
    namematch:  { state: "unverified", cls: "cb-v-unverified", statusKey: "card.status.possible" },
    unverified: { state: "unverified", cls: "cb-v-unverified", statusKey: "card.status.notFound" },
    danger:     { state: "flagged",    cls: "cb-v-flagged",    statusKey: "card.status.notFound" },
    revoked:    { state: "flagged",    cls: "cb-v-flagged",    statusKey: "card.status.revoked" },
  };

  const MEANS = {
    legitimate: "means.verified", likely: "means.possible", namematch: "means.possible",
    unverified: "means.notFound", danger: "means.flagged",  revoked: "means.revoked",
  };
  const ACTION = {
    legitimate: "action.verified", likely: "action.possible", namematch: "action.possible",
    unverified: "action.notFound", danger: "action.flagged",  revoked: "action.revoked",
  };

  /** Mirrors verdictOf()/tierOf(); records saved before `tier` existed lack it. */
  function tierOf(scan) {
    if (scan.tier && VIEW[scan.tier]) return scan.tier;
    if (scan.legitimacy === "revoked")           return "revoked";
    if (scan.legitimacy === "legitimate")        return "legitimate";
    if (scan.legitimacy === "likely_legitimate") return "likely";
    if (scan.legitimacy === "name_match_only")   return "namematch";
    if (scan.status === "no_reference_match" && scan.isStoreUrl) return "danger";
    return "unverified";
  }

  /**
   * Everything a card or badge draws, already translated.
   *
   * `scan` is the stored SAVE_SCAN payload, so this works identically for a live
   * verdict and for one read back out of history months later.
   */
  function present(scan, lang) {
    const tier = tierOf(scan);
    const v = VIEW[tier];

    // Company line. A possible match names the registrant WITHOUT its SEC
    // number: printing the number next to an unconfirmed match is the single
    // easiest way to make a guess look like a finding.
    let company;
    if (tier === "legitimate" || tier === "revoked") {
      company = scan.company
        ? T("card.company.named", { company: scan.company, sec: scan.sec || "—" }, lang)
        : T("card.company.none", null, lang);
    } else if (scan.company) {
      company = T("card.company.possible", { company: scan.company }, lang);
    } else if (scan.suggestion && scan.suggestion.company) {
      company = T("card.company.possible", { company: scan.suggestion.company }, lang);
    } else {
      company = T("card.company.none", null, lang);
    }

    return {
      tier,
      state: v.state,
      cls: v.cls,
      stateLabel: T("card.state." + v.state, null, lang),
      regLabel: T("card.regLabel", null, lang),
      status: T(v.statusKey, null, lang),
      companyLabel: T("card.companyLabel", null, lang),
      company,
      means: T(MEANS[tier], null, lang),
      action: T(ACTION[tier], null, lang),
      checks: checks(scan, lang),
    };
  }

  /**
   * The three fixed rows under "How this was checked".
   *
   * Fixed rather than free-form on purpose. The evidence trail this replaces was
   * accurate but variable-length and written for a reader who already knew what
   * a package id was; Panel 1 asked how a digitally or financially illiterate
   * user would be informed. Three constant rows always answer the same three
   * questions — where does it go, is the app declared, does the name match — so
   * a user learns the shape once.
   */
  function checks(scan, lang) {
    const none = T("check.none", null, lang);

    const dest = scan.destHost || none;

    let pkg;
    if (!scan.isStoreUrl) pkg = T("check.pkgNotStore", null, lang);
    else if (scan.tier === "legitimate" || scan.legitimacy === "legitimate" ||
             scan.legitimacy === "revoked") pkg = T("check.pkgMatch", null, lang);
    else pkg = T("check.pkgNoMatch", null, lang);

    const nameMatched = !!scan.company;
    const name = nameMatched ? T("check.nameMatch", null, lang)
                             : T("check.nameNoMatch", null, lang);

    return [
      T("check.destination", { value: dest }, lang),
      T("check.package", { value: pkg }, lang),
      T("check.name", { value: name }, lang),
    ];
  }

  window.CrediBytesVerdictView = { present, tierOf, VIEW };
})();
