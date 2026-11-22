// crawler.js - TMDB 반자동 사이트 크롤러 (1.7)
// content.js 뒤에 로드되어, 같은 isolated world의 추출 함수(window.__tmdbExtractor)를 사용한다.
// 사람이 [시작]을 누르면 현재 탭을 그대로 이동시키며 큐를 처리한다(반자동).
(function () {
  if (window.__tmdbCrawlerLoaded) return;
  window.__tmdbCrawlerLoaded = true;

  const STATE_KEY = 'tmdbCrawlerState';
  const SETTINGS_KEY = 'tmdbCrawlerSettings';
  const SETTINGS_HASH_KEY = 'tmdbCrawlerSettingsHash';
  const STATE_VERSION = 2;
  const MAX_QUEUE = 3000;
  const MAX_PEOPLE_PER_TITLE = 500;
  const MAX_RECORDS = 2000;
  const REFILL_THRESHOLD = 500;
  // 방문기록은 전체 사이트 규모(수백만)에서 메모리/저장이 무한히 커지지 않도록 상한을 둔다.
  // 사이트맵 커서가 진행 상태를 들고 있으므로 오래된 키를 잃어도 같은 페이지를 다시 훑지 않는다.
  const VISITED_MEMORY_LIMIT = 200000;
  const VISITED_SAVE_LIMIT = 20000;

  // robots.txt가 안내하는 공식 사이트맵(하위 파일은 .xml.gz)
  const SITEMAP_INDEX = {
    movie: 'https://files.tmdb.org/p/exports/sitemaps/sitemap_movies.xml',
    tv: 'https://files.tmdb.org/p/exports/sitemaps/sitemap_tv_series.xml',
    person: 'https://files.tmdb.org/p/exports/sitemaps/sitemap_people.xml'
  };

  // 표시 언어(단일 선택). TMDB 사이트는 ?language=xx-XX로 표시 언어를 바꿈
  const LANGUAGES = [
    ['ko-KR', '한국어 (기본)'],
    ['en-US', 'English'],
    ['ja-JP', '日本語'],
    ['de-DE', 'Deutsch'],
    ['zh-TW', '中文 (대만)'],
    ['zh-CN', '中文 (중국)'],
    ['fr-FR', 'Français'],
    ['es-ES', 'Español'],
    ['pt-BR', 'Português'],
    ['ru-RU', 'Русский'],
    ['it-IT', 'Italiano'],
    ['hi-IN', 'हिन्दी']
  ];

  const DEFAULT_SETTINGS = {
    _v: 3,
    // 페이지/갤러리 언어 (단일 선택)
    language: 'ko-KR',
    // JSON 저장 시 같은 이름의 폴더에 이미지도 저장
    saveImages: false,
    // 저장할 대상. 배우/감독은 제목 크레딧에서 인물 큐를 파생시킨다.
    targets: { movie: true, tv: true, cast: false, director: false },
    // 사이트맵으로 큐를 채울 때 사용할 인덱스
    sitemapKinds: { movie: true, tv: true, person: false },
    sitemapBatch: 1000,
    // 사이트맵을 뒤에서부터(최신 id → 과거) 읽어 최신 작품부터 크롤링한다
    newestFirst: false,
    // 작품 하나를 저장할 때 인물 큐에 넣을 최대 인원 (0 = 무제한)
    // 기본 30: /cast 목록은 빌링 순서라 상위 30명이면 주요·조연을 덮고, 작품당 큐 증가도 제한된다
    peoplePerTitle: 30,
    allLanguages: false,
    collectFilmography: false,
    followLists: true,
    // 다음 작업으로 링크를 자동 추적해 끊김 없이 이어서 크롤링한다
    autoFollow: true,
    // 큐가 이 값 이하일 때만, 한 번에 이 개수까지 보충한다
    autoFollowQueue: 5,
    autoFollowLimit: 8,
    // 같은 파일이 이미 있으면 덮어쓸지 (끄면 건너뛴다)
    overwrite: true,
    // 크롤링이 끝나거나 중지될 때 로그 파일을 자동 저장한다
    autoLog: true,
    humanize: true,
    readDelay: true,
    minDelayMs: 3000,
    maxDelayMs: 7000,
    subpageMinMs: 700,
    subpageMaxMs: 1800,
    breakEveryMin: 40,
    breakEveryMax: 90,
    breakMinSec: 120,
    breakMaxSec: 300,
    maxListPages: 300,
    folder: 'tmdb'
  };

  const state = {
    active: false,
    paused: false,
    queue: [],
    records: [],
    listPages: 0,
    stats: { done: 0, confirmed: 0, unconfirmed: 0, duplicates: 0, failed: 0, skipped: 0, lastError: '', byType: { movie: 0, tv: 0, person: 0 } },
    startedAt: '',
    logs: [],
    // 대기(이동 대기·휴식·한도 대기·일시정지)를 뺀 실제 크롤링 시간
    crawlMs: 0,
    crawlSince: 0,
    breakUntil: 0,
    breakAfter: 60,
    pagesSinceBreak: 0,
    cooldownUntil: 0
  };

  const sitemapState = {
    active: false,
    done: false,
    kinds: [],
    kindIndex: 0,
    kind: '',
    children: [],
    childIndex: 0,
    cursor: 0,
    fileCount: 0,
    queued: 0,
    scanned: 0,
    error: ''
  };

  const visited = new Set();
  const recentVisited = [];
  const queuedUrls = new Set();

  let settings = clone(DEFAULT_SETTINGS);
  let busy = false;
  let refilling = false;
  let panel = null;
  let els = {};
  let navTimer = null;
  let navUrl = '';
  let navigating = false;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ext() {
    return window.__tmdbExtractor || {};
  }

  function toast(message, type) {
    const api = ext();
    if (api.showToast) api.showToast(message, type || 'success');
    else console.log('[crawler]', message);
  }

  function errorMessage(error) {
    return String((error && error.message) || error || '알 수 없는 오류');
  }

  /* 작업 로그: 화면에 남기고, 파일(.log)로 저장해 코드 수정에 쓸 수 있게 한다 */
  const LOG_LIMIT = 1500;
  const LOG_SAVE_LIMIT = 400;
  // 로그 창은 내용이 실제로 바뀔 때만 다시 그린다(1초 갱신에서 DOM 재작성 방지)
  let logRevision = 0;
  let logRenderedRevision = -1;

  function timestamp() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }

  function log(message, detail) {
    let suffix = '';
    if (detail !== undefined) {
      try {
        suffix = ' | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300);
      } catch (e) {
        suffix = ' | (상세 직렬화 실패)';
      }
    }
    const line = '[' + timestamp() + '] ' + String(message || '') + suffix;
    state.logs.push(line);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
    logRevision += 1;
    try {
      console.log('[crawler]', line);
    } catch (e) {}
    return line;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randInt(min, max) {
    const low = Math.ceil(Number(min) || 0);
    const high = Math.ceil(Number(max) || low);
    if (high <= low) return low;
    return low + Math.floor(Math.random() * (high - low + 1));
  }

  function jitter(ms) {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
  }

  /* ------------------------------------------------------------------ */
  /* 저장소                                                              */
  /* ------------------------------------------------------------------ */
  function storageGet(key) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(key, value => resolve((value || {})[key]));
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  function storageSet(obj) {
    return new Promise(resolve => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  function serializeQueue() {
    return state.queue.map(entry => [entry.t, entry.id, entry.url, entry.role || '', entry.save === false ? 0 : 1, entry.force === true ? 1 : 0]);
  }

  function restoreQueue(rows) {
    state.queue = [];
    queuedUrls.clear();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      if (!Array.isArray(row) || row.length < 3 || !row[2]) return;
      const entry = { t: row[0], id: String(row[1] || ''), url: String(row[2]), role: row[3] || '', save: row[4] !== 0, force: row[5] === 1 };
      state.queue.push(entry);
      queuedUrls.add(entry.url);
    });
  }

  let saveChain = Promise.resolve();

  function saveState(force) {
    const payload = {
      _v: STATE_VERSION,
      active: state.active,
      paused: state.paused,
      queue: serializeQueue(),
      visited: recentVisited.join('\n'),
      records: state.records,
      listPages: state.listPages,
      stats: state.stats,
      startedAt: state.startedAt,
      crawlMs: crawlTimeMs(),
      crawlSince: state.crawlSince ? Date.now() : 0,
      logs: state.logs.slice(-LOG_SAVE_LIMIT),
      breakUntil: state.breakUntil,
      breakAfter: state.breakAfter,
      pagesSinceBreak: state.pagesSinceBreak,
      cooldownUntil: state.cooldownUntil,
      sitemap: sitemapState
    };
    saveChain = saveChain.then(() => storageSet({ [STATE_KEY]: payload }), () => storageSet({ [STATE_KEY]: payload }));
    return force ? saveChain : saveChain;
  }

  function saveSettings() {
    return storageSet({ [SETTINGS_KEY]: settings });
  }

  // 저장 폴더명 정리: 경로 탈출(..)과 허용되지 않는 문자를 막는다
  function safeFolder() {
    const raw = String(settings.folder || 'tmdb')
      .replace(/\\/g, '/')
      .replace(/\.\./g, '')
      .replace(/[^a-zA-Z0-9_\-/가-힣]/g, '')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '');
    return raw || 'tmdb';
  }

  /* ------------------------------------------------------------------ */
  /* URL/큐 유틸                                                         */
  /* ------------------------------------------------------------------ */
  const SUBPAGE_RE = /\/(images|cast|videos|releases|edit|remote|season|episode)\//;

  function pageTarget() {
    const match = location.pathname.match(/^\/(movie|tv|person)\/(\d+)(?:[-/]|$)/);
    if (!match) return null;
    if (SUBPAGE_RE.test(location.pathname)) return null;
    return { t: match[1], type: match[1], id: match[2], url: '/' + match[1] + '/' + match[2] };
  }

  function normalizeLinkHref(href) {
    const value = String(href || '');
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.hostname !== 'www.themoviedb.org' && url.hostname !== 'themoviedb.org') return '';
        return url.pathname + url.search;
      } catch (e) {
        return '';
      }
    }
    return value.charAt(0) === '/' ? value : '';
  }

  function isDisallowedPath(path) {
    const value = String(path || '');
    if (/\/person\/\d+\/remote\/credits/.test(value)) return true;
    return /image_sort=/.test(value);
  }

  // /movie/1368337-the-odyssey → { t:'movie', id:'1368337', url:'/movie/1368337-the-odyssey' }
  // 목록/추천/사이트맵 링크를 그대로 받아 슬러그를 보존한다.
  function entryFromPath(path) {
    const value = String(path || '');
    if (!value || isDisallowedPath(value)) return null;
    const match = value.match(/^\/(movie|tv|person)\/(\d+)(?:-([^/?#]*))?\/?(?:[?#].*)?$/);
    if (!match) return null;
    const type = match[1];
    const slug = match[3] || '';
    return {
      t: type,
      id: match[2],
      url: '/' + type + '/' + match[2] + (slug ? '-' + slug : ''),
      role: type === 'person' ? 'person' : ''
    };
  }

  function parseLocTags(xml) {
    const locs = [];
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
    let match;
    while ((match = re.exec(String(xml || '')))) {
      locs.push(match[1].trim());
    }
    return locs;
  }

  function pathFromUrl(value) {
    try {
      const url = new URL(String(value));
      if (url.hostname !== 'www.themoviedb.org' && url.hostname !== 'themoviedb.org') return '';
      return url.pathname + url.search;
    } catch (e) {
      return '';
    }
  }

  function keyOf(entry) {
    return entry.t + ':' + entry.id;
  }

  function titleSaveEnabled(type) {
    return !!(settings.targets && settings.targets[type]);
  }

  function peopleEnabled() {
    return !!(settings.targets && (settings.targets.cast || settings.targets.director));
  }

  function normalizeLanguage(value) {
    const code = String(value || '').trim();
    return LANGUAGES.some(pair => pair[0] === code) ? code : DEFAULT_SETTINGS.language;
  }

  function languageCode() {
    return normalizeLanguage(settings.language);
  }

  // 큐에는 언어 파라미터 없이 보관한다(같은 작품 중복 방지). 이동할 때만 붙인다.
  function stripLanguageParam(url) {
    try {
      const parsed = new URL(url, location.origin);
      if (!parsed.searchParams.has('language')) return url;
      parsed.searchParams.delete('language');
      const search = parsed.searchParams.toString();
      return parsed.pathname + (search ? '?' + search : '');
    } catch (e) {
      return url;
    }
  }

  function withLanguage(url) {
    try {
      const target = new URL(url, location.origin);
      if (target.origin !== location.origin) return url;
      if (!/^\/(movie|tv|person|discover|genre|keyword|company|collection)(\/|$)/.test(target.pathname)) return url;
      target.searchParams.set('language', languageCode());
      return target.pathname + target.search;
    } catch (e) {
      return url;
    }
  }

  function samePath(url) {
    try {
      const current = new URL(location.href);
      const other = new URL(url, location.origin);
      // 언어 파라미터는 무시하고 같은 페이지인지 비교한다
      current.searchParams.delete('language');
      other.searchParams.delete('language');
      return current.pathname === other.pathname && current.search === other.search;
    } catch (e) {
      return false;
    }
  }

  function dropQueued(url) {
    if (url) queuedUrls.delete(url);
  }

  function queueShift() {
    const entry = state.queue.shift();
    if (entry) dropQueued(entry.url);
    return entry;
  }

  function mergeRole(entry) {
    const existing = state.queue.find(item => item.t === 'person' && String(item.id) === String(entry.id));
    if (!existing) return;
    const roles = new Set(String(existing.role || '').split(',').filter(Boolean));
    roles.add(entry.role || 'person');
    existing.role = Array.from(roles).join(',');
  }

  // 큐 추가. 타입 선택을 지키고, 제목을 저장하지 않는 경우에도 인물 탐색이 필요하면 넣는다.
  function enqueueEntry(entry, options) {
    if (!entry) return false;
    const opts = options || {};

    if (!opts.force) {
      if (entry.t === 'person') {
        if (!peopleEnabled()) return false;
      } else if (entry.t === 'movie' || entry.t === 'tv') {
        if (!titleSaveEnabled(entry.t) && !peopleEnabled()) return false;
      } else {
        return false;
      }
    }

    if (visited.has(keyOf(entry))) return false;

    const url = stripLanguageParam(entry.url);
    if (!url) return false;
    if (queuedUrls.has(url)) {
      if (entry.t === 'person') mergeRole(entry);
      return false;
    }
    if (state.queue.length >= MAX_QUEUE) return false;

    state.queue.push({
      t: entry.t,
      id: String(entry.id),
      url: url,
      role: entry.role || (entry.t === 'person' ? 'person' : ''),
      save: opts.force === true ? true : (entry.t === 'person' ? true : titleSaveEnabled(entry.t)),
      force: opts.force === true
    });
    queuedUrls.add(url);
    return true;
  }

  function enqueueList(url, front) {
    const clean = stripLanguageParam(url);
    if (!clean || queuedUrls.has(clean)) return false;
    const entry = { t: 'list', id: '', url: clean, role: '', save: false };
    if (front) state.queue.unshift(entry);
    else state.queue.push(entry);
    queuedUrls.add(clean);
    return true;
  }

  function collectDetailLinks() {
    const found = [];
    const seen = {};
    document.querySelectorAll('a[href]').forEach(anchor => {
      const path = normalizeLinkHref(anchor.getAttribute('href'));
      const entry = entryFromPath(path);
      if (!entry) return;
      const key = keyOf(entry);
      if (seen[key]) return;
      seen[key] = true;
      found.push(entry);
    });
    return found;
  }

  // .pagination 안의 "현재 페이지 + 1" 링크만 인정한다(필터/정렬 링크 오인 방지).
  function nextPageUrl() {
    const currentUrl = new URL(location.href);
    const currentPage = Number(currentUrl.searchParams.get('page') || '1');

    const links = Array.from(document.querySelectorAll('.pagination a[href]'))
      .concat(Array.from(document.querySelectorAll('a.load_more[href]')));

    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || href.indexOf('page=') === -1) continue;

      let next;
      try {
        next = new URL(href, location.href);
      } catch (e) {
        continue;
      }
      if (next.pathname !== currentUrl.pathname) continue;

      const page = Number(next.searchParams.get('page') || '');
      if (!isFinite(page) || page <= currentPage || page > currentPage + 1) continue;

      next.hash = '';
      return next.pathname + next.search;
    }
    return '';
  }

  function isListPage() {
    if (pageTarget()) return false;
    return collectDetailLinks().length >= 3;
  }

  /* ------------------------------------------------------------------ */
  /* 사이트맵 (files.tmdb.org → background gzip 해제)                    */
  /* ------------------------------------------------------------------ */
  function bgFetch(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(Object.assign({ action: 'crawlFetch' }, message), response => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: '사이트맵 응답 없음' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // 설치 폴더의 settings.json(기본값)을 매 시작 시 읽어 온다.
  function requestPackagedSettings() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action: 'crawlerPackagedSettings' }, response => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response && typeof response === 'object' ? response : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function selectedSitemapKinds() {
    return ['movie', 'tv', 'person'].filter(kind => settings.sitemapKinds && settings.sitemapKinds[kind]);
  }

  // 제목은 저장하지 않아도 인물 탐지에 쓸 수 있으므로 peopleEnabled()도 허용한다.
  function kindUsable(kind) {
    if (kind === 'person') return peopleEnabled();
    return titleSaveEnabled(kind) || peopleEnabled();
  }

  // 큐가 줄면 사이트맵 다음 조각을 받아 보충한다. (전체 URL을 한 번에 들고 있지 않는다)
  async function refillIfNeeded(force) {
    if (!sitemapState.active) return 0;
    if (!force && state.queue.length >= REFILL_THRESHOLD) return 0;
    return fillFromSitemap(force ? sitemapBatchSize() : sitemapBatchSize());
  }

  function sitemapBatchSize() {
    const value = Number(settings.sitemapBatch);
    if (!isFinite(value)) return 1000;
    return Math.max(100, Math.min(5000, Math.round(value)));
  }

  async function fillFromSitemap(batch) {
    if (refilling) return 0;
    refilling = true;
    let added = 0;
    // 최신순이면 마지막 파일(=높은 id)부터 읽고, 파일 안에서도 뒤에서부터 읽는다
    const newestFirst = settings.newestFirst === true;
    try {
      while (sitemapState.active && added < batch) {
        const kind = sitemapState.kinds[sitemapState.kindIndex];
        if (!kind) {
          sitemapState.active = false;
          sitemapState.done = true;
          sitemapState.kind = '';
          break;
        }

        // 대상이 꺼진 종류는 파일을 받지 않고 건너뛴다(102개 인물 파일 낭비 방지)
        if (!kindUsable(kind)) {
          sitemapState.kindIndex += 1;
          sitemapState.children = [];
          sitemapState.childIndex = 0;
          sitemapState.cursor = 0;
          sitemapState.fileCount = 0;
          continue;
        }

        if (!sitemapState.children.length) {
          const index = await bgFetch({ url: SITEMAP_INDEX[kind], mode: 'text' });
          if (!index.ok) {
            sitemapState.error = index.error || '사이트맵 인덱스 실패';
            sitemapState.active = false;
            break;
          }
          sitemapState.children = parseLocTags(index.text).filter(url => /\.xml(\.gz)?$/i.test(url));
          sitemapState.childIndex = 0;
          sitemapState.cursor = 0;
          sitemapState.fileCount = sitemapState.children.length;
          sitemapState.kind = kind;
          if (!sitemapState.children.length) {
            sitemapState.kindIndex += 1;
            sitemapState.children = [];
            continue;
          }
        }

        if (sitemapState.childIndex >= sitemapState.children.length) {
          sitemapState.kindIndex += 1;
          sitemapState.children = [];
          sitemapState.childIndex = 0;
          sitemapState.cursor = 0;
          sitemapState.fileCount = 0;
          continue;
        }

        const childIndex = newestFirst
          ? sitemapState.children.length - 1 - sitemapState.childIndex
          : sitemapState.childIndex;
        const child = sitemapState.children[childIndex];
        const result = await bgFetch({
          url: child,
          mode: 'locs',
          offset: sitemapState.cursor,
          limit: Math.max(500, Math.min(5000, batch * 2)),
          fromEnd: newestFirst
        });
        if (!result.ok) {
          sitemapState.error = result.error || '사이트맵 파일 실패';
          sitemapState.childIndex += 1;
          sitemapState.cursor = 0;
          continue;
        }

        const locs = result.locs || [];
        sitemapState.scanned += locs.length;

        let consumed = 0;
        for (; consumed < locs.length && added < batch; consumed++) {
          const entry = entryFromPath(pathFromUrl(locs[consumed]));
          if (!entry || entry.t !== kind) continue;
          if (enqueueEntry(entry)) added += 1;
        }
        sitemapState.cursor += consumed;

        const total = Number(result.total) || 0;
        if (locs.length === 0 || (total > 0 && sitemapState.cursor >= total)) {
          sitemapState.childIndex += 1;
          sitemapState.cursor = 0;
        }
      }
    } catch (error) {
      sitemapState.error = errorMessage(error);
      sitemapState.active = false;
    } finally {
      refilling = false;
    }

    sitemapState.queued += added;
    updatePanel();
    return added;
  }

  async function seedSitemap() {
    const kinds = selectedSitemapKinds();
    if (kinds.length === 0) {
      toast('❌ 사이트맵에서 [영화]/[TV]/[인물] 중 하나를 선택하세요.', 'error');
      return { ok: false };
    }
    if (kinds.indexOf('person') !== -1 && !peopleEnabled()) {
      toast('❌ 인물 사이트맵은 [배우] 또는 [감독] 수집을 켜야 합니다.', 'error');
      return { ok: false };
    }
    if (kinds.indexOf('movie') !== -1 || kinds.indexOf('tv') !== -1) {
      if (!titleSaveEnabled('movie') && !titleSaveEnabled('tv') && !peopleEnabled()) {
        toast('❌ 사이트맵을 쓰려면 [영화]/[TV]/[배우]/[감독] 중 하나를 선택하세요.', 'error');
        return { ok: false };
      }
    }

    sitemapState.active = true;
    sitemapState.done = false;
    sitemapState.kinds = kinds;
    sitemapState.kindIndex = 0;
    sitemapState.kind = '';
    sitemapState.children = [];
    sitemapState.childIndex = 0;
    sitemapState.cursor = 0;
    sitemapState.fileCount = 0;
    sitemapState.queued = 0;
    sitemapState.scanned = 0;
    sitemapState.error = '';

    const added = await fillFromSitemap(sitemapBatchSize());
    await saveState(true);
    updatePanel();

    if (added > 0) {
      toast('🗺 사이트맵에서 ' + added + '개를 큐에 추가했습니다.');
    } else {
      toast('❌ 사이트맵에서 추가할 항목을 찾지 못했습니다: ' + (sitemapState.error || '결과 없음'), 'error');
    }
    return { ok: added > 0, added: added, error: sitemapState.error };
  }

  /* ------------------------------------------------------------------ */
  /* 다운로드                                                            */
  /* ------------------------------------------------------------------ */
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function downloadJsonFallback(json, filename) {
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = String(filename).replace(/[\\/]/g, '_');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return String(filename).replace(/[\\/]/g, '_');
    } catch (error) {
      console.warn('[crawler] 폴백 다운로드 실패:', error);
      return null;
    }
  }

  // background에서 받은 다운로드 id로 실제 저장 완료 여부를 확인한다(파일 확인 수 집계용)
  function verifyDownload(id) {
    if (!id) return Promise.resolve('');
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action: 'crawlerVerifyDownload', id: id }, response => {
          if (chrome.runtime.lastError) {
            resolve('');
            return;
          }
          resolve((response && response.state) || '');
        });
      } catch (e) {
        resolve('');
      }
    });
  }

  async function trackDownload(id, filename) {
    if (!id) {
      state.stats.unconfirmed += 1;
      return;
    }
    for (let i = 0; i < 4; i++) {
      const downloadState = await verifyDownload(id);
      if (downloadState === 'complete') {
        state.stats.confirmed += 1;
        log('파일 확인', filename);
        return;
      }
      if (downloadState === 'interrupted' || downloadState === 'missing') break;
      await sleep(400);
    }
    state.stats.unconfirmed += 1;
    log('파일 미확인', filename);
  }

  function sendDownload(text, filename, mime, forceOverwrite) {
    return new Promise(resolve => {
      try {
        const type = mime || 'application/json';
        const dataUrl = 'data:' + type + ';charset=utf-8;base64,' + toBase64(text);
        chrome.runtime.sendMessage({
          action: 'crawlerDownload',
          dataUrl: dataUrl,
          filename: filename,
          overwrite: forceOverwrite === true ? true : settings.overwrite !== false
        }, response => {
          const result = chrome.runtime.lastError
            ? { ok: false, error: chrome.runtime.lastError.message }
            : (response || { ok: false, error: '다운로드 응답 없음' });
          resolve(result);
        });
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
    });
  }

  async function downloadText(text, filename, mime, forceOverwrite) {
    const result = await sendDownload(text, filename, mime, forceOverwrite);
    if (result.ok || result.skipped) return result;

    const saved = downloadJsonFallback(text, filename);
    if (saved) return { ok: true, fallback: true, filename: saved };
    return result;
  }

  function downloadJson(json, filename) {
    return downloadText(json, filename, 'application/json');
  }

  /* ------------------------------------------------------------------ */
  /* 이미지 저장 (선택)                                                   */
  /* ------------------------------------------------------------------ */
  function titleSlugFor(payload, fallback) {
    const raw = String((payload && (payload.title || payload.name)) || fallback || '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    return raw.slice(0, 80) || 'image';
  }

  function imageExtension(url) {
    try {
      const match = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif)$/i);
      return match ? '.' + match[1].toLowerCase().replace('jpeg', 'jpg') : '.jpg';
    } catch (e) {
      return '.jpg';
    }
  }

  // JSON에 들어 있는 표시용 포스터/배경 + 인물 프로필만 대상으로 한다(원본/고해상도 제외)
  function imagesForPayload(payload) {
    const rows = [];
    const add = (list, kind) => {
      (Array.isArray(list) ? list : []).forEach(item => {
        const url = String((item && item.url) || item || '');
        if (/^https:\/\/(media|image)\.themoviedb\.org\//.test(url)) rows.push({ url: url, kind: kind });
      });
    };
    add(payload && payload.images ? payload.images.posters : null, 'poster');
    add(payload && payload.images ? payload.images.backdrops : null, 'backdrop');
    const profile = payload && (payload.profileImage_high || payload.profileImage);
    if (profile) rows.push({ url: profile, kind: 'profile' });
    return rows;
  }

  function sendImage(url, filename) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({
          action: 'crawlerImage',
          url: url,
          filename: filename,
          overwrite: settings.overwrite !== false
        }, response => {
          const result = chrome.runtime.lastError
            ? { ok: false, error: chrome.runtime.lastError.message }
            : (response || { ok: false, error: '이미지 응답 없음' });
          resolve(result);
        });
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
    });
  }

  // JSON과 같은 이름의 폴더에 제목 기반 파일명으로 저장한다(작품별로 섞이지 않음)
  async function saveImages(payload, baseName) {
    const rows = imagesForPayload(payload);
    if (!rows.length) return { saved: 0, failed: 0 };

    const folder = safeFolder() + '/' + baseName;
    const title = titleSlugFor(payload, baseName);
    const seen = {};
    const counters = {};
    let saved = 0;
    let failed = 0;

    for (const row of rows) {
      let name = '';
      try {
        name = new URL(row.url).pathname.split('/').pop() || '';
      } catch (e) { name = ''; }
      if (!name || seen[name]) continue;
      seen[name] = true;

      counters[row.kind] = (counters[row.kind] || 0) + 1;
      const suffix = String(counters[row.kind]).padStart(3, '0');
      const filename = folder + '/' + title + '-' + row.kind + '-' + suffix + imageExtension(row.url);
      const result = await sendImage(row.url, filename);
      if (result && result.ok) saved += 1;
      else failed += 1;
    }

    log('이미지 저장', saved + '개' + (failed ? ' · 실패 ' + failed + '개' : '') + ' → ' + folder + '/');
    return { saved: saved, failed: failed };
  }

  function logFileName() {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    return safeFolder() + '/crawl-log-' + stamp + '.log';
  }

  async function downloadLog(silent) {
    if (!state.logs.length) {
      if (!silent) toast('❌ 저장할 로그가 없습니다.', 'error');
      return { ok: false };
    }

    const header = [
      '# TMDB 크롤러 작업 로그',
      '# 시작: ' + (state.startedAt || '-'),
      '# 내보낸 시각: ' + new Date().toISOString(),
      '# 대상: ' + JSON.stringify(settings.targets || {}),
      '# 설정: ' + JSON.stringify(settings),
      '# 통계: ' + JSON.stringify(state.stats),
      '# 대기열: ' + state.queue.length + '개',
      ''
    ].join('\n');

    const filename = logFileName();
    const result = await downloadText(header + state.logs.join('\n') + '\n', filename, 'text/plain', true);
    if (!silent) toast(result.ok ? '📝 ' + filename + ' 저장 완료' : '❌ 로그 저장 실패', result.ok ? 'success' : 'error');
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 파일명                                                              */
  /* ------------------------------------------------------------------ */
  function pathSlug(path, target) {
    const match = String(path || '').match(new RegExp('^/' + target.t + '/' + target.id + '([^/?#]*)'));
    return match ? match[1].replace(/^[-/]+/, '') : '';
  }

  // movie-1368337-the-odyssey / person-1892-matt-damon / tv-1399-game-of-thrones
  function fileBaseNameFor(path, target, fallbackPath) {
    const slug = pathSlug(path, target) || pathSlug(fallbackPath, target);
    const base = target.t + '-' + target.id + (slug ? '-' + slug : '');
    const cleaned = base.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned || target.t + '-' + target.id).slice(0, 120);
  }

  function fileBaseName(target, entry) {
    return fileBaseNameFor(location.pathname, target, entry && entry.url);
  }

  /* ------------------------------------------------------------------ */
  /* 하단 지연 로딩 대비                                                 */
  /* ------------------------------------------------------------------ */
  async function waitFor(check, timeoutMs, intervalMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (check()) return true;
      } catch (e) {}
      await sleep(intervalMs || 250);
    }
    return false;
  }

  function sprinkleMouse() {
    try {
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: randInt(40, Math.max(80, window.innerWidth - 40)),
        clientY: randInt(60, Math.max(120, window.innerHeight - 60))
      }));
    } catch (e) {}
  }

  async function humanScroll(human) {
    const steps = human ? randInt(3, 7) : 2;
    let lastHeight = 0;

    for (let step = 0; step < steps; step++) {
      const height = document.documentElement.scrollHeight || document.body.scrollHeight || 0;
      const viewport = window.innerHeight || 800;
      const remaining = height - window.scrollY - viewport;
      const delta = remaining > 0 ? Math.min(remaining, randInt(viewport * 0.5, viewport * 1.4)) : viewport * 0.5;

      window.scrollBy({ top: delta, behavior: human ? 'smooth' : 'auto' });
      if (human) {
        sprinkleMouse();
        await sleep(randInt(220, 700));
      } else {
        await sleep(120);
      }

      if (height === lastHeight && remaining <= 0) break;
      lastHeight = height;
    }

    // 지연 로딩으로 높이가 늘어날 수 있으니 두 번 연속 같을 때까지 기다린다
    for (let i = 0; i < 4; i++) {
      const height = document.documentElement.scrollHeight;
      await sleep(human ? randInt(320, 760) : 120);
      if (document.documentElement.scrollHeight === height) break;
    }
  }

  async function promoteLazyImages() {
    const images = Array.from(document.querySelectorAll('img[data-src], img[data-srcset], img[loading="lazy"]')).slice(0, 120);
    const pending = [];

    images.forEach(img => {
      const src = img.getAttribute('data-src');
      const srcset = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
      try {
        if (srcset) img.setAttribute('srcset', srcset);
        if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.removeAttribute('loading');
      } catch (e) {}

      if (!img.complete) {
        pending.push(new Promise(resolve => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          img.addEventListener('load', finish, { once: true });
          img.addEventListener('error', finish, { once: true });
          setTimeout(finish, 1500);
        }));
      }
    });

    if (pending.length > 0) {
      await Promise.race([Promise.all(pending), sleep(4000)]);
    }
    return images.length;
  }

  function expandBiography() {
    try {
      const links = Array.from(document.querySelectorAll('.biography a, .overview a, .header a'));
      const more = links.find(link => /read more|더 보기|자세히|more/i.test(link.textContent || '') && !link.getAttribute('href'));
      if (more) more.click();
    } catch (e) {}
  }

  async function preparePage(target) {
    const human = settings.humanize !== false;

    await waitFor(() => {
      if (document.readyState !== 'complete') return false;
      const need = target && target.t === 'person'
        ? '.facts, .biography, #known_for, .title h2'
        : '.facts, .overview, #original_header, .title h2';
      return !!document.querySelector(need);
    }, 12000, 250);

    await humanScroll(human);
    const promoted = await promoteLazyImages();
    if (target && target.t === 'person') expandBiography();
    try {
      window.scrollTo(0, 0);
    } catch (e) {}
    await sleep(human ? randInt(300, 900) : 100);
    return promoted;
  }

  /* ------------------------------------------------------------------ */
  /* 사람처럼                                                                 */
  /* ------------------------------------------------------------------ */
  function delayRange() {
    let min = Number(settings.minDelayMs);
    let max = Number(settings.maxDelayMs);
    if (!isFinite(min) || min < 1000) min = 3000;
    if (!isFinite(max) || max < min) max = Math.max(min, 7000);
    return { min: Math.min(min, 120000), max: Math.min(max, 180000) };
  }

  function readingPause() {
    const length = (document.body && document.body.innerText ? document.body.innerText.length : 4000);
    return Math.min(8000, Math.max(2000, Math.round(length / 450) * 1000));
  }

  function pageDelay() {
    const range = delayRange();
    let wait = randInt(range.min, range.max);
    if (settings.readDelay !== false) wait += jitter(readingPause());
    return wait;
  }

  function applyPacing(api) {
    const target = api || ext();
    if (target && target.setPacing) {
      target.setPacing({
        minMs: Number(settings.subpageMinMs) || 700,
        maxMs: Number(settings.subpageMaxMs) || 1800
      });
    }
  }

  async function humanNudge() {
    if (settings.humanize === false) return;
    const y = window.scrollY || 0;
    try {
      window.scrollBy({ top: randInt(80, 260) * (Math.random() < 0.3 ? -1 : 1), behavior: 'smooth' });
      sprinkleMouse();
      await sleep(randInt(200, 700));
      window.scrollTo(0, y);
    } catch (e) {}
  }

  function maybeBreak() {
    if (settings.humanize === false) return false;

    state.pagesSinceBreak = (Number(state.pagesSinceBreak) || 0) + 1;
    const min = Math.max(1, Number(settings.breakEveryMin) || 40);
    const max = Math.max(min, Number(settings.breakEveryMax) || 90);
    const threshold = Number(state.breakAfter) || randInt(min, max);

    if (state.pagesSinceBreak < threshold) return false;

    state.pagesSinceBreak = 0;
    state.breakAfter = randInt(min, max);
    const seconds = randInt(Math.max(10, Number(settings.breakMinSec) || 120), Math.max(30, Number(settings.breakMaxSec) || 300));
    state.breakUntil = Date.now() + seconds * 1000;

    saveState(true);
    updatePanel();
    toast('☕ 사람처럼 ' + seconds + '초 쉬어갑니다.');
    schedule(seconds * 1000);
    return true;
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = value => String(value).padStart(2, '0');
    return pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  }

  /* 크롤링 시계: 실제 처리 중일 때만 흐르고, 대기 중에는 멈춘다 */
  function crawlClockOn() {
    if (state.crawlSince) return;
    state.crawlSince = Date.now();
  }

  function crawlClockOff() {
    if (!state.crawlSince) return;
    state.crawlMs = (Number(state.crawlMs) || 0) + Math.max(0, Date.now() - state.crawlSince);
    state.crawlSince = 0;
  }

  function crawlTimeMs() {
    const banked = Number(state.crawlMs) || 0;
    const live = state.crawlSince ? Math.max(0, Date.now() - state.crawlSince) : 0;
    return banked + live;
  }

  /* ------------------------------------------------------------------ */
  /* 페이지 처리                                                         */
  /* ------------------------------------------------------------------ */
  function personAllowed(payload) {
    const targets = settings.targets || {};
    if (targets.cast && targets.director) return true;

    const credits = (payload && payload.credits && Array.isArray(payload.credits.all)) ? payload.credits.all : [];
    const hasActing = credits.some(credit => credit && credit.department === 'Acting');
    const hasDirecting = credits.some(credit => credit && credit.department === 'Directing')
      || /감독|director/i.test((payload && payload.knownFor) || '');

    if (targets.director && !targets.cast) return hasDirecting;
    if (targets.cast && !targets.director) return hasActing;
    return false;
  }

  // 0은 "무제한", 그 외에는 1~MAX_PEOPLE_PER_TITLE로 자른다
  function clampPeoplePerTitle(value) {
    const number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    return Math.min(MAX_PEOPLE_PER_TITLE, Math.round(number));
  }

  function peoplePerTitleLimit() {
    return clampPeoplePerTitle(settings.peoplePerTitle);
  }

  // 인물 링크를 큐에 넣고, 한도 때문에 넣지 못한 수를 함께 돌려준다
  function enqueuePersonLinks(list, role, limit) {
    const entries = Array.isArray(list) ? list : [];
    let added = 0;
    let skipped = 0;

    for (let i = 0; i < entries.length; i++) {
      if (limit > 0 && added >= limit) {
        skipped = entries.length - i;
        break;
      }
      const entry = Object.assign({}, entries[i], { role: role });
      if (enqueueEntry(entry)) added += 1;
      else if (queuedUrls.has(entry.url)) mergeRole(entry);
    }

    return { added: added, skipped: skipped };
  }

  async function enqueuePeopleLinks(target) {
    if (!peopleEnabled()) return 0;
    const api = ext();
    if (!api.fetchCreditLinks) return 0;

    try {
      // 저장 단계에서 이미 /cast 문서를 캐시했다면 추가 요청이 없다
      const links = await api.fetchCreditLinks('/' + target.t + '/' + target.id);
      const limit = peoplePerTitleLimit();
      const empty = { added: 0, skipped: 0 };
      const cast = settings.targets.cast ? enqueuePersonLinks(links.cast, 'cast', limit) : empty;
      const directors = settings.targets.director ? enqueuePersonLinks(links.directors, 'director', limit) : empty;

      const added = cast.added + directors.added;
      const skipped = cast.skipped + directors.skipped;
      if (added > 0 || skipped > 0) {
        log('인물 큐', '배우 +' + cast.added + ' · 감독 +' + directors.added
          + ' · 한도 초과 ' + skipped + '명 (' + (limit > 0 ? '작품당 최대 ' + limit + '명' : '무제한') + ')');
      }
      return added;
    } catch (error) {
      console.warn('[crawler] 인물 링크 수집 실패:', error);
      log('인물 큐 실패', errorMessage(error));
      return 0;
    }
  }

  async function savePayload(target, entry, payload) {
    const json = JSON.stringify(payload);
    const filename = safeFolder() + '/' + fileBaseName(target, entry) + '.json';
    const result = await downloadText(json, filename, 'application/json');

    // 덮어쓰기 꺼짐 + 이미 저장한 파일 → 건너뛴다
    if (result.skipped) {
      state.stats.duplicates += 1;
      markVisited(target);
      log('중복 건너뜀', filename);
      return { skipped: true, filename: filename };
    }

    if (!result.ok) throw new Error(result.error || '다운로드 실패');

    state.stats.done += 1;
    if (!state.stats.byType) state.stats.byType = { movie: 0, tv: 0, person: 0 };
    state.stats.byType[target.t] = (Number(state.stats.byType[target.t]) || 0) + 1;

    await trackDownload(result.id, filename);

    state.records.push({
      type: target.t,
      id: target.id,
      title: payload.title || payload.name || '',
      file: filename,
      role: entry.role || target.t,
      at: new Date().toISOString()
    });
    if (state.records.length > MAX_RECORDS) state.records = state.records.slice(-MAX_RECORDS);
    log('저장 완료', filename + (result.fallback ? ' (폴백)' : ''));
    markVisited(target);

    if (settings.saveImages === true) {
      try {
        await saveImages(payload, fileBaseName(target, entry));
      } catch (error) {
        log('이미지 저장 실패', errorMessage(error));
      }
    }
    return payload;
  }

  async function processEntry(entry, target) {
    const api = ext();
    if (!api.extractMediaData || !api.extractPersonData) {
      throw new Error('추출 함수를 찾지 못했습니다(content.js 로드 실패)');
    }

    applyPacing(api);
    const force = entry.force === true;

    await preparePage(target);

    if (target.t === 'person') {
      const person = api.extractPersonData();
      if (!force && !personAllowed(person)) {
        markVisited(target);
        state.stats.skipped += 1;
        setStatus('대상 아님: 인물 ' + target.id);
        return null;
      }

      const savedPerson = await savePayload(target, entry, person);
      if (settings.collectFilmography) collectDetailLinks().forEach(link => enqueueEntry(link));
      autoFollowLinks();
      return savedPerson;
    }

    if (entry.save === false && !force) {
      // 제목은 저장하지 않고 인물(배우/감독) 탐색에만 사용한다
      if (peopleEnabled()) await enqueuePeopleLinks(target);
      markVisited(target);
      state.stats.skipped += 1;
      log('탐색 전용', target.type + ' ' + target.id);
      autoFollowLinks();
      setStatus('탐색 완료: ' + target.type + ' ' + target.id);
      return null;
    }

    const payload = await api.extractMediaData({
      galleries: true,
      cast: true,
      videos: true,
      releases: true,
      wikidata: true,
      allLanguages: settings.allLanguages === true
    });

    const saved = await savePayload(target, entry, payload);

    if (peopleEnabled()) await enqueuePeopleLinks(target);
    autoFollowLinks();
    return saved;
  }

  async function processListPage() {
    state.listPages += 1;
    log('목록 페이지', location.pathname + location.search);
    collectDetailLinks().forEach(entry => enqueueEntry(entry));

    const maxListPages = Math.max(1, Number(settings.maxListPages) || 300);
    if (settings.followLists && state.listPages < maxListPages) {
      const next = nextPageUrl();
      if (next) enqueueList(next, false);
    }
    return { type: 'list' };
  }

  function markVisited(entry) {
    if (!entry || entry.t === 'list') return;
    const key = keyOf(entry);
    if (visited.has(key)) return;

    visited.add(key);
    recentVisited.push(key);
    if (recentVisited.length > VISITED_SAVE_LIMIT) recentVisited.shift();
    if (visited.size > VISITED_MEMORY_LIMIT) {
      const oldest = visited.values().next().value;
      visited.delete(oldest);
    }
  }

  function isVisited(entry) {
    return entry.t !== 'list' && visited.has(keyOf(entry));
  }

  function dropVisitedHead() {
    let guard = 0;
    while (state.queue.length > 0 && guard < 200) {
      guard += 1;
      if (!isVisited(state.queue[0])) break;
      queueShift();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 실행 엔진                                                           */
  /* ------------------------------------------------------------------ */
  function setStatus(text) {
    if (els.state) els.state.textContent = text;
  }

  // 자동 링크 보충: 큐가 거의 빈 경우에만 소량 추가해 추천/출연 링크로 큐가 부풀지 않게 한다.
  // 임계값과 개수는 설정(autoFollowQueue / autoFollowLimit)에서 조정한다.
  function settingNumber(value, fallback, min, max) {
    // 빈 입력/숫자가 아니면 기본값으로 되돌린다(0은 유효한 값으로 인정)
    if (value === '' || value === null || value === undefined) return fallback;
    const number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  function autoFollowConfig() {
    return {
      threshold: settingNumber(settings.autoFollowQueue, 5, 0, 200),
      limit: settingNumber(settings.autoFollowLimit, 8, 1, 50)
    };
  }

  function autoFollowLinks() {
    if (settings.autoFollow === false) return 0;

    const { threshold, limit } = autoFollowConfig();
    if (state.queue.length > threshold) return 0;

    // 현재 페이지와 같은 종류를 먼저 채우고(작품→작품, 인물→필모), 나머지는 뒤로 둔다
    const type = (pageTarget() || {}).t || '';
    const links = collectDetailLinks();
    const ordered = type
      ? links.filter(link => link.t === type).concat(links.filter(link => link.t !== type))
      : links;

    let added = 0;
    for (let i = 0; i < ordered.length && added < limit; i++) {
      if (enqueueEntry(ordered[i])) added += 1;
    }

    log('큐 보충', (added > 0 ? '+' + added + '개' : '추가 없음')
      + ' · 큐 ' + state.queue.length + '개 (기준 ' + threshold + ' 이하, 최대 ' + limit + '개)');
    return added;
  }

  function statusText() {
    if (!state.active) return '대기';
    if (state.paused) return '일시정지';
    if (state.cooldownUntil > Date.now()) return '한도 대기 ' + formatCountdown(state.cooldownUntil - Date.now());
    if (state.breakUntil > Date.now()) return '휴식 ' + formatCountdown(state.breakUntil - Date.now());
    if (busy) return '처리 중';
    return '실행 중';
  }

  function sitemapText() {
    if (!sitemapState.active && !sitemapState.queued) return sitemapState.done ? '완료' : '대기';
    if (sitemapState.error) return '오류: ' + sitemapState.error.slice(0, 48);
    const files = sitemapState.fileCount || sitemapState.children.length || 0;
    const newestFirst = settings.newestFirst === true;
    const progress = newestFirst ? files - sitemapState.childIndex : sitemapState.childIndex + 1;
    const current = files ? Math.max(1, Math.min(progress, files)) : 0;
    const kind = sitemapState.kind || (sitemapState.kinds || [])[sitemapState.kindIndex] || '-';
    return kind + (newestFirst ? ' (최신순)' : '') + ' ' + current + '/' + files + ' · 누적 ' + sitemapState.queued;
  }

  function updatePanel() {
    if (!panel || !els.queue) return;
    const byType = state.stats.byType || { movie: 0, tv: 0, person: 0 };

    els.queue.textContent = state.queue.length;
    els.done.textContent = state.stats.done + ' / ' + state.stats.failed;
    els.types.textContent = '영화 ' + (byType.movie || 0) + ' · TV ' + (byType.tv || 0) + ' · 인물 ' + (byType.person || 0);
    els.lists.textContent = state.listPages;
    els.sitemap.textContent = sitemapText();
    els.state.textContent = statusText();

    if (els.elapsed) els.elapsed.textContent = formatElapsed(crawlTimeMs());
    if (els.confirm) {
      els.confirm.textContent = '확인 ' + (Number(state.stats.confirmed) || 0)
        + ' · 미확인 ' + (Number(state.stats.unconfirmed) || 0)
        + ' · 중복 ' + (Number(state.stats.duplicates) || 0);
    }

    const head = state.queue[0];
    els.next.textContent = head ? '다음: ' + head.url : '다음: (없음)';

    if (els.logText && logRenderedRevision !== logRevision) {
      logRenderedRevision = logRevision;
      els.logText.textContent = state.logs.slice(-40).join('\n') || '(로그 없음)';
    }
  }

  function finish(message) {
    state.active = false;
    state.paused = false;
    crawlClockOff();
    log('종료', message || '');
    saveState(true).then(updatePanel);
    if (message) toast('🏁 ' + message);
    setStatus('대기');
    if (settings.autoLog !== false) downloadLog(true);
  }

  function schedule(ms) {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      navTimer = null;
      tick();
    }, Math.max(0, ms));
  }

  function navigateTo(url, wait) {
    const target = withLanguage(url);
    if (samePath(target)) {
      schedule(Math.max(300, wait));
      return;
    }

    log('다음 이동 예약', Math.round(wait / 1000) + 's 후 ' + target);
    setStatus('이동 대기 ' + Math.max(1, Math.round(wait / 1000)) + 's: ' + target);
    if (navTimer && navUrl === target) return;

    navUrl = target;
    clearTimeout(navTimer);
    navTimer = setTimeout(async () => {
      navTimer = null;
      navUrl = '';
      if (!state.active || state.paused) return;
      if (state.breakUntil > Date.now()) {
        schedule(state.breakUntil - Date.now());
        return;
      }
      if (busy) {
        schedule(1000);
        return;
      }
      await humanNudge();
      crawlClockOff();
      await saveState(true);
      navigating = true;
      log('이동', target);
      location.assign(new URL(target, location.origin).href);
    }, Math.max(500, wait));
  }

  function scheduleAfterPage() {
    if (maybeBreak()) return;

    let head = state.queue[0];
    if (!head) {
      // 큐가 비어도 링크를 따라 이어서 계속한다(연속 작업)
      const added = autoFollowLinks();
      if (added > 0) {
        saveState(true);
        updatePanel();
        head = state.queue[0];
      }
    }
    if (!head) {
      finish('대기열이 비었습니다');
      return;
    }
    const wait = pageDelay();
    if (head.t === 'list' && samePath(head.url)) {
      schedule(wait);
      return;
    }
    navigateTo(head.url, wait);
  }

  function handleFailure(error, target) {
    const message = errorMessage(error);
    state.stats.failed += 1;
    state.stats.lastError = message;
    if (target) markVisited(target);
    console.warn('[crawler] 추출 실패:', target, error);

    log('실패', (target ? target.type + ' ' + target.id + ' → ' : '') + message);

    if (/429|한도/.test(message)) {
      state.cooldownUntil = Date.now() + 5 * 60 * 1000;
      toast('⏳ 요청 한도에 걸렸습니다. 5분 대기합니다.', 'error');
    }
    setStatus('실패: ' + (target ? target.type + ' ' + target.id : message));
  }

  async function tick() {
    if (busy) {
      schedule(1000);
      return;
    }
    if (!state.active || state.paused) {
      updatePanel();
      return;
    }

    if (state.breakUntil) {
      const left = state.breakUntil - Date.now();
      if (left > 0) {
        updatePanel();
        schedule(left);
        return;
      }
      state.breakUntil = 0;
    }

    if (navigating) {
      updatePanel();
      return;
    }

    if (state.cooldownUntil) {
      const left = state.cooldownUntil - Date.now();
      if (left > 0) {
        updatePanel();
        schedule(left);
        return;
      }
      state.cooldownUntil = 0;
    }

    busy = true;
    crawlClockOn();
    updatePanel();

    try {
      dropVisitedHead();
      await refillIfNeeded(false);

      let head = state.queue[0];
      if (!head) {
        const added = autoFollowLinks();
        if (added > 0) head = state.queue[0];
        if (!head) {
          busy = false;
          finish('대기열이 비었습니다');
          return;
        }
      }

      const target = pageTarget();

      if (target && head.t !== 'list' && head.t === target.t && String(head.id) === String(target.id)) {
        queueShift();
        try {
          await processEntry(head, target);
          setStatus('저장 완료: ' + target.type + ' ' + target.id);
        } catch (error) {
          handleFailure(error, target);
        }
        await saveState(true);
        busy = false;
        scheduleAfterPage();
        return;
      }

      if (!target && head.t === 'list' && samePath(head.url)) {
        queueShift();
        await preparePage(null);
        await processListPage();
        await saveState(true);
        busy = false;
        scheduleAfterPage();
        return;
      }

      busy = false;
      navigateTo(head.url, pageDelay());
    } catch (error) {
      busy = false;
      console.warn('[crawler] 처리 중 오류:', error);
      setStatus('오류: ' + errorMessage(error));
      schedule(3000);
    } finally {
      crawlClockOff();
    }
  }

  async function startCrawl(seedCurrent) {
    if (seedCurrent) seedCurrentPage(true, false);

    // 새로 시작하면 실행 시간을 새로 잰다(이어서 시작할 때는 유지)
    const resuming = state.active || state.paused;
    state.active = true;
    state.paused = false;
    navigating = false;
    if (!resuming || !state.startedAt) {
      state.startedAt = new Date().toISOString();
      state.crawlMs = 0;
    }
    state.crawlSince = 0;
    log('시작', '대기열 ' + state.queue.length + '개');
    if (!state.breakAfter) state.breakAfter = randInt(settings.breakEveryMin, settings.breakEveryMax);

    applyPacing();
    await saveSettings();
    await saveState(true);
    updatePanel();
    setStatus('워밍업');
    schedule(randInt(2000, 6000));
    return { ok: true, queue: state.queue.length };
  }

  async function togglePause() {
    if (!state.active) return startCrawl(true);
    state.paused = !state.paused;
    log(state.paused ? '일시정지' : '재개');
    if (state.paused) {
      clearTimeout(navTimer);
      navTimer = null;
      navUrl = '';
      navigating = false;
      crawlClockOff();
    }
    await saveState(true);
    updatePanel();
    setStatus(state.paused ? '일시정지' : '실행 중');
    if (!state.paused) schedule(800);
    return { ok: true, paused: state.paused };
  }

  async function stopCrawl() {
    state.active = false;
    state.paused = false;
    navigating = false;
    crawlClockOff();
    clearTimeout(navTimer);
    navTimer = null;
    navUrl = '';
    log('중지', '완료 ' + state.stats.done + ' · 실패 ' + state.stats.failed);
    await saveState(true);
    updatePanel();
    setStatus('정지');
    if (settings.autoLog !== false) downloadLog(true);
    return { ok: true };
  }

  function seedCurrentPage(front, force) {
    const target = pageTarget();
    if (target) {
      const entry = { t: target.t, id: target.id, url: target.url, role: target.t === 'person' ? 'person' : '' };
      const added = enqueueEntry(entry, { force: force === true });
      if (added && front) {
        const last = state.queue.pop();
        if (last) state.queue.unshift(last);
      }
      return added;
    }
    if (isListPage()) return enqueueList(location.pathname + location.search, front);
    return false;
  }

  async function seedCurrent() {
    const added = seedCurrentPage(false, true);
    await saveState(true);
    updatePanel();
    toast(added ? '➕ 현재 페이지를 대기열에 추가했습니다.' : '이미 대기열에 있거나 추가할 수 없는 페이지입니다.', added ? 'success' : 'error');
    return { ok: added };
  }

  async function saveCurrentOnly() {
    const target = pageTarget();
    if (!target) {
      toast('❌ 영화/TV/인물 상세 페이지에서만 저장할 수 있습니다.', 'error');
      return { ok: false };
    }
    setStatus('현재 페이지 저장 중');
    crawlClockOn();
    try {
      const entry = { t: target.t, id: target.id, url: target.url, role: target.t === 'person' ? 'person' : '', save: true, force: true };
      await processEntry(entry, target);
      await saveState(true);
      updatePanel();
      toast('💾 ' + safeFolder() + '/' + fileBaseName(target, entry) + '.json 저장 완료', 'success');
      return { ok: true };
    } catch (error) {
      state.stats.failed += 1;
      updatePanel();
      toast('❌ 저장 실패: ' + errorMessage(error), 'error');
      return { ok: false, error: String(error) };
    } finally {
      crawlClockOff();
    }
  }

  async function clearQueue() {
    state.queue = [];
    queuedUrls.clear();
    sitemapState.active = false;
    sitemapState.done = false;
    sitemapState.children = [];
    sitemapState.error = '';
    await saveState(true);
    updatePanel();
    toast('🧹 대기열과 사이트맵 진행을 비웠습니다.');
    return { ok: true };
  }

  async function exportSettings() {
    const payload = {
      app: 'tmdb-json-extractor',
      kind: 'crawler-settings',
      schemaVersion: '1.7',
      savedAt: new Date().toISOString(),
      settings: settings
    };
    const filename = safeFolder() + '/crawler-settings.json';
    const result = await downloadText(JSON.stringify(payload, null, 2), filename, 'application/json', true);
    log('설정 저장', filename);
    toast(result.ok ? '⚙ ' + filename + ' 저장 완료' : '❌ 설정 저장 실패', result.ok ? 'success' : 'error');
    return result;
  }

  function normalizeSettings(raw) {
    const next = Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === 'object') ? raw : {});
    next._v = DEFAULT_SETTINGS._v;
    next.language = normalizeLanguage(next.language);
    next.targets = Object.assign({}, DEFAULT_SETTINGS.targets, (raw && raw.targets) || {});
    next.sitemapKinds = Object.assign({}, DEFAULT_SETTINGS.sitemapKinds, (raw && raw.sitemapKinds) || {});
    if (!next.folder) next.folder = DEFAULT_SETTINGS.folder;
    next.peoplePerTitle = clampPeoplePerTitle(next.peoplePerTitle);
    return next;
  }

  async function importSettings(file) {
    if (!file) return { ok: false };
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const raw = (parsed && parsed.settings) ? parsed.settings : parsed;
      settings = normalizeSettings(raw);
      await saveSettings();
      pruneQueue();
      applyPacing();
      syncSettingsInputs();
      updatePanel();
      log('설정 불러오기', file.name || 'settings.json');
      toast('⚙ 설정을 불러왔습니다: ' + (file.name || 'settings.json'));
      return { ok: true };
    } catch (error) {
      log('설정 불러오기 실패', errorMessage(error));
      toast('❌ 설정 불러오기 실패: ' + errorMessage(error), 'error');
      return { ok: false, error: String(error) };
    }
  }

  async function exportIndex() {
    const index = {
      schemaVersion: '1.7',
      exportedAt: new Date().toISOString(),
      startedAt: state.startedAt,
      elapsed: formatElapsed(crawlTimeMs()),
      settings: settings,
      targets: settings.targets,
      stats: state.stats,
      listPages: state.listPages,
      sitemap: {
        kinds: sitemapState.kinds,
        kind: sitemapState.kind,
        childIndex: sitemapState.childIndex,
        fileCount: sitemapState.fileCount,
        queued: sitemapState.queued,
        scanned: sitemapState.scanned,
        done: sitemapState.done,
        error: sitemapState.error
      },
      total: state.records.length,
      logs: state.logs.slice(-LOG_SAVE_LIMIT),
      records: state.records
    };
    const indexFile = safeFolder() + '/index.json';
    const result = await downloadJson(JSON.stringify(index, null, 2), indexFile);
    toast(result.ok ? '📑 ' + indexFile + ' 내보내기 완료' : '❌ 인덱스 내보내기 실패', result.ok ? 'success' : 'error');
    return result;
  }

  function pruneQueue() {
    if (sitemapState.active && !sitemapState.kinds.some(kindUsable)) {
      sitemapState.active = false;
      sitemapState.error = '수집 대상이 꺼져 사이트맵을 중지했습니다';
    }

    state.queue = state.queue.filter(entry => {
      if (entry.t === 'list') return true;
      if (entry.t === 'person') return peopleEnabled();
      if (!titleSaveEnabled(entry.t)) {
        entry.save = false;
        return peopleEnabled();
      }
      entry.save = true;
      return true;
    });
    queuedUrls.clear();
    state.queue.forEach(entry => queuedUrls.add(entry.url));
  }

  /* ------------------------------------------------------------------ */
  /* 패널 UI                                                             */
  /* ------------------------------------------------------------------ */
  function buildPanel() {
    if (document.getElementById('tmdb-crawler-panel')) {
      panel = document.getElementById('tmdb-crawler-panel');
      cacheEls();
      return;
    }

    panel = document.createElement('div');
    panel.id = 'tmdb-crawler-panel';
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'top:80px', 'width:322px',
      'background:rgba(18,18,28,.76)', 'color:#e9e9f2', 'border:1px solid rgba(60,60,90,.7)',
      'border-radius:12px', 'box-shadow:0 12px 36px rgba(0,0,0,.45)',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
      'z-index:2147483000', 'padding:0', 'overflow:hidden',
      'backdrop-filter:blur(10px) saturate(140%)', '-webkit-backdrop-filter:blur(10px) saturate(140%)'
    ].join(';');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:rgba(27,27,43,.62);border-bottom:1px solid rgba(60,60,90,.6);backdrop-filter:blur(6px)">
        <strong style="font-size:13px">🕷 TMDB 크롤러</strong>
        <span id="tmdb-crawl-state" style="margin-left:auto;color:#7bed9f;font-weight:600">대기</span>
        <button id="tmdb-crawl-min" title="접기" style="background:none;border:0;color:#9a9ab5;cursor:pointer;font-size:14px">–</button>
      </div>
      <div id="tmdb-crawl-body" style="padding:10px 12px;max-height:calc(100vh - 150px);overflow:auto">
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">대기열</span><b id="tmdb-crawl-queue">0</b></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">완료 / 실패</span><b id="tmdb-crawl-done">0 / 0</b></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">저장</span><b id="tmdb-crawl-types">영화 0 · TV 0 · 인물 0</b></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">목록 페이지</span><b id="tmdb-crawl-lists">0</b></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">파일 확인</span><b id="tmdb-crawl-confirm">확인 0 · 미확인 0 · 중복 0</b></div>
        <div style="display:flex;justify-content:space-between" title="대기(이동·휴식·한도·일시정지) 시간을 뺀 실제 크롤링 시간"><span style="color:#9a9ab5">크롤링 시간</span><b id="tmdb-crawl-elapsed" style="font-variant-numeric:tabular-nums">00:00:00</b></div>
        <div style="display:flex;justify-content:space-between"><span style="color:#9a9ab5">사이트맵</span><b id="tmdb-crawl-sitemap">대기</b></div>
        <div id="tmdb-crawl-next" style="margin:8px 0;color:#b6b6d0;word-break:break-all">다음: (없음)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <button data-crawl="start" style="padding:6px;border-radius:8px;border:1px solid #2f6f4a;background:#14351f;color:#7bed9f;cursor:pointer">시작</button>
          <button data-crawl="pause" style="padding:6px;border-radius:8px;border:1px solid #6f5f2f;background:#352f14;color:#ffe08a;cursor:pointer">일시정지</button>
          <button data-crawl="stop" style="padding:6px;border-radius:8px;border:1px solid #6f2f2f;background:#351414;color:#ff9b9b;cursor:pointer">중지</button>
          <button data-crawl="seed" style="padding:6px;border-radius:8px;border:1px solid #2f3f6f;background:#141c35;color:#9bb8ff;cursor:pointer">큐에 추가</button>
          <button data-crawl="save" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:#1e1e30;color:#d7d7ea;cursor:pointer">현재 저장</button>
          <button data-crawl="clear" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:#1e1e30;color:#d7d7ea;cursor:pointer">큐 비우기</button>
          <button data-crawl="log" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:rgba(30,30,48,.75);color:#d7d7ea;cursor:pointer">로그 저장</button>
          <button data-crawl="index" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:rgba(30,30,48,.75);color:#d7d7ea;cursor:pointer">인덱스 내보내기</button>
          <button data-crawl="settingsSave" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:rgba(30,30,48,.75);color:#d7d7ea;cursor:pointer">설정 저장</button>
          <button data-crawl="settingsLoad" style="padding:6px;border-radius:8px;border:1px solid #3a3a5c;background:rgba(30,30,48,.75);color:#d7d7ea;cursor:pointer">설정 불러오기</button>
        </div>
        <div style="margin-top:10px;border-top:1px solid #2b2b44;padding-top:8px">
          <div style="color:#9a9ab5;margin-bottom:4px">수집 대상 (저장)</div>
          <label style="margin-right:8px"><input type="checkbox" data-target="movie"> 영화</label>
          <label style="margin-right:8px"><input type="checkbox" data-target="tv"> TV</label>
          <label style="margin-right:8px"><input type="checkbox" data-target="cast"> 배우</label>
          <label><input type="checkbox" data-target="director"> 감독</label>
          <div style="color:#7c7c96;margin-top:2px">배우/감독은 작품 크레딧에서 인물 페이지를 파생 수집합니다.</div>
        </div>
        <div style="margin-top:8px;border-top:1px solid #2b2b44;padding-top:8px">
          <div style="color:#9a9ab5;margin-bottom:4px">사이트맵 (전체 구조)</div>
          <label style="margin-right:8px"><input type="checkbox" data-smk="movie"> 영화</label>
          <label style="margin-right:8px"><input type="checkbox" data-smk="tv"> TV</label>
          <label style="margin-right:8px"><input type="checkbox" data-smk="person"> 인물</label>
          <input type="number" data-opt="sitemapBatch" min="100" step="100" style="width:64px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
          <label style="display:flex;align-items:center;gap:4px;margin-top:4px"><input type="checkbox" data-opt="newestFirst"> 최신 순으로 크롤링 (사이트맵 뒤에서부터)</label>
          <button data-crawl="sitemap" style="margin-top:6px;width:100%;padding:6px;border-radius:8px;border:1px solid #2f3f6f;background:#141c35;color:#9bb8ff;cursor:pointer">사이트맵으로 큐 채우기</button>
        </div>
        <div style="margin-top:8px;border-top:1px solid #2b2b44;padding-top:8px;display:flex;flex-direction:column;gap:4px">
          <label style="display:flex;align-items:center;gap:6px">언어
            <select data-opt="language" title="페이지 표시 언어 (단일 선택)" style="background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
              <option value="ko-KR">한국어 (기본)</option>
              <option value="en-US">English</option>
              <option value="ja-JP">日本語</option>
              <option value="de-DE">Deutsch</option>
              <option value="zh-TW">中文 (대만)</option>
              <option value="zh-CN">中文 (중국)</option>
              <option value="fr-FR">Français</option>
              <option value="es-ES">Español</option>
              <option value="pt-BR">Português</option>
              <option value="ru-RU">Русский</option>
              <option value="it-IT">Italiano</option>
              <option value="hi-IN">हिन्दी</option>
            </select>
          </label>
          <label><input type="checkbox" data-opt="allLanguages"> 모든 언어 포스터/배경 (끄면 1개 언어)</label>
          <label><input type="checkbox" data-opt="collectFilmography"> 인물 필모그래피 작품 수집</label>
          <label style="display:flex;align-items:center;gap:6px;padding-left:18px">작품당 인물
            <input type="number" data-opt="peoplePerTitle" min="0" max="500" step="1" title="작품 하나를 저장할 때 인물 큐에 넣을 최대 인원 (0 = 무제한)" style="width:60px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
            명 (0=무제한)
          </label>
          <label><input type="checkbox" data-opt="followLists"> 목록 페이지 다음 장 따라가기</label>
          <label><input type="checkbox" data-opt="autoFollow"> 링크 자동 추적 (연속 크롤링)</label>
          <label style="display:flex;align-items:center;gap:4px;padding-left:18px">큐
            <input type="number" data-opt="autoFollowQueue" min="0" max="200" step="1" title="이 개수 이하일 때만 보충" style="width:52px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
            이하일 때 최대
            <input type="number" data-opt="autoFollowLimit" min="1" max="50" step="1" title="한 번에 보충할 최대 개수" style="width:52px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
            개
          </label>
          <label><input type="checkbox" data-opt="overwrite"> 중복 파일 덮어쓰기 (끄면 건너뜀)</label>
          <label><input type="checkbox" data-opt="saveImages" title="포스터/배경/프로필 전체를 저장합니다(작품당 수백 장일 수 있음)"> 이미지도 저장 (JSON 이름 폴더, 파일명=제목)</label>
          <label><input type="checkbox" data-opt="autoLog"> 종료 시 로그 파일 자동 저장</label>
          <label><input type="checkbox" data-opt="humanize"> 사람처럼 (랜덤 스크롤·휴식)</label>
          <label><input type="checkbox" data-opt="readDelay"> 본문 길이만큼 읽는 시간 추가</label>
          <label style="display:flex;align-items:center;gap:6px">페이지 대기
            <input type="number" data-opt="minDelayMs" min="1000" step="500" style="width:64px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
            ~
            <input type="number" data-opt="maxDelayMs" min="1000" step="500" style="width:64px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">ms
          </label>
          <label style="display:flex;align-items:center;gap:6px">하위 요청
            <input type="number" data-opt="subpageMinMs" min="100" step="100" style="width:60px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
            ~
            <input type="number" data-opt="subpageMaxMs" min="100" step="100" style="width:60px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">ms
          </label>
          <label style="display:flex;align-items:center;gap:6px">저장 폴더
            <input type="text" data-opt="folder" placeholder="tmdb" style="width:120px;background:#1e1e30;color:#e9e9f2;border:1px solid #3a3a5c;border-radius:6px;padding:2px 4px">
          </label>
        </div>
        <details id="tmdb-crawl-logbox" style="margin-top:8px;border-top:1px solid rgba(60,60,90,.6);padding-top:8px">
          <summary style="cursor:pointer;color:#9a9ab5">작업 로그 보기</summary>
          <pre id="tmdb-crawl-logtext" style="margin:6px 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-all;font:11px/1.5 ui-monospace,Consolas,monospace;color:#b6b6d0">(로그 없음)</pre>
        </details>
        <input type="file" id="tmdb-crawl-settings-file" accept="application/json,.json" style="display:none">
        <div style="margin-top:8px;color:#7c7c96">저장 위치: 다운로드/&lt;폴더&gt;/movie-1368337-the-odyssey.json<br>기본 페이싱 기준 대략 100~200작품/시간<br>설정은 확장 저장소에 자동 저장되고 시작 시 자동으로 불러옵니다. [설정 저장]은 백업 파일 내보내기입니다.</div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(panel);
    cacheEls();

    panel.addEventListener('click', event => {
      const button = event.target.closest('button[data-crawl]');
      if (button) {
        const action = button.getAttribute('data-crawl');
        if (action === 'start') startCrawl(true);
        else if (action === 'pause') togglePause();
        else if (action === 'stop') stopCrawl();
        else if (action === 'seed') seedCurrent();
        else if (action === 'save') saveCurrentOnly();
        else if (action === 'clear') clearQueue();
        else if (action === 'index') exportIndex();
        else if (action === 'sitemap') seedSitemap();
        else if (action === 'log') downloadLog(false);
        else if (action === 'settingsSave') exportSettings();
        else if (action === 'settingsLoad') {
          const fileInput = panel.querySelector('#tmdb-crawl-settings-file');
          if (fileInput) fileInput.click();
        }
        return;
      }

      if (event.target.id === 'tmdb-crawl-min') {
        const body = panel.querySelector('#tmdb-crawl-body');
        const collapsed = body.style.display === 'none';
        body.style.display = collapsed ? '' : 'none';
        event.target.textContent = collapsed ? '–' : '+';
      }
    });

    panel.querySelectorAll('[data-target]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-target');
        settings.targets[key] = input.checked;
        pruneQueue();
        saveSettings();
        updatePanel();
      });
    });

    panel.querySelectorAll('[data-smk]').forEach(input => {
      input.addEventListener('change', () => {
        settings.sitemapKinds[input.getAttribute('data-smk')] = input.checked;
        saveSettings();
        updatePanel();
      });
    });

    panel.querySelectorAll('[data-opt]').forEach(input => {
      input.addEventListener('change', () => {
        const key = input.getAttribute('data-opt');
        if (input.type === 'checkbox') settings[key] = input.checked;
        else if (input.type === 'number') {
          const value = Number(input.value);
          settings[key] = isFinite(value) ? value : DEFAULT_SETTINGS[key];
          if (key === 'peoplePerTitle') settings[key] = clampPeoplePerTitle(settings[key]);
        } else {
          settings[key] = input.value.trim() || DEFAULT_SETTINGS[key];
        }
        if (key === 'newestFirst') {
          // 읽는 방향이 바뀌므로 사이트맵 커서를 처음부터 다시 잡는다
          sitemapState.childIndex = 0;
          sitemapState.cursor = 0;
        }
        applyPacing();
        saveSettings();
        updatePanel();
        log('설정 변경', key + ' = ' + settings[key]);
      });
    });

    const settingsFile = panel.querySelector('#tmdb-crawl-settings-file');
    if (settingsFile) {
      settingsFile.addEventListener('change', () => {
        const file = (settingsFile.files && settingsFile.files[0]) || null;
        importSettings(file);
        settingsFile.value = '';
      });
    }
  }

  function cacheEls() {
    els = {
      state: panel.querySelector('#tmdb-crawl-state'),
      queue: panel.querySelector('#tmdb-crawl-queue'),
      done: panel.querySelector('#tmdb-crawl-done'),
      types: panel.querySelector('#tmdb-crawl-types'),
      lists: panel.querySelector('#tmdb-crawl-lists'),
      confirm: panel.querySelector('#tmdb-crawl-confirm'),
      elapsed: panel.querySelector('#tmdb-crawl-elapsed'),
      sitemap: panel.querySelector('#tmdb-crawl-sitemap'),
      next: panel.querySelector('#tmdb-crawl-next'),
      logText: panel.querySelector('#tmdb-crawl-logtext')
    };
  }

  function syncSettingsInputs() {
    if (!panel) return;

    panel.querySelectorAll('[data-target]').forEach(input => {
      input.checked = !!settings.targets[input.getAttribute('data-target')];
    });
    panel.querySelectorAll('[data-smk]').forEach(input => {
      input.checked = !!settings.sitemapKinds[input.getAttribute('data-smk')];
    });
    panel.querySelectorAll('[data-opt]').forEach(input => {
      const key = input.getAttribute('data-opt');
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = settings[key];
    });
  }

  /* ------------------------------------------------------------------ */
  /* 메시지 (background 메뉴 연동)                                        */
  /* ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const action = request && request.action;
    const handlers = {
      crawlStart: () => startCrawl(true),
      crawlTogglePause: () => togglePause(),
      crawlStop: () => stopCrawl(),
      crawlSeed: () => seedCurrent(),
      crawlSitemapSeed: () => seedSitemap(),
      crawlSaveNow: () => saveCurrentOnly(),
      crawlExportIndex: () => exportIndex(),
      crawlStatus: () => ({
        ok: true,
        active: state.active,
        paused: state.paused,
        queue: state.queue.length,
        done: state.stats.done,
        failed: state.stats.failed,
        skipped: state.stats.skipped,
        sitemap: sitemapText()
      })
    };
    if (!handlers[action]) return;

    Promise.resolve(handlers[action]())
      .then(result => sendResponse(result || { ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  });

  /* ------------------------------------------------------------------ */
  /* 초기화                                                              */
  /* ------------------------------------------------------------------ */
  (async function init() {
    const savedState = await storageGet(STATE_KEY);
    if (savedState && typeof savedState === 'object' && savedState._v === STATE_VERSION) {
      state.active = !!savedState.active;
      state.paused = !!savedState.paused;
      state.records = Array.isArray(savedState.records) ? savedState.records.slice(-MAX_RECORDS) : [];
      state.listPages = Number(savedState.listPages) || 0;
      state.startedAt = savedState.startedAt || '';
      state.breakUntil = Number(savedState.breakUntil) || 0;
      state.breakAfter = Number(savedState.breakAfter) || 60;
      state.pagesSinceBreak = Number(savedState.pagesSinceBreak) || 0;
      state.cooldownUntil = Number(savedState.cooldownUntil) || 0;
      state.crawlMs = Number(savedState.crawlMs) || 0;
      // 페이지를 새로 열었을 때 이동 대기 시간이 섞이지 않도록 시계는 꺼진 상태로 시작한다
      state.crawlSince = 0;
      state.logs = Array.isArray(savedState.logs) ? savedState.logs.slice(-LOG_LIMIT) : [];
      if (state.logs.length) logRevision += 1;

      if (savedState.stats && typeof savedState.stats === 'object') {
        state.stats = Object.assign({}, state.stats, savedState.stats);
        state.stats.byType = Object.assign({ movie: 0, tv: 0, person: 0 }, savedState.stats.byType || {});
      }
      if (savedState.sitemap && typeof savedState.sitemap === 'object') {
        Object.assign(sitemapState, savedState.sitemap);
      }

      visited.clear();
      recentVisited.length = 0;
      String(savedState.visited || '').split('\n').forEach(key => {
        if (!key) return;
        visited.add(key);
        recentVisited.push(key);
      });
      if (recentVisited.length > VISITED_SAVE_LIMIT) {
        recentVisited.splice(0, recentVisited.length - VISITED_SAVE_LIMIT);
      }
      restoreQueue(savedState.queue);
    }

    // 시작할 때 설치 폴더의 settings.json + 저장된 설정을 읽는다.
    // 우선순위: 저장된 설정(UI에서 바꾼 값) > settings.json > 내장 기본값
    const packaged = await requestPackagedSettings();
    const packagedSettings = (packaged && packaged.settings && typeof packaged.settings === 'object')
      ? packaged.settings
      : null;
    const packagedHash = packaged && typeof packaged.hash === 'string' ? packaged.hash : '';
    const savedSettings = await storageGet(SETTINGS_KEY);
    const savedHash = await storageGet(SETTINGS_HASH_KEY);
    const stored = (savedSettings && typeof savedSettings === 'object' && savedSettings._v === DEFAULT_SETTINGS._v)
      ? savedSettings
      : null;
    // settings.json을 편집했다면 파일 값이 우선하고, 그렇지 않으면 UI에서 바꾼 저장값이 우선한다
    const fileChanged = !!(packagedSettings && packagedHash && packagedHash !== savedHash);
    settings = normalizeSettings(Object.assign({}, packagedSettings || {}, fileChanged ? {} : (stored || {})));
    if (fileChanged || !stored) await saveSettings();
    if (packagedHash && packagedHash !== savedHash) await storageSet({ [SETTINGS_HASH_KEY]: packagedHash });

    pruneQueue();
    applyPacing();
    buildPanel();
    syncSettingsInputs();
    updatePanel();

    setInterval(() => {
      if (!panel) return;
      if (state.startedAt || state.active || state.breakUntil || state.cooldownUntil) updatePanel();
    }, 1000);

    // 워치독: 탭 지연/이벤트 유실로 멈춘 흐름을 자동 재개한다(연속 작업)
    setInterval(() => {
      if (!state.active || state.paused || busy || navTimer || navigating) return;
      if (state.breakUntil > Date.now() || state.cooldownUntil > Date.now()) return;
      log('워치독: 멈춘 흐름 자동 재개');
      schedule(400);
    }, 5000);

    if (state.active && !state.paused) {
      schedule(900);
    }
  })();

  // 디버깅용(테스트 하네스에서 순수 함수 확인)
  window.__tmdbCrawlerInternals = {
    entryFromPath: entryFromPath,
    pathFromUrl: pathFromUrl,
    normalizeLinkHref: normalizeLinkHref,
    parseLocTags: parseLocTags,
    fileBaseNameFor: fileBaseNameFor,
    delayRange: delayRange
  };
})();
