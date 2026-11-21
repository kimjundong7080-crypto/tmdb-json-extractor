// 확장 프로그램 설치/업데이트 시 우클릭 메뉴 등록 (TMDB에서만 표시)
chrome.runtime.onInstalled.addListener(() => {
  // 업데이트 시 중복 id 오류를 막기 위해 기존 메뉴를 먼저 제거
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn("기존 컨텍스트 메뉴 제거 실패:", chrome.runtime.lastError.message);
    }

    const menus = [
      { id: "extractTmdbJson", title: "🎬 영화 JSON 추출" },
      { id: "extractTmdbCastJson", title: "🎭 배우 JSON 추출" },
      { id: "extractTmdbPersonJson", title: "👤 배우 정보 추출" }
    ];

    menus.forEach(menu => {
      chrome.contextMenus.create({
        id: menu.id,
        title: menu.title,
        contexts: ["page"],
        documentUrlPatterns: ["*://www.themoviedb.org/*"]
      }, () => {
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
  extractTmdbPersonJson: "extractPersonAndDownload"
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
      files: ["content.js"]
    });
    return await chrome.tabs.sendMessage(tabId, { action });
  } catch (error) {
    console.error("[TMDB Extractor] 동적 주입 후 실행 실패:", error);
  }
}
