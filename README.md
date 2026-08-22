# CrediBytes — Browser Extension

Chrome extension (Manifest V3) that detects Online Lending Application (OLA)
advertisements on Facebook and checks them against the SEC Philippines registry.

Part of the thesis *"A Machine Learning Advertisement Analysis System for
Detecting Legitimacy of Philippine OLAs on Facebook"*.

> **New here? Read [The five rules](#the-five-rules) first.** They are short, and
> every one of them exists because breaking it caused a real, shipped bug.

---

## Quick start

```bash
# 1. Load it
#    chrome://extensions → Developer mode → Load unpacked → select this folder
#    Icons are committed; there is no build step.

# 2. Run the tests
node tests/run-all.mjs          # expect 20/20 suites, 410 assertions
```

Playwright is not a dependency of this repo — the harness borrows it from a
sibling checkout, or set `PLAYWRIGHT_ROOT`.

**To see it work:** open Facebook and scroll, or open the
[Meta Ad Library](https://www.facebook.com/ads/library/?active_status=active&country=PH)
and search a lender name.

---

## The five rules

These are the invariants. Everything else in the codebase is negotiable.

### 1. A name never verifies, and never condemns

The SEC declares platform *names*, and anyone can type a name into an
advertisement. So a name match produces `name_match_only` — never `legitimate` —
and a match against the revoked list produces an **advisory**, never a verdict.

A live example of why: an advertiser displayed the app title
*"Mega Peso-Fast Cash Easy Loan"*, character-for-character identical to a
SEC-registered lender's declared Play listing. The page turned out to be a
Mexican operation advertising in Spanish, in pesos-not-₱, whose own commenters
called it *"Estafadores"*. Name matching would have attached a Philippine
registrant's SEC number to it. URL matching correctly reported **Unverified**.

### 2. "We did not look" is not "we looked and found nothing"

This one defect has appeared **five times** in this project, months apart, in
code written for different purposes:

| where | unknown was stored as | what it then asserted |
|---|---|---|
| `has_official_website` hardcoded | `0` | "this company has no website" |
| `yes_no_to_int("")` | `0` | "this platform is not an app" |
| empty app name → length | `0` | "a real, very short name" |
| Apple's absent privacy field | `""` | "this app has no privacy policy" |
| unreadable Data safety page | `[]` | "this app collects no data" |

It keeps happening because the wrong value always *looks* valid — `0` is a real
number, `""` a real string, `[]` a real list. Nothing throws. The model trains,
the card renders, and the system states something false with full confidence.
The first instance cost **12.7 percentage points** of real-world accuracy while
the reported figure stayed at 74.7%.

```
undefined  →  we did not look        →  feature NaN, row omitted from the card
"" / []    →  we looked, found none  →  feature 0,   row shown
```

Every field read from an external source needs an answer to *"what does this look
like when we could not find out?"* — decided when the field is added.

### 3. One renderer, never two

`verdictOf()` was duplicated once and the copies drifted. The `SAVE_SCAN` payload
was duplicated and one copy lost `isStoreUrl`, silently breaking a popup tier.
The badge's detail CSS was scoped so the widget could not reach it, and the
widget rendered the same markup as one unstyled paragraph.

`src/verdict-view.js` is the single source of verdict presentation. The badge,
the popup card and the widget's detail window all call `present()`. **If you find
yourself copying verdict logic or its styles, share them instead.**

### 4. Nothing is asserted that cannot be shown

The extension states only what it can verify against a declared channel or quote
from a first-party source. Four things were built, measured, and deliberately
**not** shipped as verdicts:

| measured | shipped as |
|---|---|
| displayed app title matching a registrant | nothing — advertiser-controlled text |
| Play/Apple data-safety declarations | **quoted**, never scored |
| revoked-list name matches | **advisory**, never a verdict |
| harassment reported in store reviews | nothing — unverifiable and non-discriminating |

### 5. The page can be destroyed mid-write

`window.close()` ends the popup. `sidePanel.setOptions({enabled:false})` tears
down the panel — *which is the same page* when a setting is changed from inside
it. `chrome.storage.local.set` is asynchronous.

Do the gesture-bound call first (`sidePanel.open()` is only valid while a user
gesture is live — a `chrome.tabs.query` callback is already too late), and do
anything that destroys a page **only inside the write callback**. Getting this
wrong made a toggle appear to "default to on": the write never landed.

---

## Architecture

Three stages. **Only Stage 2 decides the badge**, and it is not machine learning.

```
Facebook page
     │
     ▼
content.js ── MutationObserver finds "Sponsored" markers
     │        climbs to the real ad container (§ Ad roots below)
     │        extracts landing URL, ad text, advertiser name
     │
     ├─▶ STAGE 2 — matcher.js — DETERMINISTIC, AUTHORITATIVE
     │      Pass 1  exact Play package ID / Apple ID   ← store URLs stop here
     │      Pass 2  domain or subdomain
     │      Pass 3  exact normalised name  → name_match_only
     │      then    revoked-list check (verdict path + advisory path)
     │
     ├─▶ STAGE 1 — stage1.js + stage1_model.js — SUPPLEMENTARY
     │      100 LightGBM trees, 7 features, evaluated in-page
     │      → a profile score. Never overrides Stage 2. Not drawn on the card.
     │
     └─▶ STAGE 3 — stage3.js + stage3_model.js — ON A USER CLICK ONLY
            120 trees, 15 features read from the advertised store listing
            → "does this listing resemble ones SEC registrants declare?"
            → plus the developer's Data safety declaration, quoted
     │
     ▼
Inline badge  /  floating widget  /  side panel
     │
     ▼
background.js ─▶ chrome.storage.local   (single writer, serialised)
```

### Why Stage 2 is not a model

A model trained on the legitimacy label reaches ~97% accuracy from `url_type`
**alone**, because the label is derived from the same URL matching. Any such
model is a circular artifact. The label is also not a legitimacy judgement:
**Home Credit PH**, an unambiguously registered lender, is labelled `unverified`
on its Facebook-URL ads and `legitimate` on a landing-page ad — the same company
labelled both ways purely by URL shape.

So ML is applied where it is *not* circular (Stages 1 and 3) and withheld where
it would be.

### Why Stage 3 is a button

Its features come from the advertised app's store listing, which cannot be read
from a Facebook page. Fetching one per ad would mean hundreds of requests per
session, Google rate limits, and the browser quietly telling Google about every
app the user scrolls past. One deliberate click removes all three. Host
permissions are **optional** and requested at the moment the button is pressed.

---

## Verdict states

`verdictOf(legitimacy, status, isStoreUrl)` in `content.js` is the single source
of truth; both the badge and the `SAVE_SCAN` payload derive from it.

| Badge | Bar text | Trigger |
|---|---|---|
| Authority Revoked | `AD AUTHORITY REVOKED` | `legitimacy === "revoked"` — checked **first** |
| SEC Verified | `AD VERIFIED` | `legitimacy === "legitimate"` |
| Likely Legitimate | `AD LIKELY LEGITIMATE` | `legitimacy === "likely_legitimate"` |
| Name Match Only | `AD NAME MATCH ONLY` | `legitimacy === "name_match_only"` |
| Unregistered App | `AD FLAGGED` | store URL + no registry match |
| Unverified | `AD UNVERIFIED` | everything else |

**Unverified vs Unregistered.** *Unverified* means we could not confirm either
way. *Unregistered* means the exact app is identified — package ID or Apple ID
extracted — and has no SEC declaration. No ambiguity, so it ranks higher risk.

**Unregistered vs Revoked** are the two red states and they mean opposite things
about the link. Unregistered: the app was **never** authorised. Revoked: it
**was**, the link is genuine and does belong to that registrant, and the SEC has
since withdrawn the authority. Revoked ranks most severe precisely because
nothing else in the system would object to the ad.

> The bar says `AD FLAGGED` but the stored `label` stays `"Unregistered App"`.
> The bar is a headline; the label is the record, and it is the only thing that
> separates those two red states. **Do not "tidy" them into one.**

---

## Settings model

Two independent settings. They used to be one three-way value, and that conflated
two different questions:

| setting | values | controls |
|---|---|---|
| `sidePanel` | `true` / `false` | where **CrediBytes' own UI** opens: side panel or popup |
| `displayResult` | `"badge"` / `"floating"` | what is drawn **on the Facebook page** |

Every combination is reachable. A legacy `displayMode` of `"badge"`,
`"floating"` or `"sidepanel"` is still read as a fallback in three places
(`onInstalled`, `popup.js`, `content.js`) so a user who never triggers
`onInstalled` still lands somewhere valid.

`popup.html` serves **both** the popup and the side panel. They are told apart by
the `?panel=1` query parameter that the manifest and `setOptions()` supply — not
by width, since the panel is often *narrower* than the 360px popup.

---

## File map

```
CrediBytes/
├── manifest.json              MV3 config. Load order lives here and is load-bearing.
├── icons/                     16 / 32 / 48 / 128 px PNGs
├── src/
│   ├── i18n.js          37 KB  219 keys × en/tl. Verdict text is {key, params},
│   │                           rendered at DISPLAY time so old scans re-translate.
│   ├── verdict-view.js   6 KB  THE shared verdict renderer. See rule 3.
│   ├── sec_reference.js 51 KB  GENERATED — 187 SEC registrants, 128 with a website
│   ├── revoked_reference.js   GENERATED — 1,375 revoked/suspended entries (124 KB)
│   ├── stage1_model.js  13 KB  GENERATED — 100 trees, 7 features
│   ├── stage3_model.js  17 KB  GENERATED — 120 trees, 15 features
│   ├── matcher.js       27 KB  Stage 2 — JS port of match_ad_links.py
│   ├── stage1.js        13 KB  Stage 1 evaluator (tree walk + sigmoid)
│   ├── stage3.js        22 KB  Store listing fetch, Data safety parsing (worker only)
│   ├── content.js       85 KB  Ad detection, badge, floating widget, detail window
│   ├── background.js    20 KB  MV3 worker — storage writes, fetches, action behaviour
│   ├── panel-init.js     2 KB  Applies theme + panel class BEFORE first paint
│   └── popup.html/.css/.js     Popup and side panel (one file serves both)
└── tests/                     20 Playwright suites — see tests/README.md
```

**Content script load order** (from `manifest.json` — `content.js` reads globals
the others define):

```
i18n.js → verdict-view.js → sec_reference.js → revoked_reference.js
        → stage1_model.js → matcher.js → stage1.js → content.js
```

`stage3.js` and `stage3_model.js` are **not** content scripts. They are
`importScripts`-ed by the service worker, which has no `window` — both files
attach to `globalThis` for that reason. Assigning to `window` broke worker
registration outright (status code 15) and silently killed scan storage with it.

---

## Common tasks

### Add or change user-facing text

Never inline a string. Add a key to **both** `en` and `tl` in `src/i18n.js` —
`tests/i18n.test.mjs` asserts parity — and render it with `T("your.key")`.

Verdict text emitted by `matcher.js` is a `{key, params}` descriptor, not a
sentence, so a scan saved months ago re-reads in whatever language is selected
now.

### Regenerate the Stage 1 or Stage 3 model

From `CrediBytes-Backend/`:

```bash
python tools/export_model_js.py      # → ../CrediBytes/src/stage1_model.js
python tools/verify_export.py        # asserts JS == predict_proba
python tools/verify_export_stage3.py # expect max|diff| ~1e-07 over 130 rows
```

**Never edit a `*_model.js` by hand.** The exported trees address features **by
index**, so `model.features` order is load-bearing — reordering it scores every
input against the wrong columns and nothing raises.

### Update the SEC registry

From the thesis project:

```bash
python update_sec_reference.py --deploy   # writes .js and .json into src/
```

**Keep the full legal name, including "doing business as" aliases.**
`matcher.js` uses those trade names to catch ads advertising under an alias.
Truncating them breaks Pass 3.

**Keep name-only records** (no URL). They cannot verify anything, but they drive
the `name_match_only` verdict and `REGISTRY_BRANDS`, which is what decides an ad
is worth scanning at all.

### Update the revoked list

```bash
python build_revoked_reference.py --deploy   # expect 1,375 records
python export_revoked_names.py               # regenerate the parity fixture
node tests/revoked-normalisation-parity.test.mjs
```

That parity test matters more than it looks: `normalise()` in Python writes the
keys and `normalizeRevoked()` in `matcher.js` computes the key it looks up. If
they disagree, **nothing throws** — the shipped entries simply become
unreachable, every advisory stops firing, and the extension keeps running
normally.

### Point at a different backend

```js
// src/background.js
const BACKEND_URL = 'https://credibytes-backend.onrender.com'
```

Optional. Stage 1 runs locally; the backend is a fallback and is warmed by a
rate-limited request when a Facebook tab loads.

---

## Gotchas that will bite you

**Facebook's DOM is undocumented and hostile.**

- **Ad roots differ by surface.** `[role="article"]` and `[data-pagelet]` appear
  **zero times** in the Meta Ad Library. Ads there are rooted by finding the
  lowest ancestor containing "Library ID" *exactly once* — each card states it
  once, the grid states it once per card. Gated on `location.pathname` so the
  news feed is byte-for-byte unchanged.
- **The destination is not in `href`.** Facebook puts the real target in
  `data-lynx-uri` and wraps outbound links through four redirect hosts.
- **Links must be ranked, not taken in DOM order.** `links[0]` is usually the
  advertiser's avatar link. Store (0) > external (1) > social (2).
- **Search outward from the "Sponsored" marker**, not across the whole ad. A
  `WeakMap<adRoot, marker>` exists for this — scanning the whole ad once made a
  Kviku advertisement report a random commenter's name.

**Chrome APIs.**

- `sidePanel.open()` needs a **live user gesture**. Any async hop loses it.
- `chrome.permissions.request()` cannot be called from a content script or the
  worker — extension pages only.
- CSS `resize` needs `overflow` ≠ `visible`; use `hidden`, because `auto` makes
  the *whole* panel scroll and carries its header away.
- An inline `style.display` overrides the stylesheet. Use `removeProperty` to
  hand control back rather than asserting a layout that contradicts the CSS.

**Playwright failures that are not what they look like.** A syntax error in
`popup.js` shows up as *timeouts across six unrelated suites*, not as a parse
error — the page simply never becomes interactive. Check `node -e "new
Function(require('fs').readFileSync('src/popup.js','utf8'))"` first.

---

## Security and privacy

- **No `innerHTML` anywhere.** All DOM is `createElement` + `textContent`.
  Advertiser names come from Facebook and are untrusted.
- **All network calls go through `background.js`.** Facebook's CSP blocks
  `fetch()` to external origins from content scripts; the MV3 worker is exempt.
- **`background.js` is the single writer** to `chrome.storage.local`, serialised
  through one promise chain. Concurrent scans previously raced and **3 of 25
  survived**.
- **Content scripts survive extension reloads.** Reloading orphans already
  injected scripts — `chrome.runtime` reads back `undefined`. Every `chrome.*`
  call is guarded and the observer disconnects on first detection.
- **The bug reporter sends no browsing data.** Version, browser, OS, display
  settings, scan count. Never the tab URL — an Ad Library URL carries the user's
  search terms.
- **Nothing leaves the machine automatically.** Stage 1 may send a company and
  platform name to the backend; Stage 3 fetches a store page **only** on a click.

---

## Tests

```bash
node tests/run-all.mjs        # 20 suites, 410 assertions
node tests/stage3.test.mjs    # or any single suite
```

Suites load the **real** content scripts into a Chromium page against mock
Facebook markup. See [`tests/README.md`](tests/README.md) for what each locks in.

Two lessons worth inheriting:

- **A shim that is more permissive than reality hides bugs.** An early suite set
  `window.self = window` to fake a worker; that made a page look like a worker
  (the reverse of the real constraint) and concealed a failure that broke the
  extension outright.
- **Fixtures must not pin live registry contents.** Two suites broke when the
  data legitimately changed — one used a package ID as its "undeclared" example
  on the day that app became declared. Use synthetic records.

---

## Further reading

`../CLAUDE.md` is the cumulative technical reference: every rejected approach,
every measurement, and why each decision went the way it did. When something
here looks arbitrary, the reasoning is there.
