# Python enrichment companion

File-based Python helper for JSON files produced by the Chrome extension.

It only **adds** auxiliary metadata. Existing values are preserved, and the extension keeps
working without Python (this is optional).

## Sources

| Source | Adds | Key |
| --- | --- | --- |
| Wikidata SPARQL | entity ID, IMDb ID, companies, countries, languages, languageCode, person dates, official website | none |
| OMDb | ratings, poster, plot, IMDB votes, awards, box office | free OMDb key |
| IMDb datasets | basics, ratings, directors/writers names | none (large downloads) |

## Requirements

- Python 3.9+ (standard library only; no pip install)
- Optional: IMDb dataset files from <https://datasets.imdbws.com/>:
  - `title.basics.tsv.gz`
  - `title.ratings.tsv.gz`
  - `title.crew.tsv.gz` (for director/writer names)
  - `name.basics.tsv.gz`

## Usage

```powershell
# Wikidata only, write to <dir>/enriched
py python/enrich.py "C:/Users/ssii/Downloads/tmdb"

# Overwrite originals (creates .json.bak once)
py python/enrich.py "C:/Users/ssii/Downloads/tmdb" --inplace

# Add OMDb (key is never written into JSON)
py python/enrich.py "." --omdb-key YOUR_KEY
# or: set OMDB_API_KEY=YOUR_KEY

# Add IMDb dataset data
py python/enrich.py "." --imdb-dir "D:/imdb" --limit 50

# Preview without writing
py python/enrich.py "." --dry-run
```

## Output fields

- `wikidata`: `{ entityId, url, label, tmdbId, imdbId, officialWebsite, companies, countries,
  languages, languageCode, birthDate, deathDate, birthPlace, citizenship }`
- `omdb`: normalized OMDb response (title, year, rated, released, runtime, genre, director,
  writer, actors, plot, language, country, awards, poster, ratings, metascore, imdbRating,
  imdbVotes, imdbID, type, dvd, boxOffice, production, website)
- `imdb`: `{ tconst, titleType, primaryTitle, originalTitle, startYear, endYear,
  runtimeMinutes, genres, averageRating, numVotes, directors, writers }`
- `imdbId`, `enrichedAt`, `enrichmentSources`

## Auto-start with Chrome (native messaging)

The extension cannot spawn processes directly, so auto-start uses a one-time native messaging
host install. After that, Chrome starts the Python watcher on browser startup / extension
install.

```powershell
# 1. Get the unpacked extension ID from chrome://extensions
# 2. Run once (PowerShell):
powershell -ExecutionPolicy Bypass -File native\install.ps1 -ExtensionId <EXTENSION_ID>

# Optional parameters:
#   -InputDir "C:\Users\ssii\Downloads\tmdb"
#   -OutDir   "C:\Users\ssii\Downloads\tmdb\enriched"
#   -Interval 30
#   -Python   "C:\Python\pythonw.exe"
```

- Installs under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tmdb_json_extractor.enricher`
  (and the Edge equivalent).
- `background.js` calls `chrome.runtime.connectNative()` on `onStartup`/`onInstalled`; the native
  launcher runs `python/enrich.py <input> --watch --interval N --out <out>` hidden.
- A lock file prevents duplicate watchers. New/changed JSON files are enriched automatically.
- If the host is not installed, the extension ignores the error; manual CLI usage still works.
- To set an OMDb key for the watcher, add `OMDB_API_KEY` to your user environment variables.
- Uninstall: delete the registry key and the generated `native/*.exe`, `native/launcher.ini`,
  `native/com.tmdb_json_extractor.enricher.json`.

## Notes

- Only empty/missing fields are filled; existing TMDB values are never overwritten.
- Cached responses live under `<out>/.cache/enrich-cache.json` (Wikidata 7 days, OMDb 30 days).
- Python should **not** scrape TMDB HTML (Cloudflare returns 403); use the browser extension for
  collection and Python only for enrichment.
- Respect TMDB attribution, OMDb terms, Wikidata license, and IMDb dataset license
  (personal/non-commercial use; commercial use needs a separate license).
- OMDb keys are read from `--omdb-key` or `OMDB_API_KEY` and are never stored in JSON output.
