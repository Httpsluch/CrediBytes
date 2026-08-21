/**
 * i18n.js — CrediBytes
 *
 * WHY NOT chrome.i18n
 * -------------------
 * Chrome's built-in _locales system picks the language from the BROWSER locale
 * and cannot be changed at runtime. Panel 1 asked how a digitally or financially
 * illiterate user would be informed; a Filipino user running Chrome in English
 * is exactly that person, and they need to be able to choose. So this is a
 * user-selectable setting, which chrome.i18n cannot provide.
 *
 * WHY KEYS AND PARAMS, NOT SENTENCES
 * ----------------------------------
 * matcher.js used to build its evidence trail by concatenation:
 *
 *     `${adHost} is a SEC-declared website of ${ref.company}.`
 *
 * A saved scan then held English forever, and switching language would leave old
 * scans untranslated. Verdict text is now emitted as { key, params } and rendered
 * at DISPLAY time, so a scan recorded months ago re-reads in whatever language is
 * selected now.
 *
 * Word order differs between the two languages, which is the other reason
 * concatenation had to go: Tagalog puts the predicate first, so "X is declared by
 * Y" and "Idineklara ng Y ang X" cannot share a template built from fragments.
 *
 * ON THE TAGALOG
 * --------------
 * Written as the natural Taglish Filipinos actually read in financial and
 * technical contexts, not formal literary Tagalog. "App", "website", "package
 * ID", "SEC" and "link" stay in English because translating them ("aplikasyon",
 * "pook-sapot") makes the text HARDER to read for the audience this is meant to
 * protect. The grammar is Tagalog; the terminology is what people use.
 *
 * Risk descriptions are deliberately NOT translated here — see stage1.js.
 * verify_export.py asserts those match the backend character for character, so
 * they stay English at the model layer and are translated at render instead.
 */
(function () {
  "use strict";

  const LANGS = { en: "English", tl: "Tagalog" };
  const DEFAULT_LANG = "en";

  const STRINGS = {
    en: {
      // ── Verdicts ─────────────────────────────────────────────────────────
      "verdict.revoked.label": "Authority Revoked",
      "verdict.revoked.bar": "AD AUTHORITY REVOKED",
      "verdict.legitimate.label": "SEC Verified",
      "verdict.legitimate.bar": "AD VERIFIED",
      "verdict.likely.label": "Likely Legitimate",
      "verdict.likely.bar": "AD LIKELY LEGITIMATE",
      "verdict.namematch.label": "Name Match Only",
      "verdict.namematch.bar": "AD NAME MATCH ONLY",
      "verdict.danger.label": "Unregistered App",
      "verdict.danger.bar": "AD UNREGISTERED",
      "verdict.unverified.label": "Unverified",
      "verdict.unverified.bar": "AD UNVERIFIED",

      // ── Evidence trail ───────────────────────────────────────────────────
      "ev.noDestination": "No destination could be read from this ad.",
      "ev.destination": "Destination: {host}",
      "ev.playDeclared": "Play package {pkg} is declared by {company}.",
      "ev.playNotFound": "Play package {pkg} is not in the SEC registry.",
      "ev.appleDeclared": "Apple ID {id} is declared by {company}.",
      "ev.appleNotFound": "Apple ID {id} is not in the SEC registry.",
      "ev.storeSkipName":
        "Name matching skipped: this is a store link, and a company can advertise " +
        "an undeclared app under its own name.",
      "ev.websiteDeclared": "{host} is a SEC-declared website of {company}.",
      "ev.subdomainDeclared": "{host} is a subdomain of {suffix}, declared by {company}.",
      "ev.hostNotDeclared": "{host} is not among any registrant's declared websites.",
      "ev.socialDestination":
        "This destination is a social or messaging page, never a SEC-declared channel.",
      "ev.nameNotChannel": "{what} matches {company}, but a name is not a declared channel.",
      "ev.appNameCompanyDiffers":
        "App name matches {company}'s entry, but the company name differs.",
      "ev.nameNoMatch": "The advertised name matches no SEC registry entry exactly.",
      "ev.revokedVerdict":
        "{company} appears on the SEC's revoked list. {status}",
      "ev.revokedAdvisory":
        "An entity named “{name}” appears on the SEC's revoked list. {status} " +
        "This ad has not been shown to belong to it.",

      // ── Verdict reasons ──────────────────────────────────────────────────
      "reason.noUrl": "No redirect URL found in this ad.",
      "reason.playMatch": "Play Store package ID matches SEC-registered app: “{app}” ({sec}).",
      "reason.appleMatch": "App Store ID matches SEC-registered app: “{app}” ({sec}).",
      "reason.storeNoMatch":
        "This app's package ID or Apple ID has no SEC registration — it may be an " +
        "undeclared or illegal lending application.",
      "reason.domainMatch": "Domain matches SEC-registered website of “{company}” ({sec}).",
      "reason.subdomainMatch": "Subdomain matches SEC-registered website of “{company}” ({sec}).",
      "reason.nameMatchOnly":
        "{what} matches SEC-registered “{company}” ({sec}), but this ad links to {dest} " +
        "Verify via the official links below.",
      "reason.appNameMatch":
        "App name matches SEC registry entry for “{company}” ({sec}), but company name " +
        "differs and the link is not a declared channel.",
      "reason.noMatch": "No matching SEC-registered OLA found for this ad link.",
      "reason.revoked":
        "This ad links to a channel declared by “{company}” ({sec}), but that registrant " +
        "appears on the SEC's revoked list. {status}",

      "what.appAndCompany": "App and company name",
      "what.appName": "App name",
      "what.companyName": "Company name",
      "dest.social": "a social or messaging page, which is not a SEC-declared channel.",
      "dest.other": "a destination that is not among that registrant's SEC-declared channels.",

      // ── Revoked-list categories ──────────────────────────────────────────
      "revoked.RL": "Certificate of Authority to operate as a lending company was revoked",
      "revoked.RF": "Certificate of Authority to operate as a financing company was revoked",
      "revoked.SL": "Certificate of Authority to operate as a lending company was suspended",
      "revoked.RP": "Certificate of Registration (primary licence) was revoked",
      "revoked.RT": "Partnership registration was revoked",
      "revoked.CD": "A cease and desist order was issued",
      "revoked.fallback": "A SEC registration was revoked",
      "revoked.on": "{what} on {date}.",
      "revoked.noDate": "{what}.",

      // ── Badge sections and rows ──────────────────────────────────────────
      "sec.howChecked": "How this was checked",
      "sec.secRegistration": "SEC registration",
      "sec.registrantClaimed": "Registrant claimed — link not verified",
      "sec.possibleMatch": "Possible match — not verified",
      "sec.listingType": "Listing type",
      "sec.destination": "Destination",
      "sec.profileSignal": "Profile signal",
      "sec.profileSignalSupp": "Profile signal — supplementary",
      "sec.revokedList": "SEC revoked list",
      "sec.revokedNameOnly": "Name appears on the SEC revoked list",
      "row.secNo": "SEC No.",
      "row.registrant": "Registrant",
      "row.registeredAs": "Registered as",
      "row.officialPlay": "Official Play Store",
      "row.officialApple": "Official App Store",
      "row.officialSite": "Official site",
      "row.company": "Company",
      "row.status": "Status",
      "row.listedAs": "Listed as",
      "row.date": "Date",
      "badge.details": "Details",
      "badge.hide": "Hide",
      "badge.hideDetails": "Hide details",
      "badge.showDetails": "Show details",
      "badge.showCrediBytes": "Show CrediBytes details",

      "note.calculator":
        "This listing presents itself as a calculator or planning tool, but the " +
        "advertisement offers loans. Utilities are not required to register with the " +
        "SEC, so treat the absence of a declaration here as a mismatch to check " +
        "rather than proof of wrongdoing.",
      "note.fromCaption":
        "Read from the ad's displayed link ({host}); this preview exposes no " +
        "clickable destination.",
      "note.revokedVerdict":
        "The link in this ad is genuine — it belongs to this registrant. What changed " +
        "is the registrant's standing: the SEC has withdrawn the authority under " +
        "which it operated.",
      "note.revokedAdvisory":
        "This is a name match only. Nothing links this advertisement to that entity, " +
        "and different companies can share a name — treat it as a reason to verify, " +
        "not as a conclusion about this advertiser.",
      "note.contributions":
        "Points are relative to a typical registrant. This score describes the " +
        "advertiser's name profile only — it never decides the verdict above.",
      "note.profileFallback":
        "Profile score: {pct}% — {desc}",

      // ── Stage 1 feature labels ───────────────────────────────────────────
      "feat.appNameLength": "app name length ({n} chars)",
      "feat.advertiserNameLength": "advertiser name length ({n} chars)",
      "feat.loanKeyword": "“loan” in the app name",
      "feat.noLoanKeyword": "no “loan” in the app name",
      "feat.cashKeyword": "“cash” in the app name",
      "feat.noCashKeyword": "no “cash” in the app name",
      "feat.urlInName": "a web address in the app name",
      "feat.noUrlInName": "no web address in the app name",
      "feat.singleWord": "app name is a single word",
      "feat.severalWords": "app name is several words",
      "feat.knownWebsite": "known official website",
      "feat.noWebsite": "no official website on record",

      // ── Risk tiers (rendered, not the model's own strings) ───────────────
      "risk.High": "High",
      "risk.Moderate": "Moderate",
      "risk.Low": "Low",
      "risk.desc.High":
        "Profile score: {pct}% — profile strongly matches patterns of SEC-registered OLA platforms.",
      "risk.desc.Moderate":
        "Profile score: {pct}% — profile partially matches patterns of SEC-registered OLA platforms.",
      "risk.desc.Low":
        "Profile score: {pct}% — profile does not match typical patterns of SEC-registered OLA platforms.",

      // ── Popup ────────────────────────────────────────────────────────────
      "ui.tagline": "Detect and check OLA ads on Facebook",
      "ui.scanResults": "Scan Results",
      "ui.settings": "Settings",
      "ui.verified": "Verified",
      "ui.unverified": "Unverified",
      "ui.flagged": "Flagged",
      "ui.noScans": "No ads scanned yet",
      "ui.seeAll": "See all results",
      "ui.scanning": "Scanning",
      "ui.enableScanning": "Enable scanning",
      "ui.displayMode": "Display Mode",
      "ui.displayResult": "Display Result",
      "ui.reportBug": "Report a bug",
      "ui.reportBugBtn": "Report a bug",
      "ui.reportBugDesc": "Opens a short form in a new tab. Your extension version and settings are filled in; nothing about the pages you visit is included.",
      "ui.inlineBadge": "Inline Badge",
      "ui.floatingWidget": "Floating Widget",
      "ui.floatingHint": "Draggable summary of the page",
      "ui.sidePanel": "Side Panel",
      "ui.appearance": "Appearance",
      "ui.system": "System",
      "ui.light": "Light",
      "ui.dark": "Dark",
      "ui.language": "Language",
      "ui.data": "Data",
      "ui.clearHistory": "Clear scan history",
      "ui.clearHint": "Removes all stored scan records",
      "ui.clear": "CLEAR",
      "ui.detailResult": "Result",
      "ui.detailRegistrant": "SEC registrant",
      "ui.detailClosest": "Closest registry entry — not a match",
      "ui.showingOf": "Showing the {shown} most recent of {total} matching scans.",
      "ui.tierVerified": "Verified",
      "ui.tierLikely": "Likely",
      "ui.tierNamematch": "Name only",
      "ui.tierDanger": "Unregistered",
      "ui.tierUnverified": "Unverified",
      "ui.tierRevoked": "Authority revoked",
      "ui.themeHint": "System follows your operating system setting.",
      "ui.langHint": "Applies to badges on Facebook as well.",
      "ui.emptyTitle": "No ads scanned yet",
      "ui.emptySub": "Browse Facebook and CrediBytes will automatically check OLA ads against the SEC registry.",
      "ui.inlineBadgeDesc": "Adds a verdict label directly above each ad",
      "ui.sidePanelDesc": "Open CrediBytes in Chrome's side panel instead of a popup",
      "ui.refNote": "SEC reference: Philippines OLA Registry",
      "ui.scans": "{n} scans",
      "time.justNow": "just now",
      "time.sec": "{n}s ago",
      "time.min": "{n}m ago",
      "time.hour": "{n}h ago",
      "time.day": "{n}d ago",
      "ui.profileCap": "Profile",
      "card.regLabel": "SEC Registration:",
      "card.companyLabel": "Company:",
      "card.state.verified": "VERIFIED",
      "card.state.unverified": "UNVERIFIED",
      "card.state.flagged": "FLAGGED",
      "card.status.confirmed": "Confirmed",
      "card.status.possible": "Possible Match",
      "card.status.notFound": "Not found",
      "card.status.revoked": "Revoked",
      "card.company.none": "No matching record found",
      "card.company.possible": "Possible match — {company}",
      "card.company.named": "{company} ({sec})",
      "card.howChecked": "HOW THIS WAS CHECKED",
      "card.whatMeans": "WHAT THIS MEANS",
      "card.action": "RECOMMENDED ACTION",
      "check.destination": "Advertisement destination: {value}",
      "check.package": "App package: {value}",
      "check.name": "Advertised name: {value}",
      "check.none": "—",
      "check.pkgMatch": "Matches the SEC-registered OLA/app link",
      "check.pkgNoMatch": "No SEC-registered app matches this package",
      "check.pkgNotStore": "Not an app/play store link",
      "check.nameMatch": "Matches the registered company",
      "check.nameNoMatch": "No exact match in the SEC registry",
      "means.verified": "The advertisement matches an SEC-registered online lending platform.",
      "means.possible": "The advertisement could not be confirmed as belonging to the possible SEC-registered company.",
      "means.notFound": "No matching SEC registration was found for this advertisement in the records checked.",
      "means.flagged": "This exact app is not declared by any SEC-registered lender.",
      "means.revoked": "The link is genuine and belongs to this registrant, but the SEC has withdrawn the authority under which it operated.",
      "action.verified": "Registration confirmed. Always review the loan terms before applying.",
      "action.possible": "Verify the platform before applying or sharing personal information.",
      "action.notFound": "Avoid sharing personal information.",
      "action.flagged": "Avoid sharing personal or financial information with this platform.",
      "action.revoked": "Do not proceed. This company's authority to lend has been withdrawn.",
      "btn.checkListing": "Check this app's listing",
      "btn.checking": "Checking…",
      "btn.failed": "Could not read the listing — try again later.",
      "listing.heading": "APP LISTING",
      "listing.developer": "Developer: {value}",
      "listing.installs": "Installs: {value}",
      "listing.ratings": "Ratings: {value}",
      "listing.stars": "Star rating: {value} out of 5",
      "listing.updated": "Last updated: {value}",
      "listing.privacy": "Privacy policy: {value}",
      "listing.privacyFree": "on a free hosting service",
      "listing.privacyOk": "present",
      "listing.privacyNone": "none listed",
      "listing.verdict": "Listing profile: {pct}% likely to resemble a declared app.",
      "listing.note": "Read from the app store just now, at your request. Declared apps typically carry far more ratings and more recent maintenance.",
      "ds.heading": "DATA THE DEVELOPER DECLARES",
      "ds.collected": "Collected by this app:",
      "ds.shared": "Shared with third parties:",
      "ds.tracking": "Used to track you across other companies' apps:",
      "ds.noneCollected": "The developer declares no data collection.",
      "ds.sensitive": "Includes {list}.",
      "ds.encrypted": "Encrypted in transit",
      "ds.deletable": "Deletion can be requested",
      "ds.linked": "Linked to your identity:",
      "ds.notLinked": "Collected, but not linked to your identity:",
      "ds.storePlay": "Google Play",
      "ds.storeApple": "the App Store",
      "ds.note": "The developer's own declaration to {store}, shown as written. It is not a finding about this lender.",
    },

    tl: {
      // ── Verdicts ─────────────────────────────────────────────────────────
      "verdict.revoked.label": "Binawi ang Awtoridad",
      "verdict.revoked.bar": "BINAWI ANG AWTORIDAD",
      "verdict.legitimate.label": "SEC Verified",
      "verdict.legitimate.bar": "VERIFIED ANG AD",
      "verdict.likely.label": "Malamang Lehitimo",
      "verdict.likely.bar": "MALAMANG LEHITIMO",
      "verdict.namematch.label": "Pangalan Lang ang Tugma",
      "verdict.namematch.bar": "PANGALAN LANG ANG TUGMA",
      "verdict.danger.label": "Hindi Rehistradong App",
      "verdict.danger.bar": "HINDI REHISTRADO",
      "verdict.unverified.label": "Hindi Ma-verify",
      "verdict.unverified.bar": "HINDI MA-VERIFY",

      // ── Evidence trail ───────────────────────────────────────────────────
      "ev.noDestination": "Walang mabasang destinasyon sa ad na ito.",
      "ev.destination": "Destinasyon: {host}",
      "ev.playDeclared": "Ang Play package {pkg} ay idineklara ng {company}.",
      "ev.playNotFound": "Ang Play package {pkg} ay wala sa SEC registry.",
      "ev.appleDeclared": "Ang Apple ID {id} ay idineklara ng {company}.",
      "ev.appleNotFound": "Ang Apple ID {id} ay wala sa SEC registry.",
      "ev.storeSkipName":
        "Nilaktawan ang pagtutugma ng pangalan: store link ito, at maaaring i-advertise " +
        "ng isang kompanya ang hindi nitong idineklarang app sa ilalim ng sarili nitong pangalan.",
      "ev.websiteDeclared": "Ang {host} ay website na idineklara sa SEC ng {company}.",
      "ev.subdomainDeclared": "Ang {host} ay subdomain ng {suffix}, idineklara ng {company}.",
      "ev.hostNotDeclared": "Ang {host} ay wala sa mga idineklarang website ng kahit sinong rehistrado.",
      "ev.socialDestination":
        "Social o messaging page ang destinasyong ito — hindi ito kailanman naging " +
        "channel na idineklara sa SEC.",
      "ev.nameNotChannel":
        "Tumutugma ang {what} sa {company}, ngunit ang pangalan ay hindi idineklarang channel.",
      "ev.appNameCompanyDiffers":
        "Tumutugma ang app name sa entry ng {company}, ngunit magkaiba ang pangalan ng kompanya.",
      "ev.nameNoMatch": "Walang eksaktong katugma ang ipinapakitang pangalan sa SEC registry.",
      "ev.revokedVerdict":
        "Ang {company} ay nasa listahan ng binawian ng SEC. {status}",
      "ev.revokedAdvisory":
        "May entidad na nagngangalang “{name}” sa listahan ng binawian ng SEC. {status} " +
        "Hindi napatunayang kabilang dito ang ad na ito.",

      // ── Verdict reasons ──────────────────────────────────────────────────
      "reason.noUrl": "Walang nakitang redirect URL sa ad na ito.",
      "reason.playMatch":
        "Tumutugma ang Play Store package ID sa app na rehistrado sa SEC: “{app}” ({sec}).",
      "reason.appleMatch":
        "Tumutugma ang App Store ID sa app na rehistrado sa SEC: “{app}” ({sec}).",
      "reason.storeNoMatch":
        "Walang SEC registration ang package ID o Apple ID ng app na ito — maaaring " +
        "hindi ito idineklara o iligal na lending application.",
      "reason.domainMatch":
        "Tumutugma ang domain sa website na rehistrado sa SEC ng “{company}” ({sec}).",
      "reason.subdomainMatch":
        "Tumutugma ang subdomain sa website na rehistrado sa SEC ng “{company}” ({sec}).",
      "reason.nameMatchOnly":
        "Tumutugma ang {what} sa rehistradong “{company}” ({sec}), ngunit ang ad na ito ay " +
        "naka-link sa {dest} I-verify sa mga opisyal na link sa ibaba.",
      "reason.appNameMatch":
        "Tumutugma ang app name sa SEC registry entry ng “{company}” ({sec}), ngunit " +
        "magkaiba ang pangalan ng kompanya at ang link ay hindi idineklarang channel.",
      "reason.noMatch": "Walang katugmang OLA na rehistrado sa SEC para sa link ng ad na ito.",
      "reason.revoked":
        "Ang ad na ito ay naka-link sa channel na idineklara ng “{company}” ({sec}), " +
        "ngunit ang rehistradong ito ay nasa listahan ng binawian ng SEC. {status}",

      // Lowercase on purpose. English uses these sentence-initially ("Company
      // name matches ..."), Tagalog mid-sentence ("Tumutugma ang pangalan ng
      // kompanya sa ..."). Each language's casing follows its own word order,
      // which is precisely what a shared fragment could not have expressed.
      "what.appAndCompany": "pangalan ng app at kompanya",
      "what.appName": "pangalan ng app",
      "what.companyName": "pangalan ng kompanya",
      "dest.social": "social o messaging page, na hindi channel na idineklara sa SEC.",
      "dest.other": "destinasyong wala sa mga channel na idineklara sa SEC ng rehistradong iyon.",

      // ── Revoked-list categories ──────────────────────────────────────────
      "revoked.RL": "Binawi ang Certificate of Authority upang mag-operate bilang lending company",
      "revoked.RF": "Binawi ang Certificate of Authority upang mag-operate bilang financing company",
      "revoked.SL": "Sinuspinde ang Certificate of Authority upang mag-operate bilang lending company",
      "revoked.RP": "Binawi ang Certificate of Registration (pangunahing lisensya)",
      "revoked.RT": "Binawi ang rehistrasyon ng partnership",
      "revoked.CD": "Naglabas ng cease and desist order",
      "revoked.fallback": "May binawing rehistrasyon sa SEC",
      "revoked.on": "{what} noong {date}.",
      "revoked.noDate": "{what}.",

      // ── Badge sections and rows ──────────────────────────────────────────
      "sec.howChecked": "Paano ito sinuri",
      "sec.secRegistration": "Rehistrasyon sa SEC",
      "sec.registrantClaimed": "Inaangking rehistrado — hindi na-verify ang link",
      "sec.possibleMatch": "Posibleng katugma — hindi na-verify",
      "sec.listingType": "Uri ng listing",
      "sec.destination": "Destinasyon",
      "sec.profileSignal": "Profile signal",
      "sec.profileSignalSupp": "Profile signal — karagdagan lamang",
      "sec.revokedList": "Listahan ng binawian ng SEC",
      "sec.revokedNameOnly": "Ang pangalan ay nasa listahan ng binawian ng SEC",
      "row.secNo": "SEC No.",
      "row.registrant": "Rehistrado",
      "row.registeredAs": "Nakarehistro bilang",
      "row.officialPlay": "Opisyal na Play Store",
      "row.officialApple": "Opisyal na App Store",
      "row.officialSite": "Opisyal na website",
      "row.company": "Kompanya",
      "row.status": "Katayuan",
      "row.listedAs": "Nakalista bilang",
      "row.date": "Petsa",
      "badge.details": "Detalye",
      "badge.hide": "Itago",
      "badge.hideDetails": "Itago ang detalye",
      "badge.showDetails": "Ipakita ang detalye",
      "badge.showCrediBytes": "Ipakita ang detalye ng CrediBytes",

      "note.calculator":
        "Ipinapakita ng listing na ito na isa itong calculator o planning tool, ngunit " +
        "nag-aalok ng pautang ang ad. Hindi kailangang magparehistro sa SEC ang mga " +
        "utility app, kaya ituring ang kawalan ng deklarasyon dito bilang bagay na " +
        "dapat suriin, hindi patunay ng paglabag.",
      "note.fromCaption":
        "Mula sa ipinapakitang link ng ad ({host}); walang mapipinditang destinasyon " +
        "ang preview na ito.",
      "note.revokedVerdict":
        "Tunay ang link sa ad na ito — pag-aari ito ng rehistradong ito. Ang nagbago ay " +
        "ang katayuan nito: binawi na ng SEC ang awtoridad na pinagpapatakbuhan nito.",
      "note.revokedAdvisory":
        "Pangalan lamang ang tugma. Walang nag-uugnay sa ad na ito sa entidad na iyon, " +
        "at maaaring magkapareho ng pangalan ang magkaibang kompanya — ituring itong " +
        "dahilan upang mag-verify, hindi konklusyon tungkol sa advertiser na ito.",
      "note.contributions":
        "Ang mga puntos ay kumpara sa karaniwang rehistrado. Inilalarawan lamang ng " +
        "iskor na ito ang profile ng pangalan ng advertiser — hindi nito kailanman " +
        "pinagpapasyahan ang hatol sa itaas.",
      "note.profileFallback": "Profile score: {pct}% — {desc}",

      // ── Stage 1 feature labels ───────────────────────────────────────────
      "feat.appNameLength": "haba ng app name ({n} karakter)",
      "feat.advertiserNameLength": "haba ng pangalan ng advertiser ({n} karakter)",
      "feat.loanKeyword": "may “loan” sa app name",
      "feat.noLoanKeyword": "walang “loan” sa app name",
      "feat.cashKeyword": "may “cash” sa app name",
      "feat.noCashKeyword": "walang “cash” sa app name",
      "feat.urlInName": "may web address sa app name",
      "feat.noUrlInName": "walang web address sa app name",
      "feat.singleWord": "isang salita ang app name",
      "feat.severalWords": "maraming salita ang app name",
      "feat.knownWebsite": "may kilalang opisyal na website",
      "feat.noWebsite": "walang naitalang opisyal na website",

      // ── Risk tiers ───────────────────────────────────────────────────────
      "risk.High": "Mataas",
      "risk.Moderate": "Katamtaman",
      "risk.Low": "Mababa",
      "risk.desc.High":
        "Profile score: {pct}% — malakas na tumutugma ang profile sa mga pattern ng " +
        "OLA platform na rehistrado sa SEC.",
      "risk.desc.Moderate":
        "Profile score: {pct}% — bahagyang tumutugma ang profile sa mga pattern ng " +
        "OLA platform na rehistrado sa SEC.",
      "risk.desc.Low":
        "Profile score: {pct}% — hindi tumutugma ang profile sa karaniwang pattern ng " +
        "OLA platform na rehistrado sa SEC.",

      // ── Popup ────────────────────────────────────────────────────────────
      "ui.tagline": "Tuklasin at suriin ang mga OLA ad sa Facebook",
      "ui.scanResults": "Resulta ng Pag-scan",
      "ui.settings": "Mga Setting",
      "ui.verified": "Verified",
      "ui.unverified": "Hindi ma-verify",
      "ui.flagged": "Naka-flag",
      "ui.noScans": "Wala pang na-scan na ad",
      "ui.seeAll": "Tingnan lahat ng resulta",
      "ui.scanning": "Pag-scan",
      "ui.enableScanning": "Paganahin ang pag-scan",
      "ui.displayMode": "Paraan ng Pagpapakita",
      "ui.displayResult": "Pagpapakita ng Resulta",
      "ui.reportBug": "Mag-report ng bug",
      "ui.reportBugBtn": "Mag-report ng bug",
      "ui.reportBugDesc": "Magbubukas ng maikling form sa bagong tab. Nakalagay na ang bersyon ng extension at ang mga setting mo; walang kasamang impormasyon tungkol sa mga page na binibisita mo.",
      "ui.inlineBadge": "Inline na Badge",
      "ui.floatingWidget": "Floating na Widget",
      "ui.floatingHint": "Buod ng pahina na puwedeng i-drag",
      "ui.sidePanel": "Side Panel",
      "ui.appearance": "Hitsura",
      "ui.system": "Sistema",
      "ui.light": "Maliwanag",
      "ui.dark": "Madilim",
      "ui.language": "Wika",
      "ui.data": "Datos",
      "ui.clearHistory": "Burahin ang kasaysayan ng pag-scan",
      "ui.clearHint": "Buburahin ang lahat ng naitalang scan",
      "ui.clear": "BURAHIN",
      "ui.detailResult": "Resulta",
      "ui.detailRegistrant": "Rehistrado sa SEC",
      "ui.detailClosest": "Pinakamalapit na entry sa registry — hindi katugma",
      "ui.showingOf": "Ipinapakita ang {shown} pinakabago sa {total} tugmang scan.",
      "ui.tierVerified": "Verified",
      "ui.tierLikely": "Malamang",
      "ui.tierNamematch": "Pangalan lang",
      "ui.tierDanger": "Hindi rehistrado",
      "ui.tierUnverified": "Hindi ma-verify",
      "ui.tierRevoked": "Binawi ang awtoridad",
      "ui.themeHint": "Susunod ang Sistema sa setting ng iyong operating system.",
      "ui.langHint": "Nalalapat din sa mga badge sa Facebook.",
      "ui.emptyTitle": "Wala pang na-scan na ad",
      "ui.emptySub": "Mag-browse sa Facebook at awtomatikong susuriin ng CrediBytes ang mga OLA ad laban sa SEC registry.",
      "ui.inlineBadgeDesc": "Nagdaragdag ng label ng hatol sa itaas mismo ng bawat ad",
      "ui.sidePanelDesc": "Buksan ang CrediBytes sa side panel ng Chrome imbes na sa popup",
      "ui.refNote": "Sanggunian ng SEC: Philippines OLA Registry",
      "ui.scans": "{n} na scan",
      "time.justNow": "ngayon lang",
      "time.sec": "{n}s ang nakaraan",
      "time.min": "{n}m ang nakaraan",
      "time.hour": "{n}h ang nakaraan",
      "time.day": "{n}d ang nakaraan",
      "ui.profileCap": "Profile",
      "card.regLabel": "Rehistrasyon sa SEC:",
      "card.companyLabel": "Kompanya:",
      "card.state.verified": "VERIFIED",
      "card.state.unverified": "HINDI MA-VERIFY",
      "card.state.flagged": "NAKA-FLAG",
      "card.status.confirmed": "Kumpirmado",
      "card.status.possible": "Posibleng Tugma",
      "card.status.notFound": "Hindi matagpuan",
      "card.status.revoked": "Binawi",
      "card.company.none": "Walang natagpuang tugmang rekord",
      "card.company.possible": "Posibleng tugma — {company}",
      "card.company.named": "{company} ({sec})",
      "card.howChecked": "PAANO ITO SINURI",
      "card.whatMeans": "ANO ANG IBIG SABIHIN NITO",
      "card.action": "INIREREKOMENDANG AKSYON",
      "check.destination": "Destinasyon ng ad: {value}",
      "check.package": "App package: {value}",
      "check.name": "Pangalang ginamit sa ad: {value}",
      "check.none": "—",
      "check.pkgMatch": "Tumutugma sa OLA/app link na rehistrado sa SEC",
      "check.pkgNoMatch": "Walang rehistradong app sa SEC ang tumutugma sa package na ito",
      "check.pkgNotStore": "Hindi ito app/play store link",
      "check.nameMatch": "Tumutugma sa rehistradong kompanya",
      "check.nameNoMatch": "Walang eksaktong tugma sa SEC registry",
      "means.verified": "Tumutugma ang ad sa isang online lending platform na rehistrado sa SEC.",
      "means.possible": "Hindi makumpirma na ang ad ay pag-aari ng posibleng kompanyang rehistrado sa SEC.",
      "means.notFound": "Walang natagpuang tugmang rehistrasyon sa SEC para sa ad na ito sa mga tinignang rekord.",
      "means.flagged": "Ang eksaktong app na ito ay hindi idineklara ng sinumang lender na rehistrado sa SEC.",
      "means.revoked": "Tunay ang link at pag-aari ito ng rehistradong ito, ngunit binawi na ng SEC ang awtoridad na pinagpapatakbuhan nito.",
      "action.verified": "Kumpirmado ang rehistrasyon. Suriin pa rin ang mga tuntunin ng pautang bago mag-apply.",
      "action.possible": "I-verify ang platform bago mag-apply o magbahagi ng personal na impormasyon.",
      "action.notFound": "Iwasang magbahagi ng personal na impormasyon.",
      "action.flagged": "Iwasang magbahagi ng personal o pinansyal na impormasyon sa platform na ito.",
      "action.revoked": "Huwag magpatuloy. Binawi na ang awtoridad ng kompanyang ito na magpautang.",
      "btn.checkListing": "Suriin ang listing ng app na ito",
      "btn.checking": "Sinusuri…",
      "btn.failed": "Hindi mabasa ang listing — subukan muli mamaya.",
      "listing.heading": "LISTING NG APP",
      "listing.developer": "Developer: {value}",
      "listing.installs": "Mga install: {value}",
      "listing.ratings": "Mga rating: {value}",
      "listing.stars": "Star rating: {value} sa 5",
      "listing.updated": "Huling na-update: {value}",
      "listing.privacy": "Privacy policy: {value}",
      "listing.privacyFree": "nasa libreng hosting service",
      "listing.privacyOk": "mayroon",
      "listing.privacyNone": "wala",
      "listing.verdict": "Profile ng listing: {pct}% ang tsansang kahawig ito ng idineklarang app.",
      "listing.note": "Binasa mula sa app store ngayon lang, sa iyong kahilingan. Ang mga idineklarang app ay karaniwang may mas maraming rating at mas bagong maintenance.",
      "ds.heading": "DATA NA IDINEKLARA NG DEVELOPER",
      "ds.collected": "Kinukuha ng app na ito:",
      "ds.shared": "Ibinabahagi sa third parties:",
      "ds.tracking": "Ginagamit para subaybayan ka sa mga app ng ibang kumpanya:",
      "ds.noneCollected": "Idineklara ng developer na walang data na kinukuha.",
      "ds.sensitive": "Kabilang ang {list}.",
      "ds.encrypted": "Naka-encrypt habang ipinapadala",
      "ds.deletable": "Puwedeng hilingin ang pagbura",
      "ds.linked": "Nakaugnay sa pagkakakilanlan mo:",
      "ds.notLinked": "Kinukuha, pero hindi nakaugnay sa pagkakakilanlan mo:",
      "ds.storePlay": "Google Play",
      "ds.storeApple": "App Store",
      "ds.note": "Ito ang sariling deklarasyon ng developer sa {store}, ipinapakita ayon sa pagkakasulat. Hindi ito natuklasang paglabag ng lender na ito.",
    },
  };

  let current = DEFAULT_LANG;

  /**
   * Look up `key` and substitute {placeholders} from `params`.
   *
   * Falls back to English, then to the key itself. A missing key must never
   * throw or render blank: the badge would silently lose a line of its
   * reasoning, which is worse than showing an untranslated string.
   */
  function t(key, params, lang) {
    const l = lang || current;
    const table = STRINGS[l] || STRINGS[DEFAULT_LANG];
    let s = table[key];
    if (s === undefined) s = STRINGS[DEFAULT_LANG][key];
    if (s === undefined) return key;
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, name) => {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return m;
      return resolve(params[name], l);
    });
  }

  /**
   * A parameter may itself be a { key, params } descriptor rather than a string.
   *
   * The revoked-list lines need this. Their status clause is assembled from a
   * category ("Certificate of Authority ... revoked") and a date, and baking the
   * rendered English into the stored params would freeze that clause in whatever
   * language was selected when the scan happened — the exact problem keys and
   * params exist to avoid. Resolution recurses, so revoked.on -> revoked.RF
   * nests cleanly.
   */
  function resolve(value, lang) {
    if (value && typeof value === "object" && typeof value.key === "string") {
      return t(value.key, value.params, lang);
    }
    return String(value);
  }

  /** Render an { key, params } entry, tolerating a pre-rendered `text`. */
  function render(entry, lang) {
    if (!entry) return "";
    // Scans stored before this file existed carry `text` and no key.
    if (!entry.key) return entry.text || "";
    return t(entry.key, entry.params, lang);
  }

  function setLang(lang) { current = STRINGS[lang] ? lang : DEFAULT_LANG; return current; }
  function getLang() { return current; }
  function has(lang) { return !!STRINGS[lang]; }

  window.CrediBytesI18n = { t, render, setLang, getLang, has, LANGS, DEFAULT_LANG, STRINGS };
})();
