#!/usr/bin/env python3
"""TMDB JSON enricher (file-based Python companion).

Reads JSON files produced by the Chrome extension and adds auxiliary metadata from:
  - Wikidata (companies, countries, languages, IMDb ID, official website, person dates)
  - OMDb (ratings, poster, plot, country/language/production; requires OMDb API key)
  - Wikipedia (summary text when overview is empty)
  - IMDb public datasets (basics, ratings, crew; optional --imdb-dir)

Only missing fields are filled; existing values are preserved. Standard library only.

Examples:
  py python/enrich.py "C:/Users/ssii/Downloads/tmdb"
  py python/enrich.py "C:/Users/ssii/Downloads/tmdb" --inplace
  py python/enrich.py . --omdb-key YOUR_KEY
  py python/enrich.py . --imdb-dir "D:/imdb"
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
OMDB_KEY_FILE = Path(__file__).resolve().parent.parent / "OMDb API.txt"
OMDB_ENDPOINT = "https://www.omdbapi.com/"
WIKIPEDIA_CACHE_TTL = 7 * 24 * 3600
USER_AGENT = "tmdb-json-extractor-enricher/1.0 (personal, non-commercial)"

KIND_PROPERTY = {
    "movie": "P4947",   # TMDB movie ID
    "tv": "P4983",      # TMDB TV series ID
    "person": "P4985",  # TMDB person ID
}

MEDIA_QUERY = """SELECT ?tmdb ?item ?itemLabel ?companyLabel ?countryLabel ?languageLabel ?iso ?imdb ?website WHERE {
  VALUES ?tmdb { %s }
  ?item wdt:{prop} ?tmdb.
  { ?item wdt:P272 ?company. } UNION
  { ?item wdt:P495 ?country. } UNION
  { ?item wdt:P364 ?language. OPTIONAL { ?language wdt:P218 ?iso. } } UNION
  { ?item wdt:P345 ?imdb. } UNION
  { ?item wdt:P856 ?website. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
} LIMIT 1000"""

PERSON_QUERY = """SELECT ?tmdb ?item ?itemLabel ?imdb ?website ?birth ?death ?birthPlaceLabel ?citizenshipLabel WHERE {
  VALUES ?tmdb { %s }
  ?item wdt:{prop} ?tmdb.
  OPTIONAL { ?item wdt:P345 ?imdb. }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item wdt:P569 ?birth. }
  OPTIONAL { ?item wdt:P570 ?death. }
  OPTIONAL { ?item wdt:P19 ?birthPlace. }
  OPTIONAL { ?item wdt:P27 ?citizenship. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
} LIMIT 1000"""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        print(f"[skip] {path.name}: {error}", file=sys.stderr)
        return None


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def http_json(url: str, headers: dict | None = None, timeout: int = 30, retries: int = 3,
              quiet: bool = False) -> dict | None:
    request_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        request_headers.update(headers)

    for attempt in range(retries + 1):
        request = urllib.request.Request(url, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < retries:
                retry_after = error.headers.get("Retry-After", "") if error.headers else ""
                wait = float(retry_after) if str(retry_after).isdigit() else 5 * (attempt + 1)
                wait = min(max(wait, 2), 30)
                print(f"[http] 429 rate limit, retrying in {wait:.0f}s", file=sys.stderr)
                time.sleep(wait)
                continue
            if error.code in (500, 502, 503, 504) and attempt < retries:
                time.sleep(2 * (attempt + 1))
                continue
            if not quiet:
                print(f"[http] {error.code} {url[:120]}", file=sys.stderr)
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
                continue
            if not quiet:
                print(f"[http] {error} {url[:120]}", file=sys.stderr)
            return None
    return None


def detect_kind(path: Path, data: dict) -> str | None:
    match = re.match(r"(movie|tv|person)-", path.name)
    if match:
        return match.group(1)
    if isinstance(data.get("mediaType"), str) and data["mediaType"] in KIND_PROPERTY:
        return data["mediaType"]
    if "credits" in data and "title" in data:
        return "movie"
    if "name" in data and "biography" in data:
        return "person"
    return None


def read_omdb_key_file() -> str:
    """Read the shared OMDb key file in the project root (the extension folder).

    Accepts a bare key, `apikey=...`, `API Key: ...`, an OMDb URL, or JSON that
    contains an apikey field. Plain OMDb response JSON has no key and yields "".
    """
    try:
        text = OMDB_KEY_FILE.read_text(encoding="utf-8-sig").strip()
    except OSError:
        return ""
    if not text:
        return ""

    if text.startswith("{") or text.startswith("["):
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return ""
        if isinstance(data, dict):
            for name in ("apikey", "apiKey", "api_key", "key"):
                value = str(data.get(name) or "").strip()
                if re.fullmatch(r"[A-Za-z0-9]{6,32}", value):
                    return value
        return ""

    line = next((row.strip() for row in text.splitlines() if row.strip()), "")
    match = re.search(r"[?&]apikey=([A-Za-z0-9]{6,32})", line, re.IGNORECASE)
    if match:
        return match.group(1)
    after_separator = re.split(r"[:=]", line)[-1].strip().strip("\"'")
    match = re.search(r"[A-Za-z0-9]{6,32}", after_separator)
    return match.group(0) if match else ""


def collect_wikidata(kinds_to_ids: dict[str, list[str]], cache: dict, chunk_delay: float = 0.0) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for kind, ids in kinds_to_ids.items():
        prop = KIND_PROPERTY[kind]
        unique_ids = sorted({str(value) for value in ids if str(value).strip()})
        for start in range(0, len(unique_ids), 25):
            chunk = unique_ids[start:start + 25]
            cache_key = f"wikidata:{kind}:{','.join(chunk)}"
            cached = cache.get(cache_key)
            # 빈 결과는 캐시로 재사용하지 않는다. 429/일시 오류로 빈 응답을 받은 뒤
            # 7일 동안 재시도가 막히는 문제를 피하기 위함이다.
            if cached and cached.get("data") and time.time() - cached.get("ts", 0) < 7 * 24 * 3600:
                results.update(cached.get("data", {}))
                continue

            values = " ".join('"%s"' % value.replace('"', "") for value in chunk)
            template = PERSON_QUERY if kind == "person" else MEDIA_QUERY
            query = template.replace("{prop}", prop).replace("%s", values)
            url = WIKIDATA_ENDPOINT + "?format=json&query=" + urllib.parse.quote(query)
            payload = http_json(url, {"Accept": "application/sparql-results+json"})
            if not payload:
                continue

            batch: dict[str, dict] = {}
            for row in payload.get("results", {}).get("bindings", []):
                tmdb_id = value_of(row, "tmdb")
                if not tmdb_id:
                    continue
                entry = batch.setdefault(tmdb_id, {
                    "entityId": "",
                    "url": "",
                    "label": "",
                    "tmdbId": tmdb_id,
                    "imdbId": "",
                    "officialWebsite": "",
                    "companies": [],
                    "countries": [],
                    "languages": [],
                    "languageCode": "",
                    "birthDate": "",
                    "deathDate": "",
                    "birthPlace": "",
                    "citizenship": [],
                })
                item_uri = value_of(row, "item")
                if item_uri and not entry["entityId"]:
                    entry["entityId"] = item_uri.rsplit("/", 1)[-1]
                    entry["url"] = item_uri
                if not entry["label"]:
                    entry["label"] = value_of(row, "itemLabel")
                if not entry["imdbId"]:
                    entry["imdbId"] = value_of(row, "imdb")
                if not entry["officialWebsite"]:
                    entry["officialWebsite"] = value_of(row, "website")
                push_unique(entry["companies"], value_of(row, "companyLabel"))
                push_unique(entry["countries"], value_of(row, "countryLabel"))
                push_unique(entry["languages"], value_of(row, "languageLabel"))
                if not entry["languageCode"]:
                    entry["languageCode"] = value_of(row, "iso")
                if not entry["birthDate"]:
                    entry["birthDate"] = shorten_date(value_of(row, "birth"))
                if not entry["deathDate"]:
                    entry["deathDate"] = shorten_date(value_of(row, "death"))
                if not entry["birthPlace"]:
                    entry["birthPlace"] = value_of(row, "birthPlaceLabel")
                push_unique(entry["citizenship"], value_of(row, "citizenshipLabel"))

            if batch:
                cache[cache_key] = {"ts": time.time(), "data": batch}
            results.update(batch)
            if chunk_delay > 0:
                time.sleep(chunk_delay)

    return results


def value_of(row: dict, key: str) -> str:
    value = row.get(key) or {}
    return str(value.get("value") or "").strip()


def shorten_date(value: str) -> str:
    if not value:
        return ""
    match = re.match(r"(\d{4}-\d{2}-\d{2})", value)
    return match.group(1) if match else value


def push_unique(values: list, value: str) -> None:
    if value and value not in values:
        values.append(value)


def name_list(existing) -> list[dict]:
    rows = []
    for item in existing or []:
        if isinstance(item, dict) and item.get("name"):
            rows.append({"name": item["name"]})
        elif isinstance(item, str) and item.strip():
            rows.append({"name": item.strip()})
    return rows


def merge_wikidata(data: dict, info: dict) -> bool:
    if not info:
        return False
    changed = False

    existing = data.get("wikidata") if isinstance(data.get("wikidata"), dict) else {}
    merged = dict(existing)
    for key, value in info.items():
        if value and not merged.get(key):
            merged[key] = value
    if merged and merged != existing:
        data["wikidata"] = merged
        changed = True

    if not data.get("imdbId") and info.get("imdbId"):
        data["imdbId"] = info["imdbId"]
        changed = True

    if not data.get("homepage") and info.get("officialWebsite"):
        data["homepage"] = info["officialWebsite"]
        changed = True

    if isinstance(data.get("productionCompanies"), list) and not data["productionCompanies"]:
        data["productionCompanies"] = [{"name": name} for name in info.get("companies", [])]
        changed = bool(data["productionCompanies"]) or changed

    if isinstance(data.get("productionCountries"), list) and not data["productionCountries"]:
        data["productionCountries"] = [{"name": name} for name in info.get("countries", [])]
        changed = bool(data["productionCountries"]) or changed

    if isinstance(data.get("spokenLanguages"), list) and not data["spokenLanguages"]:
        data["spokenLanguages"] = [{"name": name} for name in info.get("languages", [])]
        changed = bool(data["spokenLanguages"]) or changed

    if not data.get("originalLanguageCode") and info.get("languageCode"):
        data["originalLanguageCode"] = info["languageCode"]
        changed = True

    if info.get("birthDate") and not data.get("birthday"):
        data["birthday"] = info["birthDate"]
        changed = True
    if info.get("deathDate") and not data.get("deathday"):
        data["deathday"] = info["deathDate"]
        changed = True
    if info.get("birthPlace") and not data.get("placeOfBirth"):
        data["placeOfBirth"] = info["birthPlace"]
        changed = True

    return changed


def load_cache(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_cache(path: Path, cache: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    except OSError as error:
        print(f"[cache] {error}", file=sys.stderr)


def fetch_omdb(api_key: str, data: dict, kind: str, cache: dict) -> dict | None:
    imdb_id = data.get("imdbId") or (data.get("wikidata") or {}).get("imdbId") or ""
    title = data.get("title") or data.get("name") or ""
    year = str(data.get("releaseDate") or "")[:4]
    cache_key = f"omdb:{imdb_id or (kind + ':' + title + ':' + year)}"
    cached = cache.get(cache_key)
    if cached and time.time() - cached.get("ts", 0) < 30 * 24 * 3600:
        return cached.get("data")

    params = {"apikey": api_key, "plot": "full"}
    if imdb_id:
        params["i"] = imdb_id
    elif title:
        params["t"] = title
        if re.fullmatch(r"\d{4}", year):
            params["y"] = year
        params["type"] = "series" if kind == "tv" else "movie"
    else:
        return None

    url = OMDB_ENDPOINT + "?" + urllib.parse.urlencode(params)
    payload = http_json(url)
    if not payload or str(payload.get("Response")) != "True":
        return None

    result = {
        "title": payload.get("Title") or "",
        "year": payload.get("Year") or "",
        "rated": payload.get("Rated") or "",
        "released": payload.get("Released") or "",
        "runtime": payload.get("Runtime") or "",
        "genre": payload.get("Genre") or "",
        "director": payload.get("Director") or "",
        "writer": payload.get("Writer") or "",
        "actors": payload.get("Actors") or "",
        "plot": payload.get("Plot") or "",
        "language": payload.get("Language") or "",
        "country": payload.get("Country") or "",
        "awards": payload.get("Awards") or "",
        "poster": "" if payload.get("Poster") == "N/A" else (payload.get("Poster") or ""),
        "ratings": payload.get("Ratings") if isinstance(payload.get("Ratings"), list) else [],
        "metascore": "" if payload.get("Metascore") == "N/A" else (payload.get("Metascore") or ""),
        "imdbRating": "" if payload.get("imdbRating") == "N/A" else (payload.get("imdbRating") or ""),
        "imdbVotes": "" if payload.get("imdbVotes") == "N/A" else (payload.get("imdbVotes") or ""),
        "imdbID": payload.get("imdbID") or "",
        "type": payload.get("Type") or "",
        "dvd": "" if payload.get("DVD") == "N/A" else (payload.get("DVD") or ""),
        "boxOffice": "" if payload.get("BoxOffice") == "N/A" else (payload.get("BoxOffice") or ""),
        "production": "" if payload.get("Production") == "N/A" else (payload.get("Production") or ""),
        "website": "" if payload.get("Website") == "N/A" else (payload.get("Website") or ""),
    }
    cache[cache_key] = {"ts": time.time(), "data": result}
    return result


def split_omdb_list(value: str) -> list[str]:
    return [item.strip() for item in str(value or "").split(",")
            if item.strip() and item.strip() != "N/A"]


def format_runtime_minutes(value: str) -> str:
    """Format OMDb's "142 min" like TMDB's "2h 22m" so one field has one format."""
    match = re.search(r"\d+", str(value or ""))
    total = int(match.group(0)) if match else 0
    if not total:
        return ""
    hours, minutes = divmod(total, 60)
    if hours and minutes:
        return f"{hours}h {minutes}m"
    if hours:
        return f"{hours}h"
    return f"{minutes}m"


def merge_omdb(data: dict, omdb: dict) -> bool:
    if not omdb:
        return False
    changed = False
    if data.get("omdb") != omdb:
        data["omdb"] = omdb
        changed = True
    if not data.get("imdbId") and omdb.get("imdbID"):
        data["imdbId"] = omdb["imdbID"]
        changed = True
    if not data.get("overview") and omdb.get("plot"):
        data["overview"] = omdb["plot"]
        changed = True

    # TMDB에 없는 항목을 OMDb로 보강한다(이미 값이 있으면 기존 값을 유지).
    rated = str(omdb.get("rated") or "")
    if not data.get("certification") and rated and rated != "N/A":
        data["certification"] = rated
        changed = True
    website = str(omdb.get("website") or "")
    if not data.get("homepage") and website and website != "N/A":
        data["homepage"] = website
        changed = True
    runtime = format_runtime_minutes(omdb.get("runtime"))
    if not data.get("runtime") and runtime:
        data["runtime"] = runtime
        changed = True
    if not data.get("genres"):
        genres = split_omdb_list(omdb.get("genre"))
        if genres:
            data["genres"] = genres
            changed = True
    if not data.get("productionCompanies"):
        companies = split_omdb_list(omdb.get("production"))
        if companies:
            data["productionCompanies"] = [{"name": name} for name in companies]
            changed = True
    if not data.get("productionCountries"):
        countries = split_omdb_list(omdb.get("country"))
        if countries:
            data["productionCountries"] = [{"name": name} for name in countries]
            changed = True
    if not data.get("spokenLanguages"):
        languages = split_omdb_list(omdb.get("language"))
        if languages:
            data["spokenLanguages"] = [{"name": name} for name in languages]
            changed = True
    return changed


def wikipedia_candidates(data: dict) -> list[tuple[str, str]]:
    candidates: list[tuple[str, str]] = []

    def add(lang: str, title: str) -> None:
        code = str(lang or "").lower().split("-")[0]
        name = str(title or "").strip()
        if not re.fullmatch(r"[a-z]{2,3}", code) or not name:
            return
        pair = (code, name)
        if pair not in candidates:
            candidates.append(pair)

    add("ko", data.get("title"))
    add("ko", data.get("originalTitle"))
    add(data.get("originalLanguageCode"), data.get("originalTitle"))
    add("en", data.get("originalTitle"))
    add("en", data.get("title"))
    return candidates[:5]


def fetch_wikipedia(data: dict, cache: dict) -> dict | None:
    """Return a Wikipedia REST summary for the first matching title candidate."""
    for lang, title in wikipedia_candidates(data):
        cache_key = f"wikipedia:{lang}:{title}"
        cached = cache.get(cache_key)
        if cached and time.time() - cached.get("ts", 0) < WIKIPEDIA_CACHE_TTL:
            result = cached.get("data")
        else:
            encoded = urllib.parse.quote(title.replace(" ", "_"), safe="")
            url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{encoded}?redirect=true"
            payload = http_json(url, headers={"Accept": "application/json"},
                                timeout=15, retries=1, quiet=True)
            result = None
            if payload and payload.get("type") != "disambiguation" and payload.get("extract"):
                content_urls = payload.get("content_urls") or {}
                desktop = content_urls.get("desktop") or {}
                result = {
                    "lang": lang,
                    "title": payload.get("title") or title,
                    "url": desktop.get("page") or "",
                    "description": payload.get("description") or "",
                    "extract": payload.get("extract"),
                }
            # 실패/불일치 결과는 캐시하지 않는다. 일시적 오류가 7일 동안 굳지 않게 한다.
            if result:
                cache[cache_key] = {"ts": time.time(), "data": result}
        if result:
            return result
    return None


def merge_wikipedia(data: dict, wiki: dict | None) -> bool:
    if not wiki:
        return False
    changed = False
    info = {key: wiki.get(key) for key in ("lang", "title", "url", "description")}
    if data.get("wikipedia") != info:
        data["wikipedia"] = info
        changed = True
    if not data.get("overview") and wiki.get("extract"):
        data["overview"] = wiki["extract"]
        changed = True
    return changed


def ensure_fields(path: Path, field: str) -> Path:
    candidate = path / field
    if not candidate.exists():
        raise FileNotFoundError(f"{candidate} not found")
    return candidate


def load_imdb(imdb_dir: Path, needed: set[str]) -> dict[str, dict]:
    if not needed:
        return {}

    basics_file = ensure_fields(imdb_dir, "title.basics.tsv.gz")
    ratings_file = imdb_dir / "title.ratings.tsv.gz"
    crew_file = imdb_dir / "title.crew.tsv.gz"
    names_file = imdb_dir / "name.basics.tsv.gz"

    rows: dict[str, dict] = {}

    with gzip.open(basics_file, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
        next(reader, None)
        for row in reader:
            if len(row) < 9 or row[0] not in needed:
                continue
            rows[row[0]] = {
                "tconst": row[0],
                "titleType": clean_tsv(row[1]),
                "primaryTitle": clean_tsv(row[2]),
                "originalTitle": clean_tsv(row[3]),
                "startYear": clean_tsv(row[5]),
                "endYear": clean_tsv(row[6]),
                "runtimeMinutes": clean_tsv(row[7]),
                "genres": clean_tsv(row[8]),
                "averageRating": "",
                "numVotes": "",
                "directors": [],
                "writers": [],
            }

    if ratings_file.exists():
        with gzip.open(ratings_file, "rt", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
            next(reader, None)
            for row in reader:
                if len(row) >= 3 and row[0] in rows:
                    rows[row[0]]["averageRating"] = clean_tsv(row[1])
                    rows[row[0]]["numVotes"] = clean_tsv(row[2])

    if crew_file.exists() and names_file.exists():
        crew: dict[str, tuple[str, str]] = {}
        needed_people: set[str] = set()
        with gzip.open(crew_file, "rt", encoding="utf-8", newline="") as handle:
            reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
            next(reader, None)
            for row in reader:
                if len(row) >= 3 and row[0] in rows:
                    crew[row[0]] = (row[1], row[2])
                    for value in (row[1], row[2]):
                        for person in value.split(","):
                            if person and person != "\\N":
                                needed_people.add(person)

        names: dict[str, str] = {}
        if needed_people:
            with gzip.open(names_file, "rt", encoding="utf-8", newline="") as handle:
                reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
                next(reader, None)
                for row in reader:
                    if len(row) >= 2 and row[0] in needed_people:
                        names[row[0]] = clean_tsv(row[1])

        for tconst, (directors, writers) in crew.items():
            rows[tconst]["directors"] = [names[value] for value in directors.split(",") if value in names]
            rows[tconst]["writers"] = [names[value] for value in writers.split(",") if value in names]

    return rows


def clean_tsv(value: str) -> str:
    return "" if value == "\\N" else value


def merge_imdb(data: dict, imdb: dict | None) -> bool:
    if not imdb:
        return False
    if data.get("imdb") == imdb:
        return False
    data["imdb"] = imdb
    return True


def list_json_files(input_dir: Path) -> list[Path]:
    return sorted(
        path for path in input_dir.glob("*.json")
        if path.is_file() and path.name not in {"index.json", "settings.json"}
        and not path.name.endswith(".bak")
    )


def run_batch(input_dir: Path, out_dir: Path, cache_dir: Path, cache: dict, args,
              only_paths: set[Path] | None = None) -> tuple[int, int, int]:
    files = list_json_files(input_dir)
    if only_paths is not None:
        files = [path for path in files if path in only_paths]
    if args.limit and args.limit > 0:
        files = files[:args.limit]

    loaded: list[tuple[Path, dict, str]] = []
    for path in files:
        data = read_json(path)
        if not isinstance(data, dict):
            continue
        kind = detect_kind(path, data)
        if not kind:
            continue
        loaded.append((path, data, kind))

    if not loaded:
        return 0, 0, len(files)

    changed_by_file: dict[Path, set[str]] = {path: set() for path, _, _ in loaded}

    if not args.no_wikidata:
        kinds_to_ids: dict[str, list[str]] = {}
        for path, data, kind in loaded:
            tmdb_id = (data.get("wikidata") or {}).get("tmdbId") or extract_tmdb_id(path)
            if tmdb_id:
                kinds_to_ids.setdefault(kind, []).append(str(tmdb_id))
        wiki_map = collect_wikidata(kinds_to_ids, cache, args.wikidata_delay)
        for path, data, kind in loaded:
            tmdb_id = (data.get("wikidata") or {}).get("tmdbId") or extract_tmdb_id(path)
            info = wiki_map.get(str(tmdb_id)) if tmdb_id else None
            if merge_wikidata(data, info):
                changed_by_file[path].add("wikidata")

    omdb_key = (args.omdb_key or "").strip() or read_omdb_key_file()
    if omdb_key:
        for path, data, kind in loaded:
            if data.get("type") == "person" or kind == "person":
                continue
            omdb = fetch_omdb(omdb_key, data, kind, cache)
            if omdb:
                if merge_omdb(data, omdb):
                    changed_by_file[path].add("omdb")
                if args.omdb_delay > 0:
                    time.sleep(args.omdb_delay)

    if not args.no_wikipedia:
        for path, data, kind in loaded:
            if kind == "person" or data.get("overview"):
                continue
            wiki = fetch_wikipedia(data, cache)
            if merge_wikipedia(data, wiki):
                changed_by_file[path].add("wikipedia")

    if args.imdb_dir:
        needed = set()
        for _, data, _ in loaded:
            imdb_id = data.get("imdbId") or (data.get("wikidata") or {}).get("imdbId")
            if imdb_id:
                needed.add(imdb_id)
        try:
            imdb_map = load_imdb(args.imdb_dir, needed)
        except (OSError, EOFError) as error:
            print(f"[imdb] {error}", file=sys.stderr)
            imdb_map = {}
        for path, data, _ in loaded:
            imdb_id = data.get("imdbId") or (data.get("wikidata") or {}).get("imdbId")
            if merge_imdb(data, imdb_map.get(imdb_id) if imdb_id else None):
                changed_by_file[path].add("imdb")

    written = 0
    for path, data, _ in loaded:
        sources = changed_by_file[path]
        if not sources:
            continue
        data["enrichedAt"] = utc_now()
        data["enrichmentSources"] = sorted(sources)

        target = out_dir / path.name
        if args.dry_run:
            print(f"[dry-run] {path.name}: {', '.join(sorted(sources))}")
            continue
        if args.inplace and not args.no_backup:
            backup = path.with_suffix(path.suffix + ".bak")
            if not backup.exists():
                backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        write_json(target, data)
        written += 1
        print(f"[write] {target} ({', '.join(sorted(sources))})")

    save_cache(cache_dir / "enrich-cache.json", cache)
    return len(loaded), written, len(files) - len(loaded)


def acquire_watch_lock(path: Path):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+")
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        return handle
    except (OSError, ImportError):
        return None


def watch_loop(input_dir: Path, out_dir: Path, cache_dir: Path, args) -> int:
    lock = acquire_watch_lock(cache_dir / "enrich-watch.lock")
    if not lock:
        print("watch already running")
        return 0

    log_path = cache_dir / "enrich-watch.log"

    def log(message: str) -> None:
        line = f"{utc_now()} {message}\n"
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as handle:
                handle.write(line)
        except OSError:
            pass
        print(line.strip())

    cache = load_cache(cache_dir / "enrich-cache.json")
    seen: dict[Path, tuple[int, int]] = {}
    log(f"watch started: input={input_dir} out={out_dir} interval={args.interval}s")

    while True:
        try:
            files = list_json_files(input_dir)
            changed = []
            for path in files:
                try:
                    stat = path.stat()
                except OSError:
                    continue
                signature = (stat.st_mtime_ns, stat.st_size)
                if seen.get(path) != signature:
                    changed.append(path)

            if changed:
                scanned, written, skipped = run_batch(input_dir, out_dir, cache_dir, cache, args, set(changed))
                log(f"batch: changed={len(changed)} scanned={scanned} written={written} skipped={skipped}")

            for path in files:
                try:
                    stat = path.stat()
                    seen[path] = (stat.st_mtime_ns, stat.st_size)
                except OSError:
                    pass
            for path in list(seen):
                if not path.exists():
                    seen.pop(path, None)
        except Exception as error:  # keep the watcher alive
            log(f"error: {error}")

        time.sleep(max(5.0, float(args.interval)))


def main() -> int:
    parser = argparse.ArgumentParser(description="Enrich TMDB crawler JSON with Wikidata/OMDb/IMDb data.")
    parser.add_argument("input_dir", type=Path, help="Directory containing movie-*.json / tv-*.json / person-*.json")
    parser.add_argument("--out", type=Path, help="Output directory (default: <input>/enriched)")
    parser.add_argument("--inplace", action="store_true", help="Overwrite input files")
    parser.add_argument("--no-backup", action="store_true", help="Do not create .json.bak when using --inplace")
    parser.add_argument("--no-wikidata", action="store_true", help="Skip Wikidata enrichment")
    parser.add_argument("--no-wikipedia", action="store_true", help="Skip Wikipedia summary enrichment")
    parser.add_argument("--wikidata-delay", type=float, default=1.0, help="Delay between Wikidata batches (seconds)")
    parser.add_argument("--omdb-key", default=os.environ.get("OMDB_API_KEY", ""), help="OMDb API key (or OMDB_API_KEY)")
    parser.add_argument("--omdb-delay", type=float, default=0.25, help="Delay between OMDb requests (seconds)")
    parser.add_argument("--imdb-dir", type=Path, help="Directory with IMDb title.basics.tsv.gz and friends")
    parser.add_argument("--limit", type=int, default=0, help="Process at most N files")
    parser.add_argument("--dry-run", action="store_true", help="Do not write output files")
    parser.add_argument("--cache-dir", type=Path, help="Cache directory (default: <out>/.cache)")
    parser.add_argument("--watch", action="store_true", help="Keep running and enrich new/changed JSON files")
    parser.add_argument("--interval", type=float, default=30.0, help="Watch scan interval in seconds (min 5)")
    args = parser.parse_args()

    input_dir = args.input_dir
    if not input_dir.is_dir():
        print(f"input directory not found: {input_dir}", file=sys.stderr)
        return 2

    out_dir = input_dir if args.inplace else (args.out or input_dir / "enriched")
    cache_dir = args.cache_dir or (out_dir / ".cache")
    cache = load_cache(cache_dir / "enrich-cache.json")

    if args.watch:
        return watch_loop(input_dir, out_dir, cache_dir, args)

    scanned, written, skipped = run_batch(input_dir, out_dir, cache_dir, cache, args)
    print(f"done: {scanned} scanned, {written} written, {skipped} skipped")
    return 0


def extract_tmdb_id(path: Path) -> str:
    match = re.match(r"(?:movie|tv|person)-(\d+)", path.name)
    return match.group(1) if match else ""


if __name__ == "__main__":
    raise SystemExit(main())
