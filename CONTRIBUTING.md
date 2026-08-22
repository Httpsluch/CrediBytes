# Contributing to CrediBytes

This document records the design invariants and platform constraints that govern
this codebase. Each one is stated with the incident that produced it, because a
rule without its evidence tends to be optimised away by the next person who
reads it.

Read **Design invariants** before changing verdict logic, model handling, or
anything that writes to storage.

---

## Design invariants

### 1. A name neither verifies nor condemns

The SEC declares platform **names**, and any advertiser can display one. A name
match therefore yields `name_match_only` and never `legitimate`; a match against
the revoked list yields an **advisory** and never a verdict.

**Incident.** An advertiser displayed the app title *"Mega Peso-Fast Cash Easy
Loan"* — character-for-character identical to a SEC-registered lender's declared
Play Store listing. Verification by name would have attached that registrant's
SEC number to the advertisement. The page proved to be a Mexican operation
advertising in Spanish, quoting amounts in non-Philippine currency, whose own
commenters described it as fraudulent. Because verification is performed against
declared URLs rather than displayed names, the advertisement was correctly
reported as unverified.

**Symmetry matters.** The same reasoning applies in the opposite direction.
Of 1,413 revoked and suspended entries, only three carry a SEC registration
number; the rest are a company name and a date. A revocation notice is the only
claim this system makes *against* a named business, and two unrelated companies
sharing a name is sufficient to produce a false one. Only a revocation confirmed
against registration numbers by a human, and reached through a URL the
advertisement already proved it owns, may change a badge.

### 2. "Not observed" is distinct from "observed as absent"

```
undefined  →  the source could not be read     →  feature NaN, row omitted
"" / []    →  the source was read, found none  →  feature 0,   row displayed
```

**Why this recurs.** The incorrect value always looks valid. `0` is a real
number, `""` a real string, `[]` a real list. Nothing raises. The model trains,
the card renders, and the system asserts something false with full confidence.

**Five occurrences, found months apart in unrelated code:**

| Location | Unknown stored as | Assertion produced |
|---|---|---|
| `has_official_website` hardcoded in the backend | `0` | "this company has no website" |
| `yes_no_to_int("")` during dataset construction | `0` | "this platform is not an app" |
| Empty app name → `platform_name_length` | `0` | "a real, very short name" |
| Apple's absent privacy field | `""` | "this app has no privacy policy" |
| Unreadable Data safety page | `[]` | "this app collects no data" |

The first cost **12.7 percentage points** of real-world accuracy while the
reported figure remained at 74.7%. The second invented two training labels and
moved a reported result by 2.8 points.

**When adding any field read from an external source, decide at that moment what
it looks like when the value could not be obtained.** Not when a user reports a
misleading badge.

One qualification: LightGBM learns a direction for missing values only from
missing values **present during training**. `NaN` is correct where training had
genuine gaps (Stage 3: 49 of 130 rows lack an install count) and wrong where it
had none — Stage 1 saw no missing values, so an imputed typical value is used
instead.

### 3. One renderer, never two

`src/verdict-view.js` is the single source of verdict presentation. The inline
badge, the popup card, and the floating widget's detail window all call
`present()`.

**Incidents.** `verdictOf()` was duplicated and the copies drifted. The
`SAVE_SCAN` payload was duplicated and one copy omitted `isStoreUrl`, silently
breaking a popup filter tier. The badge's detail styles were scoped to
`.credibytes-badge`, so the widget produced identical markup with none of the
styling applied and rendered as one undifferentiated paragraph.

If you find yourself copying verdict logic **or its styles**, share them instead.

### 4. Assert only what can be evidenced

The extension states only what it can verify against a declared channel or quote
from a first-party source. Four signals were built, measured, and deliberately
not shipped as verdicts:

| Measured | Shipped as | Reason |
|---|---|---|
| Displayed app title matching a registrant | nothing | advertiser-controlled text |
| Play and Apple data-safety declarations | quoted, never scored | a compliance disclosure, not a predictor of registration |
| Revoked-list name matches | advisory, never a verdict | a name must not condemn a company |
| Harassment reported in store reviews | nothing | self-selected, unverifiable, and statistically indistinguishable between registered and unregistered apps |

### 5. A page may be destroyed mid-write

`window.close()` terminates the popup. `sidePanel.setOptions({enabled: false})`
tears down the side panel — **which is the same page** when a setting is changed
from within it. `chrome.storage.local.set` is asynchronous.

**Sequence accordingly:**

- Gesture-bound calls run **first and synchronously**. `chrome.sidePanel.open()`
  is valid only while a user gesture remains in scope; a `chrome.tabs.query`
  callback is already too late, and Chrome refuses the call.
- Anything that destroys a page runs **inside the write callback**.

**Incident.** Turning the side-panel toggle off from within the panel closed the
panel before the write completed, so the setting never persisted and read back
as enabled on next open — externally indistinguishable from defaulting to on.
Separately, `open()` throwing prevented the `window.close()` two lines below from
running, so a single defect presented as two.

---

## Platform constraints

### Facebook's DOM

The markup is undocumented, obfuscated, and varies by surface.

- **Ad containers differ per surface.** `[role="article"]` and `[data-pagelet]`
  do not appear at all in the Meta Ad Library. Cards there are located by finding
  the lowest ancestor containing the text "Library ID" exactly once — each card
  states it once, the enclosing grid states it once per card. This path is gated
  on `location.pathname` so the news feed remains unaffected.
- **The destination is not in `href`.** Facebook stores the real target in
  `data-lynx-uri` while `href` holds an internal redirect, and wraps outbound
  links through four redirect hosts.
- **Links must be ranked, not taken in document order.** `links[0]` is typically
  the advertiser's avatar link. Ranking is store (0) > external (1) > social (2),
  applied after redirect unwrapping.
- **Search outward from the "Sponsored" marker**, not across the whole
  advertisement. A `WeakMap<adRoot, marker>` exists for this; scanning the entire
  subtree once caused an advertisement to report an unrelated commenter's name.
- **Some previews expose no outbound link at all.** The destination appears only
  as displayed caption text. That path is used only as a last resort, accepts
  only elements whose *entire* text is a bare domain, and discloses its
  provenance on the badge.

### Chrome extension APIs

- `chrome.sidePanel.open()` requires a live user gesture and cannot be called
  after an asynchronous hop.
- `chrome.permissions.request()` is available only to extension pages — not to
  content scripts and not to the service worker.
- Service workers have no `window` and no `DOMParser`. Files loaded by
  `importScripts` must attach to `globalThis`; assigning to `window` prevented
  worker registration entirely (status code 15).
- CSS `resize` requires `overflow` other than `visible`. Use `hidden`: `auto`
  makes the entire panel scrollable and detaches its header when the body
  scrolls.
- An inline `style.display` overrides the stylesheet. Use `removeProperty()` to
  return control to CSS rather than asserting a layout that contradicts it.

### Generated files

`sec_reference.js`, `revoked_reference.js`, `stage1_model.js` and
`stage3_model.js` are generated. **Do not edit them by hand.**

Exported model trees address features **by index**, so the ordering of
`model.features` is load-bearing. Reordering it scores every input against the
wrong columns and raises no error.

---

## Working practices

### User-facing text

Never inline a string. Add the key to **both** `en` and `tl` in `src/i18n.js` —
`tests/i18n.test.mjs` asserts parity — and render it through `T("your.key")`.

Verdict text emitted by `matcher.js` is a `{key, params}` descriptor rather than
a completed sentence, so a scan stored months ago renders in whichever language
is selected at display time.

### Regenerating artefacts

```bash
# Models — from the CrediBytes-Backend repository, cloned as a sibling directory
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

**When regenerating the SEC registry:**

- **Preserve full legal names**, including "doing business as" aliases.
  `matcher.js` uses those trade names to identify advertisements running under an
  alias rather than the registered corporate name. Truncating them breaks name
  matching.
- **Retain name-only records** (those with no URL). They cannot verify anything,
  but they drive the `name_match_only` verdict and the brand set that determines
  whether an advertisement is scanned at all. An early revision dropped them and
  silently degraded both verdict quality and detection recall.

**The parity test is not optional.** `normalise()` in Python writes the revoked
list's keys; `normalizeRevoked()` in `matcher.js` computes the key it looks up.
If the two disagree, **nothing raises** — the shipped entries simply become
unreachable, every advisory stops firing, and the extension continues to run
normally.

---

## Testing

```bash
node tests/run-all.mjs        # 20 suites, 407 assertions
node tests/stage3.test.mjs    # a single suite
```

Suites load the real content scripts into a Chromium page against mock Facebook
markup rather than testing extracted logic in isolation.

### Two lessons worth inheriting

**A test double more permissive than the real environment conceals defects.** An
early suite set `window.self = window` to simulate a service worker. That made a
page resemble a worker — the inverse of the actual constraint — and concealed a
failure that disabled the extension outright.

**Fixtures must not depend on live registry contents.** Two suites broke when the
underlying data legitimately changed; one used a package ID as its "undeclared"
example on the day that application became declared. Use synthetic records for
anything that asserts on registry state.

### Diagnosing unusual failures

A syntax error in `popup.js` presents as **timeouts across several unrelated
suites**, not as a parse error — the page simply never becomes interactive.
Check the file parses before investigating the failures:

```bash
node -e "new Function(require('fs').readFileSync('src/popup.js','utf8'))"
```
