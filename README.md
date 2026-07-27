# CrediBytes — Browser Extension

Chrome extension (Manifest V3) that detects Online Lending Application (OLA)
advertisements on Facebook and checks them against the SEC Philippines registry.

Part of the thesis *"A Machine Learning Advertisement Analysis System for
Detecting Legitimacy of Philippines OLAs"*.

---

## How it works

Two signals are combined per advertisement, both computed **locally in the
page** — no network request is required to render a verdict.

```
Facebook feed
      │
      ▼
content.js — MutationObserver finds "Sponsored" posts
      │      climbs to the real ad container, extracts landing URL,
      │      ad text and advertiser name
      ▼
      ├── STAGE 2 — matcher.js  (deterministic, authoritative)
      │     Pass 1  Play Store package ID  ─┐
      │     Pass 2  App Store numeric ID    ├─ store URLs stop here
      │     Pass 3  domain / subdomain      │
      │     Pass 4  normalised name match  ─┘
      │        → legitimate / likely_legitimate / unverified
      │        → plus a fuzzy "possible match" suggestion when unverified
      │
      └── STAGE 1 — stage1.js + stage1_model.js  (supplementary)
            LightGBM ensemble evaluated in-page
              → profile score + risk tier
      │
      ▼
Badge / floating widget / side panel
      │
      ▼
background.js  → chrome.storage.local (single writer)
```

**Stage 2 decides the badge.** Stage 1 contributes a *profile score* — how much
the advertiser's identity resembles SEC-registered OLA platforms — and never
overrides the registry lookup.

---

## Badge states

| Badge | Meaning |
|---|---|
| **SEC Verified** | URL matched a SEC-declared Play Store / App Store ID, domain, or name |
| **Likely Legitimate** | App name matched the registry, but the URL could not be verified |
| **Unverified** | No registry match — a non-store URL, or a store URL with no extractable ID |
| **Unregistered App** | A store URL whose package/Apple ID *was* extracted and is absent from the registry |

The last two differ in certainty. *Unverified* means we could not confirm either
way. *Unregistered App* means the exact application is identified and it has no
SEC declaration — no ambiguity, so it ranks highest risk.

---

## Display modes

Set in the popup's Settings tab. Changes apply immediately, with no page reload.

| Mode | Behaviour |
|---|---|
| **Inline badge** | A verdict bar above each detected ad |
| **Floating widget** | Draggable summary panel listing recent scans |
| **Side panel** | Badges on ads plus Chrome's side panel; the toolbar icon opens the panel instead of the popup |

`popup.html` serves both the popup and the side panel. The two are told apart by
the `?panel=1` query parameter that the manifest and `setOptions()` supply — not
by width, since the panel is resizable and is often narrower than the popup.

---

## Layout

```
CrediBytes/
├── manifest.json            Manifest V3 configuration
├── icons/                   16 / 48 / 128 px PNGs (SVG sources alongside)
├── src/
│   ├── sec_reference.json   SEC OLA registry — 153 records
│   ├── sec_reference.js     The same data as `const SEC_REFERENCE = [...]`
│   ├── matcher.js           Stage 2 matcher — JS port of match_ad_links.py
│   ├── stage1_model.js      GENERATED — LightGBM trees, ~11.5 KB
│   ├── stage1.js            Stage 1 evaluator (walks the trees, applies sigmoid)
│   ├── content.js           Ad detection, badge injection, floating widget
│   ├── background.js        MV3 service worker — storage writes, backend fallback
│   ├── panel-init.js        Sets the side-panel layout class before first paint
│   └── popup.html/.css/.js  Popup and side-panel UI
└── tests/                   Playwright suites — see tests/README.md
```

Content scripts load in dependency order:
`sec_reference.js → stage1_model.js → matcher.js → stage1.js → content.js`.

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `CrediBytes/` folder

The PNG icons are committed, so no build step is required.

---

## Stage 1 runs locally

The Stage 1 model is bundled rather than called over the network. The backend is
hosted on Render's free tier, which spins down after ~15 minutes of inactivity;
the next request then pays a 30–60 second cold start, and the profile score used
to disappear from the badge for exactly the users who waited longest.

The model is 100 trees at `max_depth=3`, about 11.5 KB exported, so evaluating
it in the page is instant and works offline.

**This is not an approximation.** `stage1.js` walks LightGBM's own thresholds
and sums its own leaf values, reproducing `predict_proba` exactly.
`CrediBytes-Backend/verify_export.py` asserts it:

```
1. probabilities   n=190  max|diff| = 0.00e+00
2. features        8 edge cases  OK
3. risk tiers      10 boundary probes  OK
```

The backend remains the fallback if `stage1_model.js` fails to load, and is
warmed by a rate-limited request when a Facebook tab loads or activates so the
fallback is ready if it is ever needed.

### Regenerating the model

After retraining, from `CrediBytes-Backend/`:

```bash
python export_model_js.py     # writes ../CrediBytes/src/stage1_model.js
python verify_export.py       # asserts JS output matches the served model
```

Never edit `stage1_model.js` by hand.

---

## Updating the SEC registry

`sec_reference.json` is generated from the thesis pipeline's `ph_ola_final.csv`:

```bash
cd "path/to/Thesis Project"
python update_sec_reference.py
```

Copy the output over `src/sec_reference.json`, mirror it into
`src/sec_reference.js` as `const SEC_REFERENCE = [...]`, then reload the
extension.

The **full legal name** matters here, including "doing business as" aliases —
`matcher.js` uses those trade names to catch ads that advertise under an alias
rather than the registered corporate name. Do not truncate them.

---

## Backend

Optional. See [`../CrediBytes-Backend`](../CrediBytes-Backend). Configured at
the top of `src/background.js`:

```js
const BACKEND_URL = 'https://credibytes-backend.onrender.com'
```

---

## Tests

```bash
node tests/run-all.mjs
```

Six Playwright suites (78 assertions) load the real content scripts into a
Chromium page against mock Facebook markup. See
[`tests/README.md`](tests/README.md) for what each one locks in.

Playwright is not a dependency of this repo; the harness borrows it from a
sibling checkout, or set `PLAYWRIGHT_ROOT`.

---

## Security and robustness notes

- **No `innerHTML` anywhere.** All DOM is built with `createElement` +
  `textContent`. Advertiser names come from Facebook and are untrusted input.
- **All network calls go through `background.js`.** Facebook's CSP blocks
  `fetch()` to external origins from content scripts; the MV3 service worker is
  exempt.
- **`background.js` is the single writer** to `chrome.storage.local`, which
  keeps concurrent scans across tabs from racing.
- **Content scripts survive extension reloads.** Reloading or updating the
  extension orphans scripts already injected into open tabs — `chrome.runtime`
  becomes `undefined`. Every `chrome.*` call is guarded and the observer shuts
  down on first detection, instead of throwing once per detected ad.
