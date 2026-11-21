# TMDB JSON Extractor — Agent Handoff Notes

Last updated: 2026-11-21

## Project overview

Chrome Manifest V3 extension that extracts movie/TV/person data from The Movie Database
(TMDB) detail pages and copies/downloads it as JSON.

- Working directory: `D:\크롬_앱\01-tmdb-json-extractor`
- Extension version: `1.4` (see `manifest.json`)
- Output schema version: `1.4` (`schemaVersion` field in media/person JSON)

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `contextMenus`, `clipboardWrite`, `scripting`. Host: `*://www.themoviedb.org/*`. |
| `background.js` | Context-menu registration (install/update safe), menu-id to action map, content-script dynamic injection fallback. |
| `content.js` | All extraction logic: media/cast/person, toast UI, clipboard, JSON download, image helpers. |
| `tmdb-json-extractor.zip` | Legacy 1.3 package. Intentionally NOT regenerated. Ignored by Git. |
| `AGENTS.md` | This handoff/test log. |

No build system, linter, or test runner. Plain JS loaded directly by Chrome.

## Architecture notes

- `content.js` registers `chrome.runtime.onMessage` only once using
  `window.__tmdbExtractorLoaded` as an idempotency guard.
- Listener maps actions to `handleExtraction(kind, sendResponse)`:
  - `extractAndDownload` -> `media`
  - `extractCastAndDownload` -> `cast`
  - `extractPersonAndDownload` -> `person`
- `getPageInfo()` parses `new URL(location.href).pathname` with
  `^/(movie|tv|person)/<digits>[-/]`. TV season/episode subpages are rejected.
- `background.js` re-injects `content.js` only when sendMessage fails with
  "Receiving end does not exist" / "Could not establish connection". Other errors are logged,
  not retried, to avoid double listeners.
- `handleExtraction` builds the payload, copies to clipboard (`copyToClipboard`, with
  `execCommand` fallback), then downloads a file. A single toast reports the combined result.
- `downloadJsonFile` returns the final filename, or `null` on failure.

## Changes made in this session

1. **Critical TDZ fix**: `factsEls` is declared before the `isTV` block inside
   `extractMediaData()`. Previously TV pages threw `ReferenceError` and all extraction failed.
2. **Duplicate execution guard**: `window.__tmdbExtractorLoaded`; background no longer blindly
   re-injects on every sendMessage error.
3. **Context menu robustness**: `chrome.contextMenus.removeAll()` before creating menus on
   install/update; no `setTimeout` in the service worker.
4. **URL handling**: pathname-based detection (supports TMDB slugs such as
   `/movie/27205-inception`); blocks `/tv/<id>/season/...` and `episode` pages.
5. **Shared helpers**: `handleExtraction`, `copyToClipboard`, `downloadJsonFile` replace three
   duplicated message handlers. Clipboard failure no longer reports success.
6. **Cast handling**: empty cast produces an error toast and no download; cast images use
   `srcset`/`data-src` via `getImageSource`; `episodes` is `null` for movies.
7. **Image classification**: exact size-token matching instead of substring matching.
   Poster-only tokens vs backdrop tokens are mutually exclusive; profile-only tokens
   (`w45/w90/w138/w276` families, `h632`) are excluded from posters/backdrops.
   Added `w600_and_h900_face`, `w440_and_h660_face`. `posters`/`backdrops` are deduped by
   filename, keeping the highest-width variant.
8. **Profile high-res**: `w276_and_h350_face` maps to `h632` for `image_high` (verified 200 OK).
9. **Countries**: dedupe LD+JSON and DOM values; skip empty names.
10. **TV status**: no LD+JSON status guessing for TV; DOM Status wins. Added `statusKey`
    (`released`, `returning`, `ended`, `canceled`, `post_production`, `planned`).
11. **Numbers normalized**: `voteAverage`, `voteCount`, `reviewCount`, `discussionCount`,
    `videoCount`, `backdropCount`, `posterCount`, and numeric `contentScore` use `toNumber`.
12. **Metadata added** to media and person payloads: `statusKey` (media), `schemaVersion`,
    `sourceUrl`, `extractedAt`.
13. **Crew splitting**: combined roles like `"Director, Writer"` become separate crew entries.
14. **Companies/languages fallbacks**: LD+JSON `productionCompany` and facts-row fallbacks for
    `productionCompanies` / `spokenLanguages` (may still be empty; see limitations).
15. **Manifest**: removed `activeTab`, narrowed host/matches/documentUrlPatterns to
    `*://www.themoviedb.org/*`.

## Live verification (2026-11-21)

Tested against `https://www.themoviedb.org/movie/1368337-the-odyssey`:

- `.facts` rows on the page: original title, status, original language, budget, revenue only.
  There are **no** production-company or language links anywhere in the DOM.
- The page LD+JSON (`@type: Movie`) has no `inLanguage`, no `productionCompany`, and no
  `startDate`/`endDate`; it has `countryOfOrigin`, `duration`, `genre`, `datePublished`.
- Image size tokens present: `w300_and_h450_face`, `w600_and_h900_face`,
  `w138_and_h175_face`, `w276_and_h350_face`, `w45_and_h45_face`, `w90_and_h90_face`,
  `w533_and_h300_face`, `w1066_and_h600_face`, `w220_and_h330_face`, `w440_and_h660_face`.
- Cast card `<img>`: `src` is `w138_and_h175_face`, `srcset` includes `w276_and_h350_face 2x`.
- Crew list has one row: "Director, Writer" (now split into two entries).
- `certification` is `15` and `release` is `2026/08/05 (KR)` as displayed by TMDB; these are
  site-provided values, not extraction bugs.
- CDN checks: `h632`, `w780`, and `w600_and_h900_face` variants returned HTTP 200.

## Known limitations

- `productionCompanies` and `spokenLanguages` are empty on current TMDB movie pages because the
  data is not present in DOM or LD+JSON. Only API enrichment could fill them.
- `originalLanguage` is a localized label ("영어"); no reliable ISO code source on the page.
- `certification` is whatever the page shows and may not match the release locale.
- `releaseDate` prefers LD+JSON `datePublished`; it can differ from `releaseInfo` (local release).
- Image collection covers only images rendered in the DOM. `posterCount`/`backdropCount` come
  from menu labels and can greatly exceed the number of collected URLs.
- `w185`/`w780` are shared by multiple image types; path hints are preferred when available.
- Date parsing in `releaseInfo` is locale-dependent; LD+JSON date is preferred.
- The ZIP package is stale (1.3). Load the directory as an unpacked extension instead.

## Validation commands

```powershell
node --check content.js
node --check background.js
Get-Content -Raw manifest.json | ConvertFrom-Json
```

All three passed after the last edits.

## How to test manually

1. Load `D:\크롬_앱\01-tmdb-json-extractor` via `chrome://extensions` (Developer mode, Load unpacked).
2. Open a movie page, e.g. `https://www.themoviedb.org/movie/1368337-the-odyssey`.
3. Right-click -> "영화 JSON 추출" / "배우 JSON 추출"; check toast, clipboard, downloaded JSON.
4. Verify numbering types and new fields: `schemaVersion`, `statusKey`, `sourceUrl`, `extractedAt`.
5. Repeat on a TV detail page and a person page. Confirm season/episode subpages are rejected.

## Possible next steps

- Re-extract a sample after reloading the extension and compare against schema 1.4.
- Consider adding a `mediaType` field to media JSON.
- Optionally enrich companies/languages via the TMDB API (requires an API key and new permissions;
  out of current scope).
- Rebuild the ZIP only if a packaged release is requested.
