# CrediBytes

![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)
![Tests](https://img.shields.io/badge/tests-20%20suites%20%2F%20407%20assertions-2e9e4f)
![Models](https://img.shields.io/badge/LightGBM-2%20models%20bundled-76b729)
![Status](https://img.shields.io/badge/version-1.0.0-blue)

A Chrome extension that detects Online Lending Application (OLA) advertisements
on Facebook and checks each one against the SEC Philippines registry — in the
page, as the user scrolls.

Built for the undergraduate thesis *"A Machine Learning Advertisement Analysis
System for Detecting Legitimacy of Philippine OLAs on Facebook."*

**The core idea.** Illegitimate lending apps advertise using the names of
registered ones. A name can be typed by anyone, so CrediBytes verifies the
**destination** instead: an advertisement is legitimate only if its link resolves
to a channel the lender actually declared to the SEC — an exact Play package ID,
an Apple app ID, or a registered domain. Everything else is reported as
unconfirmed rather than condemned.

**Research findings it carries.** Across 2,164 collected ad appearances, **22.7%
resolved to SEC-declared channels** and 73.7% could not be verified, surfacing
**68 unique undeclared apps**. Two supervised models ship with it: an
undeclared-app detector at **ROC AUC 0.909** (developer-grouped, vs a 0.585
baseline) and a registrant profile model at **ROC AUC 0.839** (company-grouped
over 30 splits, vs a 0.562 baseline).

---

## Quick start

### Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `CrediBytes/` folder

Icons and models are committed, so there is no build step.

### Try it

Open [Facebook](https://www.facebook.com) and scroll, or search a lender name in
the [Meta Ad Library](https://www.facebook.com/ads/library/?active_status=active&country=PH).
Detected advertisements receive a verdict bar; the toolbar icon opens the scan
history.

### Run the tests

```bash
node tests/run-all.mjs          # expect 20/20 suites, 407 assertions
node tests/stage3.test.mjs      # or any single suite
```

Playwright is not a dependency of this repository. The harness borrows it from a
sibling checkout, or set `PLAYWRIGHT_ROOT` to an installation.

---

## Architecture and pipeline

Three stages. **Only Stage 2 determines the verdict**, and it is deterministic
rather than learned — see below for why.

```
Facebook page
     │
     ▼
content.js ── MutationObserver locates "Sponsored" markers
     │        climbs to the true ad container (surface-dependent)
     │        extracts landing URL, ad text, advertiser name
     │
     ├─▶ STAGE 2 — matcher.js — DETERMINISTIC, AUTHORITATIVE
     │      Pass 1  exact Play package ID / Apple ID   ← store URLs stop here
     │      Pass 2  domain or subdomain match
     │      Pass 3  exact normalised name  → name_match_only
     │      then    revoked-list check (verdict path + advisory path)
     │
     ├─▶ STAGE 1 — stage1.js + stage1_model.js — SUPPLEMENTARY
     │      100 LightGBM trees, 7 features, evaluated in-page
     │      → registrant profile score. Never overrides Stage 2.
     │
     └─▶ STAGE 3 — stage3.js + stage3_model.js — ON USER REQUEST ONLY
            120 trees, 15 features read from the advertised store listing
            → "does this listing resemble those SEC registrants declare?"
            → plus the developer's Data safety declaration, quoted verbatim
     │
     ▼
Inline badge  │  Floating widget  │  Side panel
     │
     ▼
background.js ─▶ chrome.storage.local   (single writer, serialised)
```

### Why Stage 2 is deterministic

A model trained on the legitimacy label reaches approximately **97% accuracy
from `url_type` alone**, because that label is *derived from* the same URL
matching logic. Such a model learns how the labels were constructed, not
anything about lenders — a circular artifact reporting an impressive number.

The label is also not itself a legitimacy judgement. **Home Credit Philippines**,
an unambiguously registered lender, is labelled `unverified` on its
Facebook-URL advertisements and `legitimate` on a landing-page advertisement:
the same company classified both ways purely by URL shape.

Machine learning is therefore applied where it is not circular, and withheld
where it would be.

### Where machine learning is applied

| Stage | Task | Validation | Baseline |
|---|---|---|---|
| **Stage 3** | Is this advertised app declared to the SEC? | **ROC AUC 0.909**, accuracy 0.823, grouped by developer | 0.585 |
| **Stage 1** | Does this registrant have a declared mobile app? | **ROC AUC 0.839** (sd 0.018), accuracy 0.770, mean of 30 company-grouped splits | 0.562 |

Grouping is not optional in either case. One operator commonly publishes several
re-skinned lending apps, so a random split places sibling apps on both sides of a
fold: Stage 3 measures 87.7% under random cross-validation and 82.3% when grouped
by developer. The grouped figure is the honest one.

Both models are exported to plain JavaScript that walks LightGBM's own
thresholds and sums its own leaf values. This is not an approximation —
`verify_export.py` asserts equivalence with `predict_proba` across the training
set (Stage 3: max absolute difference ≈ 1e-07 over 130 rows).

### Why Stage 3 runs on a click

Its features come from the advertised app's store listing, which cannot be read
from a Facebook page. Fetching one per advertisement would mean hundreds of
requests per session, exposure to rate limiting, and the browser silently
reporting to Google every app a user scrolls past. A single deliberate click
removes all three concerns. Host permissions are **optional** and requested at
the moment the button is pressed, so a user who never presses it never grants
them.

---

## Verdict states and settings

### Verdict states

`verdictOf(legitimacy, status, isStoreUrl)` in `content.js` is the single source
of truth; both the rendered badge and the stored `SAVE_SCAN` payload derive from
it.

| Badge | Bar text | Trigger |
|---|---|---|
| Authority Revoked | `AD AUTHORITY REVOKED` | `legitimacy === "revoked"` — evaluated **first** |
| SEC Verified | `AD VERIFIED` | `legitimacy === "legitimate"` |
| Likely Legitimate | `AD LIKELY LEGITIMATE` | `legitimacy === "likely_legitimate"` |
| Name Match Only | `AD NAME MATCH ONLY` | `legitimacy === "name_match_only"` |
| Unregistered App | `AD FLAGGED` | store URL with no registry match |
| Unverified | `AD UNVERIFIED` | all remaining cases |

**Unverified versus Unregistered.** *Unverified* means the advertisement could
not be confirmed either way. *Unregistered* means the exact application is
identified — its package ID or Apple ID was extracted — and carries no SEC
declaration. The absence of ambiguity is what makes it the higher-risk state.

**Unregistered versus Revoked** are the two red states, and they assert opposite
things about the link. *Unregistered*: the app was **never** authorised.
*Revoked*: it **was**, the link genuinely belongs to that registrant, and the SEC
has since withdrawn the authority. Revoked ranks most severe precisely because
nothing else in the system would object to the advertisement.

> The bar reads `AD FLAGGED` while the stored `label` remains
> `"Unregistered App"`. The bar is a headline; the label is the record, and it is
> the only field distinguishing the two red states. They should not be merged.

### Settings model

Two independent settings, previously conflated into a single three-way value:

| Setting | Values | Controls |
|---|---|---|
| `sidePanel` | `true` / `false` | where **the extension's own interface** opens: side panel or popup |
| `displayResult` | `"badge"` / `"floating"` | what is rendered **on the Facebook page** |

Every combination is reachable. A legacy `displayMode` value (`"badge"`,
`"floating"` or `"sidepanel"`) is still read as a fallback in three locations —
`onInstalled`, `popup.js` and `content.js` — so a user who never triggers
`onInstalled` still resolves to a valid state.

`popup.html` serves **both** the popup and the side panel. The two are
distinguished by the `?panel=1` query parameter supplied by the manifest and by
`setOptions()`, not by viewport width: the side panel is frequently narrower
than the 360px popup.

---

## File map

```
CrediBytes/
├── manifest.json              MV3 configuration. Content-script load order lives here.
├── icons/                     16 / 32 / 48 / 128 px PNGs
├── src/
│   ├── i18n.js          37 KB  219 keys × en/tl. Verdict text is {key, params},
│   │                           resolved at display time so stored scans re-translate.
│   ├── verdict-view.js   6 KB  Shared verdict renderer — badge, popup card, widget
│   ├── sec_reference.js 51 KB  GENERATED — 187 SEC registrants, 128 with a website
│   ├── revoked_reference.js   GENERATED — 1,375 revoked/suspended entries (124 KB)
│   ├── stage1_model.js  13 KB  GENERATED — 100 trees, 7 features
│   ├── stage3_model.js  17 KB  GENERATED — 120 trees, 15 features
│   ├── matcher.js       27 KB  Stage 2 — JavaScript port of match_ad_links.py
│   ├── stage1.js        13 KB  Stage 1 evaluator (tree walk + sigmoid)
│   ├── stage3.js        22 KB  Store-listing fetch and Data safety parsing (worker only)
│   ├── content.js       85 KB  Ad detection, badge, floating widget, detail window
│   ├── background.js    20 KB  MV3 worker — storage writes, fetches, action behaviour
│   ├── panel-init.js     2 KB  Applies theme and panel class before first paint
│   └── popup.html/.css/.js     Popup and side panel (one file serves both surfaces)
└── tests/                     20 Playwright suites — see tests/README.md
```

### Load order

Content scripts are injected in dependency order, declared in `manifest.json`.
`content.js` reads globals that the preceding files define:

```
i18n.js → verdict-view.js → sec_reference.js → revoked_reference.js
        → stage1_model.js → matcher.js → stage1.js → content.js
```

`stage3.js` and `stage3_model.js` are **not** content scripts. They are loaded by
the service worker through `importScripts`. A service worker has no `window`
object, which is why both files attach to `globalThis`; assigning to `window`
prevented worker registration entirely (status code 15) and silently disabled
scan storage along with it.

---

## Security and privacy

**Document integrity**

- **No `innerHTML` anywhere.** All DOM is constructed with `createElement` and
  `textContent`. Advertiser names originate from Facebook and are untrusted
  input.

**Network**

- **All external requests are issued from `background.js`.** Facebook's Content
  Security Policy blocks `fetch()` to external origins from content scripts; the
  MV3 service worker is exempt.
- **Store access is optional and user-initiated.** `play.google.com`,
  `apps.apple.com` and `itunes.apple.com` are declared under
  `optional_host_permissions` and requested only when the listing button is
  pressed.

**Data**

- **`background.js` is the sole writer** to `chrome.storage.local`, serialised
  through a single promise chain. Concurrent scans previously raced, and a
  measurement found **3 of 25 writes surviving**.
- **Nothing is transmitted automatically.** Stage 1 may send a company name and
  platform name to the backend as a fallback; Stage 3 fetches a store page only
  on an explicit click.
- **Bug reports carry no browsing data** — extension version, browser, operating
  system, display settings and scan count only. Never the active tab URL, which
  on the Ad Library would contain the user's search terms.

**Resilience**

- **Content scripts survive extension reloads.** Reloading or updating the
  extension orphans scripts already injected into open tabs, and `chrome.runtime`
  reads back as `undefined`. Every `chrome.*` call is guarded, and the
  MutationObserver disconnects on first detection rather than throwing once per
  advertisement.

---

## Testing

```bash
node tests/run-all.mjs                 # full suite: 20 suites, 407 assertions
node tests/stage3.test.mjs             # a single suite
node tests/revoked-normalisation-parity.test.mjs
```

Suites load the **real** content scripts into a Chromium page against mock
Facebook markup, rather than testing extracted logic in isolation. Coverage
spans ad detection across both Facebook surfaces, link capture and redirect
unwrapping, all six verdict states, the revoked-list advisory, display modes and
settings migration, theme injection, orphaned-context handling, model
equivalence, and the Python↔JavaScript normalisation parity that keeps the
revoked list reachable.

See [`tests/README.md`](tests/README.md) for what each suite locks in.

---

## Development and maintainer guidelines

Contributors should read
[`CONTRIBUTING.md`](CONTRIBUTING.md) before making changes. It documents the
design invariants and platform constraints in full. The essentials:

### Design invariants

1. **A name neither verifies nor condemns.** The SEC declares platform *names*,
   and any advertiser can display one. A name match yields `name_match_only`,
   never `legitimate`; a revoked-list name match yields an advisory, never a
   verdict.
2. **"Not observed" is distinct from "observed as absent."** `undefined` means a
   value could not be read and must become `NaN` or an omitted row; `""` or `[]`
   means the source was read and reported nothing. Conflating them has caused
   five separate defects in this project, the costliest worth 12.7 percentage
   points of real-world accuracy.
3. **One renderer, never two.** `verdict-view.js` is the single source of verdict
   presentation, shared by the badge, the popup card and the widget. Duplicated
   verdict logic has drifted twice before.
4. **Assert only what can be evidenced.** Four signals were measured and
   deliberately not shipped as verdicts, including displayed app titles and
   reported harassment.
5. **A page may be destroyed mid-write.** `window.close()` and
   `sidePanel.setOptions({enabled:false})` both tear down the page executing
   them, while `chrome.storage.local.set` is asynchronous. Sequence
   gesture-bound calls first and destructive calls inside the write callback.

### Platform constraints

**Facebook's DOM is undocumented and varies by surface.** Ad containers differ
between the news feed and the Meta Ad Library; the destination URL is held in
`data-lynx-uri` rather than `href` and may be wrapped through redirect hosts;
outbound links must be ranked by type rather than taken in document order.

**Chrome API sequencing is strict.** `sidePanel.open()` requires a live user
gesture and cannot be called after an asynchronous hop.
`chrome.permissions.request()` is available only to extension pages. CSS
`resize` requires `overflow` other than `visible`, and `hidden` is correct here —
`auto` makes the entire panel scrollable and detaches its header.

**Generated files must not be edited by hand.** Exported model trees address
features by index, so `model.features` ordering is load-bearing; reordering it
scores every input against the wrong columns without raising an error.

### Regenerating artefacts

```bash
# Models — from CrediBytes-Backend/
python tools/export_model_js.py        # → ../CrediBytes/src/stage1_model.js
python tools/verify_export.py          # asserts JS output == predict_proba
python tools/verify_export_stage3.py   # expect max|diff| ~1e-07 over 130 rows

# SEC registry — from the thesis project
python update_sec_reference.py --deploy

# Revoked list — from the thesis project
python build_revoked_reference.py --deploy    # expect 1,375 records
python export_revoked_names.py                # regenerate the parity fixture
node tests/revoked-normalisation-parity.test.mjs
```

When regenerating the SEC registry, preserve full legal names including "doing
business as" aliases — `matcher.js` relies on those trade names — and retain
name-only records, which drive the `name_match_only` verdict and the brand set
that decides whether an advertisement is scanned at all.

### Backend configuration

```js
// src/background.js
const BACKEND_URL = 'https://credibytes-backend.onrender.com'
```

Optional. Stage 1 evaluates locally; the backend serves as a fallback and is
warmed by a rate-limited request when a Facebook tab loads.

---

## Further reading

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — design invariants and platform
  constraints in full, with the incidents behind each
- [`tests/README.md`](tests/README.md) — what each suite locks in
- [`../CrediBytes-Backend`](../CrediBytes-Backend) — FastAPI service and model
  export tooling
- `../CLAUDE.md` — cumulative technical reference: rejected approaches,
  measurements, and the reasoning behind each decision
