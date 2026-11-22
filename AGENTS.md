# TMDB JSON Extractor — Agent Handoff Notes

Last updated: 2026-11-22

## Project overview

Chrome Manifest V3 extension that extracts movie/TV/person data from The Movie Database
(TMDB) detail pages and copies/downloads it as JSON.

- Working directory: `D:\크롬_앱\01-tmdb-json-extractor`
- Repository: `https://github.com/kimjundong7080-crypto/tmdb-json-extractor` (branch `main`)
- Extension version: `1.7` (see `manifest.json`)
- Output schema version: `1.7` (`schemaVersion` field in media/person JSON; visible change:
  `youtubeLinks[]`)
- No TMDB API key is available (approval denied). Do not add API-dependent code paths.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `contextMenus`, `clipboardWrite`, `scripting`, `downloads`, `storage`, `unlimitedStorage`. Hosts: `*://www.themoviedb.org/*`, `https://query.wikidata.org/*`, `https://files.tmdb.org/*`. |
| `crawler.js` | Semi-automatic crawler: persistent queue, sitemap discovery/seeding, auto tab navigation, pacing/breaks, control panel, logs, settings, optional image saving. Loaded after `content.js`. |
| `settings.json` | Packaged default settings read at every page start through the service worker (read-only; Chrome forbids writing to the install folder). |
| `background.js` | Context-menu registration (install/update safe), message routing (downloads, image downloads, sitemap proxy/gunzip, packaged settings), content-script injection fallback. |
| `content.js` | All extraction logic: media/cast/person, subpage + Wikidata enrichment, galleries, credits, YouTube link collection, toast UI, clipboard, JSON download, image helpers. |
| `tmdb-json-extractor.zip` | Legacy 1.3 package. Intentionally NOT regenerated. Ignored by Git. |
| `AGENTS.md` | This handoff/test log. |

No build system, linter, or test runner. Plain JS loaded directly by Chrome.

## Quick status (2026-11-22)

- Extension is `1.7` and the output schema is `1.7`; source directory is the deliverable (not the
  stale ZIP).
- Media extraction is async and enriched from TMDB subpages plus Wikidata; all enrichment
  failures are non-fatal.
- Live test on `movie/1368337`: 69 cast, 252 crew, 3 videos, 170 posters, 288 backdrops,
  110 releases, 2 companies, 3 countries, `originalLanguageCode: "en"`, ~2.4 s.
- Gallery image dedupe bug is fixed: `mergeGalleryImages` now assigns the deduped arrays back
  to `data.images.*`; verified zero duplicate filenames.
- Crawler feature set (`crawler.js`, 1.7 series): sitemap streaming queue, per-title people cap,
  single-select language navigation, packaged `settings.json`, optional image saving,
  newest-first sitemap order, and `youtubeLinks[]` in the payload (schema `1.7`).
- Open/manual item: **nothing in the 1.6/1.7 crawler work has been run in a real browser yet**.
  Reload the unpacked extension and follow the checklists below. All-language galleries and TMDB
  API enrichment are intentionally out of scope.

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

## Changes in 1.6 — semi-automatic site crawler (2026-11-22)

Goal: crawl TMDB site-wide without omissions, starting from the Chrome extension (Python was
not needed and would not work with plain HTTP — see limitation below).

### New file

| File | Purpose |
| --- | --- |
| `crawler.js` | Semi-automatic crawler: persistent queue, auto tab navigation, folder downloads, floating control panel, crawl context menus. |

### Added behaviour

1. **All-language galleries (removes the old omission)**: the posters/backdrops gallery page
   carries ~43 `?image_language=xx` filter links. `getGalleryLanguages()` collects them and
   `fetchGalleryUrls(kind, basePath, options)` fetches every language (6 concurrent, 120 ms
   apart) into one deduped set. Verified live: 43 language codes, per-language subsets merged
   (en alone = 141 posters; page badge = 485). `allLanguages: false` keeps the old default/xx/en.
2. **Gallery URL cache**: `window.__tmdbGalleryCache` (10 min) stores only filenames, and gallery
   HTML is fetched with `{ cache: false }` so 50 large documents do not stay in memory.
   `fetchHtmlDoc` also caps the HTML cache at 40 entries.
3. **Crawler engine** (`crawler.js`): state in `chrome.storage.local` (`tmdbCrawlerState`), so it
   survives the tab navigation it performs. Queue entries are `{type, id, url}` for
   movie/tv/person plus `{type:'list'}` list pages. On each load, if active it processes the
   queue head, discovers more links, then navigates after `delayMs`.
   - List pages: all title links + the `?page=N` next page (`.pagination a.load_more`).
   - Detail pages: cast/crew person links (from the already cached `/cast` document) and,
     optionally, a person's filmography titles.
4. **Downloads**: content scripts cannot use `chrome.downloads`, so the content script posts a
   base64 data URL to `background.js`, which saves it as `tmdb/{movie|tv|person}/{id}.json`
   (compact JSON) and `tmdb/index.json` (pretty). Falls back to a flat `<a download>` name if the
   API call fails.
5. **Control panel**: fixed panel on every TMDB page — 시작/일시정지/중지, 큐에 추가, 현재 저장,
   큐 비우기, 인덱스 내보내기, and options (all languages, collect people, collect filmography,
   follow list pages, delay). Context-menu equivalents added in `background.js`.
6. **Person credits fixed (was silently empty)**: `extractPersonData()` used `h3.zero`/`h3.one`,
   which no longer exist, so `credits.acting` was always `[]`. It now keys off the section `h3`
   labels (`.credit_heading` is a single wrapper around all filter UI — do not use it) and emits
   `credits.all[]` with `department`, plus the legacy `acting`/`production` arrays. Live check on
   `/person/1892` (Matt Damon): 226 rows, Acting 188 / Production 31 / Writing 4 / Crew 1 /
   Editing 1 / Creator 1, with job text such as "책임 프로듀서".
7. **Korean fact labels**: person facts rendered in Korean only (`활동명`, `전문 분야`,
   `참여 작품 수`, `성별`, `생일`, `출생지`, `다른 이름`). Mappings added; `age` also parses
   `56세`. Movie labels (`원제`/`상태`/`원어`/`제작비`/`수익`) were already handled.
8. **TV `/releases` removed**: verified 404 (`/tv/1399-.../releases` → "Page Not Found").
   Releases are now requested for movies only.
9. **Crew completeness**: `/cast` crew rows were skipped when the person also appeared in cast
   (actor-directors lost their crew credits). Skipping removed; duplicates are still removed by
   `mergeCastAndCrew` (name+job).
10. **Wikidata query**: three chained `OPTIONAL`s produced a cartesian product (companies ×
    countries × languages) and `LIMIT 50` truncated real values. Replaced with `UNION` +
    `LIMIT 500`, so rows = values, not combinations.
11. **Manifest 1.6**: added `downloads`, `storage`, `unlimitedStorage`; `crawler.js` registered
    after `content.js`; `background.js` re-injection now injects both files.

### Verified in this session

- `node --check content.js|crawler.js|background.js` and `manifest.json` JSON parse: pass.
- Live DOM probes in Chrome (no extension needed): gallery language links (43), release table
  (`table.releases` + `h2.release[id=KR]` inside `<th>`), `/cast` (왕좌의 게임: 593 cast / 349 crew,
  `h4` department labels, `p.episode_count_crew` jobs), person credit sections, TV `/releases` 404.
- Person-credit and all-language gallery algorithms were executed against the live pages; see
  counts above.

### Not verified (needs a real extension load)

- The crawler has not been run end-to-end inside Chrome. Load unpacked, approve the new
  permissions, then: open a TMDB list page → panel [큐에 추가] → [시작]. Check that files appear
  in `Downloads/tmdb/...` and that the tab advances.
- `chrome.downloads.download` with a `data:` URL for large payloads (hundreds of KB) is assumed
  to work; the `<a download>` fallback drops the `tmdb/` subfolder.

### Limitations

- **Plain HTTP clients are blocked**: TMDB answers 403 (Cloudflare) to Python/curl even with a
  browser UA. That is why crawling lives in the browser. A Python crawler would need Playwright
  or CDP driving a real Chrome profile.
- Site-wide means tens of thousands of pages; each title costs ~2 gallery listing requests per
  language (~50) plus `/cast`, `/videos`, `/releases`, Wikidata. Keep `delayMs` ≥ 1500 and expect
  hours. Rate limits or captchas can appear.
- `Discover`/list pagination is capped by TMDB itself (~500 pages); `maxListPages` (300 default)
  additionally limits how many list pages are followed.
- Watch mode is not implemented; `movie`/`tv`/`person` detail pages and list pages are.
- TV seasons/episodes are not extracted individually (they are not detail-page queue entries).

## 1.6.1 adjustments (2026-11-22, after first real crawl)

First real run output lives in `C:\Users\ssii\Downloads\tmdb` (11 records: 9 person, 2 movie).
Folder layout works: `<folder>/movie/<id>.json`, `<folder>/person/<id>.json`, `<folder>/index.json`.

1. **Default is now ONE gallery language** (user request): `allLanguages` defaults to `false`, and the
   non-all path fetches only the site-language gallery page (1 request per gallery type). The
   checkbox "모든 언어 포스터/배경 (끄면 1개 언어)" turns the 43-language sweep back on.
   Settings are versioned (`_v: 2`); old saved settings are discarded so a stale
   `allLanguages: true` cannot silently apply.
2. **Movie-only crawling by default**: `collectPeople` and `collectFilmography` now default to
   `false`, so `https://www.themoviedb.org/movie/` seeds only movie pages plus the `?page=N`
   list pages until the user enables people collection.
3. **Crawl folder is configurable**: new `folder` setting (default `tmdb`) with a panel input;
   `safeFolder()` strips `..`, leading/trailing slashes and unsafe characters before building
   `folder/type/id.json`. `index.json` follows the same folder.
4. **Rate-limit hardening (real failure found)**: the first run wrote only 40 posters and 1
   backdrop for `movie/1726` because the all-language sweep fired ~40 gallery requests in a few
   seconds and TMDB started returning 429/redirects; each failed gallery was caught and skipped
   silently. `fetchHtmlDoc` now: builds an absolute URL from `location.origin` (a relative fetch
   was observed resolving against `image.tmdb.org`), retries once after 1.2 s on 429/5xx, and
   rejects non-HTML responses. Gallery concurrency is 3 with 200 ms spacing.
5. **Still not verified end-to-end**: the extension has not been reloaded and re-run by the agent.
   Re-run checklist: reload unpacked extension → open `https://www.themoviedb.org/movie/` →
   panel [큐에 추가] → [시작] → confirm `listPages` increments and
   `movie-<id>-<slug>.json` grows in `Downloads/<folder>/`.

## 1.6.2 file naming (2026-11-22)

- Output files are now flat and slug-named: `folder/movie-1368337-the-odyssey.json`,
  `folder/person-1892-matt-damon.json`, `folder/tv-1399-game-of-thrones.json` (previous layout
  was `folder/movie/1368337.json`).
- `fileBaseName()` takes the slug from `location.pathname` during processing (the queue stores
  slug-less URLs such as `/movie/1368337`; TMDB redirects to the slug, which is what is used),
  strips unsafe characters, collapses repeated dashes and caps the length at 120.
- Fallbacks: `/movie/1368337` (no slug on the page) → `movie-1368337.json`; a season page would
  yield `tv-1399-game-of-thrones-season-1.json`, but season pages are never queued.
- `index.json` stays `folder/index.json` and its `file` fields use the new names.
- Files produced by earlier runs (`movie/1726.json`, `person/10980.json`) are not renamed.

## Changes in 1.7 — sitemap discovery, targets, human pacing (2026-11-22)

Goal: crawl titles as well as people, choose what to collect, discover the whole site from the
TMDB sitemaps, and stop looking like a script.

### Discovery and selection

1. **Official sitemap discovery**: `robots.txt` points at
   `https://files.tmdb.org/p/exports/sitemaps/sitemap_{movies,tv_series,people}.xml`. Those are
   sitemap indexes; each child (`.xml.gz`, ~1 MB, 50,000 URLs, 5.7 MB decompressed) contains
   canonical URLs **with slugs** (`/movie/3924-blondie`).
2. **Background proxy**: `background.js` handles `crawlFetch`, validates the host
   (`files.tmdb.org` only), downloads, gunzips with `DecompressionStream('gzip')`, extracts
   `<loc>`, caches the last two loc arrays and returns them sliced by `offset`/`limit` so the
   content script never holds a whole sitemap.
3. **Streaming queue**: `crawler.js` keeps a 3,000-entry window. Below 500 entries it asks for
   the next slice (default 1,000 additions) and persists only `kindIndex/childIndex/cursor`.
   Resuming re-reads the same child from the stored cursor.
4. **Targets UI**: 영화 / TV / 배우 / 감독 checkboxes. Titles are saved only when their type is
   checked; 배우 enqueues cast links, 감독 enqueues only Directing crew (from `/cast`). If only a
   people target is checked, titles are visited as **discovery-only** (`save:false`) so the
   gallery/cast/video enrichment is skipped.
5. **Person role filter**: with only 감독, person pages without a Directing credit (and without
   `전문 분야: Directing`) are skipped; with only 배우, pages without Acting credits are skipped.
   `index.json` records the `role` of each person.
6. **Sitemap seeding UI**: `사이트맵` 영화/TV/인물 + batch size + `사이트맵으로 큐 채우기`; the
   same action is on the context menu. People sitemaps require 배우/감독.

### Human-like pacing

7. **Serialized requests**: every TMDB subpage request goes through one promise chain in
   `content.js`; galleries dropped from concurrency 3 to 1 and sleep 0.9–2.0 s per language.
8. **Jitter**: subpage requests wait 0.7–1.8 s (configurable), each with random spread; page
   turn waits 3–7 s plus a reading pause proportional to body text (2–8 s, ±40%).
9. **Long breaks**: every 40–90 pages the crawler takes a 2–5 minute break with a panel
   countdown (`휴식 mm:ss`). Warm-up 2–6 s on start; small scroll/mouse movement before
   navigation.
10. **429 handling**: honours `Retry-After`, backs off 5 s → 15 s → 45 s, and after three
    consecutive 429s sets a 5-minute cooldown (`한도 대기 mm:ss`) and records the item as failed.
11. **robots.txt**: `/person/*/remote/credits` and `image_sort=` URLs are never requested.
12. **Lazy loading**: `preparePage()` waits for core selectors up to 12 s, scrolls 3–7 randomized
    steps until `scrollHeight` stabilises, promotes `img[data-src]`/`source[data-srcset]` to real
    sources and waits for loads (≤1.5 s each), expands person biographies, then scrolls back up.
    List pages are scrolled before pagination/link collection too.

### Fixed defects

13. Link collection now keeps the original href, so queued titles carry slugs and filenames stay
    `movie-1368337-the-odyssey.json` (previously `/movie/1726`).
14. `nextPageUrl()` only accepts `.pagination` / `a.load_more` links for the current path and
    current page + 1 (no more filter-link false positives).
15. Detail-page detection rejects `/cast`, `/images`, `/videos`, `/releases`, `/season/`,
    `/episode/`, `/remote/` subpages.
16. `downloadJsonFile` (manual extraction) now uses the crawler naming rule
    (`buildOutputFilename`) instead of `movie_1726_제목.json`.
17. Persisted crawl state is compact (`queue` as arrays, visited keys as a newline string,
    `STATE_VERSION 2`); visited is capped at 200k in memory and 20k persisted.
18. `getCrawlerSettings()` ignores settings whose `_v` is not 3, so an old
    `allLanguages:true` cannot silently apply.
19. `/cast` crew parsing also accepts department `h3/h4` + `ol/ul.people` markup variants;
    `fetchCreditLinks()` was added to extract cast/director person links for the crawler.

### Verification (this session)

- `node --check content.js`, `crawler.js`, `background.js`; `manifest.json` JSON parse: pass.
- Temporary Node harness (removed afterwards) executed the real `crawler.js` in a VM:
  - URL/type filter: slug preserved, TV season rejected, `/remote/credits` rejected, gallery
    subpage rejected, absolute href normalised, foreign host rejected.
  - Filenames: `movie-1368337-the-odyssey`, `movie-1726-iron-man` (queue-slug fallback),
    `person-1892-matt-damon`, unsafe characters stripped; manual filename builder agreed.
  - Real `sitemap_movies_1.xml.gz`: 50,000 `<loc>` entries, 5,712 KB decompressed, 50,000/50,000
    accepted as movies, no season/episode entries, background and crawler loc counts equal, and
    `DecompressionStream('gzip')` output length matched Node `zlib`.
- **Not verified**: the extension was not reloaded, so no end-to-end crawl, no panel interaction,
  and no real download was exercised.

### Manual checklist (needs an extension reload)

1. `chrome://extensions` → reload the unpacked extension → approve the new
   `files.tmdb.org` permission.
2. Open `https://www.themoviedb.org/movie/`, tick 영화 (and TV if wanted), tick 사이트맵 영화,
   click `사이트맵으로 큐 채우기`, then `시작`.
3. Confirm: panel shows `영화 1/26 · 누적 1000`, files appear as
   `Downloads/tmdb/movie-<id>-<slug>.json`, panel counts split by 영화/TV/인물, and a `휴식 mm:ss`
   countdown appears after 40–90 pages.
4. Enable 배우 or 감독 and confirm person files appear only for the selected role; with both
   title targets off, movie JSON must **not** be written (discovery only).
5. `인덱스 내보내기` → `index.json` has `schemaVersion: "1.7"`, `targets`, `sitemap`, and
   `records[].role`.

### Limits

- Scale is real: the movie index has 26 children × 50,000 = ~1.3 M URLs, and the people index has
  102 children. At the default pacing a run handles roughly 100–200 titles/hour, so a full sweep
  is a multi-day background job; use the batch size and target checkboxes to bound it.
- Person sitemap rows have no role, so 배우/감독 filtering requires visiting each person page;
  deriving people from title credits is much cheaper.
- Each saved JSON triggers a Chrome download entry; large runs clutter the download shelf.
- `state` is rewritten after every page. Persisted size is bounded (queue ≤ 3,000, records ≤ 2,000,
  visited ≤ 20,000 keys) but is still several hundred KB per write.
- TV seasons/episodes are still not queued individually; only `sitemap_tv_series` is used.
- Default galleries remain one language; `모든 언어` multiplies gallery requests and 429 risk.

## 1.7.1 per-title people cap (2026-11-22)

- New setting `peoplePerTitle` (default `30`, clamped to 0–500; `0` = unlimited): the maximum
  number of person entries enqueued from one title's `/cast` page. Limit applies per role (배우 and
  감독 separately) so directors are not crowded out by cast. 30 was chosen because `/cast` is in
  billing order, so the first 30 cover top-billed plus notable supporting cast while bounding
  queue growth per title to 30; users who want everything set `0`.
- `enqueuePeopleLinks()` now delegates to `enqueuePersonLinks(list, role, limit)`, which stops once
  the limit is reached and reports the remainder as `한도 초과`.
- Log line: `인물 큐 | 배우 +N · 감독 +M · 한도 초과 K명 (작품당 최대 L명)` or `(무제한)`.
  `/cast` fetch failure logs `인물 큐 실패 | <message>` instead of only `console.warn`.
- Panel: `작품당 인물 [N] 명 (0=무제한)` under the target options. Imported/saved settings are
  normalized through `clampPeoplePerTitle()`.
- Verified with a temporary Node VM harness that loaded the real `crawler.js` (10 checks, all
  passed): default 30, clamp (0/-5/501/'12.6'/'abc'/9999/'45'), limit 0 unlimited (`+5`, 0
  skipped), limit 3 of 10 (`+3`, 7 skipped), exact limit (0 skipped), 2 already queued (`+3`, 5
  skipped, queue 5), 2 already visited (no quota used), both roles (`+2/+2`, 4 skipped), director
  only (`+0/+2`, 1 skipped), and silence when nothing was added. Also `node --check crawler.js`,
  `manifest.json` parse. Not verified end-to-end (extension reload + real queue growth not
  exercised).

## 1.7.2 language, settings file, image saving (2026-11-22)

1. **Single-select language** (`language`, default `ko-KR`): ko-KR / en-US / ja-JP / de-DE /
   zh-TW / zh-CN / fr-FR / es-ES / pt-BR / ru-RU / it-IT / hi-IN. TMDB's website honors
   `?language=xx-XX` (verified: `/movie/550-fight-club?language=ja-JP` returns a Japanese page),
   so the crawler appends it only when navigating. Queue URLs stay canonical
   (`stripLanguageParam` in `enqueueEntry`/`enqueueList`) and `samePath` ignores the parameter, so
   the same title is never queued twice. `content.js` `pageLocale()` mirrors the current page
   language onto subpage requests (`/cast`, `/videos`, `/releases`, gallery pages) and the
   single-language gallery fetch now uses `?image_language=<short>` instead of the site default.
2. **Settings file**: `settings.json` sits next to `manifest.json` and is read on every page start
   through the service worker (`crawlerPackagedSettings`, which also returns a content hash). First
   run applies the file; afterwards UI changes in `chrome.storage` win until the file is edited.
   When the hash differs from the stored `tmdbCrawlerSettingsHash`, the edited file wins, is
   persisted, and the new hash is stored. **Chrome does not allow an extension to write into its
   own installed folder**, so the UI cannot persist back into `settings.json`; [설정 저장] remains
   a backup export into Downloads. Old `_v != 3` stored settings are discarded.
   Precedence harness (4 cases) passed: first run, unchanged file, edited file, missing file.
3. **Optional image saving** (`saveImages`, default off): after a successful JSON download,
   `saveImages()` sends each display poster/backdrop (or person `profileImage_high`) to
   `background.js` (`crawlerImage`), which calls `chrome.downloads.download` with a remote URL.
   Layout: `<folder>/<json base name>/<title>-poster-001.jpg`, `-backdrop-001.jpg`,
   `-profile-001.jpg` — one folder per title, so titles never mix. Only `media.themoviedb.org` /
   `image.tmdb.org` URLs are accepted, `..` filenames are rejected, and overwrite follows the
   existing `overwrite` setting. High/original variants are intentionally not downloaded.
- Verified with a temporary VM harness (8 groups, all passed): packaged `settings.json` applied at
  startup, language normalization, `withLanguage`/`stripLanguageParam`, canonical queue URLs,
  title slug/extension, image selection, per-title folders and filenames, image log line. Also
  `node --check` on all three scripts plus `manifest.json`/`settings.json` parse. Not verified in a
  real browser (extension reload + real downloads). Image volume is large: a title with 170
  posters and 288 backdrops produces ~458 files.

## 1.7.3 newest-first crawling + YouTube links (2026-11-22)

1. **Newest-first checkbox** (`newestFirst`, default off, panel: `최신 순으로 크롤링 (사이트맵
   뒤에서부터)`). Verified against the live movie sitemap: children are TMDB-id ascending
   (child 1: 3924→71657, child 26: 1787733→1836230, 27,118 URLs), so newest titles are in the last
   child and at the end of each file. When enabled, `fillFromSitemap()` walks children from the
   last one and `background.js` slices `locs` from the end (`fromEnd: true`) and reverses each
   batch; the panel shows `영화 (최신순) 1/26`. Toggling the setting resets `childIndex`/`cursor`
   because the read direction changes.
2. **YouTube links** (`youtubeLinks[]` added to media and person payloads). `content.js`
   `collectYoutubeLinks()` gathers YouTube URLs from (a) page anchors (`youtube.com`, `youtu.be`),
   (b) text in overview/tagline/homepage (media) or biography (person), and (c) the collected
   `videos[].url` list. Each entry is `{ videoId, url: https://www.youtube.com/watch?v=<id>,
   title, source: 'link' | 'text' | 'video' }`, deduped by video ID. Nothing is downloaded from
   YouTube; links are recorded in the saved JSON.
- **Schema 1.7**: `schemaVersion` is now `"1.7"` in both media and person payloads; the only
  payload-shape change is the new `youtubeLinks[]` field.
- Review cleanups: the two duplicate YouTube URL regexes were merged into one pattern inside
  `collectYoutubeLinks` (`extractYoutubeId` removed), the unused `fromEnd` echo was dropped from
  the `background.js` response, and `newestFirst` is read once per sitemap fill/text update.
- Verified with a temporary harness (all passed): real `background.js` `fromEnd` slicing of
  `sitemap_movies_26.xml.gz` returns 1836230 → 1836228 and offset 3 continues at 1836227;
  crawler queue is 5,4,3,2,1 with `newestFirst:true` and 1,2,3,4,5 otherwise; YouTube parsing
  dedupes anchors/text/videos and normalizes short links. Also `node --check` on all scripts and
  JSON parse. Not verified in a real browser.

## Session handoff — current state (2026-11-22, end of session)

This section is the starting point for the next agent. Everything above is historical; where the
two disagree, this section wins.

### What was added in this session (all in the 1.7 series)

| Area | Entry points | Behaviour |
| --- | --- | --- |
| Crawler engine | `crawler.js` (`tick`, `scheduleAfterPage`, `navigateTo`) | Semi-automatic: the tab itself is navigated; state survives navigation in `chrome.storage.local` (`tmdbCrawlerState`, `STATE_VERSION 2`). |
| Sitemap queue | `fillFromSitemap`, `refillIfNeeded`, `seedSitemap`, `crawlFetch` in `background.js` | Streams `sitemap_{movies,tv_series,people}.xml` children, gunzips in the service worker, keeps a 3,000-entry queue and only persists `kindIndex/childIndex/cursor`. |
| Newest first | `newestFirst` setting, `fromEnd` slicing in `background.js` | Walks sitemap children from the last one and slices each file from the end, so highest TMDB ids (newest) are processed first. Toggling resets the sitemap cursor. |
| People cap | `peoplePerTitle`, `enqueuePeopleLinks`, `enqueuePersonLinks` | Max persons enqueued per title from `/cast`; applies per role (배우/감독). `0` = unlimited. `30` is the default. Logs `인물 큐 | 배우 +N · 감독 +M · 한도 초과 K명`. |
| Language | `language` setting, `withLanguage`, `stripLanguageParam`, `pageLocale` in `content.js` | Single-select: ko-KR (default), en-US, ja-JP, de-DE, zh-TW, zh-CN, fr-FR, es-ES, pt-BR, ru-RU, it-IT, hi-IN. Queue URLs stay canonical; `?language=` is added only when navigating. Subpage fetches inherit the page language; single-language galleries use `?image_language=<short>`. |
| Settings file | `settings.json`, `crawlerPackagedSettings`, `loadPackagedSettings`, `requestPackagedSettings` | Read at every page start. `chrome.storage` values win until the file content hash changes; an edited file wins and updates `tmdbCrawlerSettingsHash`. Chrome forbids writing to the install folder, so `[설정 저장]` stays a Downloads backup. |
| Image saving | `saveImages`, `imagesForPayload`, `crawlerImage` in `background.js` | Optional. Writes `<folder>/<json base name>/<title>-poster-001.jpg` etc. Display posters/backdrops + person profile only. Remote URLs limited to `media.themoviedb.org` / `image.tmdb.org`. |
| YouTube links | `collectYoutubeLinks` in `content.js` | Adds `youtubeLinks[]` to media and person payloads: `{ videoId, url, title, source: link|text|video }`, deduped by video id. YouTube is not fetched or downloaded. |
| Schema | `schemaVersion` in both payloads | Bumped to `1.7`; the only shape change is `youtubeLinks[]`. |

### Settings (`DEFAULT_SETTINGS`, `_v: 3`)

`language: ko-KR`, `targets {movie:true,tv:true,cast:false,director:false}`,
`sitemapKinds {movie:true,tv:true,person:false}`, `sitemapBatch: 1000`, `newestFirst: false`,
`allLanguages: false`, `collectFilmography: false`, `followLists: true`, `autoFollow: true`,
`autoFollowQueue: 5`, `autoFollowLimit: 8`, `peoplePerTitle: 30`, `overwrite: true`,
`saveImages: false`, `autoLog: true`, `humanize: true`, `readDelay: true`, `minDelayMs: 3000`,
`maxDelayMs: 7000`, `subpageMinMs: 700`, `subpageMaxMs: 1800`, `breakEveryMin: 40`,
`breakEveryMax: 90`, `breakMinSec: 120`, `breakMaxSec: 300`, `maxListPages: 300`, `folder: tmdb`.

`settings.json` at the repo root contains a subset of these; `crawler.js` fills the rest from
`DEFAULT_SETTINGS`. Stored settings whose `_v` is not `3` are discarded.

### Output layout

- JSON: `Downloads/<folder>/movie-<id>-<slug>.json`, `person-...`, `tv-...`
- Log: `Downloads/<folder>/crawl-log-YYYYMMDD-HHMMSS.log`
- Settings backup: `Downloads/<folder>/crawler-settings.json`
- Index report: `Downloads/<folder>/index.json` (`schemaVersion: 1.7`, settings, stats, sitemap
  progress, last 400 log lines, records with `role`)
- Images (opt-in): `Downloads/<folder>/<json base name>/<title>-poster-001.jpg`, ...

### Verification actually performed

- `node --check crawler.js content.js background.js`; `manifest.json` and `settings.json` parse:
  pass after the last edit.
- Temporary VM harnesses (all deleted afterwards; nothing remains in the repo):
  - people cap: 10 checks (unlimited, limit reached, exact limit, already queued, visited,
    per-role limit, director only, silence when nothing added).
  - settings precedence: 4 cases (first run, unchanged file, edited file, missing file).
  - language + images: 8 groups (language normalization, URL add/strip, canonical queue URLs,
    title slug/extension, image selection, per-title folders/filenames, log line).
  - newest-first + YouTube: real `background.js` `fromEnd` slicing of
    `sitemap_movies_26.xml.gz` (1836230 → 1836228, offset 3 → 1836227), crawler queue order
    5,4,3,2,1 vs 1,2,3,4,5, and YouTube anchor/text/video dedupe.
  - review cleanup: consolidated regex, `schemaVersion` 1.7 in both payloads.
- Live network checks: sitemap children are TMDB-id ascending; TMDB honors `?language=ja-JP`.

### Not verified (highest risk first)

1. **No end-to-end browser run.** The extension has never been reloaded with `crawler.js`.
   Nothing below has been observed working in Chrome.
2. Panel layout/render with the new controls (language `<select>`, `작품당 인물`, `이미지도 저장`,
   `최신 순으로 크롤링`) — no visual check.
3. Real downloads: JSON in `Downloads/<folder>/`, image folders/filenames, overwrite/skip,
   verification counter (`chrome.downloads.search`).
4. Settings hash flow in the real service worker (packaged file edit → next page load applies it).
5. Newest-first resume: stop mid-file, reload, and confirm the cursor continues without skipping
   or duplicating.
6. Language navigation in a live crawl (redirect to slug keeps `?language=`; `samePath` handling).
7. Image volume/rate: a title with 170 posters + 288 backdrops writes ~458 files; Chrome may
   throttle or clutter the shelf. No cap exists.

### Remaining work (suggested order)

1. Reload at `chrome://extensions`, approve `files.tmdb.org`, then smoke-test:
   detail page → `시작`; `사이트맵으로 큐 채우기` with/without `최신 순`; one title with `이미지도
   저장`; a person page; `설정 저장` → edit `settings.json` → reload page.
2. Fix whatever the smoke test breaks (panel DOM ids, message routing, download names).
3. Decide whether image saving needs a per-title cap (`imageLimit`) or a poster/backdrop toggle;
   current implementation downloads every display variant.
4. Consider logging when `MAX_QUEUE` (3,000) drops entries — it is currently silent.
5. Consider a UI hint (or automatic re-visit) for the case where 배우/감독 was enabled after titles
   were already visited: `visited` prevents backfilling person links for those titles.
6. Decide whether the cast-only payload (`extractCastAndDownload`) should also carry
   `schemaVersion` (it currently has none).
7. Optional: apply the selected language to manual extraction by offering a navigation/reload
   action (today manual extraction uses whatever language the open page is in).
8. Optional: add a real test harness file to the repo instead of ad-hoc VM harnesses.

### Known problems / limitations

- **Chrome cannot write to the extension install folder**, so `settings.json` is read-only. UI
  changes live in `chrome.storage`; the file only wins when its hash changes.
- Image saving has no cap and re-downloads everything when `overwrite` is on.
- `newestFirst` only affects sitemap seeding, not list-page seeds.
- YouTube links are recorded only; lazy-loaded sections may not be scanned until the page scrolls
  (`preparePage` does scroll, but extraction relies on what is in the DOM at that moment).
- `visited` (t + id) prevents re-processing; enabling a target later does not backfill.
- Person sitemap rows carry no role, so 배우/감독 filtering requires visiting each person page.
- `state` is rewritten after every page (several hundred KB); queue ≤ 3,000, records ≤ 2,000,
  visited ≤ 20,000 persisted.
- `tmdb-json-extractor.zip` is still the stale 1.3 package; do not ship it.
- No build system, linter, test runner, or CI. All verification is manual/VM-based.
- Git state at handoff: branch `main`, commit created at the end of this session
  (`git log -1`), pushed to 
## Session handoff — current state (2026-11-22, end of session)

This section is the starting point for the next agent. Everything above is historical; where the
two disagree, this section wins.

### What was added in this session (all in the 1.7 series)

| Area | Entry points | Behaviour |
| --- | --- | --- |
| Crawler engine | `crawler.js` (`tick`, `scheduleAfterPage`, `navigateTo`) | Semi-automatic: the tab itself is navigated; state survives navigation in `chrome.storage.local` (`tmdbCrawlerState`, `STATE_VERSION 2`). |
| Sitemap queue | `fillFromSitemap`, `refillIfNeeded`, `seedSitemap`, `crawlFetch` in `background.js` | Streams `sitemap_{movies,tv_series,people}.xml` children, gunzips in the service worker, keeps a 3,000-entry queue and only persists `kindIndex/childIndex/cursor`. |
| Newest first | `newestFirst` setting, `fromEnd` slicing in `background.js` | Walks sitemap children from the last one and slices each file from the end, so highest TMDB ids (newest) are processed first. Toggling resets the sitemap cursor. |
| People cap | `peoplePerTitle`, `enqueuePeopleLinks`, `enqueuePersonLinks` | Max persons enqueued per title from `/cast`; applies per role (배우/감독). `0` = unlimited. `30` is the default. Logs `인물 큐 \| 배우 +N · 감독 +M · 한도 초과 K명`. |
| Language | `language` setting, `withLanguage`, `stripLanguageParam`, `pageLocale` in `content.js` | Single-select: ko-KR (default), en-US, ja-JP, de-DE, zh-TW, zh-CN, fr-FR, es-ES, pt-BR, ru-RU, it-IT, hi-IN. Queue URLs stay canonical; `?language=` is added only when navigating. Subpage fetches inherit the page language; single-language galleries use `?image_language=<short>`. |
| Settings file | `settings.json`, `crawlerPackagedSettings`, `loadPackagedSettings`, `requestPackagedSettings` | Read at every page start. `chrome.storage` values win until the file content hash changes; an edited file wins and updates `tmdbCrawlerSettingsHash`. Chrome forbids writing to the install folder, so `[설정 저장]` stays a Downloads backup. |
| Image saving | `saveImages`, `imagesForPayload`, `crawlerImage` in `background.js` | Optional. Writes `<folder>/<json base name>/<title>-poster-001.jpg` etc. Display posters/backdrops + person profile only. Remote URLs limited to `media.themoviedb.org` / `image.tmdb.org`. |
| YouTube links | `collectYoutubeLinks` in `content.js` | Adds `youtubeLinks[]` to media and person payloads: `{ videoId, url, title, source: link\|text\|video }`, deduped by video id. YouTube is not fetched or downloaded. |
| Schema | `schemaVersion` in both payloads | Bumped to `1.7`; the only shape change is `youtubeLinks[]`. |

### Settings (`DEFAULT_SETTINGS`, `_v: 3`)

`language: ko-KR`, `targets {movie:true,tv:true,cast:false,director:false}`,
`sitemapKinds {movie:true,tv:true,person:false}`, `sitemapBatch: 1000`, `newestFirst: false`,
`allLanguages: false`, `collectFilmography: false`, `followLists: true`, `autoFollow: true`,
`autoFollowQueue: 5`, `autoFollowLimit: 8`, `peoplePerTitle: 30`, `overwrite: true`,
`saveImages: false`, `autoLog: true`, `humanize: true`, `readDelay: true`, `minDelayMs: 3000`,
`maxDelayMs: 7000`, `subpageMinMs: 700`, `subpageMaxMs: 1800`, `breakEveryMin: 40`,
`breakEveryMax: 90`, `breakMinSec: 120`, `breakMaxSec: 300`, `maxListPages: 300`, `folder: tmdb`.

`settings.json` at the repo root contains a subset of these; `crawler.js` fills the rest from
`DEFAULT_SETTINGS`. Stored settings whose `_v` is not `3` are discarded.

### Output layout

- JSON: `Downloads/<folder>/movie-<id>-<slug>.json`, `person-...`, `tv-...`
- Log: `Downloads/<folder>/crawl-log-YYYYMMDD-HHMMSS.log`
- Settings backup: `Downloads/<folder>/crawler-settings.json`
- Index report: `Downloads/<folder>/index.json` (`schemaVersion: 1.7`, settings, stats, sitemap
  progress, last 400 log lines, records with `role`)
- Images (opt-in): `Downloads/<folder>/<json base name>/<title>-poster-001.jpg`, ...

### Verification actually performed

- `node --check crawler.js content.js background.js`; `manifest.json` and `settings.json` parse:
  pass after the last edit.
- Temporary VM harnesses (all deleted afterwards; nothing remains in the repo):
  - people cap: 10 checks (unlimited, limit reached, exact limit, already queued, visited,
    per-role limit, director only, silence when nothing added).
  - settings precedence: 4 cases (first run, unchanged file, edited file, missing file).
  - language + images: 8 groups (language normalization, URL add/strip, canonical queue URLs,
    title slug/extension, image selection, per-title folders/filenames, log line).
  - newest-first + YouTube: real `background.js` `fromEnd` slicing of
    `sitemap_movies_26.xml.gz` (1836230 -> 1836228, offset 3 -> 1836227), crawler queue order
    5,4,3,2,1 vs 1,2,3,4,5, and YouTube anchor/text/video dedupe.
  - review cleanup: consolidated regex, `schemaVersion` 1.7 in both payloads.
- Live network checks: sitemap children are TMDB-id ascending; TMDB honors `?language=ja-JP`.

### Not verified (highest risk first)

1. **No end-to-end browser run.** The extension has never been reloaded with `crawler.js`.
   Nothing below has been observed working in Chrome.
2. Panel layout/render with the new controls (language `<select>`, `작품당 인물`, `이미지도 저장`,
   `최신 순으로 크롤링`) — no visual check.
3. Real downloads: JSON in `Downloads/<folder>/`, image folders/filenames, overwrite/skip,
   verification counter (`chrome.downloads.search`).
4. Settings hash flow in the real service worker (packaged file edit -> next page load applies it).
5. Newest-first resume: stop mid-file, reload, and confirm the cursor continues without skipping
   or duplicating.
6. Language navigation in a live crawl (redirect to slug keeps `?language=`; `samePath` handling).
7. Image volume/rate: a title with 170 posters + 288 backdrops writes ~458 files; Chrome may
   throttle or clutter the shelf. No cap exists.

### Remaining work (suggested order)

1. Reload at `chrome://extensions`, approve `files.tmdb.org`, then smoke-test:
   detail page -> `시작`; `사이트맵으로 큐 채우기` with/without `최신 순`; one title with
   `이미지도 저장`; a person page; `설정 저장` -> edit `settings.json` -> reload page.
2. Fix whatever the smoke test breaks (panel DOM ids, message routing, download names).
3. Decide whether image saving needs a per-title cap (`imageLimit`) or a poster/backdrop toggle;
   current implementation downloads every display variant.
4. Consider logging when `MAX_QUEUE` (3,000) drops entries — it is currently silent.
5. Consider a UI hint (or automatic re-visit) for the case where 배우/감독 was enabled after titles
   were already visited: `visited` prevents backfilling person links for those titles.
6. Decide whether the cast-only payload (`extractCastAndDownload`) should also carry
   `schemaVersion` (it currently has none).
7. Optional: apply the selected language to manual extraction by offering a navigation/reload
   action (today manual extraction uses whatever language the open page is in).
8. Optional: add a real test harness file to the repo instead of ad-hoc VM harnesses.

### Known problems / limitations

- **Chrome cannot write to the extension install folder**, so `settings.json` is read-only. UI
  changes live in `chrome.storage`; the file only wins when its hash changes.
- Image saving has no cap and re-downloads everything when `overwrite` is on.
- `newestFirst` only affects sitemap seeding, not list-page seeds.
- YouTube links are recorded only; lazy-loaded sections may not be scanned until the page scrolls
  (`preparePage` does scroll, but extraction relies on what is in the DOM at that moment).
- `visited` (t + id) prevents re-processing; enabling a target later does not backfill.
- Person sitemap rows carry no role, so 배우/감독 filtering requires visiting each person page.
- `state` is rewritten after every page (several hundred KB); queue <= 3,000, records <= 2,000,
  visited <= 20,000 persisted.
- `tmdb-json-extractor.zip` is still the stale 1.3 package; do not ship it.
- No build system, linter, test runner, or CI. All verification is manual/VM-based.
- Git state at handoff: branch `main`, commit created at the end of this session
  (`git log -1`), pushed to `origin` if credentials allowed. Working tree should be clean.
