/**
 * BONG HSK 통합 단어 데이터 로더 및 툴팁 파서 코어 엔진 (word-core.js)
 * - HTTP/HTTPS fetch 및 로컬(file://) 환경 완벽 호환 (자동 폴백 + 메모리 캐싱)
 * - 슬림 고딕 디자인 및 다의어/접속사 구문 툴팁 매칭 고도화
 */

let wordDictionary = {};
let isExtraDictLoaded = false;
const jsonDataCache = {};
let bundleLoadPromise = null;

function normalizeFileName(fileOrPath) {
    if (!fileOrPath) return '';
    const parts = fileOrPath.split('/');
    return parts[parts.length - 1];
}

function loadDataBundleScript() {
    if (window.BONG_DATA) return Promise.resolve(window.BONG_DATA);
    if (bundleLoadPromise) return bundleLoadPromise;

    bundleLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = './js/data-bundle.js';
        script.onload = () => resolve(window.BONG_DATA || {});
        script.onerror = (err) => reject(err);
        document.head.appendChild(script);
    });
    return bundleLoadPromise;
}

/**
 * JSON 데이터를 안전하게 로드합니다.
 * 1) 메모리 캐시 확인 (중복 네트워크 요청 차단)
 * 2) http/https 환경에서는 ./data/*.json fetch 우선 수행
 * 3) file:// 직접 실행 또는 네트워크 오류 시 data-bundle.js 폴백 자동 가동
 */
async function fetchJsonData(fileOrPath) {
    const fileName = normalizeFileName(fileOrPath);
    if (!fileName) return [];

    if (jsonDataCache[fileName]) {
        return jsonDataCache[fileName];
    }

    jsonDataCache[fileName] = (async () => {
        const isFileProtocol = window.location.protocol === 'file:';

        if (!isFileProtocol) {
            try {
                const res = await fetch(`./data/${fileName}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                return data;
            } catch (err) {
                console.warn(`⚠️ fetch 실패 (${fileName}), 번들 폴백 전환:`, err.message);
            }
        }

        const bundle = await loadDataBundleScript();
        if (bundle && bundle[fileName]) {
            return JSON.parse(JSON.stringify(bundle[fileName]));
        }
        throw new Error(`데이터를 찾을 수 없습니다: ${fileName}`);
    })();

    try {
        return await jsonDataCache[fileName];
    } catch (err) {
        delete jsonDataCache[fileName];
        throw err;
    }
}

async function loadMasterDictionary(currentType = 'all') {
    try {
        let primaryTarget = '';
        if (currentType === '1' || currentType === '2' || currentType === '3') {
            primaryTarget = `hsk${currentType}.json`;
        } else if (currentType === 'radical') {
            primaryTarget = 'radical.json';
        }

        if (primaryTarget) {
            const res = await fetchJsonData(primaryTarget).catch(() => []);
            injectWordsToDictionary(res, currentType);
        } else {
            const datasets = await Promise.all([
                fetchJsonData('hsk1.json').catch(() => []),
                fetchJsonData('hsk2.json').catch(() => []),
                fetchJsonData('hsk3.json').catch(() => [])
            ]);
            injectWordsToDictionary(datasets[0], '1');
            injectWordsToDictionary(datasets[1], '2');
            injectWordsToDictionary(datasets[2], '3');
        }

        setTimeout(async () => {
            if (isExtraDictLoaded) return;
            const extraFiles = [
                { file: 'hsk1.json', tag: '1' },
                { file: 'hsk2.json', tag: '2' },
                { file: 'hsk3.json', tag: '3' },
                { file: 'radical.json', tag: 'radical' }
            ];

            for (const item of extraFiles) {
                if (primaryTarget && item.file === primaryTarget) continue;
                if (!primaryTarget && item.file !== 'radical.json') continue;
                const data = await fetchJsonData(item.file).catch(() => []);
                injectWordsToDictionary(data, item.tag);
            }
            isExtraDictLoaded = true;
        }, 200);

    } catch (err) {
        console.error("❌ 마스터 사전 데이터 로드 실패:", err);
    }
}

function registerDictEntry(key, meanText, pyText, hanjaText, levelLabel) {
    if (!key) return;
    const trimmedKey = key.trim();
    if (!trimmedKey) return;

    if (wordDictionary[trimmedKey]) {
        const existing = wordDictionary[trimmedKey];
        // 동일 급수 내 동형이의어(예: 2급 对, 3급 只/花)는 뜻과 병음을 병합
        if (existing.level === levelLabel) {
            if (meanText && !existing.mean.includes(meanText)) {
                existing.mean += ` / ${meanText}`;
            }
            if (pyText && !existing.py.split(', ').includes(pyText)) {
                existing.py += `, ${pyText}`;
            }
            return;
        }
        // 하위 급수(기초 단어) 우선 보존
        if (existing.level === '1급') return;
        if (existing.level === '2급' && (levelLabel === '3급' || levelLabel === '부수')) return;
        if (existing.level === '3급' && levelLabel === '부수') return;
    }

    wordDictionary[trimmedKey] = {
        mean: meanText,
        py: pyText,
        hanja: hanjaText,
        level: levelLabel
    };
}

function injectWordsToDictionary(wordsArray, typeTag) {
    if (!Array.isArray(wordsArray)) return;
    let levelLabel = '부수';
    if (typeTag === '1') levelLabel = '1급';
    if (typeTag === '2') levelLabel = '2급';
    if (typeTag === '3') levelLabel = '3급';

    wordsArray.forEach(word => {
        const wordKey = word.hanzi || word.han || word.word;
        if (wordKey) {
            const trimmedKey = wordKey.trim();
            let meanText = '';
            if (Array.isArray(word.meanings)) {
                meanText = word.meanings.map(m => `[${m.pos}] ${m.ko}`).join(', ');
            } else {
                meanText = word.meaning || word.kor || '';
            }
            const pyText = word.pinyin || word.pin || '';
            const hanjaText = word.hanja || '';

            registerDictEntry(trimmedKey, meanText, pyText, hanjaText, levelLabel);

            // 접속사 세트(예: 虽然...但是..., 因为...所以..., 不但...而且, 只有…才…)의 개별 단어도 사전에 매핑
            if (/[.…]/.test(trimmedKey)) {
                const subWords = trimmedKey.split(/[.…\s]+/).filter(Boolean);
                const subPinyins = pyText.split(/[.…\s]+/).filter(Boolean);
                subWords.forEach((sw, idx) => {
                    if (/^[\u4e00-\u9fa5]+$/.test(sw) && !wordDictionary[sw]) {
                        registerDictEntry(
                            sw,
                            `${meanText} (${trimmedKey})`,
                            subPinyins[idx] || pyText,
                            hanjaText,
                            levelLabel
                        );
                    }
                });
            }
        }
    });
}

function escapeForInlineJs(str) {
    return (str || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, ' ');
}

function parseHanziToTooltip(sentence) {
    if (!sentence) return '';
    const isChineseChar = (str) => /[\u4e00-\u9fa5]/.test(str);
    let resultHtml = '';

    const safeSentence = escapeForInlineJs(sentence);

    for (let i = 0; i < sentence.length; i++) {
        let char = sentence[i];
        if (isChineseChar(char)) {
            resultHtml += `<span class="zh-normal-char" style="cursor: pointer;" onclick="handleCharClick(event, '${safeSentence}', ${i})">${char}</span>`;
        } else {
            resultHtml += `<span>${char}</span>`;
        }
    }
    return resultHtml;
}

function handleCharClick(event, fullSentence, clickIndex) {
    event.stopPropagation();

    let matchedWord = '';
    let maxLen = 0;

    for (let start = Math.max(0, clickIndex - 3); start <= clickIndex; start++) {
        for (let end = clickIndex + 1; end <= Math.min(fullSentence.length, clickIndex + 4); end++) {
            let subWord = fullSentence.substring(start, end);
            if (wordDictionary[subWord] && subWord.length > maxLen) {
                matchedWord = subWord;
                maxLen = subWord.length;
            }
        }
    }

    if (!matchedWord) {
        matchedWord = fullSentence.charAt(clickIndex);
    }

    if (matchedWord) {
        showWordCoreTooltip(event, matchedWord);
    }
}

function showWordCoreTooltip(event, word) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    let tooltip = document.getElementById('tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'tooltip';
        tooltip.className = 'word-tooltip';
        document.body.appendChild(tooltip);
    }

    const info = wordDictionary[word];
    if (info) {
        let badgeColor = '#64748b';
        if (info.level === '1급') badgeColor = '#4caf50';
        if (info.level === '2급') badgeColor = '#0284c7';
        if (info.level === '3급') badgeColor = '#2563eb';

        let hanjaHtml = info.hanja ? `<div style="font-size: 13px; font-weight: 400; color: #cbd5e1; margin-top: 3px;">${info.hanja}</div>` : '';

        tooltip.innerHTML = `
            <div style="text-align: center; min-width: 180px; max-width: 260px; font-family: 'Pretendard', -apple-system, 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif; padding: 4px 0;">
                <div style="display: flex; justify-content: center; align-items: center; gap: 6px; flex-wrap: wrap; line-height: 1.2;">
                    <span style="font-size: 11px; font-weight: 500; color: #ffffff; background: ${badgeColor}; padding: 1px 4px; border-radius: 4px; flex-shrink: 0; font-family: sans-serif;">${info.level}</span>
                    <span style="font-size: 24px; font-weight: 400; color: #ffffff; letter-spacing: 0.02em;">${word}</span>
                    <span style="font-size: 14px; font-weight: 500; color: #93c5fd; margin-left: 1px; font-family: sans-serif;">${info.py}</span>
                </div>
                ${hanjaHtml}
                <div style="font-size: 13px; font-weight: 400; color: #f8fafc; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.15); margin-top: 6px; text-align: center; line-height: 1.4; white-space: normal; word-break: keep-all;">
                    ${info.mean}
                </div>
            </div>
        `;

        const ut = new SpeechSynthesisUtterance(word);
        ut.lang = 'zh-CN';
        ut.rate = 0.8;
        window.speechSynthesis.speak(ut);
    } else {
        tooltip.innerHTML = `
            <div style="text-align: center; min-width: 160px; font-family: 'Pretendard', -apple-system, sans-serif; padding: 4px 0;">
                <span style="font-size: 20px; font-weight: 400; color: #ffffff;">${word}</span>
                <div style="font-size: 12px; font-weight: 400; color: #94a3b8; padding-top: 4px; margin-top: 4px; border-top: 1px dashed rgba(255,255,255,0.15);">단어장 검색 결과 없음</div>
            </div>
        `;
    }

    // 실제 크기를 정확히 측정하기 위해 먼저 블록화 후 뷰포트 경계 보정
    tooltip.style.visibility = 'hidden';
    tooltip.style.display = 'block';

    const rect = event.target.getBoundingClientRect();
    const tWidth = tooltip.offsetWidth || 180;
    const tHeight = tooltip.offsetHeight || 95;

    let leftPos = rect.left + window.scrollX + (rect.width / 2) - (tWidth / 2);
    const minLeft = window.scrollX + 10;
    const maxLeft = window.scrollX + window.innerWidth - tWidth - 10;
    leftPos = Math.max(minLeft, Math.min(leftPos, maxLeft));

    let topPos = rect.top + window.scrollY - tHeight - 14;
    if (rect.top < tHeight + 20) {
        topPos = rect.bottom + window.scrollY + 10;
    }

    tooltip.style.left = `${leftPos}px`;
    tooltip.style.top = `${topPos}px`;
    tooltip.style.visibility = 'visible';
}

document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', () => {
        const tooltip = document.getElementById('tooltip');
        if (tooltip) tooltip.style.display = 'none';
    });
});
