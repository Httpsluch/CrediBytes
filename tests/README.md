# Extension tests

Browser tests that load the real content scripts (`sec_reference.js` →
`matcher.js` → `content.js`) into a Chromium page against mock Facebook markup,
with the `chrome.*` APIs shimmed by an in-memory store that genuinely fires
`storage.onChanged`.

That last detail matters: the display-mode bug these tests cover was *caused* by
nothing listening for storage changes, so a stub that merely recorded calls
would have passed while the feature was broken.

## Running

```bash
node tests/run-all.mjs          # all suites
node tests/display-modes.test.mjs   # one suite
```

Playwright is not a dependency of this repo — `_setup.mjs` borrows it from a
sibling checkout that already has it. Override with:

```bash
PLAYWRIGHT_ROOT=/path/to/project/with/playwright node tests/run-all.mjs
```

## Suites

| File | Covers |
|---|---|
| `display-modes.test.mjs` | Live switching between badge / floating / side panel without a page reload; the `scanningEnabled` toggle; badge detail panel and its ARIA state |
| `ad-detection.test.mjs` | Advertiser-name extraction in the news feed (no `role="article"`) and in search results; noise rejection; the Kviku fuzzy-suggestion path; popup height |
| `layout-and-naming.test.mjs` | Side-panel sizing at narrow widths (359/367/500px); popup vs panel detection; marker-anchored advertiser name; live-ticking timestamps |

## Regressions these lock in

- Display mode changed only after a page reload — nothing observed
  `chrome.storage.onChanged`, so only side panel appeared to work (it has a
  separate `sidePanel.open()` call).
- The **Enable scanning** toggle did nothing; `scanningEnabled` was written but
  never read.
- Side panel left a large empty area below the content: sizing was gated on
  `@media (min-width: 400px)`, but the panel is resizable and is commonly
  *narrower* than the 360px popup. Detection is now by `?panel=1`, not width.
- Popup collapsed to a sliver: a Chrome popup has no viewport height of its own,
  so `height: 100%` resolved against nothing and `.feed { flex: 1 }` had no
  space to claim.
- Advertiser name read from the wrong element — a Kviku ad reported an unrelated
  person's name. The search now starts at the "Sponsored" label and walks
  outward, rather than scanning the whole container in selector order.
