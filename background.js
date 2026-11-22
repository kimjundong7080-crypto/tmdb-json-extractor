// background.js - 컨텍스트 메뉴, 메시지 라우팅, 폴더 구조 JSON 다운로드, 사이트맵 프록시
const ALLOWED_FETCH_HOSTS = ['files.tmdb.org'];

chrome.runtime.onInstalled.addListener(() => {
  // 업데이트 시 중복 id 오류를 막기 위해 기존 메뉴를 먼저 제거
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn("기존 컨텍스트 메뉴 제거 실패:", chrome.runtime.lastError.message);
    }

    const menus = [
      { id: "extractTmdbJson", title: "🎬 영화 JSON 추출" },
      { id: "extractTmdbCastJson", title: "🎭 배우 JSON 추출" },
      { id: "extractTmdbPersonJson", title: "👤 배우 정보 추출" },
      { id: "crawlSeparator", type: "separator" },
      { id: "crawlSeedCurrent", title: "➕ 현재 페이지를 크롤 큐에 추가" },
      { id: "crawlSitemapSeed", title: "🗺 사이트맵으로 큐 채우기" },
      { id: "crawlSaveNow", title: "💾 현재 페이지만 저장 (tmdb/ 폴더)" },
      { id: "crawlStart", title: "🕷 사이트 크롤링 시작" },
      { id: "crawlPause", title: "⏸ 크롤링 일시정지 / 재개" },
      { id: "crawlStop", title: "⏹ 크롤링 중지" },
      { id: "crawlExportIndex", title: "📑 크롤링 인덱스 내보내기" }
    ];

    menus.forEach(menu => {
      const options = {
        id: menu.id,
        contexts: ["page"],
        documentUrlPatterns: ["*://www.themoviedb.org/*"]
      };
      if (menu.type) {
        options.type = menu.type;
      } else {
        options.title = menu.title;
      }

      chrome.contextMenus.create(options, () => {
        if (chrome.runtime.lastError) {
          console.warn(`컨텍스트 메뉴 생성 실패 (${menu.id}):`, chrome.runtime.lastError.message);
        }
      });
    });
  });
});

// 메뉴 id → content script 액션 매핑
const MENU_ACTIONS = {
  extractTmdbJson: "extractAndDownload",
  extractTmdbCastJson: "extractCastAndDownload",
  extractTmdbPersonJson: "extractPersonAndDownload",
  crawlSeedCurrent: "crawlSeed",
  crawlSitemapSeed: "crawlSitemapSeed",
  crawlSaveNow: "crawlSaveNow",
  crawlStart: "crawlStart",
  crawlPause: "crawlTogglePause",
  crawlStop: "crawlStop",
  crawlExportIndex: "crawlExportIndex"
};

// 우클릭 메뉴 클릭 시 처리
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const action = MENU_ACTIONS[info.menuItemId];
  if (!action) return;

  if (!tab || typeof tab.id !== "number") {
    console.warn("유효한 탭 정보가 없어 실행을 건너뜁니다.");
    return;
  }

  sendAction(tab.id, action).catch(error => {
    console.error(`[TMDB Extractor] ${action} 처리 실패:`, error);
  });
});

async function sendAction(tabId, action) {
  try {
    return await chrome.tabs.sendMessage(tabId, { action });
  } catch (error) {
    const message = String((error && error.message) || error);
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(message);
    if (!noReceiver) {
      console.warn("[TMDB Extractor] 메시지 전송 오류:", error);
      return;
    }
  }

  // content script가 없는 탭에만 동적 주입 후 재시도
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js", "crawler.js"]
    });
    return await chrome.tabs.sendMessage(tabId, { action });
  } catch (error) {
    console.error("[TMDB Extractor] 동적 주입 후 실행 실패:", error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  // 크롤러 다운로드: content script는 chrome.downloads를 쓸 수 없으므로 여기서 저장한다.
  if (message.action === "crawlerDownload") {
    handleCrawlerDownload(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }

  // 저장한 파일이 실제로 디스크에 남았는지 확인한다(파일 확인 수 집계).
  if (message.action === "crawlerVerifyDownload") {
    try {
      chrome.downloads.search({ id: Number(message.id) }, items => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const item = items && items[0];
        sendResponse({
          ok: true,
          state: item ? item.state : "missing",
          exists: !!(item && item.exists),
          bytes: item ? (item.fileSize || item.bytesReceived || 0) : 0,
          filename: item ? item.filename : ""
        });
      });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
    return true;
  }

  // 이미지 다운로드: JSON과 같은 폴더에, 제목 기반 파일명으로 저장한다.
  if (message.action === "crawlerImage") {
    handleCrawlerImage(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }

  // 확장 설치 폴더의 settings.json(읽기 전용 기본값)을 시작할 때 읽는다.
  if (message.action === "crawlerPackagedSettings") {
    loadPackagedSettings()
      .then(settings => sendResponse(settings || {}))
      .catch(() => sendResponse({}));
    return true;
  }

  // 사이트맵 프록시: files.tmdb.org는 TMDB와 다른 origin이라 content script에서 직접 못 읽는다.
  // host_permissions를 가진 service worker가 대신 받아 gzip을 풀고 필요한 부분만 돌려준다.
  if (message.action === "crawlFetch") {
    fetchCrawlResource(message)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: String((error && error.message) || error) }));
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 다운로드 + 중복(덮어쓰기) 처리                                        */
/* ------------------------------------------------------------------ */
// 이미 저장한 파일 이름을 기억해 두고, 덮어쓰기가 꺼져 있으면 다시 받지 않는다.
const SAVED_FILES_KEY = "tmdbSavedFiles";
const SAVED_FILES_LIMIT = 60000;

let savedFiles = null;
let savedFilesDirty = false;
let savedFilesTimer = null;

function ensureSavedFiles() {
  if (savedFiles) return Promise.resolve(savedFiles);
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(SAVED_FILES_KEY, value => {
        const rows = (value && value[SAVED_FILES_KEY]) || [];
        savedFiles = new Set(Array.isArray(rows) ? rows : []);
        resolve(savedFiles);
      });
    } catch (e) {
      savedFiles = new Set();
      resolve(savedFiles);
    }
  });
}

function rememberSavedFile(filename) {
  if (!savedFiles) savedFiles = new Set();
  savedFiles.add(filename);
  savedFilesDirty = true;
  if (savedFilesTimer) return;

  savedFilesTimer = setTimeout(() => {
    savedFilesTimer = null;
    if (!savedFilesDirty || !savedFiles) return;
    savedFilesDirty = false;

    let rows = Array.from(savedFiles);
    if (rows.length > SAVED_FILES_LIMIT) {
      rows = rows.slice(-SAVED_FILES_LIMIT);
      savedFiles = new Set(rows);
    }
    try {
      chrome.storage.local.set({ [SAVED_FILES_KEY]: rows });
    } catch (e) {}
  }, 1500);
}

async function handleCrawlerDownload(message) {
  const filename = String(message.filename || "tmdb/export.json").replace(/^\/+/, "");
  const overwrite = message.overwrite !== false;

  if (!overwrite) {
    const saved = await ensureSavedFiles();
    if (saved.has(filename)) return { ok: true, skipped: true, filename: filename };
  }

  return await new Promise(resolve => {
    try {
      chrome.downloads.download(
        {
          url: message.dataUrl,
          filename: filename,
          conflictAction: overwrite ? "overwrite" : "uniquify",
          saveAs: false
        },
        downloadId => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          rememberSavedFile(filename);
          resolve({ ok: true, id: downloadId, filename: filename });
        }
      );
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

// 이미지 한 장을 지정한 경로(폴더 포함)로 저장한다. TMDB 이미지 호스트만 허용한다.
async function handleCrawlerImage(message) {
  const filename = String(message.filename || "").replace(/^\/+/, "");
  const url = String(message.url || "");
  const overwrite = message.overwrite !== false;

  if (!filename || filename.indexOf("..") !== -1) {
    return { ok: false, error: "잘못된 파일명" };
  }
  if (!/^https:\/\/(media|image)\.themoviedb\.org\//.test(url)) {
    return { ok: false, error: "허용되지 않은 이미지 URL" };
  }

  return await new Promise(resolve => {
    try {
      chrome.downloads.download(
        {
          url: url,
          filename: filename,
          conflictAction: overwrite ? "overwrite" : "uniquify",
          saveAs: false
        },
        downloadId => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve({ ok: true, id: downloadId, filename: filename });
        }
      );
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

// 설치 폴더의 settings.json은 읽기만 가능하다(Chrome이 확장 폴더 쓰기를 막는다).
// 파일이 바뀌었는지 비교할 수 있도록 내용 해시도 함께 돌려준다.
function hashString(value) {
  let hash = 5381;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}

async function loadPackagedSettings() {
  try {
    const response = await fetch(chrome.runtime.getURL("settings.json"));
    if (!response.ok) return null;
    const text = await response.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return null;
    return { settings: data, hash: hashString(text) };
  } catch (e) {
    return null;
  }
}

// 사이트맵 한 파일은 5만 URL/5.7MB라서 매 배치마다 다시 받으면 낭비다.
// 최근 2개 파일의 loc 목록을 service worker 메모리에 캐시하고 offset/limit으로 잘라 보낸다.
const LOC_CACHE = new Map();
const LOC_CACHE_TTL = 10 * 60 * 1000;

async function fetchCrawlResource(message) {
  let url;
  try {
    url = new URL(String(message.url || ""));
  } catch (e) {
    return { ok: false, error: "잘못된 URL" };
  }

  if (url.protocol !== "https:" || ALLOWED_FETCH_HOSTS.indexOf(url.hostname) === -1) {
    return { ok: false, error: "허용되지 않은 호스트: " + url.hostname };
  }

  if (message.mode === "locs") {
    let locs = getCachedLocs(url.href);
    if (!locs) {
      locs = extractLocs(await downloadText(url));
      cacheLocs(url.href, locs);
    }

    const offset = Math.max(0, Math.round(Number(message.offset) || 0));
    const limit = Math.max(1, Math.min(5000, Math.round(Number(message.limit) || 2000)));

    // 최신순: 사이트맵은 TMDB id 오름차순이므로 파일 뒤에서부터 잘라 준다.
    if (message.fromEnd === true) {
      const end = Math.max(0, locs.length - offset);
      const start = Math.max(0, end - limit);
      return { ok: true, locs: locs.slice(start, end).reverse(), total: locs.length, offset: offset };
    }

    return { ok: true, locs: locs.slice(offset, offset + limit), total: locs.length, offset: offset };
  }

  const text = await downloadText(url);
  return { ok: true, text: text, bytes: text.length };
}

async function downloadText(url) {
  const response = await fetch(url.href, { credentials: "omit", cache: "no-store" });
  if (!response.ok) {
    const error = new Error("HTTP " + response.status);
    error.status = response.status;
    throw error;
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  return isGzip(bytes, url.pathname) ? await gunzip(bytes) : new TextDecoder("utf-8").decode(bytes);
}

function getCachedLocs(url) {
  const entry = LOC_CACHE.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > LOC_CACHE_TTL) {
    LOC_CACHE.delete(url);
    return null;
  }
  return entry.locs;
}

function cacheLocs(url, locs) {
  if (LOC_CACHE.size >= 2) {
    LOC_CACHE.delete(LOC_CACHE.keys().next().value);
  }
  LOC_CACHE.set(url, { ts: Date.now(), locs: locs });
}

function isGzip(bytes, pathname) {
  if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  return /\.gz$/i.test(pathname || "");
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("이 브라우저는 gzip 해제(DecompressionStream)를 지원하지 않습니다");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let match;
  while ((match = re.exec(String(xml || "")))) {
    locs.push(match[1].trim());
  }
  return locs;
}
