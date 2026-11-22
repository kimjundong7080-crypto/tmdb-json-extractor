# TMDB JSON Extractor ??Agent Handoff Notes

Last updated: 2026-11-22

## Project overview

Chrome Manifest V3 extension that extracts movie/TV/person data from The Movie Database
(TMDB) detail pages and copies/downloads it as JSON.

- Working directory: `D:\?щ＼_??01-tmdb-json-extractor`
- Repository: `https://github.com/kimjundong7080-crypto/tmdb-json-extractor` (branch `main`)
- Extension version: `1.7.2` (see `manifest.json`)
- Output schema version: `1.7.2` (`schemaVersion` field in media/person JSON; visible changes:
  `youtubeLinks[]`, `mediaSection`, `topBilledCast[]`, `videos[].thumbnail`,
  image/cast metadata, collection totals)
- No TMDB API key is available (approval denied). Do not add API-dependent code paths.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Permissions: `contextMenus`, `clipboardWrite`, `scripting`, `downloads`, `storage`, `unlimitedStorage`. Hosts: `*://www.themoviedb.org/*`, `https://query.wikidata.org/*`, `https://files.tmdb.org/*`. |
| `crawler.js` | Semi-automatic crawler: persistent queue, sitemap discovery/seeding, auto tab navigation, pacing/breaks, control panel, logs, settings, optional image saving. Loaded after `content.js`. |
| `settings.json` | Packaged default settings read at every page start through the service worker. After a one-time `[?대뜑 ?곌껐]`, the crawler overwrites this file directly through the File System Access API (raw settings object). |
| `background.js` | Context-menu registration (install/update safe), message routing (downloads, image downloads, sitemap proxy/gunzip, packaged settings), content-script injection fallback. |
| `content.js` | All extraction logic: media/cast/person, subpage + Wikidata enrichment, galleries, credits, YouTube link collection, toast UI, clipboard, JSON download, image helpers. |
| `tmdb-json-extractor.zip` | Legacy 1.3 package. Intentionally NOT regenerated. Ignored by Git. |
| `AGENTS.md` | This handoff/test log. |

No build system, linter, or test runner. Plain JS loaded directly by Chrome.

## Quick status (2026-11-22)

- Extension and output schema are `1.7.2`; the source directory is the deliverable (not the
  stale ZIP).
- Media extraction is async and enriched from TMDB subpages, Wikidata, and optional OMDb; all
  enrichment failures are non-fatal.
- Live tests: `movie/55` reached 76/76 posters, 57/57 backdrops, 26/26 cast, 64/64 crew,
  `isComplete: true` (~50 s cold); `movie/22` reached 70 posters / 113 backdrops;
  `movie/38` verified `mediaSection` tabs/items and video thumbnails.
- Gallery merge keeps the highest-resolution URL and merges metadata from the losing duplicate;
  verified zero duplicate filenames after the final merge.
- Crawler: sitemap streaming queue, per-title people cap, single-select language, newest-first
  order, settings/log direct writes via `[폴더 연결]`, and enrichment warnings/summaries in the
  crawl log. Image saving is disabled; `autoLog` is always on.
- Python companion `python/enrich.py` plus optional native auto-start
  (`native/install.ps1`) and a top panel button `🐍 Python 보강 실행 (수동 로드)`.
- Open/manual items: native host install in real Chrome, a live Python enrichment run
  (Wikidata returned 429 during testing), and re-crawls of stale JSON. All-language galleries
  and TMDB API use remain out of scope.

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
  - `/{movie|tv}/{id}/cast`: full cast (`h3` "異쒖뿰吏?/"Cast" + following `ol.people`) and full
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

## Changes in 1.5 ??no-API enrichment (2026-11-22)

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
- `originalLanguage` is a localized label ("?곸뼱"); `originalLanguageCode` comes from Wikidata
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

1. Load `D:\?щ＼_??01-tmdb-json-extractor` via `chrome://extensions` (Developer mode, Load unpacked).
   Reload the extension after code changes; version is 1.5.
2. Open a movie page, e.g. `https://www.themoviedb.org/movie/1368337-the-odyssey`.
3. Right-click -> "?곹솕 JSON 異붿텧" / "諛곗슦 JSON 異붿텧"; check toast, clipboard, downloaded JSON.
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

## Changes in 1.6 ??semi-automatic site crawler (2026-11-22)

Goal: crawl TMDB site-wide without omissions, starting from the Chrome extension (Python was
not needed and would not work with plain HTTP ??see limitation below).

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
5. **Control panel**: fixed panel on every TMDB page ???쒖옉/?쇱떆?뺤?/以묒?, ?먯뿉 異붽?, ?꾩옱 ???
   ??鍮꾩슦湲? ?몃뜳???대낫?닿린, and options (all languages, collect people, collect filmography,
   follow list pages, delay). Context-menu equivalents added in `background.js`.
6. **Person credits fixed (was silently empty)**: `extractPersonData()` used `h3.zero`/`h3.one`,
   which no longer exist, so `credits.acting` was always `[]`. It now keys off the section `h3`
   labels (`.credit_heading` is a single wrapper around all filter UI ??do not use it) and emits
   `credits.all[]` with `department`, plus the legacy `acting`/`production` arrays. Live check on
   `/person/1892` (Matt Damon): 226 rows, Acting 188 / Production 31 / Writing 4 / Crew 1 /
   Editing 1 / Creator 1, with job text such as "梨낆엫 ?꾨줈???.
7. **Korean fact labels**: person facts rendered in Korean only (`?쒕룞紐?, `?꾨Ц 遺꾩빞`,
   `李몄뿬 ?묓뭹 ??, `?깅퀎`, `?앹씪`, `異쒖깮吏`, `?ㅻⅨ ?대쫫`). Mappings added; `age` also parses
   `56??. Movie labels (`?먯젣`/`?곹깭`/`?먯뼱`/`?쒖옉鍮?/`?섏씡`) were already handled.
8. **TV `/releases` removed**: verified 404 (`/tv/1399-.../releases` ??"Page Not Found").
   Releases are now requested for movies only.
9. **Crew completeness**: `/cast` crew rows were skipped when the person also appeared in cast
   (actor-directors lost their crew credits). Skipping removed; duplicates are still removed by
   `mergeCastAndCrew` (name+job).
10. **Wikidata query**: three chained `OPTIONAL`s produced a cartesian product (companies 횞
    countries 횞 languages) and `LIMIT 50` truncated real values. Replaced with `UNION` +
    `LIMIT 500`, so rows = values, not combinations.
11. **Manifest 1.6**: added `downloads`, `storage`, `unlimitedStorage`; `crawler.js` registered
    after `content.js`; `background.js` re-injection now injects both files.

### Verified in this session

- `node --check content.js|crawler.js|background.js` and `manifest.json` JSON parse: pass.
- Live DOM probes in Chrome (no extension needed): gallery language links (43), release table
  (`table.releases` + `h2.release[id=KR]` inside `<th>`), `/cast` (?뺤쥖??寃뚯엫: 593 cast / 349 crew,
  `h4` department labels, `p.episode_count_crew` jobs), person credit sections, TV `/releases` 404.
- Person-credit and all-language gallery algorithms were executed against the live pages; see
  counts above.

### Not verified (needs a real extension load)

- The crawler has not been run end-to-end inside Chrome. Load unpacked, approve the new
  permissions, then: open a TMDB list page ??panel [?먯뿉 異붽?] ??[?쒖옉]. Check that files appear
  in `Downloads/tmdb/...` and that the tab advances.
- `chrome.downloads.download` with a `data:` URL for large payloads (hundreds of KB) is assumed
  to work; the `<a download>` fallback drops the `tmdb/` subfolder.

### Limitations

- **Plain HTTP clients are blocked**: TMDB answers 403 (Cloudflare) to Python/curl even with a
  browser UA. That is why crawling lives in the browser. A Python crawler would need Playwright
  or CDP driving a real Chrome profile.
- Site-wide means tens of thousands of pages; each title costs ~2 gallery listing requests per
  language (~50) plus `/cast`, `/videos`, `/releases`, Wikidata. Keep `delayMs` ??1500 and expect
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
   checkbox "紐⑤뱺 ?몄뼱 ?ъ뒪??諛곌꼍 (?꾨㈃ 1媛??몄뼱)" turns the 43-language sweep back on.
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
   Re-run checklist: reload unpacked extension ??open `https://www.themoviedb.org/movie/` ??   panel [?먯뿉 異붽?] ??[?쒖옉] ??confirm `listPages` increments and
   `movie-<id>-<slug>.json` grows in `Downloads/<folder>/`.

## 1.6.2 file naming (2026-11-22)

- Output files are now flat and slug-named: `folder/movie-1368337-the-odyssey.json`,
  `folder/person-1892-matt-damon.json`, `folder/tv-1399-game-of-thrones.json` (previous layout
  was `folder/movie/1368337.json`).
- `fileBaseName()` takes the slug from `location.pathname` during processing (the queue stores
  slug-less URLs such as `/movie/1368337`; TMDB redirects to the slug, which is what is used),
  strips unsafe characters, collapses repeated dashes and caps the length at 120.
- Fallbacks: `/movie/1368337` (no slug on the page) ??`movie-1368337.json`; a season page would
  yield `tv-1399-game-of-thrones-season-1.json`, but season pages are never queued.
- `index.json` stays `folder/index.json` and its `file` fields use the new names.
- Files produced by earlier runs (`movie/1726.json`, `person/10980.json`) are not renamed.

## Changes in 1.7 ??sitemap discovery, targets, human pacing (2026-11-22)

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
4. **Targets UI**: ?곹솕 / TV / 諛곗슦 / 媛먮룆 checkboxes. Titles are saved only when their type is
   checked; 諛곗슦 enqueues cast links, 媛먮룆 enqueues only Directing crew (from `/cast`). If only a
   people target is checked, titles are visited as **discovery-only** (`save:false`) so the
   gallery/cast/video enrichment is skipped.
5. **Person role filter**: with only 媛먮룆, person pages without a Directing credit (and without
   `?꾨Ц 遺꾩빞: Directing`) are skipped; with only 諛곗슦, pages without Acting credits are skipped.
   `index.json` records the `role` of each person.
6. **Sitemap seeding UI**: `?ъ씠?몃㏊` ?곹솕/TV/?몃Ъ + batch size + `?ъ씠?몃㏊?쇰줈 ??梨꾩슦湲?; the
   same action is on the context menu. People sitemaps require 諛곗슦/媛먮룆.

### Human-like pacing

7. **Serialized requests**: every TMDB subpage request goes through one promise chain in
   `content.js`; galleries dropped from concurrency 3 to 1 and sleep 0.9??.0 s per language.
8. **Jitter**: subpage requests wait 0.7??.8 s (configurable), each with random spread; page
   turn waits 3?? s plus a reading pause proportional to body text (2?? s, 짹40%).
9. **Long breaks**: every 40??0 pages the crawler takes a 2?? minute break with a panel
   countdown (`?댁떇 mm:ss`). Warm-up 2?? s on start; small scroll/mouse movement before
   navigation.
10. **429 handling**: honours `Retry-After`, backs off 5 s ??15 s ??45 s, and after three
    consecutive 429s sets a 5-minute cooldown (`?쒕룄 ?湲?mm:ss`) and records the item as failed.
11. **robots.txt**: `/person/*/remote/credits` and `image_sort=` URLs are never requested.
12. **Lazy loading**: `preparePage()` waits for core selectors up to 12 s, scrolls 3?? randomized
    steps until `scrollHeight` stabilises, promotes `img[data-src]`/`source[data-srcset]` to real
    sources and waits for loads (??.5 s each), expands person biographies, then scrolls back up.
    List pages are scrolled before pagination/link collection too.

### Fixed defects

13. Link collection now keeps the original href, so queued titles carry slugs and filenames stay
    `movie-1368337-the-odyssey.json` (previously `/movie/1726`).
14. `nextPageUrl()` only accepts `.pagination` / `a.load_more` links for the current path and
    current page + 1 (no more filter-link false positives).
15. Detail-page detection rejects `/cast`, `/images`, `/videos`, `/releases`, `/season/`,
    `/episode/`, `/remote/` subpages.
16. `downloadJsonFile` (manual extraction) now uses the crawler naming rule
    (`buildOutputFilename`) instead of `movie_1726_?쒕ぉ.json`.
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

1. `chrome://extensions` ??reload the unpacked extension ??approve the new
   `files.tmdb.org` permission.
2. Open `https://www.themoviedb.org/movie/`, tick ?곹솕 (and TV if wanted), tick ?ъ씠?몃㏊ ?곹솕,
   click `?ъ씠?몃㏊?쇰줈 ??梨꾩슦湲?, then `?쒖옉`.
3. Confirm: panel shows `?곹솕 1/26 쨌 ?꾩쟻 1000`, files appear as
   `Downloads/tmdb/movie-<id>-<slug>.json`, panel counts split by ?곹솕/TV/?몃Ъ, and a `?댁떇 mm:ss`
   countdown appears after 40??0 pages.
4. Enable 諛곗슦 or 媛먮룆 and confirm person files appear only for the selected role; with both
   title targets off, movie JSON must **not** be written (discovery only).
5. `?몃뜳???대낫?닿린` ??`index.json` has `schemaVersion: "1.7"`, `targets`, `sitemap`, and
   `records[].role`.

### Limits

- Scale is real: the movie index has 26 children 횞 50,000 = ~1.3 M URLs, and the people index has
  102 children. At the default pacing a run handles roughly 100??00 titles/hour, so a full sweep
  is a multi-day background job; use the batch size and target checkboxes to bound it.
- Person sitemap rows have no role, so 諛곗슦/媛먮룆 filtering requires visiting each person page;
  deriving people from title credits is much cheaper.
- Each saved JSON triggers a Chrome download entry; large runs clutter the download shelf.
- `state` is rewritten after every page. Persisted size is bounded (queue ??3,000, records ??2,000,
  visited ??20,000 keys) but is still several hundred KB per write.
- TV seasons/episodes are still not queued individually; only `sitemap_tv_series` is used.
- Default galleries remain one language; `紐⑤뱺 ?몄뼱` multiplies gallery requests and 429 risk.

## 1.7.1 per-title people cap (2026-11-22)

- New setting `peoplePerTitle` (default `30`, clamped to 0??00; `0` = unlimited): the maximum
  number of person entries enqueued from one title's `/cast` page. Limit applies per role (諛곗슦 and
  媛먮룆 separately) so directors are not crowded out by cast. 30 was chosen because `/cast` is in
  billing order, so the first 30 cover top-billed plus notable supporting cast while bounding
  queue growth per title to 30; users who want everything set `0`.
- `enqueuePeopleLinks()` now delegates to `enqueuePersonLinks(list, role, limit)`, which stops once
  the limit is reached and reports the remainder as `?쒕룄 珥덇낵`.
- Log line: `?몃Ъ ??| 諛곗슦 +N 쨌 媛먮룆 +M 쨌 ?쒕룄 珥덇낵 K紐?(?묓뭹??理쒕? L紐?` or `(臾댁젣??`.
  `/cast` fetch failure logs `?몃Ъ ???ㅽ뙣 | <message>` instead of only `console.warn`.
- Panel: `?묓뭹???몃Ъ [N] 紐?(0=臾댁젣??` under the target options. Imported/saved settings are
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
   own installed folder**, so the UI cannot persist back into `settings.json`; [?ㅼ젙 ??? remains
   a backup export into Downloads. Old `_v != 3` stored settings are discarded.
   Precedence harness (4 cases) passed: first run, unchanged file, edited file, missing file.
3. **Optional image saving** (`saveImages`, default off): after a successful JSON download,
   `saveImages()` sends each display poster/backdrop (or person `profileImage_high`) to
   `background.js` (`crawlerImage`), which calls `chrome.downloads.download` with a remote URL.
   Layout: `<folder>/<json base name>/<title>-poster-001.jpg`, `-backdrop-001.jpg`,
   `-profile-001.jpg` ??one folder per title, so titles never mix. Only `media.themoviedb.org` /
   `image.tmdb.org` URLs are accepted, `..` filenames are rejected, and overwrite follows the
   existing `overwrite` setting. High/original variants are intentionally not downloaded.
- Verified with a temporary VM harness (8 groups, all passed): packaged `settings.json` applied at
  startup, language normalization, `withLanguage`/`stripLanguageParam`, canonical queue URLs,
  title slug/extension, image selection, per-title folders and filenames, image log line. Also
  `node --check` on all three scripts plus `manifest.json`/`settings.json` parse. Not verified in a
  real browser (extension reload + real downloads). Image volume is large: a title with 170
  posters and 288 backdrops produces ~458 files.

## 1.7.3 newest-first crawling + YouTube links (2026-11-22)

1. **Newest-first checkbox** (`newestFirst`, default off, panel: `理쒖떊 ?쒖쑝濡??щ·留?(?ъ씠?몃㏊
   ?ㅼ뿉?쒕???`). Verified against the live movie sitemap: children are TMDB-id ascending
   (child 1: 3924??1657, child 26: 1787733??836230, 27,118 URLs), so newest titles are in the last
   child and at the end of each file. When enabled, `fillFromSitemap()` walks children from the
   last one and `background.js` slices `locs` from the end (`fromEnd: true`) and reverses each
   batch; the panel shows `?곹솕 (理쒖떊?? 1/26`. Toggling the setting resets `childIndex`/`cursor`
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
  `sitemap_movies_26.xml.gz` returns 1836230 ??1836228 and offset 3 continues at 1836227;
  crawler queue is 5,4,3,2,1 with `newestFirst:true` and 1,2,3,4,5 otherwise; YouTube parsing
  dedupes anchors/text/videos and normalizes short links. Also `node --check` on all scripts and
  JSON parse. Not verified in a real browser.

## Python enrichment companion (2026-11-22)

Optional file-based Python helper: `python/enrich.py` (standard library only, Python 3.9+).
The extension remains the collector; Python only post-processes saved JSON.

- Input: `<dir>/*.json` written by the crawler (`movie-*.json`, `tv-*.json`, `person-*.json`).
- Output: `<dir>/enriched/` by default, or overwrite with `--inplace` (creates `.json.bak`
  once). `--dry-run` previews.
- Sources:
  - **Wikidata SPARQL** (on by default): entity ID, label, IMDb ID (`P345`), official website,
    companies (`P272`), countries (`P495`), languages (`P364`+`P218`), person birth/death/place.
  - **OMDb** (optional): `--omdb-key` or `OMDB_API_KEY`, never written into JSON.
  - **IMDb datasets** (optional): `--imdb-dir` with `title.basics.tsv.gz`,
    `title.ratings.tsv.gz`, optional `title.crew.tsv.gz` + `name.basics.tsv.gz`.
- Adds `wikidata`, `omdb`, `imdb`, `imdbId`, `enrichedAt`, `enrichmentSources`; fills only
  missing fields and never overwrites existing TMDB values.
- Cache: `<out>/.cache/enrich-cache.json` (Wikidata 7 days, OMDb 30 days). HTTP 429 retries
  up to 3 times with `Retry-After`/backoff (max 30 s).
- Commands:
  ```powershell
  py python/enrich.py "C:/Users/ssii/Downloads/tmdb"
  py python/enrich.py "C:/Users/ssii/Downloads/tmdb" --inplace
  py python/enrich.py "." --omdb-key YOUR_KEY
  py python/enrich.py "." --imdb-dir "D:/imdb" --limit 50
  ```
- Verified: `py -m py_compile`, `--help`, and offline merge tests for Wikidata/OMDb/IMDb pass.
  Live Wikidata requests during the test returned HTTP 429 (rate limit) and were handled
  gracefully (no files written, no crash); retry later or use the cache.
- **Do not scrape TMDB HTML from Python** (Cloudflare returns 403). Use the extension for
  collection and this tool for enrichment. See `python/README.md` for details.
- Still uncommitted at the time of writing; `python/`, `.gitignore` changes and the extension
  edits above are in the working tree.

### Auto-start with Chrome (native messaging)

Chrome extensions cannot spawn Python directly, so auto-start uses a native messaging host:

- `manifest.json` has the `nativeMessaging` permission.
- `background.js` calls `chrome.runtime.connectNative('com.tmdb_json_extractor.enricher')` on
  `chrome.runtime.onStartup` and `onInstalled`; missing host errors are ignored.
- `native/launcher.cs` is compiled by `native/install.ps1` into `native/tmdb-enricher-host.exe`.
  It starts `python/enrich.py <input> --watch --interval N --out <out>` hidden, then keeps the
  native messaging channel open while Chrome runs.
- `native/install.ps1 -ExtensionId <ID>` writes `native/launcher.ini`, the host manifest, and
  registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tmdb_json_extractor.enricher`
  (plus Edge). The extension ID must come from `chrome://extensions`.
- `enrich.py --watch` polls every `--interval` seconds (min 5), writes a lock
  (`<out>/.cache/enrich-watch.lock`) to prevent duplicates, logs to
  `<out>/.cache/enrich-watch.log`, and enriches changed files into `<out>`.
- Set `OMDB_API_KEY` in the user environment to enable OMDb for the watcher.
- Generated files (`native/*.exe`, `native/launcher.ini`, host manifest) are gitignored.
- Verified: launcher compiles with `csc.exe`; watch starts, detects a new JSON, and logs
  `batch: changed=1 scanned=1`; BOM-prefixed JSON is accepted (`utf-8-sig`).
- Real Chrome launch/install still needs a manual check with the actual extension ID.

## OMDb and Wikidata auxiliary enrichment (schema 1.7.2)

- **Wikidata (optional, on by default)**: `useWikidata` setting. The SPARQL query now also
  returns the Wikidata entity (`Q...`), label, IMDb ID (`P345`) and official website (`P856`).
  The payload gets a structured `wikidata` object
  `{ entityId, url, label, tmdbId, imdbId, officialWebsite, companies, countries, languages,
  languageCode }`. Existing fields (companies/countries/languages/originalLanguageCode/imdbId)
  are still filled only when empty. If `homepage` is empty, the Wikidata official website is used.
- **IMDb ID discovery**: LD+JSON `sameAs`, a `imdb.com/title/tt...` link on the TMDB page, or
  Wikidata `P345` (in that order).
- **OMDb (optional)**: `omdbApiKey` setting (panel password input). The key is stored only in
  `chrome.storage`; `[설정 저장]` strips it from `settings.json` so it is not committed.
  After Wikidata resolves the IMDb ID, `fetchOmdb()` calls
  `https://www.omdbapi.com/?i=<tt...>&plot=full` (or `t=`/`y=`/`type=` fallback) and stores a
  normalized `omdb` object: title, year, rated, released, runtime, genre, director, writer,
  actors, plot, language, country, awards, poster, ratings[], metascore, imdbRating, imdbVotes,
  imdbID, type, dvd, boxOffice, production, website. If `overview` is empty, OMDb `plot` fills it.
- Both enrichments are best-effort (8 s timeout, non-fatal, cached). No key/API failure leaves
  the rest of the payload intact. `host_permissions` includes `query.wikidata.org` and
  `omdbapi.com`.
- Verified on `movie/55` (Wikidata only): `wikidata.entityId = Q474098`, `imdbId = tt0245712`,
  countries `["멕시코"]`, languages `["스페인어"]`, `languageCode = es`. OMDb response shape was
  validated against a sample `tt3896198` response; live OMDb calls need a user key.

## Collector metadata (schema 1.7.2)

The library size varies per title, so the payload now carries explicit collected-vs-total and
per-entity metadata instead of forcing consumers to infer it.

1. **Image records**: `images.posters[]` / `backdrops[]` entries now include
   `file_path`, `id` (gallery `data-image-id`), `iso_639_1`, `width`, `height`,
   `aspect_ratio`, and `urls` (`{w500,w780,original}` or `{w780,w1280,original}`).
   Dimensions come from the gallery card's size text; DOM-only images get `null` dimensions.
2. **Collection metadata**:
   - `images.collected = { posters, backdrops }` and `images.totals = { posters, backdrops }`
     (totals from the Media tab counts).
   - `images.pagination = { posters: {...}, backdrops: {...} }` with
     `{ page, per_page, total_pages, total_results }`.
   - `images.has_next_page` (bool, any kind incomplete), `images.incomplete` (per kind),
     `images.next_page_url` (empty; collection uses language pages, not page numbers).
3. **Credits metadata**: `credits.castTotal` / `credits.crewTotal` from the `/cast` headings
   (`출연진 N`, `제작진 N`). Cast entries now include `id`, `order`, `credit_id`, `cast_id`
   (when present), `known_for_department`, `profile_path`, `placeholder_class`.
   `credits.directors[]` / `credits.writers[]` are structured `{ id, name }` arrays
   (DP/photography/assistant directors are excluded from `directors`).
4. **`isComplete`**: true only when posters, backdrops, cast, and crew all reached their totals.
5. **Gallery merge fix**: `dedupeImagesByFilename` now keeps the highest-resolution URL but merges
   metadata from the losing duplicate, so a DOM `w600` poster keeps gallery `file_path`/language/
   dimensions. `fetchGalleryUrls` returns metadata records (cache key `v2`).

Verified on `movie/55`: `castTotal 26`, `crewTotal 64`, cast `id/order/credit_id/profile_path/
placeholder_class` populated, `directors` = 1 (DP excluded), `writers` = 1,
gallery record sample `{file_path, id, iso_639_1:"ko", width:1000, height:1500, aspect_ratio:0.667}`,
merged poster kept w600 URL plus metadata. Full extraction earlier reached 76/76 posters and
57/57 backdrops.

Not available from the website HTML (do not invent): cast `gender`, `popularity`, `adult`,
image `vote_average`/`vote_count`; video `type`, `official`, `published_at`, `size`.

## Media section extraction (schema 1.7.1)

TMDB's Media panel (`section.panel.media_panel.media`) keeps only the "Most Popular" tab in
static HTML. Tabs are `#popular`, `#videos`, `#backdrops`, `#posters`; the first tab shows a
video card, one backdrop, and one poster. The rest loads via AJAX and is covered by the existing
`/videos` and `/images/*` subpage fetchers.

- `extractMediaSection()` scopes to `section.panel.media_panel.media` (excludes
  `section.media_panel.social_panel`) and returns `{ tabs, items }`.
- `tabs[]`: `{ id, label, count, href, active }` from `.menu a[id]` plus its `<span>` count.
  `count` is the full library size, not the number of static assets.
- `items[]`: flat schema `{ tab, type, src, srcset, alt, classes, parent_classes }`.
  - `type: "video"`: thumbnail comes from the card's CSS `background-image` `url()` (no `<img>`),
    plus `data_site`, `data_id`, `data_title`, `href`.
  - `type: "backdrop" | "poster"`: `src`/`srcset`/`alt` from `img.backdrop` / `img.poster` inside
    the scroller; `parent_classes` is the real wrapper div, not the `<img>`.
- Every `videos[]` entry gets `thumbnail: https://i.ytimg.com/vi/<key>/hqdefault.jpg`.
- Verified on `movie/38`: tabs `videos 1 / backdrops 64 / posters 124`, 3 items (video thumbnail
  `jZImRrZuigA`, backdrop `w533_and_h300_face`, poster `w220_and_h330_face`), YouTube thumbnail
  populated, `schemaVersion: "1.7.1"`.

## Top Billed Cast extraction (schema 1.7.1)

The Top Billed Cast section is fully static (no AJAX): 9 `li.card` actors plus one
`li.filler.view_more` card and a `p.new_button` link.

- `extractTopBilledCast()` scopes to `section.panel.top_billed` and reads
  `#cast_scroller ol.people.scroller li.card`; `li.filler` / `li.view_more` are excluded.
- Output rows: `{ order, person_id, person_slug, name, character, profile_src,
  profile_srcset, alt, placeholder_class, profile_url }`.
  - `person_id`/`person_slug` come from `a[href*="/person/"]`.
  - `profile_src` is the 1x `src` (w138); `profile_srcset` keeps the original srcset
    (1x w138 / 2x w276). `placeholder_class` is `one` or `two`.
  - `profile_url` is `https://www.themoviedb.org/person/<id>[-<slug>]`.
- Verified on `movie/38`: 9 rows, in HTML order, IDs 206/204/205/103/109/207/209/212/77013,
  names and characters match the page, placeholder classes match `one`/`two`.

## 1.7.1 direct project-folder settings/logs (2026-11-22)

1. **Settings file**: `[?ㅼ젙 ???` now overwrites `<project>/settings.json` directly (raw
   settings object, no JSON wrapper) instead of downloading `crawler-settings.json`.
   Chrome extensions cannot write arbitrary absolute paths, so this uses the File System Access
   API. A one-time `[?대뜑 ?곌껐]` button opens `showDirectoryPicker()`; the `DirectoryHandle` is
   stored in IndexedDB (`tmdbCrawlerFS` / `handles` / `projectDir`).
2. **Settings auto-load**: on every page start the crawler restores the stored handle and reads
   `settings.json` from the project folder when permission is still granted. Precedence:
   project-folder `settings.json` > packaged `settings.json` > `chrome.storage` > defaults.
3. **Image saving disabled**: `saveImages` is forced to `false` in `normalizeSettings()`, the
   panel checkbox is removed, and the (dormant) `saveImages()` code is never called.
4. **Logs**: `autoLog` is forced to `true`; logs are written directly to the project-folder root
   as `crawl-log-YYYYMMDD-HHMMSS.log` by `[濡쒓렇 ???`, `stopCrawl()`, and `finish()`.
   If the folder is not connected or permission expired, it falls back to the old download path
   so the log is not lost.
5. **background.js**: packaged-settings fetch uses `cache: "no-store"` so direct file edits are
   seen on the next page load.
6. JSON downloads are unchanged (`Downloads/<folder>/...`).

Verified with a mock DirectoryHandle on the live TMDB page: `[?대뜑 ?곌껐]` ??`[?ㅼ젙 ???` writes
raw `settings.json` (`saveImages:false`, `autoLog:true`), `[?ㅼ젙 遺덈윭?ㅺ린]` applies values, and
stop/finish writes `crawl-log-*.log` to the mocked folder. Real native picker and permission
persistence still need a manual check after reloading the extension.

## Log/file comparison and data fixes (2026-11-22)

Compared `C:\Users\ssii\Downloads\tmdb` with `crawl-log-20261122-194052.txt`.

### File-level findings

- 13 JSON files exist; the log lists 15 successful saves. `movie-16-dancer-in-the-dark`
  and `movie-17-the-dark` were logged as saved (`?뚯씪 ?뺤씤` = complete) but are absent,
  including their image folders. Files from the earlier run (IDs 2-15) are absent as well.
- No code path deletes downloads (`chrome.downloads.removeFile` is not used). Treat these as
  removed outside the extension. Re-crawl IDs 16 and 17; the earlier run must be repeated if
  those outputs are still wanted.
- Image folder file counts match the log for every title (18:3, 19:2, ... 33:7, 35:2);
  `movie-38` has 11 files although its log line was cut off because the crawl stopped
  immediately after saving.

### Data omissions fixed

1. **Posters/backdrops were 1-2 per title.** The gallery was fetched for only one language
   (`?image_language=ko`), which is nearly empty for older non-Korean films. `fetchGalleryUrls`
   now always fetches default + `xx` (no language) + `en` in single-language mode
   (3 requests per gallery type). All-language mode is unchanged.
2. **`spokenLanguages` had 150-186 bogus entries.** In the SPARQL query, the
   `OPTIONAL { ?language wdt:P218 ?iso. }` sat outside the UNION branches, so for company/
   country rows the unbound `?language` matched every P218 triple (cartesian product).
   The OPTIONAL is now scoped inside the `P364` branch. Movie 19 now returns 1 language.
3. **Companies/languages missing on movie 18** despite existing Wikidata statements: the old
   373-row query was slow/heavy and sometimes failed silently. The scoped query returns 4 rows
   and fills both fields.

### Re-verification (movie 22, current content.js)

`posters: 70` (was 1), `backdrops: 113` (was 1), `spokenLanguages: ["?곸뼱"]` (was 186),
`productionCompanies: 3`, `cast: 70`, `crew: 330`, `videos: 1` (TMDB has only one),
`releases: 75`, `originalLanguageCode: "en"`, ~15 s with the serialized pacing queue.

### Action required

- Existing JSON files 18-38 were produced before these fixes. Re-crawl them (or accept the
  stale `spokenLanguages`/image lists) to refresh. IDs 16-17 must be re-crawled from scratch.
- Image download is intentionally disabled (see 1.7.1), so re-crawls will not recreate image
  folders; image metadata still improves the JSON.

## Crawled-file audit ??movie 55 (2026-11-22)

The only JSON currently in `Downloads/tmdb` was `movie-55-amores-perros.json`
(schema 1.7.1, crawled after the Media/Top Billed additions). Audit findings and fixes:

1. **Posters/backdrops incomplete**: 20/76 posters and 45/57 backdrops. The gallery fetched only
   default + `xx` + `en`; the rest were under other language filters (es 16, ru 3, uk 3, ...).
   `fetchGalleryUrls` now takes `targetCount` from the tab menu and, after the initial variants,
   walks the gallery language links (highest count first) until the tab total is reached
   (cap 30 extra languages). The extra 0.9-2.0 s sleep was removed; the global request pacing
   still spaces calls. Result: 76/76 posters and 57/57 backdrops on movie 55.
2. **Crew departments wrong**: TMDB `h4` headings include counts (`"誘몄닠 3"`, `"?곗냽 4"`), so the
   exact-match mapping fell back to job inference; `Director of Photography` became `Directing`
   on older code
   and `Art Direction`/`Set Decoration` became `Other`. `normalizeDepartmentLabel` strips the
   trailing count, and `getCrewDepartment` checks DP/cinematographer/still photographer before
   director and maps art direction/set decoration to Art.
   Result on movie 55: Directing 4, Writing 1, Art 3, Camera 2, Costume & Make-Up 7, Crew 19,
   Editing 5, Production 12, Sound 11 (no `Other`).
3. **YouTube link titles**: `collectYoutubeLinks` now accepts `{url, title}` objects, so
   `youtubeLinks[].title` is filled from `videos[].name` instead of being empty.
4. Full re-extraction on movie 55 (warm cache): 26 cast, 9 top-billed, 64 crew, 76/76 posters,
   57/57 backdrops, 36 releases, 1 video with thumbnail, `spokenLanguages: ["?ㅽ럹?몄뼱"]`,
   `originalLanguageCode: "es"`, schema 1.7.1, ~33 s (cold gallery sweep ~50 s).
5. `mediaSection.items` has 2 entries for movie 55 because the page's Videos tab count is 0
   (only backdrop + poster static cards). This is correct; movie 38 with 1 video yields 3 items.

The existing `movie-55` JSON on disk predates fixes 1-3. Clear visited (`諛⑸Ц湲곕줉 珥덇린??) and
re-crawl it to refresh. No other JSON files remain in `Downloads/tmdb`.

### Follow-up implemented (same session)

- `content.js` `reportEnrichmentIssue()` forwards subpage/Wikidata failures to
  `window.__tmdbEnrichWarn`; `crawler.js` logs them as `蹂닿컯 ?ㅽ뙣` so silent omissions are
  visible in `crawl-log-*.log`.
- After each media extraction the crawler logs a `?곗씠?? summary
  (`cast 쨌 crew 쨌 videos 쨌 posters/珥?쨌 backdrops/珥?쨌 releases 쨌 lang`) and warns
  `?대?吏 ?꾨씫 ?섏떖` when collected images are under 10% of the page counts.
- New panel button `諛⑸Ц湲곕줉 珥덇린?? clears `visited`/`recentVisited` only, so titles can be
  re-crawled without clearing the queue or sitemap state.
- Still manual: reload the extension, re-crawl IDs 16-17, and refresh 18-38 after resetting
  visited. Real native folder picker/permission persistence also needs a manual check.

## Session handoff — current state (2026-11-22, end of session)

This section is the starting point for the next agent. Where earlier text disagrees, this
section wins.

### Current state

- Extension version `1.7.2`; output `schemaVersion` is `1.7.2` for media and person.
- Crawler is semi-automatic: the tab navigates itself, state lives in `chrome.storage.local`,
  sitemap children are streamed/gunzipped in `background.js`, and the queue keeps a 3,000-entry
  window. `newestFirst` walks sitemap children from the end.
- Media extraction is async and enriched from same-origin TMDB HTML subpages plus Wikidata:
  - `/images/posters` and `/images/backdrops`: default + `xx` + `en`, then language links in
    descending count order until the tab total is reached (cap 30 extra languages).
  - `/cast`: full cast + crew; totals and department headings (count suffix stripped).
  - `/videos`: all cards; `videos[].thumbnail` is filled from YouTube.
  - `/releases`: rows into `releases[]`; KR certification backfills `certification`.
  - Wikidata SPARQL: companies, countries, languages, `languageCode`, IMDb ID, official site,
    person birth/death/place; stored in the `wikidata` object.
  - OMDb (optional key): ratings/poster/plot into the `omdb` object; fills `overview` if empty.
- Payload metadata: `mediaSection` (tabs + static Most Popular assets), `topBilledCast[]`,
  image records (`file_path`, `id`, `iso_639_1`, `width`, `height`, `aspect_ratio`, `urls`),
  `images.collected/totals/pagination/has_next_page/incomplete`, `credits.castTotal/crewTotal`,
  `credits.directors/writers`, `isComplete`, `imdbId`, `wikidata`, `omdb`.
- Gallery merge keeps the highest-resolution URL and merges metadata from the losing duplicate;
  verified zero duplicate filenames after the final merge.
- Settings/logs: `[폴더 연결]` (File System Access) lets `[설정 저장]` overwrite the project
  `settings.json` directly (no download) and writes logs to the project root. Settings are read
  automatically at page start when permission is granted. The OMDb key is stored only in
  `chrome.storage` and stripped from `settings.json`.
- Image saving is forced off (`saveImages: false`); `autoLog` is forced on. JSON files still go
  to Chrome's default Downloads folder.
- Python companion: `python/enrich.py` (stdlib only) enriches saved JSON from Wikidata/OMDb/
  optional IMDb datasets; `--watch` polls for new files, writes to `<input>/enriched/`, and uses
  a lock/log in `<out>/.cache`.
- Native Messaging auto-start: `native/install.ps1 -ExtensionId <ID>` compiles
  `native/tmdb-enricher-host.exe`, writes `launcher.ini` + host manifest, and registers the host
  under HKCU for Chrome (and Edge). `background.js` connects on `onStartup`/`onInstalled`.
  The crawler panel has a top button `🐍 Python 보강 실행 (수동 로드)` that asks the background
  to launch the same native host.

### Verification performed

- `node --check content.js|crawler.js|background.js`; `manifest.json`/`settings.json` parse: pass.
- `py -m py_compile python/enrich.py`, `--help`, and offline merge tests for Wikidata/OMDb/
  IMDb: pass. IMDb `basics`/`ratings` loader test: pass.
- `python/enrich.py --watch`: lock/log creation, new-file detection
  (`batch: changed=1 scanned=1`): pass. BOM JSON accepted (`utf-8-sig`).
- `native/launcher.cs` compiles with `csc.exe`; `native/install.ps1` parses.
- Live TMDB checks: `movie/38` (mediaSection tabs/items, video thumbnail), `movie/22`
  (70 posters/113 backdrops after sweep), `movie/55` full extraction (76/76 posters,
  57/57 backdrops, 26/26 cast, 64/64 crew, `isComplete: true`, schema 1.7.2, ~50 s cold).
- Panel check on a live page: the Python button is the first body element and click sends
  `{action: "startPythonEnricher"}`.

### Remaining work / known issues

1. **Native host install is not verified in real Chrome.** It needs a one-time
   `native\install.ps1 -ExtensionId <ID>`, an extension reload, and a Chrome restart. Without the
   host, the button reports an error by design.
2. **Python live Wikidata calls returned HTTP 429** during testing. The CLI retries/backs off
   and exits cleanly, but a full live enrichment run has not completed end-to-end.
3. **OMDb live calls need a user key** (`--omdb-key` or `OMDB_API_KEY`). Only the sample
   `tt3896198` response shape has been validated.
4. **Gallery sweep cost**: reaching the tab total can take 30-50 s per title. The 30-language cap
   can still leave very large libraries short.
5. **Not available from TMDB HTML (do not invent)**: `cast_id`, cast `gender`/`popularity`/
   `adult`, image `vote_average`/`vote_count`, video `type`/`official`/`published_at`/`size`.
6. **Stale crawled JSON**: files saved before these fixes have incomplete images/languages/
   departments. Use `방문기록 초기화` and re-crawl; IDs 16-17 need a fresh crawl.
7. **Image saving is intentionally disabled**, so re-crawls do not write image folders.
8. **File System Access permission can expire**; if the project folder write fails, logs fall
   back to Downloads and settings saves report an error until `[폴더 연결]` is repeated.
9. **Native host path/extension ID**: moving the project or reinstalling the unpacked extension
   invalidates the registration; rerun `install.ps1`. Generated host files are gitignored.
10. **`python` alias is broken on this machine**; use `py` (Python 3.14.5).
11. **No automated test runner/CI**; validation is manual (Node syntax, Python compile, live
    browser checks).
12. **`샘플 html_용량이 크니 읽지 마시오/` is untracked** and must not be read without explicit
    user approval; do not commit it.
13. **`settings.json` currently reflects UI values** (cast/director/person enabled). Review it
    before publishing defaults.
14. **Manual Python button requires the native host**; it only requests the host, it does not
    run Python directly.

### Suggested next steps

1. Run the native installer with the real extension ID; verify auto-start and the panel button.
2. Retry a live Python enrichment run; inspect `enriched/*.json` and the watch log.
3. Re-crawl stale titles after `방문기록 초기화`; compare `collected` vs `totals` and
   `isComplete`.
4. Add automated tests for pure `content.js` helpers and `enrich.py` merge functions.
5. Consider a local FastAPI mode if native messaging proves inconvenient; the Python CLI core
   is reusable.

## Crawl audit — `C:/Users/ssii/Downloads/tmdb` (2026-11-22, schema 1.7.3)

Re-audited the four crawled files (`movie-6`, `movie-8`, `movie-9`, `movie-11`). `index.json`
was absent from this run (the crawl did not export it).

### Fixes

1. **`mediaType` added**: `type` was empty in every movie JSON (only the TV facts block set it,
   to a label such as "Scripted"). The media payload now carries `mediaType: "movie" | "tv"`
   and its `schemaVersion` is `1.7.3`; person payloads stay `1.7.2` (shape unchanged).
2. **Gallery completeness**: `movie-11` collected 469/473 posters because the extra-language
   sweep stopped at `MAX_EXTRA_LANGUAGES = 30` while TMDB exposes 35 language filters; the
   remaining low-count languages hold the missing images. Raised the cap to 60 and added a
   `TMDB <kind> 갤러리 미완료` warning when the tab total is still not reached, so a shortfall is
   visible in the crawl log instead of silent.

### Confirmed data absence (not bugs)

- `movie-8`: TMDB shows only 상태/원어/제작비/수익 facts, no company or language links, no Top
  Billed cards. Wikidata has neither `P4947 = 8` nor `P345 = tt0825671` (verified by SPARQL),
  so empty `productionCompanies`/`spokenLanguages`/`wikidata` are source absences.
- `movie-9`: TMDB has no image library for this title (no Media panel), so 0 posters/backdrops
  is correct.
- `movie-6`: crew 19 vs `crewTotal` 18 is expected because combined roles are split into
  separate entries.

### Re-crawl needed

Existing files keep their old payloads. Reload the extension, clear `방문기록`, and re-crawl
`movie-11` (and any others) to get `mediaType` and the full poster set, then re-export
`index.json`. OMDb is already populated on all four files, so the key file works.

## Wikipedia + OMDb gap filling (2026-11-22, media schema 1.7.4)

`manifest.json` is 1.7.3 and adds `https://*.wikipedia.org/*` to `host_permissions`. Media
payloads are `schemaVersion 1.7.4`; `index.json` exports `1.7.4`.

### OMDb now fills top-level fields (extension + Python)

`mergeOmdb` / `merge_omdb` fill only empty values, so TMDB-localized data always wins:

| Payload field | OMDb source |
| --- | --- |
| `certification` | `Rated` (skips `N/A`) |
| `homepage` | `Website` |
| `runtime` | `Runtime` (`"79 min"` → `"1h 19m"`, same format as TMDB) |
| `genres[]` | `Genre` (comma split) |
| `productionCompanies[]` | `Production` |
| `productionCountries[]` | `Country` |
| `spokenLanguages[]` | `Language` |
| `overview` | `Plot` (already existed) |

OMDb values are English, so a filled field can mix with TMDB's localized values; it is a
fallback only.

### Wikipedia summary enrichment

- `content.js`: `fetchWikipediaEnrichment` tries `ko` (page locale), the original language, then
  `en`, using the REST summary endpoint
  `https://<lang>.wikipedia.org/api/rest_v1/page/summary/<title>?redirect=true`. It runs only
  when `overview` is still empty after Wikidata/OMDb, skips disambiguation pages, caches for
  30 min, and stores `wikipedia: { lang, title, url, description }` (the extract becomes
  `overview`). Verified CORS is `access-control-allow-origin: *`.
- Toggle: `useWikipedia` (default `true`) in `crawler.js` defaults, `normalizeSettings`, the
  extraction options, and the panel checkbox `Wikipedia 요약 보강`.
- `python/enrich.py`: same candidates and merge for media files with an empty `overview`, cached
  7 days, disabled with `--no-wikipedia`. Person files are skipped. Only successful lookups are
  cached, so a transient failure is retried on the next run instead of sticking for 7 days.
- `fetchWikipediaEnrichment` keeps trying the remaining language candidates when one request
  throws; it no longer aborts the whole chain on the first network error.
- `mergeOmdb` (JS) normalizes `Runtime` through `formatRuntimeMinutes` and guards
  `genres`/`productionCompanies`/`productionCountries`/`spokenLanguages` with `Array.isArray`,
  matching Python's `format_runtime_minutes` and `data.get(...)` checks.

### Verification

- JS harness: OMDb fills empty fields, never overwrites TMDB values, Wikipedia candidate order
  and merge behavior. Python harness: same fills plus mocked fallback ko→en, metadata object,
  negative-cache reuse. Both passed; `node --check` and `py -m py_compile` pass.
- Live checks: OMDb `tt0825671` returns `Country Austria`, `Language English, Hindi, ...`,
  `Production Paul Thiltges Distributions`, `Rated N/A`; Korean Wikipedia summary for
  `스타워즈 에피소드 4: 새로운 희망` returns a standard page with an extract.
- Applied to the existing output:
  `py python/enrich.py "C:/Users/ssii/Downloads/tmdb" --inplace` wrote all 6 media files
  (`movie-13` … `movie-18`) with source `omdb` and left `.json.bak` backups. TMDB values were
  preserved, e.g. `citizen-kane` keeps `certification: "NR"` although OMDb says `PG`, and
  every `runtime` stayed in TMDB's `2h 22m` form. An isolated copy with blanked
  `certification`/`homepage`/`runtime`/`genres`/countries/languages was filled from OMDb
  (`R`, `1h 33m`, `Drama/Fantasy/Horror`, 4 countries, 2 languages), proving the fill path.
  Wikidata returned HTTP 429 for the batch and contributed nothing — expected, and the empty
  result is no longer cached, so the next run retries it.
- **Not verified**: a real crawl with the reloaded extension (no `chrome://extensions` access
  here), so `mediaType`, the 60-language gallery cap, and in-page Wikipedia/OMDb enrichment were
  not exercised against live TMDB pages.