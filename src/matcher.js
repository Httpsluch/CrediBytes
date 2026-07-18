/**
 * matcher.js — CrediBytes
 * SEC OLA reference lookup — JavaScript port of match_ad_links.py
 *
 * OPTIMIZED: SEC_REFERENCE array is pre-indexed into Maps on load,
 * turning all Pass 1 lookups from O(N) loops into O(1) Map.get() calls.
 * Only Pass 2 (domain) and Pass 3 (name) still iterate — both are
 * skipped entirely for store URLs, keeping the common path fast.
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

  // ── Main matcher ───────────────────────────────────────────────────────────

  function matchUrl(adUrl, claimedAppName = "", claimedCompany = "", fixedAppleUrl = "") {
    if (!adUrl) {
      return result("no_url", null, "broken_or_missing_link",
        "No redirect URL found in this ad.");
    }

    const adPlayId  = playPackageId(adUrl);
    const adAppleId = appleAppId(adUrl) || appleAppId(fixedAppleUrl);
    const adHost    = normHost(adUrl);
    const store     = isStoreUrl(adUrl);

    // Pass 1 — O(1) exact store ID lookups via Maps
    if (adPlayId) {
      const ref = playIndex.get(adPlayId);
      if (ref) return result("exact_play_store_package_match", ref, "legitimate",
        `Play Store package ID matches SEC-registered app: "${ref.appName || ref.company}" (${ref.sec}).`);
    }
    if (adAppleId) {
      const ref = appleIndex.get(adAppleId);
      if (ref) return result("exact_app_store_id_match", ref, "legitimate",
        `App Store ID matches SEC-registered app: "${ref.appName || ref.company}" (${ref.sec}).`);
    }

    // Store URL with no ID match → definitively unregistered, skip remaining passes
    if (store) {
      return result("no_reference_match", null, "unverified",
        "This app's package ID or Apple ID has no SEC registration — it may be an undeclared or illegal lending application.");
    }

    // Pass 2 — domain / subdomain match via Map (non-store only)
    if (adHost) {
      // Exact host match
      const ref = domainIndex.get(adHost);
      if (ref) return result("same_domain_match", ref, "legitimate",
        `Domain matches SEC-registered website of "${ref.company}" (${ref.sec}).`);

      // Subdomain match: walk up the hostname and check each suffix
      const parts = adHost.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join(".");
        const parentRef = domainIndex.get(suffix);
        if (parentRef) return result("same_domain_match", parentRef, "legitimate",
          `Subdomain matches SEC-registered website of "${parentRef.company}" (${parentRef.sec}).`);
      }
    }

    // Pass 3 — exact normalized name match via Maps (non-store only)
    const normApp     = normalizeName(claimedAppName);
    const normCompany = normalizeName(claimedCompany);

    if (normApp) {
      const candidates = appNameIndex.get(normApp) || [];
      for (const ref of candidates) {
        const refCompany = normalizeName(ref.company);
        if (normCompany && refCompany && normCompany === refCompany) {
          return result("exact_name_match", ref, "legitimate",
            `App name and company name match SEC registry: "${ref.company}" (${ref.sec}).`);
        }
        return result("app_name_match", ref, "likely_legitimate",
          `App name matches SEC registry entry for "${ref.company}" (${ref.sec}), but company name differs.`);
      }
    }

    if (normCompany && !normApp) {
      const candidates = companyIndex.get(normCompany) || [];
      for (const ref of candidates) {
        if (!normalizeName(ref.appName)) {
          return result("exact_company_name_match", ref, "legitimate",
            `Company name matches SEC-registered entity: "${ref.company}" (${ref.sec}).`);
        }
      }
    }

    return result("no_reference_match", null, "unverified",
      "No matching SEC-registered OLA found for this ad link.");
  }

  function result(status, ref, legitimacy, reason) {
    return { status, ref, legitimacy, reason };
  }

  window.CrediBytesMatcher = { matchUrl, playPackageId, appleAppId, normHost, isStoreUrl };

})();
