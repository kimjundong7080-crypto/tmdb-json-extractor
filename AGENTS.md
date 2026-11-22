# TMDB JSON Extractor — Agent Handoff Notes

Last updated: 2026-11-22

## Project overview

Chrome Manifest V3 extension that extracts movie/TV/person data from The Movie Database
(TMDB) detail pages and copies/downloads it as JSON.

- Working directory: `D:\크롬_앱\01-tmdb-json-extractor`
- Repository: `https://github.com/kimjundong7080-crypto/tmdb-json-extractor` (branch `main`)
- Extension version: `1.5` (see `manifest.json`)
- Output schema version: `1.5` (`schemaVersion` field in media/person JSON)
- No TMDB API key is available (approval denied). Do not add API-dependent code paths.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `contextMenus`, `clipboardWrite`, `scripting`. Hosts: `*://www.themoviedb.org/*`, `https://query.wikidata.org/*`. |
| `background.js` | Context-menu registration (install/update safe), menu-id to action map, content-script dynamic injection fallback. |
| `content.js` | All extraction logic: media/cast/person, toast UI, clipboard, JSON download, image helpers. |
| `tmdb-json-extractor.zip` | Legacy 1.3 package. Intentionally NOT regenerated. Ignored by Git. |
| `AGENTS.md` | This handoff/test log. |

No build system, linter, or test runner. Plain JS loaded directly by Chrome.

## Quick status (2026-11-22)

- Extension/schema are both `1.5`; source directory is the deliverable (not the stale ZIP).
- Media extraction is async and enriched from TMDB subpages plus Wikidata; all enrichment
  failures are non-fatal.
- Live test on `movie/1368337`: 69 cast, 252 crew, 3 videos, 170 posters, 288 backdrops,
  110 releases, 2 companies, 3 countries, `originalLanguageCode: "en"`, ~2.4 s.
- Gallery image dedupe bug is fixed: `mergeGalleryImages` now assigns the deduped arrays back
  to `data.images.*`; verified zero duplicate filenames.
- Open/manual item: reload the unpacked extension and smoke-test a TV detail page and a person
  page. All-language galleries and TMDB API enrichment are intentionally out of scope.

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
- `downloadJsonFile` returns the final filename, or `null` on failure. It keeps using
  `<a download>`, so files go to Chrome's default download folder.
- `extractMediaData(options)` is async. The main-page DOM/LD+JSON extraction stays synchronous;
  after it completes, `enrichMediaData()` optionally augments the payload.
- **No TMDB API is used** (access was not approved). Enrichment uses same-origin TMDB HTML
  subpages plus Wikidata SPARQL:
  - `/{movie|tv}/{id}/images/posters`: variants default, `?image_language=xx`,
    `?image_language=en` (120 ms apart).
  - `/{movie|tv}/{id}/images/backdrops`: variants default, `?image_language=en`.
  - `/{movie|tv}/{id}/cast`: full cast (`h3` "출연진"/"Cast" + following `ol.people`) and full
    crew (`ol.people.crew` lists, department taken from the preceding `h4`).
  - `/{movie|tv}/{id}/videos`: all video cards (`a[data-id]`).
  - `/{movie|tv}/{id}/releases`: `table.releases` rows (country, date, certification, type).
  - `https://query.wikidata.org/sparql`: fills missing companies/languages/countries and
    `originalLanguageCode` via TMDB ID properties (movie `P4947`, TV `P4983`).
- Subpage HTML is cached in `window.__tmdbFetchCache` for 10 minutes; Wikidata results in
  `window.__tmdbWikidataCache` for 30 minutes. All fetches use an 8 s AbortController timeout,
  and enrichment failures are logged without failing the extraction.
- Gallery images are normalized to `media.themoviedb.org` and emitted as three variants
  (`posters` w500, `posters_high` w780, `posters_original`; `backdrops` w780/w1280/original),
  deduped by filename.

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

## Changes in 1.5 — no-API enrichment (2026-11-22)

TMDB API approval was denied, so scraping was upgraded instead of replaced.

1. **Subpage fetching**: `fetchHtmlDoc` + `DOMParser` read same-origin TMDB HTML with a 10 min
   cache, 8 s timeout, and graceful failure per section.
2. **Galleries**: poster/backdrop gallery pages are parsed for `a[href*="/t/p/"]`. Image URLs
   from `image.tmdb.org` are normalized to `media.themoviedb.org`. Output is split into
   display/high/original arrays and deduped by filename.
3. **Full cast/crew**: `/cast` yields 69 cast and ~250 crew for the sample movie. Crew roles are
   split on commas; departments come from the localized `h4` heading
   (`normalizeDepartmentLabel`) with job-text inference as fallback.
4. **All videos**: `/videos` adds cards missing from the detail page.
5. **Releases**: `/releases` populates a new `releases[]` array
   (`country`, `countryCode`, `date`, `certification`, `type`, `language`, `note`) and backfills
   `certification` from the `KR` row when empty.
6. **Wikidata enrichment**: SPARQL fills `productionCompanies`, `productionCountries`,
   `spokenLanguages`, and `originalLanguageCode` only when those are empty. Verified CORS works
   from the TMDB page origin.
7. **Schema 1.5**: added `originalLanguageCode` and `releases`; media extraction is now async and
   `handleExtraction` awaits it. Cast-only extraction fetches only `/cast`.
8. **Manifest**: version 1.5; added `https://query.wikidata.org/*` to `host_permissions`.

Live test on `movie/1368337` (full enrichment): ~2.4 s, 69 cast, 252 crew entries, 3 videos,
170 poster URLs, 288 backdrop URLs, 110 releases, 2 companies, 3 countries, 1 language,
`originalLanguageCode: "en"`. `voteAverage`/`voteCount` normalized to numbers (8 / 5302).
Image arrays are deduped by filename with zero duplicate filenames after the final merge.

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

- `productionCompanies`, `productionCountries`, `spokenLanguages`, and `originalLanguageCode`
  still depend on Wikidata. If the title has no Wikidata item or missing statements, they stay
  empty. TMDB's own movie pages do not expose these fields in DOM or LD+JSON.
- `originalLanguage` is a localized label ("영어"); `originalLanguageCode` comes from Wikidata
  (`P218`) only, not from the page.
- `certification` prefers the page value; `releases[].certification` is parsed from `/releases`
  and may be empty per country. The first page certification can still be misleading.
- `releaseDate` prefers LD+JSON `datePublished`; `releaseInfo` and `releases[]` can differ
  (local release dates).
- Galleries are language-filtered by TMDB. The extractor fetches default, `xx`, and `en`
  (posters) or default and `en` (backdrops) to limit requests. `posterCount`/`backdropCount`
  (menu labels, e.g. 489/332) can exceed the collected URLs (e.g. 170/288). Fetching every
  language would need ~40 requests per gallery type and is intentionally not done by default.
- Cast/crew/videos/releases pages can change markup; each fetch fails independently and is
  logged, so one broken section does not abort extraction.
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

Live integration test was also run by evaluating `content.js` in the TMDB page context
(`extractMediaData` with all enrichment options enabled). Timings are ~2.4 s for 8 network
requests (5 gallery pages, 1 cast page, 1 videos page, 1 releases page, 1 Wikidata query, with
overlap), and all section failures are non-fatal.

## How to test manually

1. Load `D:\크롬_앱\01-tmdb-json-extractor` via `chrome://extensions` (Developer mode, Load unpacked).
   Reload the extension after code changes; version is 1.5.
2. Open a movie page, e.g. `https://www.themoviedb.org/movie/1368337-the-odyssey`.
3. Right-click -> "영화 JSON 추출" / "배우 JSON 추출"; check toast, clipboard, downloaded JSON.
4. Verify schema 1.5 fields: `schemaVersion`, `statusKey`, `sourceUrl`, `extractedAt`,
   `originalLanguageCode`, `releases`, numeric `voteAverage`/`voteCount`.
5. Verify enrichment on the sample movie: ~69 cast, ~252 crew, 3 videos, ~170 posters,
   ~288 backdrops, 110 releases, 2 companies, 3 countries, 1 language.
6. Repeat on a TV detail page and a person page. Confirm season/episode subpages are rejected.
7. Confirm extraction still works when one subpage request fails (e.g. offline Wikidata); the
   main payload must still be produced and a warning logged in the console.

## Possible next steps

- Re-extract a sample after reloading the extension and compare against schema 1.5.
- Consider adding a `mediaType` field to media JSON.
- Optionally add a capped "all languages" gallery mode, or make the gallery language list
  configurable (default is default/xx/en).
- TMDB API access was denied; do not assume an API key. Wikidata is the only external source in
  use, and it is best-effort only.
- Rebuild the ZIP only if a packaged release is requested (current ZIP is stale 1.3).
