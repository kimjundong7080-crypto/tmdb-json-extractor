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
      const data = extractMediaData();

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

// ===== JSON 파일 자동 다운로드 함수 =====
function downloadJsonFile(jsonString, filename, prefix, id) {
  try {
    const safeFilename = String(filename || prefix || 'export')
      .replace(/[^a-zA-Z0-9가-힣]/g, '_')
      .substring(0, 50);
    const finalFilename = `${prefix || 'export'}_${id || Date.now()}_${safeFilename}.json`;

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
    if (bestUrl) return bestUrl;
  }

  return img.getAttribute('data-src') || img.getAttribute('src') || '';
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
    if (getImageWidthRank(item.url) > getImageWidthRank(byName[name].url)) {
      byName[name] = item;
    }
  });

  return order.map(name => byName[name]);
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
    credits: {
      acting: [],
      production: []
    },
    schemaVersion: '1.4',
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
        
        if (label.includes('Known For')) data.knownFor = value;
        else if (label.includes('Known Credits')) data.knownCredits = value;
        else if (label.includes('Gender')) data.gender = value;
        else if (label.includes('Birthday')) {
          data.birthday = value;
          const ageMatch = value.match(/(\d+)\s*years? old/);
          if (ageMatch) data.age = ageMatch[1] + ' years old';
        } else if (label.includes('Place of Birth')) data.placeOfBirth = value;
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

    // Acting 크레딧
    const actingSection = document.querySelector('h3.zero');
    if (actingSection) {
      const container = actingSection.parentElement;
      const rows = container.querySelectorAll('.credit_group');
      rows.forEach(row => {
        const yearEl = row.querySelector('.year');
        const titleLink = row.querySelector('.role a');
        const characterEl = row.querySelector('.character');
        const episodeEl = row.querySelector('.tv');
        
        const year = yearEl ? yearEl.textContent.trim() : '';
        const title = titleLink ? titleLink.textContent.trim() : '';
        const titleUrl = titleLink ? titleLink.getAttribute('href') || '' : '';
        const character = characterEl ? characterEl.textContent.trim() : '';
        const episodes = episodeEl ? episodeEl.textContent.trim() : '';
        
        const mediaType = titleUrl.includes('/movie/') ? 'movie' : 
                         titleUrl.includes('/tv/') ? 'tv' : 'unknown';
        
        if (title && !data.credits.acting.find(c => c.title === title && c.year === year)) {
          data.credits.acting.push({
            year: year || null,
            title: title,
            mediaType: mediaType,
            character: character || null,
            episodes: episodes || null
          });
        }
      });
    }

    // Production 크레딧
    const productionSection = document.querySelector('h3.one');
    if (productionSection) {
      const container = productionSection.parentElement;
      const rows = container.querySelectorAll('.credit_group');
      rows.forEach(row => {
        const yearEl = row.querySelector('.year');
        const titleLink = row.querySelector('.role a');
        const roleEl = row.querySelector('.role span.role');
        
        const year = yearEl ? yearEl.textContent.trim() : '';
        const title = titleLink ? titleLink.textContent.trim() : '';
        const titleUrl = titleLink ? titleLink.getAttribute('href') || '' : '';
        const role = roleEl ? roleEl.textContent.trim() : '';
        
        const mediaType = titleUrl.includes('/movie/') ? 'movie' : 
                         titleUrl.includes('/tv/') ? 'tv' : 'unknown';
        
        if (title && !data.credits.production.find(c => c.title === title && c.year === year)) {
          data.credits.production.push({
            year: year || null,
            title: title,
            mediaType: mediaType,
            role: role || null
          });
        }
      });
    }

  } catch (error) {
    console.error('배우 데이터 추출 중 오류:', error);
    throw error;
  }

  return data;
}

// ===== 미디어(영화/TV) 데이터 추출 함수 (통합) =====
function extractMediaData() {
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
      crew: []
    },
    videos: [],
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
    statusKey: '',
    schemaVersion: '1.4',
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

              let department = '';
              const roleLower = singleRole.toLowerCase();
              if (roleLower.includes('director')) department = 'Directing';
              else if (roleLower.includes('creator')) department = 'Creator';
              else if (roleLower.includes('writer') || roleLower.includes('screenplay') || roleLower.includes('story')) department = 'Writing';
              else if (roleLower.includes('producer')) department = 'Production';
              else if (roleLower.includes('cinematographer') || roleLower.includes('director of photography')) department = 'Camera';
              else if (roleLower.includes('editor')) department = 'Editing';
              else if (roleLower.includes('music') || roleLower.includes('composer')) department = 'Sound';
              else if (roleLower.includes('art director') || roleLower.includes('production design')) department = 'Art';
              else if (roleLower.includes('costume') || roleLower.includes('makeup') || roleLower.includes('hair')) department = 'Costume & Make-Up';
              else if (roleLower.includes('visual effects') || roleLower.includes('vfx')) department = 'Visual Effects';

              data.credits.crew.push({
                name: name,
                job: singleRole,
                department: department || 'Other'
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
    castCards.forEach(card => {
      const nameEl = card.querySelector('p a');
      const charEl = card.querySelector('.character');
      const imgEl = card.querySelector('img');
      const episodeEl = card.querySelector('.episode_count');
      
      if (nameEl) {
        const imageUrl = getImageSource(imgEl);
        data.credits.cast.push({
          name: nameEl.textContent.trim(),
          character: charEl ? charEl.textContent.trim() : '',
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