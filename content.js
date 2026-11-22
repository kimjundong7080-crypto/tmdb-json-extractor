// content.js - TMDB 데이터 추출기 (영화/TV 통합 버전)

// ===== 중복 주입 가드 =====
if (!window.__tmdbExtractorLoaded) {
  window.__tmdbExtractorLoaded = true;

  // ===== 메시지 리스너 =====
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const actions = {
      extractAndDownload: "media",
      extractCastAndDownload: "cast",
      extractPersonAndDownload: "person"
    };
    const kind = actions[request.action];
    if (!kind) return;

    handleExtraction(kind, sendResponse).catch(error => {
      console.error("TMDB JSON 추출 처리 실패:", error);
    });
    return true;
  });
}

// ===== 페이지 종류/ID 판별 =====
function getPageInfo() {
  let pathname = window.location.pathname;
  try {
    pathname = new URL(window.location.href).pathname;
  } catch (e) {}

  const match = pathname.match(/^\/(movie|tv|person)\/(\d+)(?:[-/]|$)/);
  if (!match) return { kind: null, id: '', isSubPage: false };

  const kind = match[1];
  const isSubPage = kind === 'tv' && /\/(season|episode)\//.test(pathname);
  return { kind: kind, id: match[2], isSubPage: isSubPage };
}

// ===== 크롤러 설정 (crawler.js가 저장) =====
// content.js는 background에서 재주입될 수 있으므로 top-level const/let을 두지 않는다.
async function getCrawlerSettings() {
  const defaults = { allLanguages: false, subpageMinMs: 700, subpageMaxMs: 1800 };
  try {
    const result = await chrome.storage.local.get('tmdbCrawlerSettings');
    const saved = (result && result.tmdbCrawlerSettings) || {};
    // 설정 구조가 바뀐 예전 저장값(예: allLanguages:true)은 무시한다
    if (saved && saved._v === 3) return Object.assign({}, defaults, saved);
    return defaults;
  } catch (e) {
    return defaults;
  }
}

// ===== 공통 추출 처리 =====
async function handleExtraction(kind, sendResponse) {
  const respond = typeof sendResponse === 'function' ? sendResponse : function () {};
  const page = getPageInfo();

  if (kind === 'person') {
    if (page.kind !== 'person') {
      showToast("❌ 배우 상세 페이지에서만 사용할 수 있습니다.", "error");
      respond({ ok: false });
      return;
    }
  } else {
    if (page.kind !== 'movie' && page.kind !== 'tv') {
      showToast("❌ 영화 또는 TV 프로그램 상세 페이지에서만 사용할 수 있습니다.", "error");
      respond({ ok: false });
      return;
    }
    if (page.isSubPage) {
      showToast("❌ 시즌/에피소드 페이지에서는 사용할 수 없습니다.", "error");
      respond({ ok: false });
      return;
    }
  }

  try {
    let payload;
    let filenameBase;
    let prefix;
    let successMessage;

    if (kind === 'person') {
      const data = extractPersonData();
      payload = data;
      filenameBase = data.name || 'person';
      prefix = 'person';
      successMessage = `✅ 배우 "${data.name}" 정보가 클립보드에 복사되었습니다!`;
    } else {
      const crawlSettings = await getCrawlerSettings();
      const data = await extractMediaData(
        kind === 'cast'
          ? { cast: true }
          : {
              galleries: true,
              cast: true,
              videos: true,
              releases: true,
              wikidata: true,
              allLanguages: crawlSettings.allLanguages === true
            }
      );

      if (kind === 'cast') {
        const castList = (data.credits && Array.isArray(data.credits.cast)) ? data.credits.cast : [];
        if (castList.length === 0) {
          showToast("❌ 배우 정보를 찾지 못했습니다. 페이지 구조가 변경되었을 수 있습니다.", "error");
          respond({ ok: false });
          return;
        }

        payload = {
          title: data.title,
          originalTitle: data.originalTitle,
          releaseDate: data.releaseDate,
          mediaType: page.kind,
          cast: castList.map(actor => ({
            name: actor.name,
            character: actor.character,
            image: actor.image,
            image_high: actor.image_high,
            image_original: actor.image_original,
            episodes: actor.episodes || null
          })),
          totalCast: castList.length
        };
        filenameBase = (data.title || 'cast') + '_cast';
        prefix = 'cast';
        successMessage = `✅ 배우 ${castList.length}명의 JSON이 클립보드에 복사되었습니다!`;
      } else {
        payload = data;
        filenameBase = data.title || 'media';
        prefix = page.kind;
        successMessage = "✅ 미디어 JSON이 클립보드에 복사되었습니다!";
      }
    }

    const jsonString = JSON.stringify(payload, null, 2);
    const copied = await copyToClipboard(jsonString);
    const finalFilename = downloadJsonFile(jsonString, filenameBase, prefix, page.id);

    if (finalFilename === null) {
      if (copied) {
        showToast("⚠️ 클립보드에는 복사했지만 파일 저장에 실패했습니다.", "error");
      }
      respond({ ok: false, copied: copied, filename: null });
      return;
    }

    if (copied) {
      showToast(successMessage, "success");
    } else {
      showToast(`⚠️ 클립보드 복사에 실패했습니다. "${finalFilename}" 파일로 저장했습니다.`, "error");
    }
    respond({ ok: true, copied: copied, filename: finalFilename });
  } catch (error) {
    console.error("TMDB JSON 추출 오류:", error);
    let message = "❌ 데이터 추출 중 오류가 발생했습니다.";
    if (kind === 'person') message = "❌ 배우 정보 추출 중 오류가 발생했습니다.";
    else if (kind === 'cast') message = "❌ 배우 데이터 추출 중 오류가 발생했습니다.";
    showToast(message, "error");
    respond({ ok: false, error: String(error) });
  }
}

// ===== 클립보드 복사 (실패 시 fallback) =====
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    console.warn("navigator.clipboard 복사 실패, fallback 시도:", e);
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch (e) {
    console.warn("execCommand 복사 실패:", e);
    return false;
  }
}

// ===== 파일명 규칙: movie-1368337-the-odyssey.json =====
function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9\-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 100);
}

function slugFromPath(pathname, kind, id) {
  try {
    const match = String(pathname || '').match(new RegExp('^/' + kind + '/' + String(id) + '([^/?#]*)'));
    return match ? match[1].replace(/^[-/]+/, '') : '';
  } catch (e) {
    return '';
  }
}

// 크롤러와 같은 파일명 규칙: movie-1368337-the-odyssey.json
function buildOutputFilename(kind, id, title) {
  const slug = safeFilePart(slugFromPath(window.location.pathname, kind, id) || title);
  return [kind, String(id), slug].filter(Boolean).join('-') + '.json';
}

// ===== JSON 파일 자동 다운로드 함수 =====
function downloadJsonFile(jsonString, filename, prefix, id) {
  try {
    const info = getPageInfo();
    const kind = prefix || info.kind || 'export';
    const pageId = String(info.id || id || Date.now());
    const finalFilename = buildOutputFilename(kind, pageId, filename);

    const blob = new Blob([jsonString], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = finalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

    return finalFilename;
  } catch (error) {
    console.error("다운로드 오류:", error);
    showToast("❌ 파일 다운로드 중 오류가 발생했습니다.", "error");
    return null;
  }
}

// ===== 이미지 고해상도 변환 함수 =====
function getHighResImage(url, size = 'high') {
  if (!url) return url;
  url = normalizeImageUrl(url);
  if (!url.includes('media.themoviedb.org')) return url;
  
  const sizeMap = {
    'w300_and_h450_face': { high: 'w500', original: 'original' },
    'w600_and_h900_face': { high: 'w780', original: 'original' },
    'w440_and_h660_face': { high: 'w780', original: 'original' },
    'w220_and_h330_face': { high: 'w500', original: 'original' },
    'w130_and_h195_face': { high: 'w260_and_h390_face', original: 'original' },
    'w92': { high: 'w185', original: 'original' },
    'w154': { high: 'w342', original: 'original' },
    'w185': { high: 'w342', original: 'original' },
    'w342': { high: 'w500', original: 'original' },
    'w500': { high: 'w780', original: 'original' },
    'w780': { high: 'w1280', original: 'original' },
    'w300': { high: 'w780', original: 'original' },
    'w1280': { high: 'original', original: 'original' },
    'w45_and_h45_face': { high: 'w90_and_h90_face', original: 'original' },
    'w66_and_h66_face': { high: 'w132_and_h132_face', original: 'original' },
    'w138_and_h175_face': { high: 'w276_and_h350_face', original: 'original' },
    'w276_and_h350_face': { high: 'h632', original: 'original' },
    'w45': { high: 'w185', original: 'original' },
    'h30': { high: 'h60', original: 'original' },
    'h45': { high: 'h90', original: 'original' },
    'w533_and_h300_face': { high: 'w1066_and_h600_face', original: 'original' },
    'w1066_and_h600_face': { high: 'original', original: 'original' }
  };
  
  const match = url.match(/\/t\/p\/([^\/]+)\//);
  if (!match) return url;
  
  const currentSize = match[1];
  let targetSize;
  if (size === 'original') {
    targetSize = 'original';
  } else if (size === 'high') {
    targetSize = (sizeMap[currentSize] && sizeMap[currentSize].high) || 'original';
  } else {
    targetSize = size;
  }
  
  return url.replace(`/t/p/${currentSize}/`, `/t/p/${targetSize}/`);
}

// ===== 이미지 URL 추출 (srcset/data-src 우선) =====
function getImageSource(img) {
  if (!img) return '';

  const srcset = img.getAttribute('srcset');
  if (srcset) {
    let bestUrl = '';
    let bestWidth = -1;
    srcset.split(',').forEach(part => {
      const pieces = part.trim().split(/\s+/);
      const url = pieces[0];
      if (!url) return;
      const width = parseFloat(pieces[1]) || 0;
      if (width >= bestWidth) {
        bestWidth = width;
        bestUrl = url;
      }
    });
    if (bestUrl) return normalizeImageUrl(bestUrl);
  }

  return normalizeImageUrl(img.getAttribute('data-src') || img.getAttribute('src') || '');
}

// ===== 숫자/상태 정규화 헬퍼 =====
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

function getStatusKey(status) {
  const text = String(status || '').toLowerCase();
  if (!text) return '';
  if (text.includes('returning') || text.includes('방영')) return 'returning';
  if (text.includes('ended') || text.includes('종영')) return 'ended';
  if (text.includes('cancel') || text.includes('취소')) return 'canceled';
  if (text.includes('post') || text.includes('제작')) return 'post_production';
  if (text.includes('released') || text.includes('개봉')) return 'released';
  if (text.includes('planned') || text.includes('예정')) return 'planned';
  return '';
}

// ===== 이미지 파일명 기준 중복 제거 (동일 파일의 여러 사이즈 → 최대 해상도 1개) =====
function getImageWidthRank(url) {
  const token = getImageSizeToken(url);
  if (!token || token === 'original') return Number.MAX_SAFE_INTEGER;
  const match = token.match(/^w(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function dedupeImagesByFilename(items) {
  const byName = {};
  const order = [];

  items.forEach(item => {
    const name = String(item.url || '').split('/').pop();
    if (!name) return;
    if (!byName[name]) {
      byName[name] = item;
      order.push(name);
      return;
    }
    const existing = byName[name];
    const useNew = getImageWidthRank(item.url) > getImageWidthRank(existing.url);
    const winner = useNew ? item : existing;
    const loser = useNew ? existing : item;

    // URL은 큰 해상도를 유지하되, 다른 항목에만 있는 메타데이터는 합친다.
    Object.keys(loser).forEach(key => {
      if (key === 'url') return;
      const value = loser[key];
      if (value === null || value === undefined || value === '') return;
      if (winner[key] === null || winner[key] === undefined || winner[key] === '') {
        winner[key] = value;
      } else if (key === 'urls' && typeof value === 'object' && typeof winner[key] === 'object') {
        winner[key] = Object.assign({}, value, winner[key]);
      }
    });

    byName[name] = winner;
  });

  return order.map(name => byName[name]);
}

// ===== Media 섹션(인기 미디어) 정적 자산 =====
// 초기 HTML에는 Most Popular 탭의 예고편 1(CSS background-image) + 배경 1 + 포스터 1만 있다.
function extractMediaSection() {
  const result = { tabs: [], items: [] };
  const section = document.querySelector('section.panel.media_panel.media, section.media_panel.media');
  if (!section) return result;

  const menu = section.querySelector('.menu');
  if (menu) {
    menu.querySelectorAll('a[id]').forEach(link => {
      const span = link.querySelector('span');
      const countText = span ? span.textContent.trim() : '';
      const label = span ? link.textContent.replace(span.textContent, '').trim() : link.textContent.trim();
      const listItem = link.closest('li');
      result.tabs.push({
        id: link.id,
        label: label.replace(/\s+/g, ' '),
        count: toNumber(countText),
        href: link.getAttribute('href') || '',
        active: link.classList.contains('active') || !!(listItem && listItem.classList.contains('active'))
      });
    });
  }

  const root = section.querySelector('#media_scroller') ||
    section.querySelector('.h_scroller.content') ||
    section;

  root.querySelectorAll('a.play_trailer[data-id], .video.card a[data-id]').forEach(link => {
    const wrapper = link.closest('.wrapper');
    let background = wrapper ? wrapper.style.backgroundImage : '';
    if (!background && wrapper) {
      try { background = window.getComputedStyle(wrapper).backgroundImage; } catch (e) {}
    }
    const match = String(background || '').match(/url\(["']?([^"')]+)["']?\)/);
    const card = link.closest('.video.card') || link.closest('.video');

    result.items.push({
      tab: 'popular',
      type: 'video',
      src: match ? match[1] : '',
      srcset: '',
      alt: '',
      classes: card ? card.className : '',
      parent_classes: (card && card.parentElement) ? card.parentElement.className : '',
      data_site: link.getAttribute('data-site') || '',
      data_id: link.getAttribute('data-id') || '',
      data_title: link.getAttribute('data-title') || '',
      href: link.getAttribute('href') || ''
    });
  });

  root.querySelectorAll('img.backdrop, img.poster').forEach(img => {
    // img 자체에도 .backdrop/.poster 클래스가 있어 closest()는 자기 자신이 된다.
    // 구조 기록은 실제 부모 컨테이너(div.backdrop/div.poster)를 사용한다.
    const parent = img.parentElement || img;
    const isBackdrop = img.classList.contains('backdrop') ||
      !!(parent && parent.classList.contains('backdrop'));

    result.items.push({
      tab: 'popular',
      type: isBackdrop ? 'backdrop' : 'poster',
      src: img.getAttribute('src') || '',
      srcset: img.getAttribute('srcset') || '',
      alt: img.getAttribute('alt') || '',
      classes: img.className || '',
      parent_classes: parent ? parent.className : ''
    });
  });

  return result;
}

// ===== Top Billed Cast 섹션(정적 렌더링) =====
function extractTopBilledCast() {
  const rows = [];
  const section = document.querySelector('section.panel.top_billed, section.top_billed');
  if (!section) return rows;

  const list = section.querySelector('#cast_scroller ol.people.scroller, #cast_scroller ol.people, ol.people.scroller');
  if (!list) return rows;

  list.querySelectorAll('li.card').forEach(card => {
    if (card.classList.contains('filler') || card.classList.contains('view_more')) return;

    const personLink = card.querySelector('a[href*="/person/"]');
    const href = personLink ? (personLink.getAttribute('href') || '') : '';
    const match = href.match(/\/person\/(\d+)(?:-([^/?#]*))?/);
    if (!match) return;

    const personId = Number(match[1]);
    const personSlug = match[2] || '';
    const nameLink = card.querySelector('p a') || personLink;
    const name = nameLink ? nameLink.textContent.trim() : '';
    if (!name) return;

    const characterEl = card.querySelector('p.character');
    const img = card.querySelector('img.profile, img');
    const wrapper = card.querySelector('div.profile, .glyphicons.profile');
    let placeholderClass = '';
    if (wrapper) {
      if (wrapper.classList.contains('one')) placeholderClass = 'one';
      else if (wrapper.classList.contains('two')) placeholderClass = 'two';
    }

    rows.push({
      order: rows.length + 1,
      person_id: personId,
      person_slug: personSlug,
      name: name,
      character: characterEl ? characterEl.textContent.trim() : '',
      profile_src: img ? normalizeImageUrl(img.getAttribute('src') || '') : '',
      profile_srcset: img ? (img.getAttribute('srcset') || '') : '',
      alt: img ? (img.getAttribute('alt') || '') : '',
      placeholder_class: placeholderClass,
      profile_url: 'https://www.themoviedb.org/person/' + personId + (personSlug ? '-' + personSlug : '')
    });
  });

  return rows;
}

// ===== 보강 실패 보고 (콘솔 + 크롤러 로그) =====
function reportEnrichmentIssue(message, error) {
  const detail = (error && (error.message || String(error))) || '';
  try {
    console.warn('[TMDB] ' + message, error || '');
  } catch (e) {}
  try {
    if (typeof window.__tmdbEnrichWarn === 'function') window.__tmdbEnrichWarn(message, detail);
  } catch (e) {}
}

// ===== TMDB 하위 페이지/이미지 헬퍼 =====
function normalizeImageUrl(url) {
  if (!url) return '';
  return String(url)
    .replace('://image.tmdb.org/', '://media.themoviedb.org/')
    .split('?')[0];
}

function replaceImageSize(url, token) {
  const normalized = normalizeImageUrl(url);
  const match = normalized.match(/\/t\/p\/([^/]+)\//);
  if (!match) return normalized;
  return normalized.replace(`/t/p/${match[1]}/`, `/t/p/${token}/`);
}

function getImageFilename(url) {
  return normalizeImageUrl(url).split('/').pop();
}

// ===== 유튜브 링크 수집 =====
// 본문/소개글/앵커에 포함된 유튜브 주소와 영상 목록을 videoId 기준으로 모은다.
function collectYoutubeLinks(texts, urls) {
  // watch / embed / shorts / live / youtu.be 를 모두 videoId로 정규화한다
  const idPattern = /(?:youtube\.com\/(?:watch\?[^#\s"'<>]*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/;
  const seen = {};
  const rows = [];

  function add(url, title, source) {
    const match = String(url || '').match(idPattern);
    if (!match || seen[match[1]]) return;
    seen[match[1]] = true;
    rows.push({
      videoId: match[1],
      url: 'https://www.youtube.com/watch?v=' + match[1],
      title: String(title || '').trim().slice(0, 200),
      source
    });
  }

  try {
    document.querySelectorAll('a[href*="youtube.com"], a[href*="youtu.be"]').forEach(anchor => {
      add(anchor.getAttribute('href'), anchor.textContent, 'link');
    });
  } catch (e) {}

  (Array.isArray(texts) ? texts : []).forEach(text => {
    const re = new RegExp(idPattern.source, 'g');
    let match;
    while ((match = re.exec(String(text || '')))) {
      add('https://www.youtube.com/watch?v=' + match[1], '', 'text');
    }
  });

  (Array.isArray(urls) ? urls : []).forEach(item => {
    if (item && typeof item === 'object') add(item.url, item.title, 'video');
    else add(item, '', 'video');
  });
  return rows;
}

function buildImageVariants(originalUrl, displayToken, highToken) {
  return {
    display: replaceImageSize(originalUrl, displayToken),
    high: replaceImageSize(originalUrl, highToken),
    original: replaceImageSize(originalUrl, 'original')
  };
}

// DOM에서만 수집된 이미지에도 공통 메타 필드를 보장한다.
function ensureImageMetadata(items) {
  (items || []).forEach(item => {
    const name = getImageFilename(item.url);
    if (!item.file_path) item.file_path = name ? '/' + name : '';
    if (!('id' in item)) item.id = null;
    if (!('iso_639_1' in item)) item.iso_639_1 = null;
    if (!('width' in item)) item.width = null;
    if (!('height' in item)) item.height = null;
    if (!('aspect_ratio' in item)) item.aspect_ratio = null;
  });
}

function buildPaginationInfo(collected, total) {
  const results = Math.max(0, Number(total) || 0);
  const count = Math.max(0, Number(collected) || 0);
  const perPage = count > 0 ? count : 1;
  return {
    page: 1,
    per_page: perPage,
    total_pages: results > 0 ? Math.ceil(results / perPage) : 0,
    total_results: results
  };
}

function buildCreditGroups(data) {
  const directors = [];
  const writers = [];
  (data.credits.crew || []).forEach(member => {
    const job = String(member.job || '').toLowerCase();
    const row = { id: member.id || null, name: member.name };

    const isDirector = job.includes('director') &&
      !job.includes('assistant') && !job.includes('second') && !job.includes('casting') &&
      !job.includes('art') && !job.includes('photography') && !job.includes('cinematographer') &&
      !job.includes('photographer');
    if (isDirector && !directors.some(existing => existing.name === row.name)) directors.push(row);

    if ((job.includes('writer') || job.includes('screenplay') || job.includes('story')) &&
      !job.includes('storyboard') &&
      !writers.some(existing => existing.name === row.name)) {
      writers.push(row);
    }
  });

  data.credits.directors = directors;
  data.credits.writers = writers;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 사람처럼 요청하기: 전역 직렬 큐 + 지터 + 429 백오프 =====
// 갤러리/출연진/영상/개봉정보 보강이 동시에 요청을 쏘지 않도록 모든 TMDB 요청을 한 줄로 세운다.
// 재주입 안전성을 위해 상태는 window에 둔다(top-level const/let 재선언 방지).
function getTmdbPacing() {
  if (!window.__tmdbPacing) {
    window.__tmdbPacing = {
      minMs: 700,
      maxMs: 1800,
      cooldownMs: 5 * 60 * 1000,
      chain: Promise.resolve(),
      lastAt: 0,
      rateLimitUntil: 0,
      streak: 0
    };
  }
  return window.__tmdbPacing;
}

function setPacing(options) {
  if (!options || typeof options !== 'object') return;
  const pacing = getTmdbPacing();
  const min = Number(options.minMs);
  const max = Number(options.maxMs);
  if (isFinite(min) && min >= 100) pacing.minMs = min;
  if (isFinite(max) && max >= pacing.minMs) pacing.maxMs = max;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// robots.txt의 Disallow 경로(/person/*/remote/credits, image_sort=)는 요청하지 않는다
function isDisallowedPath(path) {
  const value = String(path || '');
  if (/\/person\/\d+\/remote\/credits/.test(value)) return true;
  return /image_sort=/.test(value);
}

async function waitForRequestSlot() {
  const pacing = getTmdbPacing();
  const now = Date.now();
  if (pacing.rateLimitUntil > now) {
    throw new Error('429 한도 대기 중 (' + Math.ceil((pacing.rateLimitUntil - now) / 1000) + 's)');
  }
  const nextAt = Math.max(now, pacing.lastAt + randomBetween(pacing.minMs, pacing.maxMs));
  if (nextAt > now) await delay(nextAt - now);
  pacing.lastAt = Date.now();
}

function serializeTmdbRequest(task) {
  const pacing = getTmdbPacing();
  const run = pacing.chain.then(task, task);
  pacing.chain = run.then(() => undefined, () => undefined);
  return run;
}

function getFetchCache() {
  if (!window.__tmdbFetchCache) window.__tmdbFetchCache = {};
  return window.__tmdbFetchCache;
}

// 상대 경로가 엉뚱한 origin으로 풀리는 경우를 막기 위해 항상 origin 기준 절대 URL로 만든다
function absoluteUrl(path) {
  try {
    return new URL(path, window.location.origin).href;
  } catch (e) {
    return path;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
  try {
    return await fetch(url, Object.assign({ credentials: 'same-origin' }, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// 페이지 표시 언어: URL의 ?language= 값을 우선하고, 없으면 <html lang>을 쓴다.
// 이 값을 하위 페이지(/cast, /videos, 갤러리) 요청에도 붙여 페이지와 언어를 맞춘다.
function pageLocale() {
  const known = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', de: 'de-DE', zh: 'zh-TW', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', ru: 'ru-RU', it: 'it-IT', hi: 'hi-IN' };
  let code = '';
  try {
    code = new URL(window.location.href).searchParams.get('language') || '';
  } catch (e) {}
  if (!code) {
    try {
      code = (document.documentElement && document.documentElement.getAttribute('lang')) || '';
    } catch (e) {}
  }
  code = String(code || '').trim();
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(code)) return '';
  if (code.indexOf('-') === -1) return known[code.toLowerCase()] || code;
  return code;
}

function withPageLocale(path) {
  const locale = pageLocale();
  const value = String(path || '');
  if (!locale || value.charAt(0) !== '/') return value;
  try {
    const url = new URL(value, window.location.origin);
    if (url.searchParams.has('language')) return value;
    url.searchParams.set('language', locale);
    return url.pathname + url.search;
  } catch (e) {
    return value;
  }
}

async function fetchHtmlDoc(path, timeoutMs, options) {
  const target = withPageLocale(path);
  const cache = getFetchCache();
  const cached = cache[target];
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return new DOMParser().parseFromString(cached.html, 'text/html');
  }
  if (isDisallowedPath(target)) {
    throw new Error(`robots.txt에서 제외된 경로입니다 (${target})`);
  }

  return serializeTmdbRequest(async () => {
    // 429는 Retry-After를 존중하고 5s → 15s → 45s로 물러선다
    const backoff = [0, 5000, 15000, 45000];
    let lastStatus = 0;

    for (let attempt = 0; attempt < backoff.length; attempt++) {
      if (backoff[attempt] > 0) await delay(backoff[attempt] + randomBetween(0, 1500));
      await waitForRequestSlot();

      const response = await fetchWithTimeout(absoluteUrl(target), {}, timeoutMs);
      lastStatus = response.status;

      if (response.status === 429) {
        const pacing = getTmdbPacing();
        pacing.streak += 1;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (isFinite(retryAfter) && retryAfter > 0 && retryAfter < 120) await delay(retryAfter * 1000);
        if (pacing.streak >= 3) {
          pacing.rateLimitUntil = Date.now() + pacing.cooldownMs;
          throw new Error(`429 요청 한도: 5분 뒤 재시도합니다 (${target})`);
        }
        continue;
      }
      if (response.status >= 500) continue;
      if (!response.ok) throw new Error(`HTTP ${response.status} (${target})`);

      getTmdbPacing().streak = 0;
      const contentType = response.headers.get('content-type') || '';
      if (contentType && contentType.indexOf('text/html') === -1) {
        throw new Error(`HTML이 아님 (${contentType}) ${target}`);
      }
      const html = await response.text();

      // 갤러리 전 언어 수집처럼 많은 페이지를 훑을 때는 HTML 캐시를 남기지 않는다
      const shouldCache = !options || options.cache !== false;
      if (shouldCache) {
        const keys = Object.keys(cache);
        if (keys.length > 40) {
          keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0))
            .slice(0, keys.length - 40)
            .forEach(key => delete cache[key]);
        }
        cache[target] = { ts: Date.now(), html: html };
      }
      return new DOMParser().parseFromString(html, 'text/html');
    }

    throw new Error(`HTTP ${lastStatus || 'error'} (${target})`);
  });
}

async function getGalleryLanguages(kind, basePath) {
  const doc = await fetchHtmlDoc(`${basePath}/images/${kind}`);
  const codes = [];
  doc.querySelectorAll('a[href*="image_language"]').forEach(anchor => {
    const match = (anchor.getAttribute('href') || '').match(/image_language=([a-zA-Z-]+)/);
    const code = match ? match[1] : '';
    if (code && code !== 'xx' && !codes.includes(code)) codes.push(code);
  });
  return codes;
}

// 갤러리 언어 링크와 각 언어의 이미지 수를 함께 돌려준다(많은 순).
async function getGalleryLanguagePairs(kind, basePath) {
  const doc = await fetchHtmlDoc(`${basePath}/images/${kind}`);
  const pairs = [];
  doc.querySelectorAll('a[href*="image_language"]').forEach(anchor => {
    const match = (anchor.getAttribute('href') || '').match(/image_language=([a-zA-Z-]+)/);
    const code = match ? match[1] : '';
    if (!code || code === 'xx') return;
    if (pairs.some(pair => pair.code === code)) return;

    const countMatch = anchor.textContent.trim().match(/(\d+)\s*$/);
    pairs.push({ code: code, count: countMatch ? Number(countMatch[1]) : 0 });
  });
  return pairs.sort((a, b) => b.count - a.count);
}

// 갤러리 언어 필터를 모두 순회해 이미지 URL을 모은다.
// allLanguages=true 이면 모든 언어를, false(기본값)면 기본+xx+en 후
// 목표 개수(탭 카운트)에 도달할 때까지 언어를 추가로 순회한다.
async function fetchGalleryUrls(kind, basePath, options) {
  const allLanguages = !!(options && options.allLanguages === true);
  const targetCount = Number(options && options.targetCount) || 0;
  const locale = pageLocale();
  if (!window.__tmdbGalleryCache) window.__tmdbGalleryCache = {};
  const cacheKey = `${basePath}/images/${kind}|v2|${allLanguages ? 'all' : (locale || 'basic') + '|t' + targetCount}`;
  const cached = window.__tmdbGalleryCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
    return (cached.items || []).slice();
  }

  const variants = [''];
  if (allLanguages) {
    try {
      const codes = await getGalleryLanguages(kind, basePath);
      codes.forEach(code => variants.push('?image_language=' + encodeURIComponent(code)));
    } catch (error) {
      reportEnrichmentIssue(`TMDB ${kind} 언어 목록 수집 실패`, error);
    }
    if (!variants.includes('?image_language=xx')) variants.push('?image_language=xx');
  } else {
    // 갤러리는 언어별로 나뉜다. 1개 언어만 보면 포스터/배경이 1~2장만 남으므로
    // 기본(사이트 언어) + 언어 없음(xx) + 영어(en)를 함께 수집한다(요청 3회).
    variants.length = 0;
    variants.push('');
    variants.push('?image_language=xx');
    variants.push('?image_language=en');
  }
  const uniqueVariants = Array.from(new Set(variants));

  const records = {};

  function languageCodeForVariant(variant) {
    const match = String(variant || '').match(/image_language=([a-zA-Z-]+)/);
    if (match) return match[1] === 'xx' ? null : match[1];
    const localeCode = String(pageLocale() || '').split('-')[0].toLowerCase();
    return localeCode || null;
  }

  function collectFromDoc(doc, variant) {
    const languageCode = languageCodeForVariant(variant);
    let anchors = doc.querySelectorAll('.card a[href*="/t/p/"]');
    if (anchors.length === 0) anchors = doc.querySelectorAll('a[href*="/t/p/"]');

    anchors.forEach(anchor => {
      const href = normalizeImageUrl(anchor.getAttribute('href'));
      const name = getImageFilename(href);
      if (!href || !name) return;

      if (records[name]) {
        if (!records[name].iso_639_1 && languageCode) records[name].iso_639_1 = languageCode;
        return;
      }

      const card = anchor.closest('.card');
      let imageId = '';
      let width = null;
      let height = null;
      if (card) {
        imageId = card.getAttribute('data-image-id') || card.id || '';
        const sizeMatch = card.textContent.match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
        if (sizeMatch) {
          width = Number(sizeMatch[1]);
          height = Number(sizeMatch[2]);
        }
      }

      records[name] = {
        url: href,
        file_path: '/' + name,
        id: imageId || null,
        iso_639_1: languageCode,
        width: width,
        height: height,
        aspect_ratio: (width && height) ? Number((width / height).toFixed(3)) : null
      };
    });
  }

  function recordCount() {
    return Object.keys(records).length;
  }

  let index = 0;
  const CONCURRENCY = 1;  // 사람처럼 한 번에 한 요청만 보낸다(429 방지)

  async function worker() {
    while (index < uniqueVariants.length) {
      const variant = uniqueVariants[index++];
      try {
        const doc = await fetchHtmlDoc(`${basePath}/images/${kind}${variant}`, undefined, { cache: false });
        collectFromDoc(doc, variant);
      } catch (error) {
        reportEnrichmentIssue(`TMDB ${kind} 갤러리 수집 실패 (${variant || 'default'})`, error);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, uniqueVariants.length); i++) workers.push(worker());
  await Promise.all(workers);

  // 단일 언어 모드: 탭 카운트(전체 라이브러리 수)에 못 미치면 언어를 추가 순회한다.
  if (!allLanguages && targetCount > 0 && recordCount() < targetCount) {
    const fetchedCodes = {};
    uniqueVariants.forEach(variant => {
      const match = variant.match(/image_language=([a-zA-Z-]+)/);
      if (match) fetchedCodes[match[1]] = true;
    });

    let pairs = [];
    try {
      pairs = await getGalleryLanguagePairs(kind, basePath);
    } catch (error) {
      reportEnrichmentIssue(`TMDB ${kind} 언어 목록 수집 실패`, error);
    }

    const MAX_EXTRA_LANGUAGES = 30;
    let extra = 0;
    for (const pair of pairs) {
      if (recordCount() >= targetCount || extra >= MAX_EXTRA_LANGUAGES) break;
      if (fetchedCodes[pair.code]) continue;
      fetchedCodes[pair.code] = true;
      extra += 1;
      try {
        const doc = await fetchHtmlDoc(
          `${basePath}/images/${kind}?image_language=${encodeURIComponent(pair.code)}`,
          undefined,
          { cache: false }
        );
        collectFromDoc(doc, '?image_language=' + pair.code);
      } catch (error) {
        reportEnrichmentIssue(`TMDB ${kind} 갤러리 수집 실패 (${pair.code})`, error);
      }
    }
  }

  const items = Object.values(records);
  window.__tmdbGalleryCache[cacheKey] = { ts: Date.now(), items: items };
  return items;
}

function mergeGalleryImages(data, kind, items) {
  const isPoster = kind === 'posters';
  const displayToken = isPoster ? 'w500' : 'w780';
  const highToken = isPoster ? 'w780' : 'w1280';
  const lists = isPoster
    ? {
        display: data.images.posters,
        high: data.images.posters_high,
        original: data.images.posters_original
      }
    : {
        display: data.images.backdrops,
        high: data.images.backdrops_high,
        original: data.images.backdrops_original
      };

  (items || []).forEach(item => {
    const record = (typeof item === 'string') ? { url: item } : (item || {});
    const originalUrl = record.url || '';
    if (!originalUrl) return;

    const variants = buildImageVariants(originalUrl, displayToken, highToken);
    const urls = {};
    urls[displayToken] = variants.display;
    urls[highToken] = variants.high;
    urls.original = variants.original;

    const meta = {
      file_path: record.file_path || ('/' + getImageFilename(originalUrl)),
      id: record.id || null,
      iso_639_1: record.iso_639_1 || null,
      width: record.width || null,
      height: record.height || null,
      aspect_ratio: record.aspect_ratio || null,
      urls: urls
    };

    lists.display.push(Object.assign({ url: variants.display }, meta));
    lists.high.push({ url: variants.high });
    lists.original.push({ url: variants.original });
  });

  const dedupedDisplay = dedupeImagesByFilename(lists.display);
  const dedupedHigh = dedupeImagesByFilename(lists.high);
  const dedupedOriginal = dedupeImagesByFilename(lists.original);

  if (isPoster) {
    data.images.posters = dedupedDisplay;
    data.images.posters_high = dedupedHigh;
    data.images.posters_original = dedupedOriginal;
  } else {
    data.images.backdrops = dedupedDisplay;
    data.images.backdrops_high = dedupedHigh;
    data.images.backdrops_original = dedupedOriginal;
  }
}

function getCrewDepartment(role) {
  const roleLower = String(role || '').toLowerCase();
  // "Director of Photography"는 Directing이 아니라 Camera다( director 검사보다 먼저 )
  if (roleLower.includes('director of photography') || roleLower.includes('cinematographer') || roleLower.includes('still photographer')) return 'Camera';
  if (roleLower.includes('art direction') || roleLower.includes('set decoration') || roleLower.includes('production design') || roleLower.includes('art director')) return 'Art';
  if (roleLower.includes('director')) return 'Directing';
  if (roleLower.includes('creator')) return 'Creator';
  if (roleLower.includes('writer') || roleLower.includes('screenplay') || roleLower.includes('story')) return 'Writing';
  if (roleLower.includes('producer')) return 'Production';
  if (roleLower.includes('editor')) return 'Editing';
  if (roleLower.includes('music') || roleLower.includes('composer')) return 'Sound';
  if (roleLower.includes('costume') || roleLower.includes('makeup') || roleLower.includes('hair')) return 'Costume & Make-Up';
  if (roleLower.includes('visual effects') || roleLower.includes('vfx')) return 'Visual Effects';
  return 'Other';
}

function normalizeDepartmentLabel(label) {
  // TMDB h4 제목 뒤에 인원수가 붙는다: "미술 3", "연출 4", "Costume & Make-Up 7"
  const text = String(label || '').trim().replace(/[\s\d]+$/, '').trim();
  const koreanMap = {
    '미술': 'Art',
    '카메라': 'Camera',
    '의상 & 분장': 'Costume & Make-Up',
    '제작진': 'Crew',
    '연출': 'Directing',
    '편집': 'Editing',
    '조명': 'Lighting',
    '제작': 'Production',
    '음향': 'Sound',
    '시각 효과': 'Visual Effects',
    '각본': 'Writing'
  };
  if (koreanMap[text]) return koreanMap[text];

  const english = ['Art', 'Camera', 'Costume & Make-Up', 'Crew', 'Directing', 'Editing', 'Lighting', 'Production', 'Sound', 'Visual Effects', 'Writing'];
  return english.find(name => name.toLowerCase() === text.toLowerCase()) || '';
}

function findCastList(doc) {
  const headings = Array.from(doc.querySelectorAll('h2, h3'));
  const castHeading = headings.find(h => /출연진|^Cast\b/i.test(h.textContent.trim()));
  if (castHeading) {
    const next = castHeading.nextElementSibling;
    if (next && next.matches('ol.people, ul.people')) return next;
    const scope = castHeading.parentElement;
    const nested = scope ? scope.querySelector('ol.people, ul.people') : null;
    if (nested) return nested;
  }
  return doc.querySelector('ol.people.credits, ul.people.credits') || null;
}

// 제작진 목록은 ol.people.crew가 기본이지만, 마크업에 따라 부서 h3/h4 뒤의
// ol.people/ul.people로만 존재할 수 있다. 출연진 목록을 제작진으로 오인하지 않도록
// 부서명이 들어간 헤딩과 연결된 목록만 채택한다.
function findCrewLists(doc) {
  const primary = Array.from(doc.querySelectorAll('ol.people.crew, ul.people.crew'));
  if (primary.length > 0) return primary;

  const crewHeading = /제작|연출|각본|제작진|음향|미술|카메라|의상|분장|편집|조명|시각|crew|direct|writing|production|sound|art|camera|costume|editing|lighting|visual/i;
  const found = [];
  Array.from(doc.querySelectorAll('h3, h4')).forEach(heading => {
    if (!crewHeading.test(heading.textContent.trim())) return;
    const scope = heading.parentElement || doc;
    Array.from(scope.querySelectorAll('ol.people, ul.people')).forEach(list => {
      if (found.indexOf(list) === -1) found.push(list);
    });
  });
  return found;
}

function crewHeadingFor(list) {
  let node = list.previousElementSibling;
  while (node && !/^H[34]$/.test(node.tagName)) node = node.previousElementSibling;
  if (node) return node.textContent.trim();

  const parent = list.parentElement;
  if (parent) {
    const heading = parent.querySelector('h4, h3');
    if (heading) return heading.textContent.trim();
    const previous = parent.previousElementSibling;
    const nested = previous && previous.querySelector ? previous.querySelector('h4, h3') : null;
    if (nested) return nested.textContent.trim();
  }
  return '';
}

// /cast 문서에서 "인물 페이지 링크"만 뽑는다(감독 판별 포함).
// 크롤러는 이 정보로 배우/감독 인물 큐를 채운다.
async function fetchCreditLinks(basePath) {
  const doc = await fetchHtmlDoc(basePath + '/cast');
  const cast = [];
  const directors = [];
  const seen = {};

  function personEntry(anchor) {
    const href = (anchor && anchor.getAttribute('href')) || '';
    const match = href.match(/^\/person\/(\d+)(?:-([^/?#]*))?/);
    if (!match) return null;
    return {
      t: 'person',
      id: match[1],
      url: '/person/' + match[1] + (match[2] ? '-' + match[2] : '')
    };
  }

  const castList = findCastList(doc);
  if (castList) {
    castList.querySelectorAll('li').forEach(li => {
      const entry = personEntry(li.querySelector('.info p a[href^="/person/"], p a[href^="/person/"], a[href^="/person/"]'));
      if (entry && !seen['c' + entry.id]) {
        seen['c' + entry.id] = true;
        cast.push(entry);
      }
    });
  }

  findCrewLists(doc).forEach(list => {
    const heading = crewHeadingFor(list);
    const department = normalizeDepartmentLabel(heading);
    const headingIsDirecting = department === 'Directing' || /감독|연출|director/i.test(heading);

    list.querySelectorAll('li').forEach(li => {
      const jobEl = li.querySelector('p.episode_count_crew, p.character, .character');
      const job = jobEl ? jobEl.textContent.trim() : '';
      if (!headingIsDirecting && !/감독|director|연출/i.test(job)) return;

      const entry = personEntry(li.querySelector('.info p a[href^="/person/"], p a[href^="/person/"], a[href^="/person/"]'));
      if (entry && !seen['d' + entry.id]) {
        seen['d' + entry.id] = true;
        directors.push(entry);
      }
    });
  });

  return { cast: cast, directors: directors };
}

async function fetchCastAndCrew(basePath) {
  const doc = await fetchHtmlDoc(basePath + '/cast');
  const castList = findCastList(doc);
  const castNames = {};
  const cast = [];

  if (castList) {
    castList.querySelectorAll('li').forEach(li => {
      const nameLink = li.querySelector('.info p a, p a');
      const name = nameLink ? nameLink.textContent.trim() : '';
      if (!name || castNames[name]) return;
      castNames[name] = true;

      const characterEl = li.querySelector('p.character, .character');
      const imageUrl = getImageSource(li.querySelector('img'));
      const personMatch = String(nameLink.getAttribute('href') || '').match(/\/person\/(\d+)(?:-([^/?#]*))?/);
      const orderAttr = li.getAttribute('data-order');
      const profileWrap = li.querySelector('.glyphicons.picture.profile, .profile');
      let placeholderClass = '';
      if (profileWrap) {
        if (profileWrap.classList.contains('one')) placeholderClass = 'one';
        else if (profileWrap.classList.contains('two')) placeholderClass = 'two';
      }

      cast.push({
        id: personMatch ? Number(personMatch[1]) : null,
        order: orderAttr !== null ? Number(orderAttr) + 1 : cast.length + 1,
        credit_id: li.getAttribute('data-credit-id') || '',
        cast_id: li.getAttribute('data-cast-id') ? Number(li.getAttribute('data-cast-id')) : null,
        name: name,
        character: characterEl ? characterEl.textContent.trim() : '',
        known_for_department: 'Acting',
        profile_path: imageUrl ? '/' + getImageFilename(imageUrl) : '',
        placeholder_class: placeholderClass,
        image: imageUrl ? replaceImageSize(imageUrl, 'w276_and_h350_face') : '',
        image_high: imageUrl ? replaceImageSize(imageUrl, 'h632') : '',
        image_original: imageUrl ? replaceImageSize(imageUrl, 'original') : '',
        episodes: null
      });
    });
  }

  const crew = [];
  findCrewLists(doc).forEach(list => {
    const heading = crewHeadingFor(list);
    const listedDepartment = normalizeDepartmentLabel(heading);

    list.querySelectorAll('li').forEach(li => {
      const nameLink = li.querySelector('.info p a, p a');
      const name = nameLink ? nameLink.textContent.trim() : '';
      if (!name) return;  // 배우 겸 제작진도 수집한다(중복은 merge 단계에서 제거)

      const jobEl = li.querySelector('p.episode_count_crew, p.character, .character');
      const job = jobEl ? jobEl.textContent.trim() : '';
      if (!job) return;

      const personMatch = String(nameLink.getAttribute('href') || '').match(/\/person\/(\d+)(?:-([^/?#]*))?/);

      job.split(',').map(part => part.trim()).filter(Boolean).forEach(singleJob => {
        if (crew.some(member => member.name === name && member.job === singleJob)) return;
        crew.push({
          id: personMatch ? Number(personMatch[1]) : null,
          credit_id: li.getAttribute('data-credit-id') || '',
          name: name,
          job: singleJob,
          department: listedDepartment || getCrewDepartment(singleJob)
        });
      });
    });
  });

  let castTotal = cast.length;
  let crewTotal = crew.length;
  doc.querySelectorAll('h3').forEach(heading => {
    const text = heading.textContent.trim();
    let match = text.match(/(?:출연진|Cast)\s*(\d+)/i);
    if (match) castTotal = Number(match[1]);
    match = text.match(/(?:제작진|Crew)\s*(\d+)/i);
    if (match) crewTotal = Number(match[1]);
  });

  return { cast: cast, crew: crew, castTotal: castTotal, crewTotal: crewTotal };
}

function mergeCastAndCrew(data, fetched) {
  fetched.cast.forEach(actor => {
    const existing = data.credits.cast.find(row => row.name === actor.name);
    if (existing) {
      // 메인 페이지 카드에는 없는 상세 메타를 전체 캐스트 페이지 값으로 보강한다.
      ['id', 'order', 'credit_id', 'cast_id', 'profile_path', 'placeholder_class', 'known_for_department'].forEach(key => {
        if ((existing[key] === undefined || existing[key] === null || existing[key] === '') &&
          actor[key] !== undefined && actor[key] !== null && actor[key] !== '') {
          existing[key] = actor[key];
        }
      });
      return;
    }
    data.credits.cast.push(actor);
  });

  fetched.crew.forEach(member => {
    const existing = data.credits.crew.find(row => row.name === member.name && row.job === member.job);
    if (existing) {
      ['id', 'credit_id'].forEach(key => {
        if (!existing[key] && member[key]) existing[key] = member[key];
      });
      return;
    }
    data.credits.crew.push(member);
  });

  if (fetched.castTotal) {
    data.credits.castTotal = Math.max(Number(data.credits.castTotal) || 0, fetched.castTotal);
  }
  if (fetched.crewTotal) {
    data.credits.crewTotal = Math.max(Number(data.credits.crewTotal) || 0, fetched.crewTotal);
  }
}

async function fetchAllVideos(basePath, existingVideos) {
  const doc = await fetchHtmlDoc(basePath + '/videos');
  const videos = (existingVideos || []).slice();
  const seen = {};
  videos.forEach(video => { if (video.key) seen[video.key] = true; });

  doc.querySelectorAll('.video.card, .video').forEach(card => {
    const link = card.querySelector('a[data-id], [data-video-id]');
    if (!link) return;

    const key = link.getAttribute('data-id') || link.getAttribute('data-video-id');
    if (!key || seen[key]) return;
    seen[key] = true;

    const titleEl = card.querySelector('h2 a, .title');
    const title = (titleEl && titleEl.textContent.trim()) ||
      link.getAttribute('data-title') || 'Video';
    const site = link.getAttribute('data-site') || 'YouTube';

    videos.push({
      name: title,
      url: `https://www.youtube.com/watch?v=${key}`,
      site: site,
      key: key
    });
  });

  return videos;
}

async function fetchReleases(basePath) {
  const doc = await fetchHtmlDoc(basePath + '/releases');
  const releases = [];

  doc.querySelectorAll('table.releases').forEach(table => {
    const heading = table.querySelector('h2.release');
    const country = heading ? heading.textContent.trim() : '';
    const countryCode = heading ? (heading.getAttribute('id') || '') : '';

    table.querySelectorAll('tbody tr').forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) return;
      const date = cells[0].textContent.trim();
      if (!date) return;

      releases.push({
        country: country,
        countryCode: countryCode,
        date: date,
        certification: cells[1].textContent.trim(),
        type: cells[2].textContent.trim(),
        language: cells[3].textContent.trim(),
        note: cells[4] ? cells[4].textContent.trim() : ''
      });
    });
  });

  return releases;
}

function getTmdbWikidataProperty(kind) {
  if (kind === 'tv') return 'P4983';
  if (kind === 'person') return 'P4985';
  return 'P4947';
}

async function fetchWikidataEnrichment(page) {
  if (!page || !page.id) return null;

  if (!window.__tmdbWikidataCache) window.__tmdbWikidataCache = {};
  const cache = window.__tmdbWikidataCache;
  const cacheKey = `${page.kind}:${page.id}`;
  const cached = cache[cacheKey];
  if (cached && (Date.now() - cached.ts) < 30 * 60 * 1000) return cached.data;

  const property = getTmdbWikidataProperty(page.kind);
  // OPTIONAL을 이어 붙이면 카르테시안 곱이 되어 LIMIT에서 잘리므로 UNION으로 분리한다
  const query = `SELECT ?item ?itemLabel ?companyLabel ?countryLabel ?languageLabel ?iso ?imdb ?website WHERE {
    ?item wdt:${property} "${page.id}".
    { ?item wdt:P272 ?company. } UNION
    { ?item wdt:P495 ?country. } UNION
    { ?item wdt:P364 ?language. OPTIONAL { ?language wdt:P218 ?iso. } } UNION
    { ?item wdt:P345 ?imdb. } UNION
    { ?item wdt:P856 ?website. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
  } LIMIT 500`;

  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);
  const response = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { Accept: 'application/sparql-results+json' }
  }, 8000);
  if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);

  const json = await response.json();
  const bindings = (json.results && json.results.bindings) || [];
  const enrichment = {
    entityId: '',
    entityUrl: '',
    label: '',
    tmdbId: String(page.id),
    imdbId: '',
    officialWebsite: '',
    companies: [],
    countries: [],
    languages: [],
    languageCode: ''
  };

  const pushUnique = (list, value) => {
    if (value && !list.includes(value)) list.push(value);
  };

  bindings.forEach(row => {
    pushUnique(enrichment.companies, row.companyLabel && row.companyLabel.value);
    pushUnique(enrichment.countries, row.countryLabel && row.countryLabel.value);
    pushUnique(enrichment.languages, row.languageLabel && row.languageLabel.value);
    if (!enrichment.languageCode && row.iso && row.iso.value) {
      enrichment.languageCode = row.iso.value;
    }
    if (!enrichment.imdbId && row.imdb && row.imdb.value) {
      enrichment.imdbId = row.imdb.value;
    }
    if (!enrichment.entityId && row.item && row.item.value) {
      enrichment.entityId = row.item.value.split('/').pop();
      enrichment.entityUrl = row.item.value;
    }
    if (!enrichment.label && row.itemLabel && row.itemLabel.value) {
      enrichment.label = row.itemLabel.value;
    }
    if (!enrichment.officialWebsite && row.website && row.website.value) {
      enrichment.officialWebsite = row.website.value;
    }
  });

  cache[cacheKey] = { ts: Date.now(), data: enrichment };
  return enrichment;
}

function mergeWikidata(data, enrichment) {
  if (!enrichment) return;

  // Wikidata에서 확인된 보조 데이터는 별도 객체로도 보존한다.
  if (enrichment.entityId) {
    data.wikidata = {
      entityId: enrichment.entityId,
      url: enrichment.entityUrl,
      label: enrichment.label,
      tmdbId: enrichment.tmdbId,
      imdbId: enrichment.imdbId,
      officialWebsite: enrichment.officialWebsite,
      companies: enrichment.companies.slice(),
      countries: enrichment.countries.slice(),
      languages: enrichment.languages.slice(),
      languageCode: enrichment.languageCode
    };
  }
  if (!data.homepage && enrichment.officialWebsite) {
    data.homepage = enrichment.officialWebsite;
  }

  if (data.productionCompanies.length === 0) {
    enrichment.companies.forEach(name => data.productionCompanies.push({ name: name }));
  }
  if (data.productionCountries.length === 0) {
    enrichment.countries.forEach(name => data.productionCountries.push({ name: name }));
  }
  if (data.spokenLanguages.length === 0) {
    enrichment.languages.forEach(name => data.spokenLanguages.push({ name: name }));
  }
  if (!data.originalLanguageCode && enrichment.languageCode) {
    data.originalLanguageCode = enrichment.languageCode;
  }
  if (!data.imdbId && enrichment.imdbId) {
    data.imdbId = enrichment.imdbId;
  }
}

async function fetchOmdb(apiKey, page, data) {
  const key = String(apiKey || '').trim();
  if (!key) return null;

  if (!window.__omdbCache) window.__omdbCache = {};
  const cacheKey = data.imdbId || `${page.kind}:${data.title || ''}:${String(data.releaseDate || '').slice(0, 4)}`;
  const cached = window.__omdbCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) return cached.data;

  let url = 'https://www.omdbapi.com/?apikey=' + encodeURIComponent(key) + '&plot=full';
  if (data.imdbId) {
    url += '&i=' + encodeURIComponent(data.imdbId);
  } else {
    if (!data.title) return null;
    url += '&t=' + encodeURIComponent(data.title);
    const year = String(data.releaseDate || '').slice(0, 4);
    if (/^\d{4}$/.test(year)) url += '&y=' + year;
    url += '&type=' + (page.kind === 'tv' ? 'series' : 'movie');
  }

  const response = await fetchWithTimeout(url, { credentials: 'omit' }, 8000);
  if (!response.ok) throw new Error('OMDb HTTP ' + response.status);

  const json = await response.json();
  if (String(json.Response) !== 'True') return null;

  const result = {
    title: json.Title || '',
    year: json.Year || '',
    rated: json.Rated || '',
    released: json.Released || '',
    runtime: json.Runtime || '',
    genre: json.Genre || '',
    director: json.Director || '',
    writer: json.Writer || '',
    actors: json.Actors || '',
    plot: json.Plot || '',
    language: json.Language || '',
    country: json.Country || '',
    awards: json.Awards || '',
    poster: (json.Poster && json.Poster !== 'N/A') ? json.Poster : '',
    ratings: Array.isArray(json.Ratings) ? json.Ratings : [],
    metascore: json.Metascore || '',
    imdbRating: json.imdbRating || '',
    imdbVotes: json.imdbVotes || '',
    imdbID: json.imdbID || '',
    type: json.Type || '',
    dvd: json.DVD || '',
    boxOffice: json.BoxOffice || '',
    production: json.Production || '',
    website: json.Website || ''
  };

  window.__omdbCache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

function mergeOmdb(data, omdb) {
  if (!omdb) return;
  data.omdb = omdb;
  if (!data.imdbId && omdb.imdbID) data.imdbId = omdb.imdbID;
  if (!data.overview && omdb.plot) data.overview = omdb.plot;
}

async function enrichMediaData(data, options) {
  const page = getPageInfo();
  if (!page || !page.id) return;

  const basePath = `/${page.kind}/${page.id}`;
  const tasks = [];

  if (options.galleries) {
    tasks.push((async () => {
      for (const kind of ['posters', 'backdrops']) {
        try {
          const targetCount = Number(data[kind === 'posters' ? 'posterCount' : 'backdropCount']) || 0;
          const urls = await fetchGalleryUrls(kind, basePath, Object.assign({}, options, { targetCount: targetCount }));
          if (urls.length > 0) mergeGalleryImages(data, kind, urls);
        } catch (error) {
          reportEnrichmentIssue(`TMDB ${kind} 보강 실패`, error);
        }
      }
    })());
  }

  if (options.cast) {
    tasks.push((async () => {
      try {
        const fetched = await fetchCastAndCrew(basePath);
        mergeCastAndCrew(data, fetched);
      } catch (error) {
        reportEnrichmentIssue('TMDB 출연진/제작진 보강 실패', error);
      }
    })());
  }

  if (options.videos) {
    tasks.push((async () => {
      try {
        data.videos = await fetchAllVideos(basePath, data.videos);
      } catch (error) {
        reportEnrichmentIssue('TMDB 영상 보강 실패', error);
      }
    })());
  }

  if (options.releases && page.kind === 'movie') {  // TV에는 /releases 페이지가 없다(404)
    tasks.push((async () => {
      try {
        const releases = await fetchReleases(basePath);
        if (releases.length > 0) data.releases = releases;
      } catch (error) {
        reportEnrichmentIssue('TMDB 방송일 보강 실패', error);
      }
    })());
  }

  // Wikidata로 IMDb ID를 먼저 확보한 뒤 OMDb를 호출한다(같은 작업 안에서 순차 실행).
  if (options.wikidata || options.omdbApiKey) {
    tasks.push((async () => {
      if (options.wikidata) {
        try {
          mergeWikidata(data, await fetchWikidataEnrichment(page));
        } catch (error) {
          reportEnrichmentIssue('Wikidata 보강 실패', error);
        }
      }
      if (options.omdbApiKey) {
        try {
          mergeOmdb(data, await fetchOmdb(options.omdbApiKey, page, data));
        } catch (error) {
          reportEnrichmentIssue('OMDb 보강 실패', error);
        }
      }
    })());
  }

  await Promise.all(tasks);
}

// ===== 토스트 메시지 표시 함수 =====
function showToast(message, type = 'success') {
  const existingToast = document.getElementById('tmdb-toast');
  if (existingToast) {
    existingToast.remove();
  }

  let style = document.getElementById('tmdb-toast-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'tmdb-toast-style';
    style.textContent = `
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
    `;
    document.head.appendChild(style);
  }

  const toast = document.createElement('div');
  toast.id = 'tmdb-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: ${type === 'success' ? '#1a1a2e' : '#2d1a1a'};
    color: ${type === 'success' ? '#7bed9f' : '#ff6b6b'};
    padding: 16px 32px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    font-size: 15px;
    font-weight: 500;
    z-index: 9999999;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    border: 1px solid ${type === 'success' ? '#2a2a4a' : '#4a2a2a'};
    animation: slideUp 0.3s ease-out;
    max-width: 90%;
    text-align: center;
  `;

  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s';
    setTimeout(() => {
      toast.remove();
    }, 500);
  }, 3000);
}

// ===== 배우(Person) 데이터 추출 함수 =====
function extractPersonData() {
  const data = {
    name: '',
    profileImage: '',
    profileImage_high: '',
    profileImage_original: '',
    knownFor: '',
    knownCredits: '',
    gender: '',
    birthday: '',
    age: '',
    placeOfBirth: '',
    alsoKnownAs: [],
    biography: '',
    contentScore: '',
    knownForWorks: [],
    youtubeLinks: [],
    credits: {
      acting: [],
      production: [],
      all: []
    },
    schemaVersion: '1.7.2',
    sourceUrl: window.location.href,
    extractedAt: new Date().toISOString()
  };

  try {
    function $(selector) {
      try { return document.querySelector(selector); } 
      catch (e) { return null; }
    }

    function $$(selector) {
      try { return document.querySelectorAll(selector); } 
      catch (e) { return []; }
    }

    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    let ldData = null;
    
    for (const script of scripts) {
      try {
        const jsonData = JSON.parse(script.textContent);
        if (jsonData && jsonData['@type'] === 'Person') {
          ldData = jsonData;
          break;
        }
      } catch (e) {}
    }

    if (ldData) {
      data.name = ldData.name || '';
      data.birthday = ldData.birthDate || '';
      data.biography = ldData.description || '';
      data.gender = ldData.gender || '';
      
      if (ldData.image) {
        const profileUrl = ldData.image;
        data.profileImage = profileUrl;
        data.profileImage_high = getHighResImage(profileUrl, 'high');
        data.profileImage_original = getHighResImage(profileUrl, 'original');
      }
    }

    const titleEl = $('.title h2 a, .title h2');
    if (titleEl) {
      data.name = titleEl.textContent.trim();
    }

    const profileImg = $('.image_content .profile img, #original_header .profile img');
    if (profileImg) {
      const src = profileImg.getAttribute('src');
      if (src) {
        data.profileImage = src;
        data.profileImage_high = getHighResImage(src, 'high');
        data.profileImage_original = getHighResImage(src, 'original');
      }
    }

    const factsEls = $$('.facts p, .facts .full');
    const ulEls = $$('.facts ul li');

    factsEls.forEach(el => {
      const strong = el.querySelector('strong');
      if (strong) {
        const label = strong.textContent.trim();
        const value = el.textContent.replace(label, '').trim();
        
        if (label.includes('Known For') || label.includes('전문 분야')) data.knownFor = value;
        else if (label.includes('Known Credits') || label.includes('참여 작품 수')) data.knownCredits = value;
        else if (label.includes('Gender') || label.includes('성별')) data.gender = value;
        else if (label.includes('Birthday') || label.includes('생일') || label.includes('출생일')) {
          data.birthday = value;
          const ageMatch = value.match(/(\d+)\s*(?:years?\s*old|세)/);
          if (ageMatch) data.age = ageMatch[1] + ' years old';
        } else if (label.includes('Place of Birth') || label.includes('출생지')) data.placeOfBirth = value;
      }
    });

    ulEls.forEach(el => {
      const name = el.textContent.trim();
      if (name && !data.alsoKnownAs.includes(name)) data.alsoKnownAs.push(name);
    });

    const biographyEl = $('.biography .content .text p, .biography .content p');
    if (biographyEl) data.biography = biographyEl.textContent.trim();

    const contentScoreEl = $('.content_score .content_score div p');
    if (contentScoreEl) data.contentScore = contentScoreEl.textContent.trim();

    // Known For 작품 목록 추출
    const knownForSection = document.getElementById('known_for');
    if (knownForSection) {
      const items = knownForSection.querySelectorAll('li.item_adult_false, li');
      items.forEach(item => {
        const link = item.querySelector('a[href]');
        const img = item.querySelector('img');
        const titleEl2 = item.querySelector('p a.title');
        
        if (link) {
          const href = link.getAttribute('href') || '';
          const title = titleEl2 ? titleEl2.textContent.trim() : '';
          const posterUrl = img ? img.getAttribute('src') || '' : '';
          
          let mediaType = 'unknown';
          if (href.includes('/movie/')) mediaType = 'movie';
          else if (href.includes('/tv/')) mediaType = 'tv';
          
          const idMatch = href.match(/\/(movie|tv)\/(\d+)/);
          const id = idMatch ? idMatch[2] : '';
          
          if (title && !data.knownForWorks.find(w => w.title === title && w.id === id)) {
            data.knownForWorks.push({
              id: id,
              title: title,
              mediaType: mediaType,
              poster: posterUrl,
              poster_high: posterUrl ? getHighResImage(posterUrl, 'high') : '',
              poster_original: posterUrl ? getHighResImage(posterUrl, 'original') : '',
              url: href
            });
          }
        }
      });
    }

    // 크레딧 전체(연기/제작/각본/제작진/편집/창작자 등) — h3.zero 같은 위치 클래스 대신
    // 섹션 라벨(.credit_heading) 기준으로 모든 .credit_group 행을 수집한다.
    // 부서 라벨은 .credit_heading(전체 필터 UI 1개)이 아니라 섹션 h3에 있다.
    const departmentLabels = /^(연기|제작|제작진|각본|연출|편집|창작자|음향|미술|카메라|의상|분장|시각|조명|Acting|Production|Crew|Writing|Directing|Editing|Creator|Sound|Art|Camera|Costume|Visual|Lighting)/i;
    const creditHeadings = Array.from(document.querySelectorAll('h3'))
      .map(heading => ({
        el: heading,
        label: heading.textContent.replace(/\s+/g, ' ').replace(/\s*\d+\s*$/, '').trim()
      }))
      .filter(entry => departmentLabels.test(entry.label));

    function getSectionLabel(table) {
      let label = '';
      creditHeadings.forEach(entry => {
        if (entry.el.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
          label = entry.label;
        }
      });
      return label;
    }

    function departmentFromLabel(label) {
      const text = String(label || '').toLowerCase();
      if (!text) return '';
      if (/연기|acting/.test(text)) return 'Acting';
      if (/제작진|crew/.test(text)) return 'Crew';
      if (/각본|writing|script/.test(text)) return 'Writing';
      if (/연출|directing/.test(text)) return 'Directing';
      if (/제작|production/.test(text)) return 'Production';
      if (/편집|editing/.test(text)) return 'Editing';
      if (/음향|sound/.test(text)) return 'Sound';
      if (/미술|art/.test(text)) return 'Art';
      if (/카메라|camera|photography/.test(text)) return 'Camera';
      if (/의상|분장|costume/.test(text)) return 'Costume & Make-Up';
      if (/시각|visual effects/.test(text)) return 'Visual Effects';
      if (/조명|lighting/.test(text)) return 'Lighting';
      if (/창작|creator/.test(text)) return 'Creator';
      return label;
    }

    const seenCredits = {};

    document.querySelectorAll('.credit_group').forEach(table => {
      const sectionLabel = getSectionLabel(table);
      const department = departmentFromLabel(sectionLabel);

      table.querySelectorAll('tr').forEach(row => {
        const titleLink = row.querySelector('.role a');
        if (!titleLink) return;

        const title = titleLink.textContent.trim();
        if (!title) return;

        const titleUrl = titleLink.getAttribute('href') || '';
        const idMatch = titleUrl.match(/\/(movie|tv)\/(\d+)/);
        const yearEl = row.querySelector('.year');
        const characterEl = row.querySelector('.character');
        const roleEl = row.querySelector('.role span.role, .role .role');
        const episodeEl = row.querySelector('.tv');

        const year = yearEl ? yearEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const character = characterEl ? characterEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const role = roleEl ? roleEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const episodes = episodeEl ? episodeEl.textContent.replace(/\s+/g, ' ').trim() : '';
        const mediaType = titleUrl.includes('/movie/') ? 'movie' : titleUrl.includes('/tv/') ? 'tv' : 'unknown';

        const key = [department, title, year, role, character, idMatch ? idMatch[2] : ''].join('|');
        if (seenCredits[key]) return;
        seenCredits[key] = true;

        data.credits.all.push({
          department: department,
          year: year || null,
          title: title,
          id: idMatch ? idMatch[2] : '',
          mediaType: mediaType,
          role: role || null,
          character: character || null,
          episodes: episodes || null
        });

        if (department === 'Acting' && !data.credits.acting.some(c => c.title === title && c.year === (year || null))) {
          data.credits.acting.push({
            year: year || null,
            title: title,
            mediaType: mediaType,
            character: character || null,
            episodes: episodes || null
          });
        }

        if (department === 'Production' && !data.credits.production.some(c => c.title === title && c.year === (year || null))) {
          data.credits.production.push({
            year: year || null,
            title: title,
            mediaType: mediaType,
            role: role || null
          });
        }
      });
    });

  } catch (error) {
    console.error('배우 데이터 추출 중 오류:', error);
    throw error;
  }

  data.youtubeLinks = collectYoutubeLinks([data.biography]);
  return data;
}

// ===== 미디어(영화/TV) 데이터 추출 함수 (통합) =====
async function extractMediaData(options = {}) {
  const pageInfo = getPageInfo();
  const isTV = pageInfo.kind === 'tv';
  
  const data = {
    title: '',
    originalTitle: '',
    releaseDate: '',
    genres: [],
    overview: '',
    voteAverage: '',
    voteCount: '',
    userScorePercent: '',
    runtime: '',
    status: '',
    tagline: '',
    homepage: '',
    productionCompanies: [],
    productionCountries: [],
    spokenLanguages: [],
    credits: {
      cast: [],
      crew: [],
      castTotal: 0,
      crewTotal: 0,
      directors: [],
      writers: []
    },
    videos: [],
    youtubeLinks: [],
    mediaSection: { tabs: [], items: [] },
    topBilledCast: [],
    imdbId: '',
    omdb: null,
    wikidata: null,
    images: {
      posters: [],
      backdrops: [],
      posters_high: [],
      posters_original: [],
      backdrops_high: [],
      backdrops_original: []
    },
    seasons: [],
    networks: [],
    type: '',
    originalLanguage: '',
    originalLanguageCode: '',
    keywords: [],
    budget: '',
    revenue: '',
    reviewCount: '',
    discussionCount: '',
    videoCount: '',
    backdropCount: '',
    posterCount: '',
    contentScore: '',
    certification: '',
    releaseInfo: '',
    runtimeInfo: '',
    releases: [],
    statusKey: '',
    isComplete: false,
    schemaVersion: '1.7.2',
    sourceUrl: window.location.href,
    extractedAt: new Date().toISOString()
  };

  try {
    function $(selector) {
      try { return document.querySelector(selector); } 
      catch (e) { return null; }
    }

    function $$(selector) {
      try { return document.querySelectorAll(selector); } 
      catch (e) { return []; }
    }

    // facts 영역은 TV 전용 블록보다 먼저 선언되어야 함 (TDZ 방지)
    const factsEls = $$('.facts .wrap, .facts p');

    // facts 라벨 기반 값 추출 (페이지에 별도 섹션이 없을 때 폴백)
    function getFactValues(labels) {
      for (const el of factsEls) {
        const strong = el.querySelector('strong');
        if (!strong) continue;
        const label = strong.textContent.trim();
        if (!labels.some(target => label.includes(target))) continue;

        const links = el.querySelectorAll('a');
        if (links.length > 0) {
          return Array.from(links).map(a => a.textContent.trim()).filter(Boolean);
        }
        return el.textContent
          .replace(strong.textContent, '')
          .split(/\s*,\s*/)
          .map(value => value.trim())
          .filter(Boolean);
      }
      return [];
    }

    // ===== 1. LD+JSON 데이터 추출 =====
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    let ldData = null;
    
    for (const script of scripts) {
      try {
        const jsonData = JSON.parse(script.textContent);
        if (jsonData && (jsonData['@type'] === 'TVSeries' || jsonData['@type'] === 'Movie')) {
          ldData = jsonData;
          break;
        }
      } catch (e) {}
    }

    if (ldData) {
      data.title = ldData.name || '';
      data.originalTitle = ldData.alternateName || ldData.originalName || '';
      data.overview = ldData.description || '';
      data.tagline = ldData.tagline || '';
      
      if (ldData.startDate) data.releaseDate = ldData.startDate;
      else if (ldData.datePublished) data.releaseDate = ldData.datePublished;
      else if (ldData.releasedEvent) {
        const event = Array.isArray(ldData.releasedEvent) ? ldData.releasedEvent[0] : ldData.releasedEvent;
        if (event && event.startDate) data.releaseDate = event.startDate;
      }
      
      if (ldData.genre && Array.isArray(ldData.genre)) {
        data.genres = ldData.genre;
      }
      
      if (ldData.aggregateRating) {
        data.voteAverage = ldData.aggregateRating.ratingValue || '';
        data.voteCount = ldData.aggregateRating.ratingCount || '';
        data.reviewCount = ldData.aggregateRating.reviewCount || '';
      }
      
      if (ldData.countryOfOrigin) {
        const countries = Array.isArray(ldData.countryOfOrigin) ? ldData.countryOfOrigin : [ldData.countryOfOrigin];
        countries.forEach(c => {
          const name = (typeof c === 'object' && c) ? (c.name || '') : String(c || '');
          if (name && !data.productionCountries.some(x => x.name === name)) {
            data.productionCountries.push({ name });
          }
        });
      }

      if (ldData.productionCompany) {
        const companies = Array.isArray(ldData.productionCompany) ? ldData.productionCompany : [ldData.productionCompany];
        companies.forEach(c => {
          const name = (typeof c === 'object' && c) ? (c.name || '') : String(c || '');
          if (name && !data.productionCompanies.some(x => x.name === name)) {
            data.productionCompanies.push({ name });
          }
        });
      }

      if (ldData.inLanguage) {
        data.originalLanguageCode = String(ldData.inLanguage);
      }

      if (ldData.sameAs) {
        const sameAsList = Array.isArray(ldData.sameAs) ? ldData.sameAs : [ldData.sameAs];
        sameAsList.forEach(link => {
          const match = String(link || '').match(/imdb\.com\/title\/(tt\d+)/);
          if (match && !data.imdbId) data.imdbId = match[1];
        });
      }
      
      if (ldData.duration) {
        const duration = ldData.duration;
        if (duration.startsWith('PT')) {
          const days = duration.match(/(\d+)D/);
          const hours = duration.match(/(\d+)H/);
          const mins = duration.match(/(\d+)M/);
          const secs = duration.match(/(\d+)S/);
          let result = '';
          if (days) result += days[1] + 'd ';
          if (hours) result += hours[1] + 'h ';
          if (mins) result += mins[1] + 'm ';
          if (secs) result += secs[1] + 's';
          data.runtime = result.trim() || duration;
        } else {
          data.runtime = duration;
        }
      }
      
      // TV는 방영 상태를 LD+JSON으로 추정하지 않고 DOM Status를 우선 사용
      if (!isTV) {
        if (ldData.endDate) {
          data.status = 'Ended';
        } else if (ldData.startDate) {
          data.status = 'Released';
        }
      }
    }

    // ===== 2. 기본 정보 추출 =====
    const certificationEl = document.querySelector('.certification');
    if (certificationEl) {
      data.certification = certificationEl.textContent.trim();
    }

    const releaseEl = document.querySelector('.release');
    if (releaseEl) {
      data.releaseInfo = releaseEl.textContent.trim();
      if (!data.releaseDate) {
        const dateMatch = releaseEl.textContent.trim().match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{4})/);
        if (dateMatch) data.releaseDate = dateMatch[1] || dateMatch[2];
      }
    }

    const runtimeEl = document.querySelector('.runtime');
    if (runtimeEl) {
      data.runtimeInfo = runtimeEl.textContent.trim();
      if (!data.runtime) {
        data.runtime = runtimeEl.textContent.trim();
      }
    }

    const genresSpan = document.querySelector('.genres');
    if (genresSpan) {
      const genreLinks = genresSpan.querySelectorAll('a');
      const genres = [];
      genreLinks.forEach(link => {
        const genreText = link.textContent.trim();
        if (genreText && !genres.includes(genreText)) {
          genres.push(genreText);
        }
      });
      if (genres.length > 0) {
        data.genres = genres;
      }
    }

    const overviewDiv = document.querySelector('.overview');
    if (overviewDiv) {
      const overviewP = overviewDiv.querySelector('p');
      if (overviewP) {
        const overviewText = overviewP.textContent.trim();
        if (overviewText) data.overview = overviewText;
      }
    }

    // ===== 3. 제작진 (crew) 추출 =====
    const peopleList = document.querySelector('ol.people.no_image');
    if (peopleList) {
      const profiles = peopleList.querySelectorAll('li.profile');
      profiles.forEach(profile => {
        const nameLink = profile.querySelector('p a');
        const characterP = profile.querySelector('p.character');
        
        if (nameLink) {
          const name = nameLink.textContent.trim();
          const role = characterP ? characterP.textContent.trim() : '';
          
          if (name && role) {
            // "Director, Writer"처럼 합쳐진 직무를 개별 크레딧으로 분리
            role.split(',').map(r => r.trim()).filter(Boolean).forEach(singleRole => {
              if (data.credits.crew.some(c => c.name === name && c.job === singleRole)) return;

              data.credits.crew.push({
                name: name,
                job: singleRole,
                department: getCrewDepartment(singleRole)
              });
            });
          }
        }
      });
    }

    // ===== 4. 모든 이미지 수집 =====
    // Posters 수집
    const posterUrls = new Set();
    const posterHighUrls = new Set();
    const posterOriginalUrls = new Set();
    
    const allImages = document.querySelectorAll('img');
    allImages.forEach(img => {
      const src = img.getAttribute('src');
      if (src && src.startsWith('http') && src.includes('media.themoviedb.org')) {
        if (isPosterImage(src)) {
          posterUrls.add(src);
          posterHighUrls.add(getHighResImage(src, 'high'));
          posterOriginalUrls.add(getHighResImage(src, 'original'));
        }
      }
      
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
        urls.forEach(url => {
          if (url && url.startsWith('http') && url.includes('media.themoviedb.org')) {
            if (isPosterImage(url)) {
              posterUrls.add(url);
              posterHighUrls.add(getHighResImage(url, 'high'));
              posterOriginalUrls.add(getHighResImage(url, 'original'));
            }
          }
        });
      }
      
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && dataSrc.startsWith('http') && dataSrc.includes('media.themoviedb.org')) {
        if (isPosterImage(dataSrc)) {
          posterUrls.add(dataSrc);
          posterHighUrls.add(getHighResImage(dataSrc, 'high'));
          posterOriginalUrls.add(getHighResImage(dataSrc, 'original'));
        }
      }
    });
    
    // Posters 저장
    posterUrls.forEach(url => {
      if (!data.images.posters.find(p => p.url === url)) {
        data.images.posters.push({ url: url });
      }
    });
    posterHighUrls.forEach(url => {
      if (!data.images.posters_high.find(p => p.url === url)) {
        data.images.posters_high.push({ url: url });
      }
    });
    posterOriginalUrls.forEach(url => {
      if (!data.images.posters_original.find(p => p.url === url)) {
        data.images.posters_original.push({ url: url });
      }
    });

    // 동일 포스터 파일의 여러 사이즈는 최대 해상도 1개만 유지
    data.images.posters = dedupeImagesByFilename(data.images.posters);
    
    // Backdrops 수집
    const backdropUrls = new Set();
    const backdropHighUrls = new Set();
    const backdropOriginalUrls = new Set();
    
    allImages.forEach(img => {
      const src = img.getAttribute('src');
      if (src && src.startsWith('http') && src.includes('media.themoviedb.org')) {
        if (isBackdropImage(src)) {
          backdropUrls.add(src);
          
          const srcset = img.getAttribute('srcset');
          let highResSrc = '';
          if (srcset) {
            const parts = srcset.split(',');
            if (parts.length > 1) {
              const highResPart = parts[parts.length - 1].trim();
              highResSrc = highResPart.split(' ')[0];
            }
          }
          backdropHighUrls.add(highResSrc || getHighResImage(src, 'high'));
          backdropOriginalUrls.add(getHighResImage(src, 'original'));
        }
      }
      
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
        urls.forEach(url => {
          if (url && url.startsWith('http') && url.includes('media.themoviedb.org')) {
            if (isBackdropImage(url)) {
              backdropUrls.add(url);
              backdropHighUrls.add(getHighResImage(url, 'high'));
              backdropOriginalUrls.add(getHighResImage(url, 'original'));
            }
          }
        });
      }
    });
    
    // Backdrops 저장
    backdropUrls.forEach(url => {
      if (!data.images.backdrops.find(b => b.url === url)) {
        data.images.backdrops.push({ url: url });
      }
    });
    backdropHighUrls.forEach(url => {
      if (!data.images.backdrops_high.find(b => b.url === url)) {
        data.images.backdrops_high.push({ url: url });
      }
    });
    backdropOriginalUrls.forEach(url => {
      if (!data.images.backdrops_original.find(b => b.url === url)) {
        data.images.backdrops_original.push({ url: url });
      }
    });

    // 동일 배경 파일의 여러 사이즈는 최대 해상도 1개만 유지
    data.images.backdrops = dedupeImagesByFilename(data.images.backdrops);
    
    // ===== 5. 비디오 수집 =====
    const videoIds = new Set();
    
    const trailerBtns = document.querySelectorAll('.play_trailer, .video .play_trailer, [data-id][data-site="YouTube"]');
    trailerBtns.forEach(btn => {
      const videoId = btn.getAttribute('data-id');
      const site = btn.getAttribute('data-site');
      const title = btn.getAttribute('data-title') || btn.textContent.trim() || 'Video';
      
      if (videoId && !videoIds.has(videoId)) {
        videoIds.add(videoId);
        data.videos.push({
          name: title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          site: site || 'YouTube',
          key: videoId
        });
      }
    });
    
    const videoCards = document.querySelectorAll('.video.card, .video, [data-video-id]');
    videoCards.forEach(card => {
      const videoId = card.getAttribute('data-video-id') || 
                     card.querySelector('[data-id]')?.getAttribute('data-id');
      const title = card.querySelector('.title')?.textContent?.trim() || 
                   card.getAttribute('data-title') || 'Video';
      
      if (videoId && !videoIds.has(videoId)) {
        videoIds.add(videoId);
        data.videos.push({
          name: title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          site: 'YouTube',
          key: videoId
        });
      }
    });
    
    // ===== 6. TV 전용 정보 추출 (모든 시즌) =====
    if (isTV) {
      // 6-1. 모든 시즌 정보 추출 - 시즌 카드 모두 수집
      const allSeasonCards = document.querySelectorAll('.season.card, .seasons .card');
      allSeasonCards.forEach(card => {
        const titleEl = card.querySelector('h2 a');
        const yearEl = card.querySelector('.release_date, .flex .year');
        const episodeEl = card.querySelector('.episodes, .flex .episodes');
        const overviewEl = card.querySelector('.season_overview p');
        const posterEl = card.querySelector('.poster img');
        const ratingEl = card.querySelector('.rating_border .percent');
        const seasonLink = card.querySelector('h2 a');
        
        if (titleEl) {
          const seasonName = titleEl.textContent.trim();
          const posterUrl = posterEl ? posterEl.getAttribute('src') || '' : '';
          
          // 시즌 번호 추출
          let seasonNumber = '';
          const seasonMatch = seasonName.match(/(\d+)/);
          if (seasonMatch) {
            seasonNumber = seasonMatch[1];
          } else {
            seasonNumber = seasonName.replace('시즌 ', '').replace('Season ', '').trim();
          }
          
          // 시즌 링크 추출
          let seasonUrl = '';
          if (seasonLink) {
            seasonUrl = seasonLink.getAttribute('href') || '';
          }
          
          data.seasons.push({
            name: seasonName,
            seasonNumber: seasonNumber,
            episodes: episodeEl ? episodeEl.textContent.trim() : '',
            overview: overviewEl ? overviewEl.textContent.trim() : '',
            poster: posterUrl,
            poster_high: posterUrl ? getHighResImage(posterUrl, 'high') : '',
            poster_original: posterUrl ? getHighResImage(posterUrl, 'original') : '',
            airDate: yearEl ? yearEl.textContent.trim() : '',
            rating: ratingEl ? ratingEl.textContent.trim() : '',
            url: seasonUrl
          });
        }
      });

      // 6-2. 시즌 드롭다운 메뉴에서 모든 시즌 정보 수집
      const seasonDropdown = document.querySelector('.season_selector, .season_select, select[name="season"]');
      if (seasonDropdown) {
        const options = seasonDropdown.querySelectorAll('option');
        options.forEach(opt => {
          const seasonName = opt.textContent.trim();
          const seasonValue = opt.getAttribute('value') || '';
          // 이미 수집된 시즌인지 확인
          if (seasonName && !data.seasons.find(s => s.name === seasonName)) {
            data.seasons.push({
              name: seasonName,
              seasonNumber: seasonValue,
              episodes: '',
              overview: '',
              poster: '',
              poster_high: '',
              poster_original: '',
              airDate: '',
              rating: '',
              url: ''
            });
          }
        });
      }

      // 6-3. 네트워크 정보 추출
      const networkEls = $$('.networks li, .network li');
      networkEls.forEach(el => {
        const img = el.querySelector('img');
        const link = el.querySelector('a');
        if (img) {
          const alt = img.getAttribute('alt') || '';
          const src = img.getAttribute('src') || '';
          let name = alt.replace(/See more TV shows from .*\.\.\.$/, '').trim();
          if (name && !data.networks.find(n => n.name === name)) {
            data.networks.push({ 
              name: name,
              logo: src 
            });
          }
        } else if (link) {
          const name = link.textContent.trim();
          if (name && !data.networks.find(n => n.name === name)) {
            data.networks.push({ name });
          }
        }
      });

      // 6-4. TV 타입 추출
      factsEls.forEach(el => {
        const label = el.querySelector('strong');
        if (label) {
          const labelText = label.textContent;
          if (labelText.includes('Type')) {
            const value = el.textContent.replace(label.textContent, '').trim();
            if (value) data.type = value;
          }
        }
      });
    }

    // ===== 7. 제작사, 국가, 언어 정보 추출 =====
    // 제작사
    const companySelectors = [
      '.companies a',
      '.production_companies a',
      '.company a',
      '.production-company a'
    ];
    const companyEls = [];
    for (const selector of companySelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach(el => companyEls.push(el));
      }
    }
    const uniqueCompanies = new Set();
    companyEls.forEach(el => {
      const name = el.textContent.trim();
      if (name && !uniqueCompanies.has(name)) {
        uniqueCompanies.add(name);
        data.productionCompanies.push({ name });
      }
    });
    if (data.productionCompanies.length === 0) {
      getFactValues(['Production Compan', '제작사']).forEach(name => {
        if (!data.productionCompanies.some(c => c.name === name)) {
          data.productionCompanies.push({ name });
        }
      });
    }

    // 제작 국가
    const countrySelectors = [
      '.facts .country a',
      '.facts .production_countries a',
      '.facts .countries a'
    ];
    const countryEls = [];
    for (const selector of countrySelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach(el => countryEls.push(el));
      }
    }
    countryEls.forEach(el => {
      const name = el.textContent.trim();
      if (name && !data.productionCountries.some(c => c.name === name)) {
        data.productionCountries.push({ name });
      }
    });

    // 사용 언어
    const languageSelectors = [
      '.facts .languages a',
      '.facts .spoken_languages a',
      '.languages a',
      '.spoken_languages a'
    ];
    const langEls = [];
    for (const selector of languageSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach(el => langEls.push(el));
      }
    }
    const uniqueLanguages = new Set();
    langEls.forEach(el => {
      const name = el.textContent.trim();
      if (name && !uniqueLanguages.has(name)) {
        uniqueLanguages.add(name);
        data.spokenLanguages.push({ name });
      }
    });
    if (data.spokenLanguages.length === 0) {
      getFactValues(['Spoken Languages', '언어']).forEach(name => {
        if (!data.spokenLanguages.some(l => l.name === name)) {
          data.spokenLanguages.push({ name });
        }
      });
    }

    // ===== 8. 나머지 기존 추출 로직 =====
    const titleEl = $('.title h2 a, .title h2, .header_poster_wrapper .title a');
    if (titleEl) {
      let titleText = titleEl.textContent.trim();
      titleText = titleText.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      if (titleText) data.title = titleText;
    }
    
    factsEls.forEach(el => {
      const label = el.querySelector('strong');
      if (!label) return;

      const labelText = label.textContent;
      const value = el.textContent.replace(label.textContent, '').trim();
      if (!value) return;

      if (labelText.includes('Original Title') || labelText.includes('원제')) {
        data.originalTitle = value;
      } else if (labelText.includes('Status') || labelText.includes('상태')) {
        data.status = value;
      } else if (labelText.includes('Original Language') || labelText.includes('원어')) {
        data.originalLanguage = value;
      } else if (labelText.includes('Budget') || labelText.includes('제작비')) {
        data.budget = value;
      } else if (labelText.includes('Revenue') || labelText.includes('수익')) {
        data.revenue = value;
      }
    });
    
    const dateEl = $('.release_date, .title .release_date, .facts .release');
    if (dateEl && !data.releaseDate) {
      let date = dateEl.textContent.trim();
      date = date.replace(/[()]/g, '').trim();
      if (date) data.releaseDate = date;
    }
    
    const runtimeEl2 = $('.facts .runtime');
    if (runtimeEl2 && !data.runtime) {
      const runtime = runtimeEl2.textContent.trim();
      if (runtime) data.runtime = runtime;
    }
    
    const genreLinks = $$('.facts .genres a, .genres a');
    if (genreLinks.length > 0 && data.genres.length === 0) {
      data.genres = [];
      genreLinks.forEach(el => {
        const genre = el.textContent.trim();
        if (genre && !data.genres.includes(genre)) {
          data.genres.push(genre);
        }
      });
    }
    
    const overviewEl = $('.overview p, .header_info .overview p, [itemprop="description"]');
    if (overviewEl && !data.overview) {
      data.overview = overviewEl.textContent.trim();
    }
    
    const taglineEl = $('.tagline, .header_info .tagline');
    if (taglineEl) {
      data.tagline = taglineEl.textContent.trim();
    }
    
    const scoreEl = $('.user_score_chart');
    if (scoreEl) {
      const percent = scoreEl.getAttribute('data-percent');
      if (percent) {
        data.userScorePercent = percent + '%';
        data.voteAverage = (parseFloat(percent) / 10).toFixed(1);
      }
    }
    
    const contentScoreWrapper = $('.content_score_wrapper .content_score');
    if (contentScoreWrapper) {
      const scoreDiv = contentScoreWrapper.querySelector('.content_score div');
      if (scoreDiv) {
        const score = scoreDiv.textContent.trim();
        if (score) data.contentScore = score;
      }
    }
    
    if (!data.contentScore) {
      const contentScoreEl = $('.content_score .content_score div');
      if (contentScoreEl) {
        const score = contentScoreEl.textContent.trim();
        if (score) data.contentScore = score;
      }
    }
    
    const homepageEl = $('.homepage a, .social_links .homepage a');
    if (homepageEl) {
      data.homepage = homepageEl.getAttribute('href') || '';
    }
    
    const videoMenuEl = $('.media_panel .menu a#videos');
    if (videoMenuEl) {
      const span = videoMenuEl.querySelector('span');
      if (span) data.videoCount = span.textContent.trim();
    }
    
    const backdropMenuEl = $('.media_panel .menu a#backdrops');
    if (backdropMenuEl) {
      const span = backdropMenuEl.querySelector('span');
      if (span) data.backdropCount = span.textContent.trim();
    }
    
    const posterMenuEl = $('.media_panel .menu a#posters');
    if (posterMenuEl) {
      const span = posterMenuEl.querySelector('span');
      if (span) data.posterCount = span.textContent.trim();
    }
    
    const discussionMenuEl = $('.social_panel .menu a#discussions');
    if (discussionMenuEl) {
      const span = discussionMenuEl.querySelector('span');
      if (span) data.discussionCount = span.textContent.trim();
    }
    
    const reviewMenuEl = $('.social_panel .menu a#reviews');
    if (reviewMenuEl) {
      const span = reviewMenuEl.querySelector('span');
      if (span) data.reviewCount = span.textContent.trim();
    }
    
    const castCards = $$('#cast_scroller .card, .people .card');
    castCards.forEach((card, index) => {
      const nameEl = card.querySelector('p a');
      const charEl = card.querySelector('.character');
      const imgEl = card.querySelector('img');
      const episodeEl = card.querySelector('.episode_count');
      
      if (nameEl) {
        const imageUrl = getImageSource(imgEl);
        const personLink = card.querySelector('a[href*="/person/"]') || nameEl;
        const personMatch = String(personLink.getAttribute('href') || '').match(/\/person\/(\d+)(?:-([^/?#]*))?/);
        const profileWrap = card.querySelector('.profile, .glyphicons.profile');
        let placeholderClass = '';
        if (profileWrap) {
          if (profileWrap.classList.contains('one')) placeholderClass = 'one';
          else if (profileWrap.classList.contains('two')) placeholderClass = 'two';
        }

        data.credits.cast.push({
          id: personMatch ? Number(personMatch[1]) : null,
          order: index + 1,
          credit_id: card.getAttribute('data-credit-id') || '',
          cast_id: card.getAttribute('data-cast-id') ? Number(card.getAttribute('data-cast-id')) : null,
          name: nameEl.textContent.trim(),
          character: charEl ? charEl.textContent.trim() : '',
          known_for_department: 'Acting',
          profile_path: imageUrl ? '/' + getImageFilename(imageUrl) : '',
          placeholder_class: placeholderClass,
          image: imageUrl,
          image_high: imageUrl ? getHighResImage(imageUrl, 'high') : '',
          image_original: imageUrl ? getHighResImage(imageUrl, 'original') : '',
          episodes: episodeEl ? (episodeEl.textContent.trim() || null) : null
        });
      }
    });

    const keywordEls = $$('.keywords .rounded-sm, .keywords a');
    keywordEls.forEach(el => {
      const keyword = el.textContent.trim();
      if (keyword && !data.keywords.includes(keyword)) data.keywords.push(keyword);
    });

    // ===== 9. 하위 페이지/외부 소스 보강 =====
    await enrichMediaData(data, options);

    if (!data.certification) {
      const krRelease = data.releases.find(release => release.countryCode === 'KR' && release.certification);
      if (krRelease) data.certification = krRelease.certification;
    }

    // ===== 10. Media 섹션 + Top Billed Cast(정적 자산) + 영상 썸네일 =====
    data.mediaSection = extractMediaSection();
    data.topBilledCast = extractTopBilledCast();
    (data.videos || []).forEach(video => {
      if (!video.thumbnail && video.key) {
        video.thumbnail = 'https://i.ytimg.com/vi/' + video.key + '/hqdefault.jpg';
      }
    });

    if (!data.imdbId) {
      const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"]');
      const imdbMatch = String(imdbLink ? imdbLink.getAttribute('href') : '').match(/imdb\.com\/title\/(tt\d+)/);
      if (imdbMatch) data.imdbId = imdbMatch[1];
    }

    // ===== 11. 수집 범위/정합성 메타 =====
    ensureImageMetadata(data.images.posters);
    ensureImageMetadata(data.images.backdrops);

    const posterCollected = data.images.posters.length;
    const backdropCollected = data.images.backdrops.length;
    const posterTotal = Number(data.posterCount) || posterCollected;
    const backdropTotal = Number(data.backdropCount) || backdropCollected;

    data.images.collected = { posters: posterCollected, backdrops: backdropCollected };
    data.images.totals = { posters: posterTotal, backdrops: backdropTotal };
    data.images.pagination = {
      posters: buildPaginationInfo(posterCollected, posterTotal),
      backdrops: buildPaginationInfo(backdropCollected, backdropTotal)
    };
    const postersIncomplete = posterCollected < posterTotal;
    const backdropsIncomplete = backdropCollected < backdropTotal;
    data.images.has_next_page = postersIncomplete || backdropsIncomplete;
    data.images.incomplete = { posters: postersIncomplete, backdrops: backdropsIncomplete };
    data.images.next_page_url = '';

    data.credits.castTotal = Number(data.credits.castTotal) || data.credits.cast.length;
    data.credits.crewTotal = Number(data.credits.crewTotal) || data.credits.crew.length;
    buildCreditGroups(data);

    data.isComplete = !postersIncomplete && !backdropsIncomplete &&
      data.credits.cast.length >= data.credits.castTotal &&
      data.credits.crew.length >= data.credits.crewTotal;

    // 숫자 필드 타입 정규화 (LD+JSON 숫자 / DOM 문자열 혼재 제거)
    data.voteAverage = toNumber(data.voteAverage);
    data.voteCount = toNumber(data.voteCount);
    data.reviewCount = toNumber(data.reviewCount);
    data.discussionCount = toNumber(data.discussionCount);
    data.videoCount = toNumber(data.videoCount);
    data.backdropCount = toNumber(data.backdropCount);
    data.posterCount = toNumber(data.posterCount);

    const contentScoreNumber = toNumber(data.contentScore);
    if (contentScoreNumber !== null) data.contentScore = contentScoreNumber;

    if (data.status) data.statusKey = getStatusKey(data.status);

  } catch (error) {
    console.error('데이터 추출 중 오류:', error);
    throw error;
  }

  // 본문·소개글·앵커에 포함된 유튜브 링크 + 수집한 영상 URL
  data.youtubeLinks = collectYoutubeLinks(
    [data.overview, data.tagline, data.homepage],
    (data.videos || []).map(video => ({ url: video.url, title: video.name }))
  );

  return data;
}

// ===== 이미지 타입 판별 헬퍼 함수 =====
// 부분 문자열 대신 경로 힌트와 사이즈 토큰 정확 일치로 판별하여
// 포스터/배경 이미지가 서로 섞이지 않도록 한다.
function getImageSizeToken(url) {
  const match = url.match(/\/t\/p\/([^/]+)\//);
  return match ? match[1] : '';
}

function isPosterImage(url) {
  if (/\/poster\//i.test(url)) return true;
  if (/\/(backdrop|still)\//i.test(url)) return false;

  const token = getImageSizeToken(url);
  return [
    'w92', 'w154', 'w185', 'w342', 'w500',
    'w300_and_h450', 'w300_and_h450_face', 'w300_and_h450_bestv2',
    'w600_and_h900_face', 'w440_and_h660_face',
    'w220_and_h330', 'w220_and_h330_face',
    'w130_and_h195', 'w130_and_h195_face',
    'w94_and_h141_face'
  ].indexOf(token) !== -1;
}

function isBackdropImage(url) {
  if (/\/(backdrop|still)\//i.test(url)) return true;
  if (/\/poster\//i.test(url)) return false;

  const token = getImageSizeToken(url);
  return [
    'w300', 'w780', 'w1280',
    'w1920_and_h800', 'w533_and_h300', 'w533_and_h300_face',
    'w1066_and_h600', 'w1066_and_h600_face'
  ].indexOf(token) !== -1;
}

// ===== 크롤러(crawler.js)용 공개 API =====
window.__tmdbExtractor = {
  getPageInfo: getPageInfo,
  extractMediaData: extractMediaData,
  extractPersonData: extractPersonData,
  fetchHtmlDoc: fetchHtmlDoc,
  fetchCreditLinks: fetchCreditLinks,
  getGalleryLanguages: getGalleryLanguages,
  setPacing: setPacing,
  showToast: showToast
};
