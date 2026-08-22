# Extension Tests

![Suites](https://img.shields.io/badge/suites-20-4285F4)
![Assertions](https://img.shields.io/badge/assertions-407-2e9e4f)
![Runner](https://img.shields.io/badge/Playwright-Chromium-45ba4b)

Browser tests that load the **real** content scripts into a Chromium page
against mock Facebook markup, with the `chrome.*` APIs backed by an in-memory
store that genuinely fires `storage.onChanged`.

**Why a real store rather than a stub.** The display-mode defect these suites
cover was *caused* by nothing listening for storage changes. A stub that merely
recorded calls would have passed while the feature was broken. A test double
that is more permissive than the runtime does not test the runtime.

---

## Quick start

```bash
node tests/run-all.mjs               # all suites; exits non-zero on any failure
node tests/display-modes.test.mjs    # a single suite
```

Playwright is not a dependency of this repository. `_setup.mjs` borrows it from
a sibling checkout that already has it:

```bash
PLAYWRIGHT_ROOT=/path/to/project/with/playwright node tests/run-all.mjs
```

---

## How the harness works

`_setup.mjs` exports `{ chromium, read, createReporter, CHROME_SHIM, SRC,
srcUrl, loadContentScripts }`. A typical suite:

1. Launches headless Chromium and stubs all network requests via `page.route`.
2. Navigates to a real `https://www.facebook.com/...` URL. **Navigation matters**
   — several code paths are gated on `location.pathname`, so `setContent` on
   `about:blank` cannot exercise them. Setting content after navigating keeps the
   URL.
3. Injects `CHROME_SHIM`, then the content scripts **in manifest order**.
4. Waits past `BACKEND_WAIT_MS` (2,500 ms) so the Stage 1 race resolves.
5. Reads `window.__sent` — the messages the content script tried to send.

**Playwright rather than Node's `vm`.** Node's `vm` has no `URL` global, so
`normHost()` returned `""` and made an intermediate claim unreliable. The route
stub is also required: without it `popup.js` loaded twice and threw
`timeTicker already declared`.

---

## Suites

### Ad detection and extraction

| Suite | Assertions | Covers |
|---|---|---|
| `ad-detection` | 15 | Advertiser-name extraction in the news feed (no `role="article"`) and in search results; noise rejection; the fuzzy suggestion path, including a generic link-preview headline no longer burying the brand |
| `ad-library-root` | 11 | Ad Library cards rooted on the Library ID marker; four cards in one grid judged independently; two news-feed regression checks proving that path is untouched |
| `ad-library-caption` | 7 | Destination read from displayed caption text when a preview exposes no outbound link; provenance disclosed on the badge |
| `link-capture` | 9 | `data-lynx-uri` extraction, redirect unwrapping through four hosts, link ranking by type rather than document order |

### Verdicts and data

| Suite | Assertions | Covers |
|---|---|---|
| `stage3` | 65 | Feature order and count; missing values becoming `NaN` rather than `0`; Play dataset identification by shape; Data safety parsing on both stores; Apple privacy-policy extraction; service-worker scope |
| `i18n` | 48 | Key parity between `en` and `tl`; nested descriptor resolution; stored scans re-rendering in the language selected now |
| `revoked-list` | 38 | Advisory versus verdict paths; that a name match never changes a verdict, is never worded as a finding about the advertiser, and never demotes a URL-verified advertisement |
| `analysis-detail` | 39 | Expanded card sections, evidence rows, declared-channel links, possible-match presentation |
| `local-stage1` | 15 | In-page tree walk and sigmoid; risk-tier banding; feature construction including the empty-app-name imputation |
| `backend-precedence` | 11 | A warm backend wins the race; a cold one loses and the local model fills in; a `null` result is never cached |
| `revoked-normalisation-parity` | 3 | Python and JavaScript normalise all 1,413 revoked names identically |

### Interface and platform

| Suite | Assertions | Covers |
|---|---|---|
| `display-modes` | 31 | Live switching without a page reload; the settings split and its legacy migration; the uncapped batched widget; the detail window's one-window rule; scroll containment |
| `batch2-ui` | 23 | Card layout, tiles, filters, and their agreement with the stored totals |
| `layout-and-naming` | 20 | Side-panel sizing at 359/367/500 px; popup versus panel detection; marker-anchored advertiser name; live-ticking timestamps |
| `panel-path` | 16 | `?panel=1` supplied by the manifest and by `setOptions()`; the gesture rule; write-before-destroy ordering |
| `bug-report` | 16 | Form field mapping; URL encoding; that no browsing data is collected |
| `batch1-fixes` | 15 | The first remediation batch: link ranking, ad-root climbing, settings cache |
| `injected-theme` | 11 | Theme applied to badge, widget and detail window in all three states |
| `scan-totals` | 8 | Cumulative totals kept separate from the capped feed, so a tile cannot decrease |
| `orphaned-context` | 6 | Extension reload orphaning injected scripts; guarded `chrome.*` calls; observer disconnect on first detection |

---

## Regressions these lock in

Each entry is a defect that shipped, was diagnosed, and now has a test standing
over it.

**Storage and state**

- Display mode changed only after a page reload — nothing observed
  `chrome.storage.onChanged`, so only the side panel appeared to work, because
  it had a separate `sidePanel.open()` call.
- The **Enable scanning** toggle did nothing: `scanningEnabled` was written but
  never read.
- Concurrent scans raced on a read-modify-write, and **3 of 25 survived**.
  Badges appeared on the page with no corresponding row in the popup.
- Stat tiles were derived from the capped feed, so a tile could *decrease* as
  older rows aged out. The three always summed to exactly the cap.
- Turning the side-panel toggle off from inside the panel closed the panel
  before the write completed, so the setting never persisted.

**Extraction**

- The advertiser name was read from the wrong element — one advertisement
  reported an unrelated commenter's name. The search now starts at the
  "Sponsored" marker and walks outward.
- `links[0]` took the advertiser's avatar link, so an advertisement pointing at a
  SEC-declared package was judged on a `facebook.com` URL.
- Ad Library advertisements were rooted on the card's header row, so every
  verdict on that surface was based on header text alone.

**Layout**

- The side panel left dead space below its content: sizing was gated on
  `@media (min-width: 400px)`, but the panel is often *narrower* than the 360 px
  popup. Detection is by `?panel=1`, never by width.
- The popup collapsed to a sliver — a Chrome popup has no viewport height, so
  `height: 100%` resolved against nothing.
- `overflow: auto` on the resizable widget made the whole panel scroll and
  carried its header away.
- An inline `display: block` overrode the stylesheet's `display: flex`, so the
  widget body grew past its container and was clipped with no scrollbar.

**Models and data**

- The exported model assigned to `window`; a service worker has none, so
  registration failed with status code 15 and scan storage died with it.
- The Play listing dataset index was hardcoded, and a single-character string at
  the same path won the lookup — producing a card with one row and a confident
  percentage built from nothing.
- Apple's absent privacy field became `0`, asserting that every Apple app lacks a
  privacy policy.

---

## Testing guidelines

### A double must not be more permissive than the runtime

An early suite set `window.self = window` to simulate a service worker. That
made a page *resemble* a worker — the inverse of the real constraint — and
concealed a failure that disabled the extension outright. When the same shim
later lacked `chrome.action.onClicked`, the shim was extended to match MV3
rather than the code being guarded against an API that is always present.

### Fixtures must not depend on live registry contents

Two suites broke when the underlying data legitimately changed. One used a
package ID as its "undeclared" example on the day that application became
declared; another asserted on `has_official_website` the day a registrant's
website was added. Anything asserting on registry state uses **synthetic
records** pushed onto `SEC_REFERENCE`.

### Assert the ordering, not merely the calls

Several defects here were sequencing errors in which every individual call was
correct. `panel-path` therefore checks that the panel is disabled *after* the
setting is written, and that `open()` is not nested inside a `tabs.query`
callback — an ordering bug is invisible to a test that only asserts each call
occurs.

### Prefer computed styles to stylesheet text

`display-modes` asserts the widget's computed `overflow-y`, not the CSS source.
Asserting the rule text would pass on a declaration that never reaches the
element.

### Diagnosing unusual failures

A syntax error in `popup.js` presents as **timeouts across several unrelated
suites**, not as a parse error — the page simply never becomes interactive.
Check that the file parses before investigating the failures:

```bash
node -e "new Function(require('fs').readFileSync('src/popup.js','utf8'))"
```

---

## Further reading

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — design invariants and platform
  constraints, with the incident behind each
- [`../README.md`](../README.md) — architecture and verdict states
