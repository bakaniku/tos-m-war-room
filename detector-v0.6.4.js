/**
 * ═══════════════════════════════════════════════════════════════════════
 * 📷 TOS M FB TIME - 螢幕偵測模組 v0.7.0 Beta
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 【v0.7 核心革新：自動規範化擷取】
 *
 * ❌ 舊版痛點：
 *    - 使用者拖曳框選徽章 → 每個人擷取範圍不同 → 模板無法共享
 *    - 紅環偵測在不同地圖背景下不穩定（被王身上的紅、地板紅紋干擾）
 *    - 重新框選後舊模板都失效
 *
 * ✅ v0.7 解法：
 *    1. 校準模式：使用者框「計時圈完整區域」一次
 *    2. 紅環偵測（RANSAC）找出精確的紅環中心+半徑
 *    3. 用比例自動算出徽章位置 → 擷取 → 標準化 32×32
 *    4. 之後不再需要紅環偵測 → 不受地圖背景影響
 *    5. 所有人用相同比例 → 模板可共享 ✨
 *
 * 用法：
 *   在 beta.html 的 </body> 之前加入：
 *     <script src="detector-v0.7.0.js"></script>
 *
 * 依賴：
 *   - 主程式 beta.html 必須提供：saveBoss(map, ch, val), currentRoom, db
 *   - 主畫面必須有 #volRange 滑桿（音量跟隨）
 *   - 主畫面必須有 .audio-controls（注入 📷 按鈕的位置）
 *
 * 不依賴：
 *   - jQuery
 *   - 任何外部 CSS
 *   - Tesseract（會自動從 CDN 動態載入作為 OCR fallback）
 * ═══════════════════════════════════════════════════════════════════════
 */

(function() {
  'use strict';

  const DEBUG_PREFIX = '[偵測器]';
  const TEMPLATE_SIZE = 32;
  const TEMPLATE_STORAGE_KEY = 'tosm_detector_templates_v5';
  const TEMPLATE_MIN_SIM = 0.85;   // 相似度 >= 此值直接採信模板
  const TEMPLATE_AMBIGUOUS = 0.70; // 相似度介於兩者之間為不確定
  const MAX_TEMPLATES_PER_LABEL = 30;

  // v0.7: 校準資料 storage key
  const CALIBRATION_STORAGE_KEY = 'tosm_detector_calibration_v7';
  // 預設比例（從 1280x696 截圖測量得到）
  const DEFAULT_RING_RATIOS = {
    ringCenterRatio: { x: 0.3, y: 0.6 },   // 紅環中心在框內的比例
    ringRadiusRatio: 0.25,                  // 紅環半徑相對於框寬
    badgeOffsetRatio: 0.95,                 // 徽章距紅環中心的距離（相對於半徑）
    badgeSizeRatio: 0.65                    // 徽章邊長相對於半徑
  };

  // ═══════════════════════════════════════════════
  // 模板資料庫
  // ═══════════════════════════════════════════════
  const TemplateDB = {
    data: { phase: {}, ch: {} },

    load() {
      try {
        const s = localStorage.getItem(TEMPLATE_STORAGE_KEY);
        if (s) this.data = JSON.parse(s);
      } catch(e) {
        this.data = { phase: {}, ch: {} };
      }
      if (!this.data.phase) this.data.phase = {};
      if (!this.data.ch) this.data.ch = {};
    },

    save() {
      try {
        localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(this.data));
      } catch(e) {
        console.error(DEBUG_PREFIX, '模板儲存失敗（容量可能已滿）', e);
      }
    },

    // v0.6: 將原始圖片正規化並同時計算多種特徵
    // 回傳：{ pixels (32x32 灰階), pHash (64-bit BigInt), magnitude (用於餘弦相似度) }
    normalize(sourceCanvas) {
      const norm = document.createElement('canvas');
      norm.width = TEMPLATE_SIZE; norm.height = TEMPLATE_SIZE;
      const ctx = norm.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sourceCanvas, 0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
      const img = ctx.getImageData(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
        d[i] = d[i+1] = d[i+2] = g;
      }
      ctx.putImageData(img, 0, 0);
      return norm;
    },

    // v0.6: 從正規化圖片計算多種特徵
    extractFeatures(canvas) {
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const len = canvas.width * canvas.height;
      const pixels = new Float32Array(len);
      let mag = 0;
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
        pixels[j] = img.data[i];
        mag += pixels[j] * pixels[j];
      }
      // v0.6 新增：pHash（簡化版：基於平均亮度的二值化雜湊）
      // 計算平均
      let sum = 0;
      for (let i = 0; i < len; i++) sum += pixels[i];
      const avg = sum / len;
      // 64-bit hash（從 32x32 採樣 8x8 = 64 個位置）
      const hash = new Uint8Array(64);
      const step = TEMPLATE_SIZE / 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // 取每個 4x4 區塊的平均
          let regionSum = 0;
          for (let dy = 0; dy < step; dy++) {
            for (let dx = 0; dx < step; dx++) {
              const px = Math.floor(x * step + dx);
              const py = Math.floor(y * step + dy);
              regionSum += pixels[py * TEMPLATE_SIZE + px];
            }
          }
          const regionAvg = regionSum / (step * step);
          hash[y * 8 + x] = regionAvg > avg ? 1 : 0;
        }
      }
      return { pixels, magnitude: Math.sqrt(mag), hash };
    },

    // 舊 API：保留向下相容，回傳像素陣列
    getPixels(canvas) {
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = new Float32Array(canvas.width * canvas.height);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
        pixels[j] = img.data[i];
      }
      return pixels;
    },

    add(category, label, sourceCanvas) {
      const norm = this.normalize(sourceCanvas);
      const dataURL = norm.toDataURL('image/png');
      if (!this.data[category][label]) this.data[category][label] = [];
      if (this.data[category][label].includes(dataURL)) return false;
      this.data[category][label].push(dataURL);
      if (this.data[category][label].length > MAX_TEMPLATES_PER_LABEL) {
        this.data[category][label].shift();
      }
      this.save();
      return true;
    },

    clearCategory(category, label) {
      if (label) delete this.data[category][label];
      else this.data[category] = {};
      this.save();
    },

    // v0.6.4: 刪除某標籤的某一張模板
    deleteAt(category, label, index) {
      if (!this.data[category] || !this.data[category][label]) return false;
      if (index < 0 || index >= this.data[category][label].length) return false;
      this.data[category][label].splice(index, 1);
      // 如果該標籤已無模板，刪除空陣列（讓下拉選單不顯示）
      if (this.data[category][label].length === 0) {
        delete this.data[category][label];
      }
      this.save();
      return true;
    },

    async dataURLToPixels(dataURL) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = TEMPLATE_SIZE; c.height = TEMPLATE_SIZE;
          c.getContext('2d').drawImage(img, 0, 0);
          resolve(this.getPixels(c));
        };
        img.onerror = reject;
        img.src = dataURL;
      });
    },

    // v0.6: 從 dataURL 載入並計算所有特徵
    async dataURLToFeatures(dataURL) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = TEMPLATE_SIZE; c.height = TEMPLATE_SIZE;
          c.getContext('2d').drawImage(img, 0, 0);
          resolve(this.extractFeatures(c));
        };
        img.onerror = reject;
        img.src = dataURL;
      });
    },

    // v0.6: 三重相似度指標
    // 1. 歐氏距離（整體像素差）
    euclideanSim(a, b) {
      let sum = 0;
      const len = a.length;
      for (let i = 0; i < len; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      const dist = Math.sqrt(sum);
      const maxDist = Math.sqrt(len * 255 * 255);
      return 1 - (dist / maxDist);
    },

    // 2. 餘弦相似度（向量夾角，不受亮度影響）
    cosineSim(a, b, magA, magB) {
      let dot = 0;
      const len = a.length;
      for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
      }
      if (magA === 0 || magB === 0) return 0;
      return dot / (magA * magB);
    },

    // 3. pHash Hamming 距離 → 相似度
    pHashSim(hashA, hashB) {
      let diff = 0;
      for (let i = 0; i < hashA.length; i++) {
        if (hashA[i] !== hashB[i]) diff++;
      }
      return 1 - (diff / hashA.length);
    },

    async match(category, sourceCanvas) {
      const templates = this.data[category];
      if (!templates || Object.keys(templates).length === 0) return null;
      const norm = this.normalize(sourceCanvas);
      const queryFeat = this.extractFeatures(norm);

      const results = [];
      const allMatches = [];  // 用於偵錯：每個模板的詳細比對結果

      for (const [label, dataURLs] of Object.entries(templates)) {
        let bestSim = -1;
        let bestDetail = null;
        for (let idx = 0; idx < dataURLs.length; idx++) {
          const dataURL = dataURLs[idx];
          const tplFeat = await this.dataURLToFeatures(dataURL);

          // 三重相似度
          const eucSim = this.euclideanSim(queryFeat.pixels, tplFeat.pixels);
          const cosSim = this.cosineSim(queryFeat.pixels, tplFeat.pixels, queryFeat.magnitude, tplFeat.magnitude);
          const hashSim = this.pHashSim(queryFeat.hash, tplFeat.hash);

          // v0.6: 加權平均（pHash 最重要，餘弦次之，歐氏最輕）
          const combined = hashSim * 0.5 + cosSim * 0.3 + eucSim * 0.2;

          allMatches.push({ label, idx, eucSim, cosSim, hashSim, combined });

          if (combined > bestSim) {
            bestSim = combined;
            bestDetail = { idx, eucSim, cosSim, hashSim, combined };
          }
        }
        results.push({ label, similarity: bestSim, detail: bestDetail });
      }

      results.sort((a, b) => b.similarity - a.similarity);
      // 偵錯資料：所有模板的比對結果（按 combined 排序）
      allMatches.sort((a, b) => b.combined - a.combined);

      return {
        label: results[0].label,
        similarity: results[0].similarity,
        topN: results.slice(0, 5),
        // v0.6: 額外提供詳細所有比對結果
        allMatches: allMatches.slice(0, 10)
      };
    },

    euclideanDistance(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      return Math.sqrt(sum);
    },

    getStats() {
      const stats = { phase: {}, ch: {}, totalSize: 0 };
      for (const cat of ['phase', 'ch']) {
        for (const [label, arr] of Object.entries(this.data[cat])) {
          stats[cat][label] = arr.length;
          stats.totalSize += arr.reduce((s, d) => s + d.length, 0);
        }
      }
      return stats;
    },

    export() {
      const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tosm_templates_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },

    async import(file) {
      const text = await file.text();
      try {
        const imported = JSON.parse(text);
        if (!imported.phase || !imported.ch) throw new Error('格式錯誤');
        for (const cat of ['phase', 'ch']) {
          for (const [label, arr] of Object.entries(imported[cat])) {
            if (!this.data[cat][label]) this.data[cat][label] = [];
            for (const dataURL of arr) {
              if (!this.data[cat][label].includes(dataURL)) {
                this.data[cat][label].push(dataURL);
              }
            }
          }
        }
        this.save();
        return true;
      } catch(e) {
        alert('❌ 匯入失敗：' + e.message);
        return false;
      }
    }
  };

  function loadTesseract(callback) {
    if (typeof Tesseract !== 'undefined') { callback(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => callback();
    s.onerror = () => console.error(DEBUG_PREFIX, 'Tesseract 載入失敗');
    document.head.appendChild(s);
  }

  const BUILTIN_MAP_DICTIONARY = {
    "夏奧雷伊西邊森林": "1", "夏奧雷伊東邊森林": "3", "蓮帕拉沙池塘": "5",
    "夏奧雷伊礦山村莊": "7", "水晶礦山": "9", "斯拉屋塔斯峽谷": "10",
    "凱利高原": "11", "奈普里塔斯懸崖": "12", "泰內花園": "13",
    "泰內聖堂地下1層": "15", "泰內聖堂地上1層": "17", "泰內聖堂地上2層": "19",
    "庫魯森林": "20", "克尼多斯森林": "21", "達旦森林": "22",
    "諾巴哈公會所": "24", "諾巴哈別館": "26", "諾巴哈本館": "28",
    "貝雅山谷": "30", "比爾塔溪谷": "31", "科博爾特森林": "32",
    "賽堤尼山溝": "34", "塔爾克神殿": "36", "安森塔水源地": "38",
    "卡羅利斯泉水": "40", "萊塔斯小溪": "42", "德幕爾佃農村": "44",
    "德幕爾莊園": "46", "德幕爾外城": "48", "達伊納養蜂地": "50",
    "比爾那森林": "51", "烏奇斯耕作地": "52", "春光森林": "53",
    "關口路": "55", "史爾特凱拉森林": "57", "克巴伊拉斯森林": "59",
    "魯卡斯高原": "60", "王之高原": "61", "札卡里耶爾交叉路": "62",
    "王陵1層": "64", "王陵2層": "66", "王陵3層": "68",
    "阿雷魯諾男爵嶺": "70男", "水路橋地區": "70", "魔族收監所第1區": "71",
    "魔族收監所第3區": "72", "魔族收監所第4區": "73", "魔族收監所第5區": "74",
    "女神的古院": "75", "佩迪米安外城": "76", "魔法師之塔1層": "77",
    "魔法師之塔2層": "78", "魔法師之塔3層": "79", "大教堂懺悔路": "80",
    "大教堂正殿": "81", "大教堂大迴廊": "82", "大教堂至聖所": "83",
    "拉烏基美溼地": "85", "堤拉修道院": "86", "貝拉伊森林": "87",
    "潔拉哈": "88", "世伊魯森林": "89", "沿岸要塞": "90",
    "丁格巴希地區": "91", "大地要塞貯藏區域": "92", "大地要塞決戰地": "93",
    "阿勒篾森林": "95", "巴勒哈森林": "98", "卡雷伊瑪斯接見所": "101",
    "卡雷伊瑪斯拷問所": "103", "娜圖森林": "105", "史巴賓嘉斯森林": "107",
    "娜塔勒森林": "109", "泰芙林鐘乳洞 1區域": "111", "泰芙林鐘乳洞 2區域": "113",
    "杰洛梅爾廣場": "115", "尤那耶爾紀念區": "118", "坦尼爾1世紀念區": "120",
    "緹玫勒斯寺院": "123", "捷泰奧海岸": "125", "艾泰奧海岸": "128",
    "埃佩羅塔奧海岸": "130", "蘭庫22海域": "133", "泰萊希森林": "135",
    "沙烏席斯10館": "138", "巴蘭迪斯3館": "140", "巴蘭迪斯91館": "143",
    "諾貝禮爾森林": "145", "尤德伊安森林": "148", "那魯巴斯寺院": "150",
    "那魯巴斯寺院別館": "153"
  };

  function waitForApp(cb) {
    if (typeof saveBoss === 'function'
        && typeof currentRoom !== 'undefined' && currentRoom
        && typeof db !== 'undefined') {
      cb();
    } else {
      setTimeout(() => waitForApp(cb), 500);
    }
  }

  const state = {
    stream: null, autoTimer: null, currentMode: 'status',
    regions: { status: null, map: null, ch: null },
    badgeRect: null,
    lastPhase: null, stableCount: 0,
    lastSubmitted: { map: null, ch: null, val: null, time: 0 },
    mapDictionary: { ...BUILTIN_MAP_DICTIONARY },
    lastResult: null, zoom: 1.0, debugMode: false,
    panelMode: 'compact', dictLoaded: false,
    panelPos: { x: null, y: null },
    lastBadgeCanvas: null,
    lastChCanvas: null,
    muted: false,  // v0.5 新增：靜音狀態
    trainingMode: false,  // 訓練模式
    // v0.7 新增：校準資料
    calibration: null,
    // v0.6.4 診斷工具狀態
    diagLoopTimer: null,
    diagHistory: []
  };

  function getBadgeRect(statusRegion) {
    if (state.badgeRect) return { ...state.badgeRect };
    return {
      x: Math.floor(statusRegion.w * 0.55),
      y: 0,
      w: Math.ceil(statusRegion.w * 0.45),
      h: Math.floor(statusRegion.h * 0.5)
    };
  }

  function levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1));
    for (let i = 0; i <= a.length; i++) m[i][0] = i;
    for (let j = 0; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        m[i][j] = a[i-1] === b[j-1] ? m[i-1][j-1] :
          1 + Math.min(m[i-1][j-1], m[i][j-1], m[i-1][j]);
      }
    }
    return m[a.length][b.length];
  }
  function similarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, wF = 0, maxVar = 0, th = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; th = t; }
    }
    return th;
  }
  function upscale(src, scale) {
    const out = document.createElement('canvas');
    out.width = src.width * scale; out.height = src.height * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  function toGrayscale(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      d[i] = d[i+1] = d[i+2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  function stretchContrast(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const h = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) h[d[i]]++;
    const total = d.length / 4;
    let lo = 0, hi = 255, c = 0;
    for (let i = 0; i < 256; i++) { c += h[i]; if (c >= total * 0.05) { lo = i; break; } }
    c = 0;
    for (let i = 255; i >= 0; i--) { c += h[i]; if (c >= total * 0.05) { hi = i; break; } }
    const range = hi - lo;
    if (range <= 0) return canvas;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) / range) * 255));
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  function binarizeOtsu(canvas, invert = false) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const h = new Array(256).fill(0);
    for (let i = 0; i < d.length; i += 4) h[d[i]]++;
    const th = otsuThreshold(h, d.length / 4);
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] > th ? 255 : 0;
      d[i] = d[i+1] = d[i+2] = invert ? (255 - v) : v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
  function extractBrightPixels(sourceCanvas, threshold = 200) {
    const out = document.createElement('canvas');
    out.width = sourceCanvas.width;
    out.height = sourceCanvas.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i+1], b = d[i+2];
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const isBrightWhite = maxC > threshold && (maxC - minC) < 60;
      const v = isBrightWhite ? 0 : 255;
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }
  function preprocessForOCR(src, opts = {}) {
    let c = upscale(src, opts.scale || 4);
    toGrayscale(c);
    if (opts.useStretch !== false) stretchContrast(c);
    binarizeOtsu(c, opts.invert || false);
    return c;
  }

  // ═══ 擷取徽章（回傳 canvas 供模板比對/訓練用） ═══
  function captureBadgeCanvas(region) {
    // v0.7: 如果有校準資料，用校準比例擷取（標準化擷取）
    if (state.calibration && state.calibration.timing) {
      return captureBadgeFromCalibration();
    }
    // 舊版邏輯（手動拖曳橘框）
    const badge = getBadgeRect(region);
    const canvas = document.createElement('canvas');
    canvas.width = badge.w;
    canvas.height = badge.h;
    const video = document.getElementById('dVideo');
    canvas.getContext('2d').drawImage(video,
      region.x + badge.x, region.y + badge.y, badge.w, badge.h,
      0, 0, badge.w, badge.h);
    return canvas;
  }

  // v0.7: 用校準比例擷取徽章區域（已標準化為 32×32）
  function captureBadgeFromCalibration() {
    const cal = state.calibration.timing;
    const region = cal.region;

    // 算出紅環中心（絕對座標）
    const ringX = region.x + region.w * cal.ringCenterRatio.x;
    const ringY = region.y + region.h * cal.ringCenterRatio.y;
    const ringR = region.w * cal.ringRadiusRatio;

    // 算徽章位置（紅環右上 45°）
    const offset = ringR * cal.badgeOffsetRatio;
    const angleRad = -Math.PI / 4;
    const badgeCenterX = ringX + offset * Math.cos(angleRad);
    const badgeCenterY = ringY + offset * Math.sin(angleRad);
    const badgeSize = ringR * cal.badgeSizeRatio;

    const x = Math.round(badgeCenterX - badgeSize / 2);
    const y = Math.round(badgeCenterY - badgeSize / 2);
    const w = Math.round(badgeSize);
    const h = Math.round(badgeSize);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const video = document.getElementById('dVideo');
    canvas.getContext('2d').drawImage(video, x, y, w, h, 0, 0, w, h);
    return canvas;
  }

  // v0.7: 載入/儲存校準資料
  function loadCalibration() {
    try {
      const s = localStorage.getItem(CALIBRATION_STORAGE_KEY);
      if (s) {
        state.calibration = JSON.parse(s);
        return true;
      }
    } catch (e) { console.warn(DEBUG_PREFIX, '校準資料載入失敗', e); }
    return false;
  }
  function saveCalibration() {
    if (!state.calibration) return;
    try {
      localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(state.calibration));
    } catch (e) { console.warn(DEBUG_PREFIX, '校準資料儲存失敗', e); }
  }
  function clearCalibration() {
    state.calibration = null;
    localStorage.removeItem(CALIBRATION_STORAGE_KEY);
  }

  // v0.7: 更新精簡模式的「校準狀態」顯示
  function updateCalibStatus() {
    const el = document.getElementById('dCalibStatus');
    if (!el) return;
    if (!state.calibration || !state.calibration.timing) {
      el.style.display = 'none';
      return;
    }
    const t = state.calibration.timing;
    el.style.display = 'block';
    if (t.mode === 'auto') {
      el.innerHTML = `<span style="color:#0f0">✨ 已校準（自動）</span> | 紅環半徑比 ${(t.ringRadiusRatio*100).toFixed(0)}%`;
    } else {
      el.innerHTML = `<span style="color:#fa0">⚠️ 已校準（手動）</span> | 使用預設比例`;
    }
  }

  // v0.7: 校準流程步驟 1
  function renderCalibStep1() {
    const body = document.getElementById('dCalibBody');
    const hasRegion = state.regions.status;
    const hasCalibration = state.calibration && state.calibration.timing;

    let currentInfo = '';
    if (hasCalibration) {
      const t = state.calibration.timing;
      currentInfo = `
        <div class="calib-step" style="border-color:#fa0;background:rgba(255,170,0,0.05)">
          <h4 style="color:#fa0">🔧 目前校準狀態</h4>
          <div>模式：<b>${t.mode === 'auto' ? '✨ 自動' : '⚠️ 手動'}</b></div>
          <div>紅環中心比例：(${(t.ringCenterRatio.x*100).toFixed(1)}%, ${(t.ringCenterRatio.y*100).toFixed(1)}%)</div>
          <div>紅環半徑比例：${(t.ringRadiusRatio*100).toFixed(1)}%</div>
          <div>校準時間：${new Date(t.calibratedAt).toLocaleString('zh-TW')}</div>
          <div class="calib-actions">
            <button class="dbtn red" onclick="window.__detector.resetCalibration()">🗑 清除校準</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = `
      ${currentInfo}
      <div class="calib-step active">
        <h4>📐 步驟 1：框選計時圈</h4>
        <div style="line-height:1.7">
          請框選遊戲畫面右上方的「<b>計時圈完整區域</b>」<br>
          ─ 包含 <span style="color:#f33">紅環</span>+<span style="color:#0af">徽章</span>（On / R1 / R2 等文字）<br>
          ─ 範圍可以稍微大一點（系統會自動偵測精確位置）
        </div>
        <div class="calib-actions">
          ${hasRegion
            ? `<button class="dbtn" onclick="window.__detector.startCalibFrameSelect()">🎯 開始框選</button>
               <span style="font-size:11px;color:#888">（之前框過 status，校準會覆蓋它）</span>`
            : `<span style="color:#fa0">⚠️ 請先開啟擷取，再回來校準</span>`
          }
        </div>
      </div>
      <div class="calib-step" style="opacity:0.5">
        <h4>📐 步驟 2：自動偵測紅環</h4>
        <div>系統會在框內偵測紅環中心和半徑（10 次取樣，取中位數）</div>
      </div>
      <div class="calib-step" style="opacity:0.5">
        <h4>📐 步驟 3：套用比例</h4>
        <div>用紅環中心+半徑算出徽章位置，之後就用這個比例擷取</div>
      </div>
    `;
  }

  // v0.7: 校準失敗
  function renderCalibFailure(reason) {
    const body = document.getElementById('dCalibBody');
    body.innerHTML = `
      <div class="calib-step active" style="border-color:#f33">
        <h4 style="color:#f33">❌ 紅環偵測失敗</h4>
        <div>原因：${reason}</div>
        <div style="margin-top:8px;color:#888;font-size:11px">
          可能的解決方式：<br>
          1. 確認遊戲畫面中目前有可見的紅環（王重生倒數中）<br>
          2. 重新框選，包含整個紅環<br>
          3. 跳過校準，使用預設比例（之後可手動調整）
        </div>
        <div class="calib-actions">
          <button class="dbtn" onclick="window.__detector.restartCalibration()">🔄 重新校準</button>
          <button class="dbtn gray" onclick="window.__detector.skipCalibration()">⏭️ 跳過（手動模式）</button>
        </div>
      </div>
    `;
  }

  // v0.7: 校準成功 → 顯示結果
  function renderCalibAutoResult(region, result) {
    state._calibTempResult = result;
    const body = document.getElementById('dCalibBody');
    const stab = result.stability;

    const cxStable = stab.cxStd < 1 ? '🟢' : stab.cxStd < 2 ? '🟡' : '🔴';
    const cyStable = stab.cyStd < 1 ? '🟢' : stab.cyStd < 2 ? '🟡' : '🔴';
    const rStable = stab.rStd < 0.5 ? '🟢' : stab.rStd < 1.5 ? '🟡' : '🔴';
    const allStable = stab.cxStd < 2 && stab.cyStd < 2 && stab.rStd < 1.5;

    body.innerHTML = `
      <div class="calib-step active">
        <h4>✅ 紅環偵測完成</h4>
        <div class="calib-result-grid">
          <div>
            <div style="color:#888;font-size:11px;margin-bottom:4px">框選範圍 + 偵測結果</div>
            <canvas class="calib-canvas" id="dCalibPreview"></canvas>
          </div>
          <div>
            <div style="color:#888;font-size:11px;margin-bottom:4px">擷取出的徽章區（標準化 32×32）</div>
            <canvas class="calib-canvas" id="dCalibBadge" style="max-width:128px;width:128px;height:128px"></canvas>
          </div>
        </div>
        <div style="margin-top:10px">
          <div class="stab-row">${cxStable} 圓心 X 穩定度：std ${stab.cxStd.toFixed(2)}</div>
          <div class="stab-row">${cyStable} 圓心 Y 穩定度：std ${stab.cyStd.toFixed(2)}</div>
          <div class="stab-row">${rStable} 半徑穩定度：std ${stab.rStd.toFixed(2)}</div>
          <div class="stab-row">圓擬合度：${(stab.confidence*100).toFixed(0)}%</div>
        </div>
        <div style="margin-top:8px;padding:6px;background:${allStable ? 'rgba(0,255,0,0.1)' : 'rgba(255,170,0,0.1)'};border-radius:4px;font-size:11px">
          ${allStable
            ? '<span style="color:#0f0">✅ 校準品質良好！</span>'
            : '<span style="color:#fa0">⚠️ 偵測有些晃動，建議畫面靜止後重試。也可以直接套用，效果通常還是比手動好。</span>'}
        </div>
        <div class="calib-actions">
          <button class="dbtn" onclick="window.__detector.confirmAutoCalibration()">✅ 套用此校準</button>
          <button class="dbtn gray" onclick="window.__detector.restartCalibration()">🔄 重新框選</button>
          <button class="dbtn gray" onclick="window.__detector.skipCalibration()">⏭️ 跳過（手動模式）</button>
        </div>
      </div>
    `;

    // 畫預覽
    setTimeout(() => {
      const preview = document.getElementById('dCalibPreview');
      const video = document.getElementById('dVideo');
      if (preview && video) {
        const scale = Math.min(280 / region.w, 280 / region.h, 6);
        preview.width = region.w * scale;
        preview.height = region.h * scale;
        const ctx = preview.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, preview.width, preview.height);
        // 畫紅環中心（綠點）和圓周（黃線）
        const cx = result.ringCenterRatio.x * preview.width;
        const cy = result.ringCenterRatio.y * preview.height;
        const r = result.ringRadiusRatio * preview.width;
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#0f0';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        // 畫徽章方框（藍色）
        const offset = r * DEFAULT_RING_RATIOS.badgeOffsetRatio;
        const angleRad = -Math.PI / 4;
        const badgeCenterX = cx + offset * Math.cos(angleRad);
        const badgeCenterY = cy + offset * Math.sin(angleRad);
        const badgeSize = r * DEFAULT_RING_RATIOS.badgeSizeRatio;
        ctx.strokeStyle = '#0af';
        ctx.lineWidth = 3;
        ctx.strokeRect(
          badgeCenterX - badgeSize/2,
          badgeCenterY - badgeSize/2,
          badgeSize, badgeSize
        );
      }

      // 畫徽章預覽（用算出來的比例擷取）
      const badgeCanvas = document.getElementById('dCalibBadge');
      if (badgeCanvas && video) {
        const ringX = region.x + region.w * result.ringCenterRatio.x;
        const ringY = region.y + region.h * result.ringCenterRatio.y;
        const ringR = region.w * result.ringRadiusRatio;
        const offset = ringR * DEFAULT_RING_RATIOS.badgeOffsetRatio;
        const angleRad = -Math.PI / 4;
        const bcx = ringX + offset * Math.cos(angleRad);
        const bcy = ringY + offset * Math.sin(angleRad);
        const bsize = ringR * DEFAULT_RING_RATIOS.badgeSizeRatio;
        badgeCanvas.width = 128;
        badgeCanvas.height = 128;
        const ctx = badgeCanvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(video,
          bcx - bsize/2, bcy - bsize/2, bsize, bsize,
          0, 0, 128, 128);
      }
    }, 100);
  }

  // v0.7: 進入校準框選模式
  function enterCalibFrameMode() {
    // 跟原有的框選一樣，但把結果存到 _calibTempRegion
    state._calibrating = true;
    // 切換到 status 模式（重用既有框選 UI）
    setMode('status');
    log('📐 校準中：請在影片上框選計時圈完整區域', '#08f');
    showCalibInstructions();
  }

  function showCalibInstructions() {
    // 顯示一個浮動提示框，告訴使用者怎麼框
    let hint = document.getElementById('dCalibHint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'dCalibHint';
      hint.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#08f;color:#fff;padding:8px 16px;border-radius:6px;z-index:10001;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5)';
      document.body.appendChild(hint);
    }
    hint.innerHTML = '📐 校準中：請框選遊戲畫面的<b>計時圈</b>區域 <button onclick="window.__detector.cancelCalibFrame()" style="margin-left:10px;background:none;border:1px solid #fff;color:#fff;padding:2px 8px;border-radius:3px;cursor:pointer">取消</button>';
    hint.style.display = 'block';
  }

  function hideCalibInstructions() {
    const hint = document.getElementById('dCalibHint');
    if (hint) hint.style.display = 'none';
  }

  // v0.7: 進行紅環校準（連續抓 N 次取最佳結果）
  // region: 使用者框選的計時圈範圍
  async function runRingCalibration(region, options = {}) {
    const samples = options.samples || 10;
    const results = [];

    for (let i = 0; i < samples; i++) {
      const ring = detectRedRing(region, {
        redThreshold: options.redThreshold || 150,
        redDominance: options.redDominance || 60
      });
      if (ring && ring.found) {
        results.push(ring);
      }
      if (i < samples - 1) await new Promise(r => setTimeout(r, 100));
    }

    if (results.length === 0) {
      return { success: false, reason: '無法偵測到紅環（請確認當前畫面有紅環）' };
    }

    // 取中位數（避免極端值）
    const sortBy = (key) => results.slice().sort((a, b) => a[key] - b[key]);
    const median = (arr, key) => arr[Math.floor(arr.length / 2)][key];
    const cxMed = median(sortBy('centerX'), 'centerX');
    const cyMed = median(sortBy('centerY'), 'centerY');
    const rMed = median(sortBy('radius'), 'radius');

    // 計算標準差（評估穩定性）
    const stdDev = (vals) => {
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      return Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
    };
    const cxStd = stdDev(results.map(r => r.centerX));
    const cyStd = stdDev(results.map(r => r.centerY));
    const rStd = stdDev(results.map(r => r.radius));

    return {
      success: true,
      ringCenterRatio: { x: cxMed / region.w, y: cyMed / region.h },
      ringRadiusRatio: rMed / region.w,
      ringCenterAbs: { x: region.x + cxMed, y: region.y + cyMed },
      ringRadiusAbs: rMed,
      stability: {
        cxStd, cyStd, rStd,
        samples: results.length,
        confidence: results.reduce((s, r) => s + r.confidence, 0) / results.length
      }
    };
  }

  // v0.7: 套用校準結果（含手動模式 / 自動模式）
  function applyCalibration(region, ringResult, useDefault = false) {
    state.calibration = state.calibration || {};
    state.calibration.timing = {
      region: { ...region },
      ringCenterRatio: useDefault ? DEFAULT_RING_RATIOS.ringCenterRatio : ringResult.ringCenterRatio,
      ringRadiusRatio: useDefault ? DEFAULT_RING_RATIOS.ringRadiusRatio : ringResult.ringRadiusRatio,
      badgeOffsetRatio: DEFAULT_RING_RATIOS.badgeOffsetRatio,
      badgeSizeRatio: DEFAULT_RING_RATIOS.badgeSizeRatio,
      calibratedAt: Date.now(),
      mode: useDefault ? 'manual' : 'auto'
    };
    saveCalibration();
  }


  // ═══ 擷取分流區域 ═══
  function captureChCanvas(region) {
    const canvas = document.createElement('canvas');
    canvas.width = region.w;
    canvas.height = region.h;
    const video = document.getElementById('dVideo');
    canvas.getContext('2d').drawImage(video,
      region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    return canvas;
  }

  // ═══════════════════════════════════════════════
  // v0.6.4: 紅環偵測（RANSAC + 嚴格篩選對抗背景雜訊）
  // ═══════════════════════════════════════════════

  // 三點求圓
  function circleFrom3Points(p1, p2, p3) {
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null;
    const ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / d;
    const uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / d;
    const r = Math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2);
    return { centerX: ux, centerY: uy, radius: r };
  }

  // 解 3x3 線性方程組
  function solve3x3(M, b) {
    const det = (m) =>
        m[0][0] * (m[1][1]*m[2][2] - m[1][2]*m[2][1])
      - m[0][1] * (m[1][0]*m[2][2] - m[1][2]*m[2][0])
      + m[0][2] * (m[1][0]*m[2][1] - m[1][1]*m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-9) return null;
    const replaceCol = (col) => M.map((row, i) => row.map((v, j) => j === col ? b[i] : v));
    return [det(replaceCol(0)) / D, det(replaceCol(1)) / D, det(replaceCol(2)) / D];
  }

  function fitCircle(points) {
    if (points.length < 3) return null;
    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
    let sumZ = 0, sumXZ = 0, sumYZ = 0;
    const n = points.length;
    for (const p of points) {
      const z = p.x * p.x + p.y * p.y;
      sumX += p.x; sumY += p.y;
      sumXX += p.x * p.x; sumYY += p.y * p.y;
      sumXY += p.x * p.y;
      sumZ += z;
      sumXZ += p.x * z;
      sumYZ += p.y * z;
    }
    const M = [[sumXX, sumXY, sumX],[sumXY, sumYY, sumY],[sumX,  sumY,  n]];
    const b = [sumXZ, sumYZ, sumZ];
    const sol = solve3x3(M, b);
    if (!sol) return null;
    const [A, B, C] = sol;
    const a = A / 2, cy = B / 2;
    const r2 = C + a*a + cy*cy;
    if (r2 <= 0) return null;
    return { centerX: a, centerY: cy, radius: Math.sqrt(r2) };
  }

  // RANSAC 找最佳圓（對抗雜訊）
  function ransacCircle(points, options = {}) {
    const iterations = options.iterations || 200;
    const tolerance = options.tolerance || 2;
    const minRadius = options.minRadius || 5;
    const maxRadius = options.maxRadius || 100;

    if (points.length < 10) return null;

    let bestCircle = null;
    let bestInliers = [];

    for (let iter = 0; iter < iterations; iter++) {
      const i1 = Math.floor(Math.random() * points.length);
      let i2 = Math.floor(Math.random() * points.length);
      let i3 = Math.floor(Math.random() * points.length);
      while (i2 === i1) i2 = Math.floor(Math.random() * points.length);
      while (i3 === i1 || i3 === i2) i3 = Math.floor(Math.random() * points.length);

      const p1 = points[i1], p2 = points[i2], p3 = points[i3];

      // 排除靠太近的點
      const d12 = Math.sqrt((p1.x-p2.x)**2 + (p1.y-p2.y)**2);
      const d13 = Math.sqrt((p1.x-p3.x)**2 + (p1.y-p3.y)**2);
      const d23 = Math.sqrt((p2.x-p3.x)**2 + (p2.y-p3.y)**2);
      if (d12 < 5 || d13 < 5 || d23 < 5) continue;

      const circle = circleFrom3Points(p1, p2, p3);
      if (!circle) continue;
      if (circle.radius < minRadius || circle.radius > maxRadius) continue;

      const inliers = [];
      for (const p of points) {
        const dx = p.x - circle.centerX;
        const dy = p.y - circle.centerY;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (Math.abs(dist - circle.radius) <= tolerance) {
          inliers.push(p);
        }
      }

      if (inliers.length > bestInliers.length) {
        bestCircle = circle;
        bestInliers = inliers;
      }
    }

    if (!bestCircle || bestInliers.length < 10) return null;

    // 用最佳 inliers 做最小二乘擬合
    const refined = fitCircle(bestInliers);
    return {
      ...(refined || bestCircle),
      inlierCount: bestInliers.length,
      inliers: bestInliers
    };
  }

  function detectRedRing(region, options = {}) {
    const video = document.getElementById('dVideo');
    if (!video || !video.videoWidth) return null;

    const canvas = document.createElement('canvas');
    canvas.width = region.w; canvas.height = region.h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    const imgData = ctx.getImageData(0, 0, region.w, region.h);
    const data = imgData.data;

    const redThreshold = options.redThreshold || 150;
    const redDominance = options.redDominance || 60;
    const useRansac = options.useRansac !== false;

    // 收集紅色像素
    const redPixels = [];
    for (let y = 0; y < region.h; y++) {
      for (let x = 0; x < region.w; x++) {
        const i = (y * region.w + x) * 4;
        const r = data[i], g = data[i+1], b = data[i+2];
        if (r > redThreshold && (r - Math.max(g, b)) > redDominance) {
          redPixels.push({ x, y });
        }
      }
    }

    if (redPixels.length < 20) {
      return { found: false, reason: '紅色像素太少（<20）。試試降低紅色門檻', redPixels: redPixels.length };
    }

    // 用 RANSAC 找紅環
    let circle, inliers = redPixels;
    if (useRansac) {
      const ransac = ransacCircle(redPixels, {
        iterations: 200,
        tolerance: 2,
        minRadius: Math.min(region.w, region.h) * 0.15,
        maxRadius: Math.min(region.w, region.h) * 0.6
      });
      if (!ransac) {
        return { found: false, reason: 'RANSAC 找不到合適的圓（紅環可能被雜訊淹沒）', redPixels: redPixels.length };
      }
      circle = { centerX: ransac.centerX, centerY: ransac.centerY, radius: ransac.radius };
      inliers = ransac.inliers;
    } else {
      const fit = fitCircle(redPixels);
      if (!fit) return { found: false, reason: '擬合失敗', redPixels: redPixels.length };
      circle = fit;
    }

    let { centerX, centerY, radius } = circle;

    let totalErr = 0;
    for (const p of inliers) {
      const dx = p.x - centerX, dy = p.y - centerY;
      const e = Math.abs(Math.sqrt(dx*dx + dy*dy) - radius);
      totalErr += e;
    }
    const meanErr = totalErr / inliers.length;
    const confidence = Math.max(0, Math.min(1, 1 - (meanErr / (radius * 0.3))));

    return {
      found: true,
      centerX, centerY, radius,
      meanErr, confidence,
      redPixelCount: redPixels.length,
      filteredCount: inliers.length,
      redPixels,
      inliers
    };
  }

  function deriveBadgeFromRing(ring, options = {}) {
    if (!ring || !ring.found) return null;
    const offsetRatio = options.offsetRatio !== undefined ? options.offsetRatio : 0.95;
    const sizeRatio = options.sizeRatio !== undefined ? options.sizeRatio : 0.65;
    const angleRad = -Math.PI / 4;

    const dx = ring.radius * offsetRatio * Math.cos(angleRad);
    const dy = ring.radius * offsetRatio * Math.sin(angleRad);
    const badgeCenterX = ring.centerX + dx;
    const badgeCenterY = ring.centerY + dy;
    const badgeSize = ring.radius * sizeRatio;

    return {
      centerX: badgeCenterX,
      centerY: badgeCenterY,
      x: Math.round(badgeCenterX - badgeSize / 2),
      y: Math.round(badgeCenterY - badgeSize / 2),
      w: Math.round(badgeSize),
      h: Math.round(badgeSize),
      offsetRatio, sizeRatio
    };
  }


  function analyzeStatusMetrics(region) {
    const canvas = document.getElementById('dCanStatus');
    canvas.width = region.w; canvas.height = region.h;
    const ctx = canvas.getContext('2d');
    const video = document.getElementById('dVideo');
    ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);

    const imageData = ctx.getImageData(0, 0, region.w, region.h);
    const data = imageData.data;
    const w = region.w, h = region.h;
    let redCount = 0, whiteCount = 0, totalBright = 0;
    const n = w * h;
    const badge = getBadgeRect(region);
    const badgeX1 = badge.x, badgeY1 = badge.y;
    const badgeX2 = badge.x + badge.w, badgeY2 = badge.y + badge.h;
    let badgeWhiteCount = 0, badgeTotalPx = 0;

    const debugCanvas = state.debugMode ? document.getElementById('dDebugCanvas') : null;
    let debugData = null;
    if (debugCanvas) {
      debugCanvas.width = w * 4;
      debugCanvas.height = h * 4;
      const dctx = debugCanvas.getContext('2d');
      dctx.imageSmoothingEnabled = false;
      dctx.drawImage(canvas, 0, 0, debugCanvas.width, debugCanvas.height);
      debugData = dctx.getImageData(0, 0, debugCanvas.width, debugCanvas.height);
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i+1], b = data[i+2];
        const bright = (r + g + b) / 3;
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        totalBright += bright;
        const isRed = r > 80 && (r - Math.max(g, b)) > 25;
        const isBrightWhite = maxC > 200 && (maxC - minC) < 60;
        if (isRed) {
          redCount++;
          if (debugData) {
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
              const px = (x * 4 + dx), py = (y * 4 + dy);
              const di = (py * debugCanvas.width + px) * 4;
              debugData.data[di] = 0; debugData.data[di+1] = 255; debugData.data[di+2] = 0;
            }
          }
        }
        if (isBrightWhite) {
          whiteCount++;
          if (debugData) {
            for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
              const px = (x * 4 + dx), py = (y * 4 + dy);
              const di = (py * debugCanvas.width + px) * 4;
              debugData.data[di] = 0; debugData.data[di+1] = 120; debugData.data[di+2] = 255;
            }
          }
        }
        if (x >= badgeX1 && x < badgeX2 && y >= badgeY1 && y < badgeY2) {
          badgeTotalPx++;
          if (isBrightWhite) badgeWhiteCount++;
        }
      }
    }
    if (debugData) {
      const dctx = debugCanvas.getContext('2d');
      dctx.putImageData(debugData, 0, 0);
      dctx.strokeStyle = '#f80';
      dctx.lineWidth = 2;
      dctx.strokeRect(badgeX1 * 4, badgeY1 * 4, (badgeX2 - badgeX1) * 4, (badgeY2 - badgeY1) * 4);
      dctx.fillStyle = '#f80';
      dctx.font = 'bold 11px sans-serif';
      dctx.fillText('徽章', badgeX1 * 4 + 2, badgeY1 * 4 + 12);
    }
    return {
      redRatio: redCount / n,
      whiteRatio: whiteCount / n,
      badgeWhiteRatio: badgeTotalPx > 0 ? badgeWhiteCount / badgeTotalPx : 0,
      avgTotalBright: totalBright / n
    };
  }

  async function ocrBadgeFallback(badgeCanvas) {
    const passes = [
      { preprocess: (s) => extractBrightPixels(upscale(s, 8), 180) },
      { preprocess: (s) => extractBrightPixels(upscale(s, 8), 210) },
      { preprocess: (s) => preprocessForOCR(s, { scale: 8 }) },
      { preprocess: (s) => preprocessForOCR(s, { scale: 8, invert: true }) }
    ];
    const results = [];
    for (const p of passes) {
      try {
        const processed = p.preprocess(badgeCanvas);
        const { data } = await Tesseract.recognize(processed, 'eng', {
          logger: () => {},
          tessedit_pageseg_mode: '10',
          tessedit_char_whitelist: 'ON1234'
        });
        const text = data.text.trim().replace(/\s+/g, '').replace(/[^ON1234]/g, '');
        results.push({ text, confidence: data.confidence / 100 });
      } catch (e) {
        results.push({ text: '', confidence: 0 });
      }
    }
    const votes = {};
    for (const r of results) {
      if (!r.text) continue;
      if (!votes[r.text]) votes[r.text] = { count: 0, totalConf: 0 };
      votes[r.text].count++;
      votes[r.text].totalConf += r.confidence;
    }
    let bestText = '', bestScore = 0;
    for (const [text, info] of Object.entries(votes)) {
      const score = info.count * (info.totalConf / info.count);
      if (score > bestScore) { bestScore = score; bestText = text; }
    }
    const avgConf = votes[bestText] ? votes[bestText].totalConf / votes[bestText].count : 0;
    return { text: bestText, confidence: avgConf };
  }

  // ═══ 核心：階段偵測（模板比對為主，OCR 為 fallback）═══
  async function detectPhase(region) {
    const metrics = analyzeStatusMetrics(region);
    const badgeCanvas = captureBadgeCanvas(region);
    state.lastBadgeCanvas = badgeCanvas;

    // 先試模板比對
    const templateMatch = await TemplateDB.match('phase', badgeCanvas);

    if (state.debugMode) {
      console.log(DEBUG_PREFIX, 'detectPhase', {
        metrics,
        template: templateMatch
      });
    }

    // 【情境 1】模板匹配超高信心
    if (templateMatch && templateMatch.similarity >= TEMPLATE_MIN_SIM) {
      return {
        phase: templateMatch.label,
        confidence: templateMatch.similarity,
        metrics,
        source: 'template',
        templateMatch
      };
    }

    // 【情境 2】模板不夠用 / 信心不足 → 用 OCR 當 fallback
    const ocr = await ocrBadgeFallback(badgeCanvas);
    const ocrText = ocr.text.toUpperCase();
    let ocrPhase = null;
    if (ocrText === 'ON') ocrPhase = 'ON';
    else if (ocrText === '1') ocrPhase = 'R1';
    else if (ocrText === '2') ocrPhase = 'R2';
    else if (ocrText === '3') ocrPhase = 'R3';
    else if (ocrText === '4') ocrPhase = 'R4';

    const hasWhiteInBadge = metrics.badgeWhiteRatio > 0.03;

    // 【情境 3】模板與 OCR 一致 → 高信心
    if (templateMatch && ocrPhase && templateMatch.label === ocrPhase) {
      return {
        phase: ocrPhase,
        confidence: Math.max(templateMatch.similarity, ocr.confidence),
        metrics,
        source: 'template+ocr',
        templateMatch,
        ocrText
      };
    }

    // 【情境 4】模板不確定，但 OCR 有結果
    if (ocrPhase && ocr.confidence >= 0.3) {
      return {
        phase: ocrPhase,
        confidence: ocr.confidence,
        metrics,
        source: 'ocr',
        templateMatch,
        ocrText
      };
    }

    // 【情境 5】模板有一定信心（雖未達 0.85）
    if (templateMatch && templateMatch.similarity >= TEMPLATE_AMBIGUOUS) {
      return {
        phase: templateMatch.label,
        confidence: templateMatch.similarity,
        metrics,
        source: 'template-low',
        templateMatch
      };
    }

    // 【情境 6】都沒讀到 → 等待中
    return {
      phase: 'WAITING',
      confidence: hasWhiteInBadge ? 0.3 : 0.9,
      metrics,
      source: 'fallback',
      templateMatch,
      ocrText
    };
  }

  async function ocrMultiPass(region, targetCanvas, lang, whitelist, psm) {
    const src = document.createElement('canvas');
    src.width = region.w; src.height = region.h;
    const video = document.getElementById('dVideo');
    src.getContext('2d').drawImage(video, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    if (targetCanvas) {
      targetCanvas.width = region.w; targetCanvas.height = region.h;
      targetCanvas.getContext('2d').drawImage(src, 0, 0);
    }
    const passes = [
      { opts: { scale: 4, invert: false } },
      { opts: { scale: 4, invert: true } },
      { opts: { scale: 6, invert: false } }
    ];
    const results = [];
    for (const p of passes) {
      try {
        const c = preprocessForOCR(src, p.opts);
        const o = { logger: () => {}, tessedit_pageseg_mode: psm || '7' };
        if (whitelist) o.tessedit_char_whitelist = whitelist;
        const { data } = await Tesseract.recognize(c, lang, o);
        results.push({
          text: data.text.trim().replace(/\s+/g, ''),
          confidence: data.confidence / 100
        });
      } catch (e) {
        results.push({ text: '', confidence: 0 });
      }
    }
    results.sort((a, b) => b.confidence - a.confidence);
    return results[0];
  }

  // ═══ 分流偵測：模板比對 + OCR fallback ═══
  async function detectCh(region) {
    const chCanvas = captureChCanvas(region);
    state.lastChCanvas = chCanvas;

    // 先試模板比對
    const templateMatch = await TemplateDB.match('ch', chCanvas);

    // 更新除錯 canvas
    const debugCh = document.getElementById('dCanCh');
    if (debugCh) {
      debugCh.width = chCanvas.width;
      debugCh.height = chCanvas.height;
      debugCh.getContext('2d').drawImage(chCanvas, 0, 0);
    }

    if (templateMatch && templateMatch.similarity >= TEMPLATE_MIN_SIM) {
      return {
        ch: templateMatch.label,
        confidence: templateMatch.similarity,
        source: 'template',
        templateMatch,
        raw: ''
      };
    }

    // Fallback 到 OCR
    const ocr = await ocrMultiPass(region, null, 'eng', 'CH.0123456789 ');
    const m = ocr.text.match(/(\d+)/);
    const ch = m ? m[1] : null;

    if (templateMatch && ch && templateMatch.label === ch) {
      return {
        ch, confidence: Math.max(templateMatch.similarity, ocr.confidence),
        source: 'template+ocr', templateMatch, raw: ocr.text
      };
    }
    if (ch && ocr.confidence >= 0.3) {
      return { ch, confidence: ocr.confidence, source: 'ocr', templateMatch, raw: ocr.text };
    }
    if (templateMatch && templateMatch.similarity >= TEMPLATE_AMBIGUOUS) {
      return { ch: templateMatch.label, confidence: templateMatch.similarity, source: 'template-low', templateMatch, raw: ocr.text };
    }
    return { ch: null, confidence: 0, source: 'none', templateMatch, raw: ocr.text };
  }

  function matchMapName(ocrText) {
    if (!ocrText) return { matched: null, confidence: 0, raw: ocrText };
    const numMatch = ocrText.match(/^\d{1,3}$/);
    if (numMatch) return { matched: numMatch[0], confidence: 1.0, raw: ocrText };
    if (state.mapDictionary[ocrText]) {
      return { matched: state.mapDictionary[ocrText], confidence: 1.0, raw: ocrText };
    }
    let bestMatch = null, bestSim = 0, bestKey = '';
    for (const [key, code] of Object.entries(state.mapDictionary)) {
      const sim = similarity(ocrText, key);
      if (sim > bestSim) { bestSim = sim; bestMatch = code; bestKey = key; }
    }
    if (bestSim >= 0.6) return { matched: bestMatch, confidence: bestSim, raw: ocrText, matchedName: bestKey };
    if (typeof window.currentData === 'object') {
      const active = new Set();
      Object.values(window.currentData).forEach(b => { if (b.map) active.add(b.map); });
      for (const code of active) {
        if (ocrText.includes(code)) return { matched: code, confidence: 0.8, raw: ocrText };
      }
    }
    return { matched: null, confidence: 0, raw: ocrText };
  }

  function initLearning() {
    try {
      db.ref('shared/mapDictionary').on('value',
        snap => {
          const shared = snap.val() || {};
          state.mapDictionary = { ...BUILTIN_MAP_DICTIONARY, ...shared };
          state.dictLoaded = true;
          updateDictInfo();
        },
        err => {
          state.dictLoaded = true;
          updateDictInfo('⚠️ Firebase 字典連線失敗');
        }
      );
      setTimeout(() => {
        if (!state.dictLoaded) {
          state.dictLoaded = true;
          updateDictInfo('⚠️ 字典載入逾時');
        }
      }, 5000);
    } catch (e) {
      state.dictLoaded = true;
      updateDictInfo('❌ 字典初始化失敗');
    }
  }

  function contributeMapAlias(ocrRaw, correctCode) {
    if (!ocrRaw || !correctCode || ocrRaw === correctCode) return;
    if (ocrRaw.length < 2 || ocrRaw.length > 20) return;
    if (/^\d+$/.test(ocrRaw)) return;
    const safeKey = ocrRaw.replace(/[.#$[\]/]/g, '_');
    db.ref(`shared/mapDictionary/${safeKey}`).set(correctCode)
      .then(() => log(`🎓 已貢獻：「${ocrRaw}」= ${correctCode}`, '#ff0'))
      .catch(e => log('❌ 貢獻失敗：' + e.message, '#f33'));
  }

  // ═══ 音量取得：從主畫面的 volRange 讀取 ═══
  function getMainVolume() {
    if (state.muted) return 0;
    // TOS M FB TIME 主畫面的音量滑桿：id="volRange" class="vol-range" range 0~1
    const slider = document.querySelector('#volRange, input.vol-range');
    if (slider) {
      const val = parseFloat(slider.value);
      // 若 max 大於 10 視為 0-100 範圍，否則視為 0-1 範圍
      return parseFloat(slider.max) > 10 ? val / 100 : val;
    }
    return 0.5;  // 找不到就預設 50%
  }

  function beep(freq) {
    const vol = getMainVolume();
    if (vol <= 0) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.value = 0.15 * vol;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 150);
    } catch (e) {}
  }

  function injectUI() {
    const audioControls = document.querySelector('.audio-controls');
    if (!audioControls) { setTimeout(injectUI, 500); return; }
    if (document.getElementById('detectBtn')) return;

    const btn = document.createElement('button');
    btn.id = 'detectBtn';
    btn.className = 'audio-btn';
    btn.title = '螢幕偵測 v0.7.0';
    btn.innerHTML = '📷';
    btn.onclick = togglePanel;
    audioControls.appendChild(btn);

    TemplateDB.load();

    const style = document.createElement('style');
    style.textContent = `
      #detectorPanel {
        position: fixed; top: 80px; right: 20px;
        background: var(--bg-card, #111); border: 2px solid var(--border, #333);
        border-radius: 8px; z-index: 9998;
        font-size: 13px; color: var(--text-title, #aaa);
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        display: none;
        max-height: calc(100vh - 40px); overflow: hidden;
        transition: width 0.25s ease;
      }
      #detectorPanel.open { display: flex; flex-direction: column; }
      #detectorPanel.compact { width: 260px; }
      #detectorPanel.full { width: 500px; }
      body.light #detectorPanel { background: #fff; border-color: #ddd; }
      #detectorPanel .panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; background: #1a1a1a;
        border-bottom: 1px solid #333; border-radius: 6px 6px 0 0;
        cursor: move; user-select: none; flex-shrink: 0;
      }
      body.light #detectorPanel .panel-header { background: #f5f5f2; border-bottom-color: #ddd; }
      #detectorPanel .panel-header:active { cursor: grabbing; }
      #detectorPanel .panel-body { overflow-y: auto; padding: 10px; }
      #detectorPanel h3 { color: #0f0; margin: 0; font-size: 14px; }
      body.light #detectorPanel h3 { color: #1a7a1a; }
      #detectorPanel .panel-ctrl-btn {
        background: none; border: 1px solid #444; color: #888;
        padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;
        margin-left: 4px;
      }
      #detectorPanel .panel-ctrl-btn:hover { color: #ddd; border-color: #666; }
      #detectorPanel .panel-ctrl-btn.muted { color: #f33; border-color: #622; }
      /* v0.6.4: 訓練模式啟用時 */
      #detectorPanel .panel-ctrl-btn.training {
        color: #fa0; border-color: #fa0;
        background: rgba(255, 170, 0, 0.15);
        box-shadow: 0 0 5px rgba(255, 170, 0, 0.4);
      }
      body.light #detectorPanel .panel-ctrl-btn.training {
        color: #c87c00; border-color: #c87c00;
        background: rgba(200, 124, 0, 0.15);
      }
      /* 訓練模式時面板邊框變橘色 */
      #detectorPanel.training-mode { border-color: #fa0; box-shadow: 0 0 15px rgba(255, 170, 0, 0.3); }
      body.light #detectorPanel.training-mode { border-color: #c87c00; }
      body.light #detectorPanel .panel-ctrl-btn { border-color: #ccc; color: #666; }
      #detectorPanel .sec {
        background: var(--bg-card-compact, #0e0e0e);
        padding: 8px; border-radius: 6px; margin-bottom: 8px;
        border: 1px solid var(--border, #222);
      }
      #detectorPanel .sec.important { border: 1px solid #0f0; background: rgba(0, 255, 0, 0.05); }
      #detectorPanel .sec.learn { border: 1px solid #fa0; background: rgba(255, 170, 0, 0.05); }
      body.light #detectorPanel .sec.important { border-color: #1a7a1a; background: rgba(26, 122, 26, 0.05); }
      body.light #detectorPanel .sec.learn { border-color: #c87c00; background: rgba(200, 124, 0, 0.05); }
      #detectorPanel .dbtn {
        background: #0f0; color: #000; border: none; padding: 5px 10px;
        border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 12px;
        margin: 2px;
      }
      #detectorPanel .dbtn.gray { background: #444; color: #ccc; }
      #detectorPanel .dbtn.red { background: #622; color: #f66; }
      #detectorPanel .dbtn.orange { background: #f80; color: #000; }
      #detectorPanel .dbtn.blue { background: #08f; color: #000; }
      #detectorPanel .dbtn:disabled { opacity: 0.4; cursor: not-allowed; }
      #detectorPanel .mode-btn {
        background: #333; color: #aaa; border: 1px solid #555;
        padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; margin: 2px;
      }
      #detectorPanel .mode-btn.active { background: #050; color: #0f0; border-color: #0f0; }
      body.light #detectorPanel .mode-btn.active { background: #d0f0d0; color: #1a7a1a; border-color: #1a7a1a; }
      #detectorPanel .preview-scroll {
        position: relative; overflow: auto; max-height: 260px;
        border: 2px solid #333; background: #000;
      }
      #detectorPanel .preview-wrap { position: relative; display: inline-block; }
      #detectorPanel video { display: block; }
      #detectorPanel .region {
        position: absolute; border: 2px solid; background: rgba(255,255,255,0.08);
        pointer-events: none; font-size: 10px; padding: 1px 3px; color: #fff; font-weight: bold;
      }
      #detectorPanel .region.status { border-color: #f33; }
      #detectorPanel .region.map { border-color: #3f3; }
      #detectorPanel .region.ch { border-color: #ff3; }
      #detectorPanel .compact-results {
        display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px;
      }
      #detectorPanel .mini-card {
        background: #1a1a1a; padding: 6px 4px; border-radius: 4px; text-align: center;
      }
      body.light #detectorPanel .mini-card { background: #e8e5e0; }
      #detectorPanel .mini-card .label { font-size: 9px; color: #888; }
      #detectorPanel .mini-card .value {
        font-size: 14px; font-weight: bold; margin-top: 2px; min-height: 18px; color: #0f0;
      }
      body.light #detectorPanel .mini-card .value { color: #1a7a1a; }
      #detectorPanel .mini-card .conf-bar {
        height: 2px; background: #333; border-radius: 1px; margin-top: 3px; overflow: hidden;
      }
      #detectorPanel .mini-card .conf-fill { height: 100%; transition: width 0.3s, background 0.3s; }
      #detectorPanel .result-grid {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px;
      }
      #detectorPanel .result-card {
        background: #1a1a1a; padding: 6px; border-radius: 4px; text-align: center;
      }
      body.light #detectorPanel .result-card { background: #e8e5e0; }
      #detectorPanel .result-card .v {
        font-size: 15px; font-weight: bold; min-height: 22px; margin: 3px 0;
      }
      #detectorPanel .result-card canvas { border: 1px solid #555; max-width: 100%; background: #000; }
      #detectorPanel .conf-bar {
        height: 3px; background: #333; border-radius: 2px; margin: 2px 0; overflow: hidden;
      }
      #detectorPanel .conf-fill { height: 100%; transition: width 0.3s, background 0.3s; }
      #detectorPanel input[type=number], #detectorPanel input[type=text], #detectorPanel select {
        background: #222; color: #fff; border: 1px solid #555;
        padding: 3px 5px; border-radius: 3px; font-size: 12px;
      }
      body.light #detectorPanel input[type=number], body.light #detectorPanel input[type=text], body.light #detectorPanel select {
        background: #fff; color: #333; border-color: #ccc;
      }
      #detectorPanel input[type=range] {
        width: 100%; -webkit-appearance: none; height: 4px;
        background: #333; border-radius: 2px; outline: none;
      }
      #detectorPanel input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none; width: 14px; height: 14px;
        background: #0f0; border-radius: 50%; cursor: pointer;
      }
      #detectorPanel .confirm-banner {
        padding: 10px; border-radius: 6px; font-weight: bold; margin: 8px 0;
        background: #ff9d00; color: #000; font-size: 12px;
      }
      #detectorPanel .confirm-banner.low-conf { background: #ff3333; color: #fff; }
      #detectorPanel .confirm-banner.waiting { background: #888; color: #fff; }
      #detectorPanel .confirm-banner.on { background: #f33; color: #fff; }
      #detectorPanel .small { font-size: 10px; color: #888; }
      body.light #detectorPanel .sec { background: #f5f5f2; border-color: #ddd; }
      body.light #detectorPanel .result-card .v { color: #333; }
      body.light #detectorPanel .dbtn { background: #1a7a1a; color: #fff; }
      #detectorPanel .log-line { font-family: monospace; font-size: 10px; color: #888; }
      #detectorPanel .correction-row {
        display: flex; gap: 6px; margin-top: 6px; align-items: center;
      }
      #detectorPanel .correction-row input, #detectorPanel .correction-row select { flex: 1; }
      #detectorPanel .zoom-row {
        display: flex; align-items: center; gap: 8px; margin: 6px 0;
      }
      #detectorPanel .zoom-row input[type=range] { flex: 1; }
      #detectorPanel .zoom-val {
        font-family: monospace; color: #0f0; font-weight: bold;
        min-width: 40px; text-align: center;
      }
      body.light #detectorPanel .zoom-val { color: #1a7a1a; }
      #detectorPanel .metrics {
        font-family: monospace; font-size: 10px; color: #aaa; margin-top: 4px;
        text-align: left;
      }
      #detectorPanel label.bold-opt {
        display: block; font-size: 12px; color: #0f0; padding: 3px 0; font-weight: bold;
      }
      body.light #detectorPanel label.bold-opt { color: #1a7a1a; }
      #detectorPanel .debug-box {
        background: #000; border: 1px solid #555; padding: 4px;
        margin-top: 6px; text-align: center; position: relative;
      }
      #detectorPanel .debug-box canvas { max-width: 100%; display: block; margin: 0 auto; }
      #detectorPanel .threshold-row {
        display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0; font-size: 11px;
      }
      #detectorPanel .tip-box {
        background: #332; border-left: 3px solid #fa0; padding: 6px 10px;
        margin: 6px 0; font-size: 11px; color: #fd0;
      }
      body.light #detectorPanel .tip-box {
        background: #fff8e0; color: #8a5c00; border-color: #c87c00;
      }
      #detectorPanel .full-only { display: block; }
      #detectorPanel.compact .full-only { display: none; }
      #detectorPanel .compact-only { display: none; }
      #detectorPanel.compact .compact-only { display: block; }
      #detectorPanel .monitor-status {
        font-size: 10px; padding: 3px 6px; border-radius: 3px;
        background: #222; color: #888; margin-left: 4px;
      }
      #detectorPanel .monitor-status.active {
        background: #050; color: #0f0; animation: pulse 1.5s infinite;
      }
      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

      #dBadgeEditor {
        position: relative; background: #000; border: 1px solid #333;
        margin-top: 6px;
        /* 關鍵：拿掉 overflow:hidden 讓 handle 不被切掉，讓 padding 保留 handle 空間 */
        padding: 8px;
        display: flex; align-items: center; justify-content: center;
        min-height: 160px;
      }
      #dBadgeEditor canvas { display: block; image-rendering: pixelated; }
      #dBadgeEditBox {
        position: absolute; border: 2px solid #f80;
        background: rgba(255, 136, 0, 0.15); cursor: move; box-sizing: border-box;
      }
      #dBadgeEditBox .handle {
        position: absolute; width: 10px; height: 10px;
        background: #f80; border: 1px solid #fff;
      }
      /* handle 往內縮 2px（不會被切掉且仍可辨識） */
      #dBadgeEditBox .handle.tl { top: -5px; left: -5px; cursor: nw-resize; }
      #dBadgeEditBox .handle.tr { top: -5px; right: -5px; cursor: ne-resize; }
      #dBadgeEditBox .handle.bl { bottom: -5px; left: -5px; cursor: sw-resize; }
      #dBadgeEditBox .handle.br { bottom: -5px; right: -5px; cursor: se-resize; }
      #dBadgeEditBox::after {
        content: '徽章'; position: absolute; top: 2px; left: 4px;
        color: #f80; font-size: 10px; font-weight: bold;
        text-shadow: 1px 1px 2px #000;
      }

      /* 模板管理 */
      #detectorPanel .tpl-stats {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
        gap: 4px; margin: 6px 0;
      }
      #detectorPanel .tpl-chip {
        background: #222; padding: 4px 6px; border-radius: 4px;
        font-size: 10px; text-align: center; border: 1px solid #333;
      }
      body.light #detectorPanel .tpl-chip { background: #eee; border-color: #ccc; }
      #detectorPanel .tpl-chip .tpl-label { color: #0f0; font-weight: bold; }
      body.light #detectorPanel .tpl-chip .tpl-label { color: #1a7a1a; }
      #detectorPanel .tpl-chip .tpl-count { color: #888; font-size: 9px; }
      #detectorPanel .tpl-preview {
        display: flex; align-items: center; gap: 8px; margin: 6px 0;
        padding: 8px; background: #111; border-radius: 4px;
        border: 1px solid #333;
      }
      body.light #detectorPanel .tpl-preview { background: #f5f5f2; border-color: #ddd; }
      #detectorPanel .tpl-preview canvas {
        width: 64px; height: 64px; image-rendering: pixelated;
        border: 1px solid #555; background: #000;
      }

      /* v0.6.4: 模板瀏覽 */
      #detectorPanel .tpl-browse-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
        gap: 4px; margin-top: 8px;
      }
      #detectorPanel .tpl-browse-item {
        position: relative;
        background: #000; border: 1px solid #444;
        border-radius: 4px; padding: 2px;
        text-align: center;
      }
      body.light #detectorPanel .tpl-browse-item { background: #f0f0f0; border-color: #ccc; }
      #detectorPanel .tpl-browse-item img {
        width: 100%; aspect-ratio: 1; object-fit: contain;
        image-rendering: pixelated; display: block;
        background: #000;
      }
      #detectorPanel .tpl-browse-item .tpl-del-btn {
        position: absolute; top: -4px; right: -4px;
        width: 18px; height: 18px; border-radius: 50%;
        background: #f33; color: #fff; border: 1px solid #fff;
        font-size: 10px; font-weight: bold; line-height: 1;
        cursor: pointer; padding: 0;
        display: none;
      }
      #detectorPanel .tpl-browse-item:hover .tpl-del-btn { display: block; }
      #detectorPanel .tpl-browse-item .tpl-idx {
        font-size: 9px; color: #888; margin-top: 2px;
      }
      #detectorPanel .tpl-browse-empty {
        grid-column: 1 / -1; text-align: center;
        color: #666; font-size: 11px; padding: 10px;
      }
      #detectorPanel .mini-tpl-header {
        display: flex; align-items: center; gap: 6px;
        cursor: pointer; user-select: none;
        font-size: 12px; color: #fa0; font-weight: bold;
      }
      body.light #detectorPanel .mini-tpl-header { color: #c87c00; }
      #detectorPanel .mini-tpl-header .collapse-arrow {
        font-size: 9px; transition: transform 0.2s;
        display: inline-block;
      }
      #detectorPanel .mini-tpl-header.collapsed .collapse-arrow {
        transform: rotate(-90deg);
      }
      #detectorPanel #dMiniTplBody {
        overflow: hidden; transition: max-height 0.2s, opacity 0.2s;
        max-height: 200px;
      }
      #detectorPanel #dMiniTplBody.collapsed {
        max-height: 0; opacity: 0; margin-top: 0 !important;
      }
      #detectorPanel .tpl-stats-mini {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px;
        margin: 3px 0;
      }
      #detectorPanel .tpl-stats-mini .tpl-chip-mini {
        background: #1a1a1a; padding: 2px 4px; border-radius: 3px;
        font-size: 9px; text-align: center; border: 1px solid #333;
      }
      body.light #detectorPanel .tpl-stats-mini .tpl-chip-mini {
        background: #eee; border-color: #ccc;
      }
      #detectorPanel .tpl-stats-mini .tpl-chip-mini .tpl-label-mini {
        font-weight: bold;
      }

      /* v0.6.4: 精簡擷取預覽 */
      #detectorPanel .mini-preview-grid {
        display: grid; grid-template-columns: 1fr 2fr 1.2fr; gap: 4px;
        align-items: start;
      }
      #detectorPanel .mini-preview-cell {
        background: #000; padding: 3px;
        border: 1px solid #333; border-radius: 3px;
        text-align: center;
      }
      body.light #detectorPanel .mini-preview-cell {
        background: #f0f0f0; border-color: #ccc;
      }
      #detectorPanel .mini-preview-cell .small {
        margin-bottom: 2px; color: #888;
      }
      #detectorPanel .mini-preview-cell canvas {
        width: 100%; max-height: 48px; display: block;
        image-rendering: pixelated;
        object-fit: contain;
        background: #000;
      }
      body.light #detectorPanel .mini-preview-cell canvas { background: #222; }

      #detectorPanel #dMiniPreviewBody {
        overflow: hidden; transition: max-height 0.2s, opacity 0.2s;
        max-height: 300px;
      }
      #detectorPanel #dMiniPreviewBody.collapsed {
        max-height: 0; opacity: 0; margin-top: 0 !important;
      }

      /* v0.6: 偵錯比對模態框 */
      #dInspectModal {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.85);
        z-index: 10000;
        justify-content: center;
        align-items: center;
      }
      #dInspectModal.show { display: flex; }
      #dInspectModal .inspect-box {
        background: #111; border: 2px solid #08f;
        border-radius: 10px;
        max-width: 600px; width: 90%;
        max-height: 85vh;
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      body.light #dInspectModal .inspect-box {
        background: #fff; border-color: #08f;
      }
      #dInspectModal .inspect-header {
        padding: 12px 16px;
        background: #1a1a1a;
        border-bottom: 1px solid #333;
        display: flex; justify-content: space-between; align-items: center;
        color: #08f; font-size: 14px; font-weight: bold;
      }
      body.light #dInspectModal .inspect-header { background: #f5f5f2; border-bottom-color: #ddd; }
      #dInspectModal .inspect-close {
        background: none; border: none; color: #888;
        font-size: 18px; cursor: pointer; padding: 0;
      }
      #dInspectModal .inspect-body {
        overflow-y: auto; padding: 14px;
        font-size: 12px; color: #ccc;
      }
      body.light #dInspectModal .inspect-body { color: #333; }
      #dInspectModal .inspect-query {
        display: flex; gap: 12px; align-items: center;
        margin-bottom: 14px; padding: 10px;
        background: #0a0a0a; border-radius: 6px;
        border: 1px solid #333;
      }
      body.light #dInspectModal .inspect-query { background: #f5f5f2; border-color: #ddd; }
      #dInspectModal .inspect-query canvas {
        width: 64px; height: 64px;
        image-rendering: pixelated;
        border: 1px solid #555; background: #000;
      }
      #dInspectModal .inspect-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        margin-top: 8px;
      }
      #dInspectModal .inspect-table th,
      #dInspectModal .inspect-table td {
        padding: 4px 6px;
        border-bottom: 1px solid #222;
        text-align: center;
      }
      body.light #dInspectModal .inspect-table th,
      body.light #dInspectModal .inspect-table td {
        border-bottom-color: #eee;
      }
      #dInspectModal .inspect-table th {
        background: #1a1a1a; color: #08f; font-weight: bold;
      }
      body.light #dInspectModal .inspect-table th { background: #f0f0f0; color: #0066aa; }
      #dInspectModal .inspect-table tr.winner { background: rgba(0, 255, 0, 0.1); }
      #dInspectModal .inspect-table tr.suspect { background: rgba(255, 80, 80, 0.1); }
      #dInspectModal .inspect-table .tpl-thumb {
        width: 32px; height: 32px;
        image-rendering: pixelated;
        border: 1px solid #444; background: #000;
        vertical-align: middle;
      }
      #dInspectModal .inspect-table .del-tpl {
        background: #f33; color: #fff; border: none;
        padding: 2px 5px; border-radius: 3px;
        font-size: 10px; cursor: pointer;
      }
      #dInspectModal .inspect-bar {
        display: inline-block; height: 4px; width: 40px;
        background: #333; border-radius: 2px; overflow: hidden;
        vertical-align: middle; margin-left: 4px;
      }
      /* v0.7: 校準模態框（複用 inspect 大部分樣式） */
      #dCalibModal {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.85);
        z-index: 10000;
        justify-content: center;
        align-items: center;
      }
      #dCalibModal.show { display: flex; }
      #dCalibModal .calib-box {
        background: #111; border: 2px solid #08f;
        border-radius: 10px;
        max-width: 700px; width: 92%;
        max-height: 90vh;
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      body.light #dCalibModal .calib-box { background: #fff; border-color: #08f; }
      #dCalibModal .calib-header {
        padding: 12px 16px;
        background: #1a1a1a;
        border-bottom: 1px solid #333;
        display: flex; justify-content: space-between; align-items: center;
        color: #08f; font-size: 14px; font-weight: bold;
      }
      body.light #dCalibModal .calib-header { background: #f5f5f2; border-bottom-color: #ddd; }
      #dCalibModal .calib-body {
        overflow-y: auto; padding: 16px;
        font-size: 12px; color: #ccc;
      }
      body.light #dCalibModal .calib-body { color: #333; }
      #dCalibModal .calib-step {
        background: #0a0a0a; border: 1px solid #333;
        border-radius: 6px; padding: 12px; margin-bottom: 10px;
      }
      body.light #dCalibModal .calib-step { background: #f5f5f2; border-color: #ddd; }
      #dCalibModal .calib-step.active {
        border-color: #08f; box-shadow: 0 0 8px rgba(0,136,255,0.3);
      }
      #dCalibModal .calib-step h4 {
        margin: 0 0 8px 0; color: #08f; font-size: 13px;
      }
      #dCalibModal .calib-result-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
        margin-top: 8px;
      }
      #dCalibModal .calib-canvas {
        width: 100%; max-width: 280px;
        border: 1px solid #333; background: #000;
        image-rendering: pixelated;
        display: block;
      }
      #dCalibModal .stab-row {
        font-family: monospace; font-size: 11px;
        margin: 2px 0;
      }
      #dCalibModal .calib-actions {
        display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'detectorPanel';
    panel.className = 'compact';
    panel.innerHTML = `
      <div class="panel-header" id="dPanelHeader">
        <h3>📷 偵測器 <span class="small">v0.7.0</span></h3>
        <div>
          <button class="panel-ctrl-btn" id="dTrainToggle" title="訓練模式：只存模板不送 Firebase">🎯</button>
          <button class="panel-ctrl-btn" id="dMuteToggle" title="靜音切換">🔔</button>
          <button class="panel-ctrl-btn" id="dToggleMode" title="切換精簡/完整">⚙️</button>
          <button class="panel-ctrl-btn" onclick="window.__detector.close()">✕</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="compact-only">
          <div class="sec">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:11px">
              <span id="dCompactStatus">未啟動</span>
              <span id="dMonitorStatus" class="monitor-status">閒置</span>
            </div>
            <div class="compact-results">
              <div class="mini-card"><div class="label">階段</div><div class="value" id="dMiniStatus">—</div><div class="conf-bar"><div class="conf-fill" id="dMiniConfStatus"></div></div></div>
              <div class="mini-card"><div class="label">地圖</div><div class="value" id="dMiniMap">—</div><div class="conf-bar"><div class="conf-fill" id="dMiniConfMap"></div></div></div>
              <div class="mini-card"><div class="label">分流</div><div class="value" id="dMiniCh">—</div><div class="conf-bar"><div class="conf-fill" id="dMiniConfCh"></div></div></div>
            </div>
            <div style="margin-top:6px;display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
              <button class="dbtn" id="dMiniStart">▶️ 擷取</button>
              <button class="dbtn red" id="dMiniStop" disabled>⏹</button>
              <button class="dbtn" id="dMiniAuto" disabled>🔄 監控</button>
              <button class="dbtn red" id="dMiniStopAuto" disabled>⏸</button>
              <button class="dbtn gray" id="dMiniInspect" title="檢視當前偵測的詳細比對結果">🔬</button>
              <button class="dbtn blue" id="dMiniCalibrate" title="校準計時圈位置（v0.7 新功能）">✨ 校準</button>
            </div>
            <!-- v0.7: 校準狀態顯示 -->
            <div id="dCalibStatus" style="font-size:10px;text-align:center;margin-top:4px;color:#888;display:none"></div>
          </div>
          <!-- v0.6.4: 擷取預覽 + 手動標記（可收合） -->
          <div class="sec" style="padding:6px;border:1px solid #08f;background:rgba(0,136,255,0.05)">
            <div class="mini-tpl-header" id="dMiniPreviewHeader" style="color:#08f">
              <span class="collapse-arrow" id="dMiniPreviewArrow">▼</span>
              <span>📸 擷取預覽</span>
              <span class="small" id="dMiniPreviewStatus" style="margin-left:auto;color:#888">閒置</span>
            </div>
            <div id="dMiniPreviewBody" style="margin-top:6px">
              <!-- 3 張小圖 -->
              <div class="mini-preview-grid">
                <div class="mini-preview-cell">
                  <div class="small">階段</div>
                  <canvas id="dMiniPrevBadge"></canvas>
                </div>
                <div class="mini-preview-cell">
                  <div class="small">地圖</div>
                  <canvas id="dMiniPrevMap"></canvas>
                </div>
                <div class="mini-preview-cell">
                  <div class="small">分流</div>
                  <canvas id="dMiniPrevCh"></canvas>
                </div>
              </div>
              <!-- 手動標記 -->
              <div style="margin-top:8px;padding-top:6px;border-top:1px dashed #333">
                <div class="small" style="color:#08f;margin-bottom:4px">✏️ 手動標記此次擷取</div>
                <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
                  <span class="small" style="width:32px">階段</span>
                  <select id="dQuickPhaseLabel" style="flex:1;padding:2px;font-size:11px">
                    <option value="R1">R1</option>
                    <option value="R2">R2</option>
                    <option value="R3">R3</option>
                    <option value="R4">R4</option>
                    <option value="ON">ON</option>
                    <option value="WAITING">等待中</option>
                  </select>
                  <button class="dbtn blue" onclick="window.__detector.quickSavePhase()" style="padding:3px 8px;font-size:10px">💾</button>
                </div>
                <div style="display:flex;gap:4px;align-items:center">
                  <span class="small" style="width:32px">分流</span>
                  <input type="text" id="dQuickChLabel" placeholder="CH 數字" style="flex:1;padding:2px;font-size:11px" inputmode="numeric">
                  <button class="dbtn blue" onclick="window.__detector.quickSaveCh()" style="padding:3px 8px;font-size:10px">💾</button>
                </div>
              </div>
            </div>
          </div>

          <!-- v0.5.1 新增：精簡模式的模板庫（可收合） -->
          <div class="sec learn" style="padding:6px">
            <div class="mini-tpl-header" id="dMiniTplHeader">
              <span class="collapse-arrow" id="dMiniTplArrow">▼</span>
              <span>🧠 模板庫</span>
              <span class="small" id="dMiniTplTotal" style="margin-left:auto"></span>
            </div>
            <div id="dMiniTplBody" style="margin-top:6px">
              <div class="small" style="color:#fa0">階段：</div>
              <div class="tpl-stats-mini" id="dMiniTplPhase"></div>
              <div class="small" style="color:#fa0;margin-top:4px">分流：</div>
              <div class="tpl-stats-mini" id="dMiniTplCh"></div>
            </div>
          </div>
          <div id="dConfirmArea"></div>
        </div>

        <div class="full-only">
          <div class="sec">
            <button class="dbtn" id="dStart">▶️ 開始擷取</button>
            <button class="dbtn red" id="dStop" disabled>⏹ 停止</button>
            <span id="dStatus" style="margin-left:6px;font-size:11px">未啟動</span>
          </div>

          <div class="sec">
            <div style="margin-bottom:6px"><b>① 框選三個區域</b></div>
            <button class="mode-btn active" data-mode="status">🔴 狀態圖示</button>
            <button class="mode-btn" data-mode="map">🟢 地圖名</button>
            <button class="mode-btn" data-mode="ch">🟡 分流</button>
            <button class="mode-btn" data-mode="none">✋ 停</button>
            <div class="tip-box">💡 狀態圖示框整個圓圈（含右上徽章）</div>
            <div class="zoom-row">
              <span class="small">🔍</span>
              <input type="range" id="dZoom" min="0.5" max="4" step="0.1" value="1">
              <span class="zoom-val" id="dZoomVal">1.0x</span>
              <button class="dbtn gray" onclick="window.__detector.resetZoom()" style="padding:2px 6px;font-size:10px">重設</button>
            </div>
            <div class="preview-scroll" id="dPreviewScroll" style="margin-top:8px">
              <div class="preview-wrap" id="dPreview">
                <video id="dVideo" autoplay muted></video>
                <div id="dDrawBox" style="display:none"></div>
                <div class="region status" id="dBoxStatus" style="display:none">圖示</div>
                <div class="region map" id="dBoxMap" style="display:none">地圖</div>
                <div class="region ch" id="dBoxCh" style="display:none">CH</div>
              </div>
            </div>
          </div>

          <div class="sec" id="dBadgeSection" style="display:none">
            <div style="margin-bottom:6px"><b>🎯 徽章範圍微調</b>
              <button class="dbtn gray" onclick="window.__detector.resetBadge()" style="padding:2px 6px;font-size:10px;float:right">重設</button>
            </div>
            <div class="small">拖曳橘框調整位置，拖曳四角調整大小</div>
            <div id="dBadgeEditor">
              <canvas id="dBadgeEditCanvas"></canvas>
              <div id="dBadgeEditBox">
                <div class="handle tl"></div>
                <div class="handle tr"></div>
                <div class="handle bl"></div>
                <div class="handle br"></div>
              </div>
            </div>
            <!-- v0.6.4: 擷取結果預覽（橘框內的真實擷取） -->
            <div id="dBadgeCapturePreview" style="display:flex;gap:8px;align-items:center;margin-top:6px;padding:6px;background:#0a0a0a;border:1px solid #08f;border-radius:4px">
              <canvas id="dBadgeCaptureCanvas" style="width:64px;height:64px;image-rendering:pixelated;border:1px solid #555;background:#000;object-fit:contain"></canvas>
              <div style="flex:1">
                <div class="small" style="color:#08f;font-weight:bold">📸 實際擷取（將存為模板的範圍）</div>
                <div class="small" id="dBadgeCaptureInfo" style="font-family:monospace"></div>
              </div>
            </div>
            <div class="small" id="dBadgeInfo" style="margin-top:4px;font-family:monospace"></div>
          </div>

          <!-- ═══ v0.6.4: 紅環偵測診斷工具 ═══ -->
          <div class="sec" style="border:1px solid #f33;background:rgba(255,51,51,0.05)">
            <div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">
              <b style="color:#f33">🩺 紅環偵測診斷</b>
              <span class="small">驗證自動規範化可行性</span>
            </div>
            <div class="small" style="margin-bottom:6px;color:#aaa">
              診斷紅環中心+半徑能否穩定偵測。如果可以，未來可以「自動對齊擷取」<br>
              讓所有人的模板可共享、不依賴框選範圍。
            </div>
            <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">
              <button class="dbtn" onclick="window.__detector.runDiagnose()" style="padding:4px 8px;font-size:11px">🔬 單次診斷</button>
              <button class="dbtn orange" id="dDiagLoopBtn" onclick="window.__detector.toggleDiagnoseLoop()" style="padding:4px 8px;font-size:11px">🔁 連續測試</button>
              <button class="dbtn gray" onclick="window.__detector.toggleDiagAdvanced()" style="padding:4px 8px;font-size:11px">⚙️ 進階</button>
            </div>

            <!-- 進階參數 -->
            <div id="dDiagAdvanced" style="display:none;background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:6px;margin-bottom:8px">
              <div class="small" style="margin-bottom:4px;color:#888">紅色像素判定門檻：</div>
              <div class="threshold-row">
                <label>R 最低 <input type="number" id="dDiagRedMin" value="150" min="0" max="255" style="width:50px"></label>
                <label>R 比 G/B 高 <input type="number" id="dDiagRedDom" value="60" min="0" max="200" style="width:40px"></label>
              </div>
              <div class="small" style="margin-top:6px;margin-bottom:4px;color:#888">徽章推導參數：</div>
              <div class="threshold-row">
                <label>偏移比例 <input type="number" id="dDiagOffsetRatio" value="0.95" step="0.05" min="0.3" max="1.5" style="width:50px"></label>
                <label>大小比例 <input type="number" id="dDiagSizeRatio" value="0.65" step="0.05" min="0.3" max="1" style="width:50px"></label>
              </div>
              <div class="small" style="color:#666;margin-top:4px">
                試試不同數值觀察「藍框」是否對齊真實徽章
              </div>
            </div>

            <!-- 視覺化區 -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
              <div>
                <div class="small" style="text-align:center;color:#888;margin-bottom:2px">原始畫面</div>
                <canvas id="dDiagOriginal" style="width:100%;border:1px solid #333;background:#000;image-rendering:pixelated;display:block"></canvas>
              </div>
              <div>
                <div class="small" style="text-align:center;color:#888;margin-bottom:2px">偵測視覺化</div>
                <canvas id="dDiagAnnotated" style="width:100%;border:1px solid #333;background:#000;image-rendering:pixelated;display:block"></canvas>
              </div>
            </div>

            <!-- 結果文字 -->
            <div id="dDiagResult" style="font-family:monospace;font-size:11px;line-height:1.6;background:#0a0a0a;padding:6px;border-radius:4px;border:1px solid #333;min-height:50px">
              （尚未診斷）
            </div>

            <!-- 連續測試的穩定度報告 -->
            <div id="dDiagStability" style="margin-top:6px;display:none">
              <div class="small" style="color:#0f0;margin-bottom:2px">📊 穩定度（最近 30 次）</div>
              <div id="dDiagStabilityResult" style="font-family:monospace;font-size:10px;background:#0a0a0a;padding:4px;border-radius:3px;border:1px solid #222"></div>
            </div>
          </div>

          <!-- ═══ 模板管理（v0.5 新增） ═══ -->
          <div class="sec learn">
            <div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">
              <b>🧠 模板庫 <span class="small" id="dTplTotal"></span></b>
              <div>
                <button class="dbtn gray" onclick="window.__detector.exportTpl()" style="padding:2px 6px;font-size:10px">📤</button>
                <button class="dbtn gray" onclick="document.getElementById('dTplImport').click()" style="padding:2px 6px;font-size:10px">📥</button>
                <input type="file" id="dTplImport" accept=".json" style="display:none">
                <button class="dbtn red" onclick="window.__detector.clearTpl()" style="padding:2px 6px;font-size:10px">🗑</button>
              </div>
            </div>
            <div class="small" style="color:#fa0">階段模板：</div>
            <div class="tpl-stats" id="dTplPhase"></div>
            <div class="small" style="color:#fa0;margin-top:4px">分流模板：</div>
            <div class="tpl-stats" id="dTplCh"></div>

            <div class="tpl-preview" id="dTplPreview" style="display:none">
              <canvas id="dTplCanvas"></canvas>
              <div style="flex:1">
                <div class="small">當前偵測到的圖片，可標記為模板：</div>
                <div class="correction-row" style="margin-top:4px">
                  <select id="dTplCategory" style="width:70px">
                    <option value="phase">階段</option>
                    <option value="ch">分流</option>
                  </select>
                  <select id="dTplLabel">
                    <option value="R1">R1</option>
                    <option value="R2">R2</option>
                    <option value="R3">R3</option>
                    <option value="R4">R4</option>
                    <option value="ON">ON</option>
                    <option value="WAITING">等待</option>
                  </select>
                  <button class="dbtn blue" onclick="window.__detector.addTpl()">📌 儲存</button>
                </div>
              </div>
            </div>

            <label class="bold-opt"><input type="checkbox" id="dAutoLearn" checked> 🎓 確認送出時自動加入模板</label>

            <!-- v0.6.4: 瀏覽模板 -->
            <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #444">
              <div style="margin-bottom:6px"><b>🔍 瀏覽模板</b></div>
              <div class="correction-row">
                <select id="dBrowseCategory" style="width:80px">
                  <option value="phase">階段</option>
                  <option value="ch">分流</option>
                </select>
                <select id="dBrowseLabel"></select>
                <span class="small" id="dBrowseCount"></span>
              </div>
              <div id="dBrowseGrid" class="tpl-browse-grid"></div>
            </div>
          </div>

          <div class="sec important">
            <div style="margin-bottom:6px"><b>② 偵測設定</b></div>
            <div class="threshold-row">
              <label>間隔 <input type="number" id="dInterval" value="1500" style="width:55px">ms</label>
              <label>最低置信度 <input type="number" id="dMinConf" value="0.5" step="0.05" min="0" max="1" style="width:50px"></label>
            </div>
            <div class="threshold-row">
              <label>⏱ 重複冷卻 <input type="number" id="dCooldown" value="30" min="0" style="width:55px">秒</label>
            </div>
            <label class="bold-opt"><input type="checkbox" id="dAutoSubmit"> 🚀 自動送出</label>
            <label class="bold-opt"><input type="checkbox" id="dOnlyChange" checked> 🔔 只在階段變化時提示</label>
            <label class="bold-opt"><input type="checkbox" id="dContribute" checked> 🎓 貢獻糾正到社群字典</label>
            <label class="bold-opt"><input type="checkbox" id="dDebugMode"> 🔧 偵錯模式</label>
          </div>

          <div class="sec">
            <button class="dbtn" id="dTest" disabled>🧪 測試讀取</button>
            <button class="dbtn" id="dAuto" disabled>🔄 開始監控</button>
            <button class="dbtn red" id="dStopAuto" disabled>⏸ 停止</button>
            <br>
            <button class="dbtn orange" id="dForceSubmit" disabled>🔥 立即送出</button>
            <div class="result-grid">
              <div class="result-card"><div class="small">階段</div><div class="v" id="dValStatus">—</div><div class="conf-bar"><div class="conf-fill" id="dConfStatus"></div></div><canvas id="dCanStatus"></canvas><div class="metrics" id="dMetrics"></div></div>
              <div class="result-card"><div class="small">地圖</div><div class="v" id="dValMap" style="font-size:12px">—</div><div class="conf-bar"><div class="conf-fill" id="dConfMap"></div></div><canvas id="dCanMap"></canvas></div>
              <div class="result-card"><div class="small">分流</div><div class="v" id="dValCh">—</div><div class="conf-bar"><div class="conf-fill" id="dConfCh"></div></div><canvas id="dCanCh"></canvas></div>
            </div>
            <div id="dDebugBox" class="debug-box" style="display:none">
              <div class="small" style="color:#ff0">🔧 綠=紅環，藍=白字，橘=徽章區</div>
              <canvas id="dDebugCanvas"></canvas>
            </div>
          </div>

          <div class="sec">
            <div style="margin-bottom:6px"><b>🎓 地圖字典</b></div>
            <div style="font-size:11px" id="dDictInfo">載入中...</div>
            <div class="correction-row">
              <input type="text" id="dCorrectRaw" placeholder="OCR 讀到的字">
              <span>→</span>
              <input type="text" id="dCorrectCode" placeholder="正確代號" style="width:60px">
              <button class="dbtn" onclick="window.__detector.submitCorrection()">送出</button>
            </div>
          </div>

          <div class="sec">
            <div style="margin-bottom:6px"><b>偵測紀錄</b></div>
            <div id="dLog" style="max-height:100px;overflow-y:auto;font-size:10px;line-height:1.4"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // v0.6: 注入偵錯模態框
    const inspectModal = document.createElement('div');
    inspectModal.id = 'dInspectModal';
    inspectModal.innerHTML = `
      <div class="inspect-box">
        <div class="inspect-header">
          <span>🔬 模板比對診斷</span>
          <button class="inspect-close" onclick="window.__detector.closeInspect()">✕</button>
        </div>
        <div class="inspect-body" id="dInspectBody"></div>
      </div>
    `;
    document.body.appendChild(inspectModal);

    // v0.7: 注入校準模態框
    const calibModal = document.createElement('div');
    calibModal.id = 'dCalibModal';
    calibModal.innerHTML = `
      <div class="calib-box">
        <div class="calib-header">
          <span>✨ 計時圈校準（v0.7 標準化擷取）</span>
          <button class="inspect-close" onclick="window.__detector.closeCalibration()">✕</button>
        </div>
        <div class="calib-body" id="dCalibBody"></div>
      </div>
    `;
    document.body.appendChild(calibModal);

    bindEvents();
    initLearning();
    loadPanelPos();
    loadMuteState();
    loadTrainModeState();
    loadCalibration();
    updateCalibStatus();
    updateTplDisplay();
  }

  function log(msg, color = '#888') {
    const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const el = document.getElementById('dLog');
    if (el) {
      el.innerHTML = `<div class="log-line" style="color:${color}">[${t}] ${msg}</div>` + el.innerHTML;
      const lines = el.querySelectorAll('.log-line');
      if (lines.length > 30) lines[lines.length - 1].remove();
    }
    const cs = document.getElementById('dCompactStatus');
    if (cs && !msg.startsWith('紅環') && !msg.startsWith('📚')) {
      cs.textContent = msg.length > 30 ? msg.slice(0, 30) + '...' : msg;
      cs.style.color = color;
    }
  }

  function updateDictInfo(override) {
    const el = document.getElementById('dDictInfo');
    if (!el) return;
    if (override) { el.innerHTML = override; return; }
    const total = Object.keys(state.mapDictionary).length;
    const builtin = Object.keys(BUILTIN_MAP_DICTIONARY).length;
    const custom = total - builtin;
    el.innerHTML = `📚 共 <b style="color:#0f0">${total}</b> 筆（內建 ${builtin} + 貢獻 ${custom}）`;
  }

  function updateTplDisplay() {
    const stats = TemplateDB.getStats();
    const phaseLabels = ['R1','R2','R3','R4','ON','WAITING'];

    // 階段顯示（完整模式）
    const pEl = document.getElementById('dTplPhase');
    if (pEl) {
      pEl.innerHTML = phaseLabels.map(label => {
        const count = stats.phase[label] || 0;
        const color = count === 0 ? '#666' : count < 3 ? '#fa0' : '#0f0';
        return `<div class="tpl-chip">
          <div class="tpl-label" style="color:${color}">${label}</div>
          <div class="tpl-count">${count} 張</div>
        </div>`;
      }).join('');
    }

    // 分流顯示（完整模式）
    const cEl = document.getElementById('dTplCh');
    if (cEl) {
      const chLabels = Object.keys(stats.ch).sort((a,b)=>+a-+b);
      if (chLabels.length === 0) {
        cEl.innerHTML = `<div class="small" style="color:#666">尚無模板 (CH 會從確認時學習)</div>`;
      } else {
        cEl.innerHTML = chLabels.map(label => {
          const count = stats.ch[label];
          return `<div class="tpl-chip">
            <div class="tpl-label">CH.${label}</div>
            <div class="tpl-count">${count} 張</div>
          </div>`;
        }).join('');
      }
    }

    // 精簡模式
    const miniP = document.getElementById('dMiniTplPhase');
    if (miniP) {
      miniP.innerHTML = phaseLabels.map(label => {
        const count = stats.phase[label] || 0;
        const color = count === 0 ? '#666' : count < 3 ? '#fa0' : '#0f0';
        return `<div class="tpl-chip-mini">
          <span class="tpl-label-mini" style="color:${color}">${label}</span>
          <span style="color:#888">${count}</span>
        </div>`;
      }).join('');
    }
    const miniC = document.getElementById('dMiniTplCh');
    if (miniC) {
      const chLabels = Object.keys(stats.ch).sort((a,b)=>+a-+b);
      if (chLabels.length === 0) {
        miniC.innerHTML = `<div class="small" style="color:#666;grid-column:1/-1;text-align:center">尚無模板</div>`;
      } else {
        miniC.innerHTML = chLabels.map(label => {
          const count = stats.ch[label];
          return `<div class="tpl-chip-mini">
            <span class="tpl-label-mini" style="color:#0f0">CH.${label}</span>
            <span style="color:#888">${count}</span>
          </div>`;
        }).join('');
      }
    }

    // 總計
    const totalEl = document.getElementById('dTplTotal');
    const miniTotalEl = document.getElementById('dMiniTplTotal');
    const phaseTotal = Object.values(stats.phase).reduce((s, n) => s + n, 0);
    const chTotal = Object.values(stats.ch).reduce((s, n) => s + n, 0);
    const kb = (stats.totalSize / 1024).toFixed(1);
    if (totalEl) totalEl.textContent = `(階段 ${phaseTotal} + 分流 ${chTotal}，約 ${kb} KB)`;
    if (miniTotalEl) miniTotalEl.textContent = `${phaseTotal}+${chTotal}`;

    // v0.6.4: 更新瀏覽器的標籤選單
    refreshBrowseLabels();
  }

  // v0.6.4: 瀏覽模板相關函式
  function refreshBrowseLabels() {
    const catSel = document.getElementById('dBrowseCategory');
    const labelSel = document.getElementById('dBrowseLabel');
    if (!catSel || !labelSel) return;
    const cat = catSel.value;
    const currentLabel = labelSel.value;
    const labels = Object.keys(TemplateDB.data[cat] || {}).sort((a, b) => {
      if (cat === 'ch') return (+a) - (+b);
      const order = ['R1','R2','R3','R4','ON','WAITING'];
      return order.indexOf(a) - order.indexOf(b);
    });
    labelSel.innerHTML = labels.length
      ? labels.map(l => `<option value="${l}">${cat === 'ch' ? 'CH.'+l : l}</option>`).join('')
      : '<option value="">(無)</option>';
    // 保留選擇
    if (labels.includes(currentLabel)) labelSel.value = currentLabel;
    renderBrowseGrid();
  }

  function renderBrowseGrid() {
    const catSel = document.getElementById('dBrowseCategory');
    const labelSel = document.getElementById('dBrowseLabel');
    const grid = document.getElementById('dBrowseGrid');
    const countEl = document.getElementById('dBrowseCount');
    if (!catSel || !labelSel || !grid) return;

    const cat = catSel.value;
    const label = labelSel.value;
    const templates = (TemplateDB.data[cat] || {})[label] || [];

    if (countEl) countEl.textContent = `共 ${templates.length} 張`;

    if (templates.length === 0) {
      grid.innerHTML = '<div class="tpl-browse-empty">尚無模板</div>';
      return;
    }

    grid.innerHTML = templates.map((dataURL, idx) => `
      <div class="tpl-browse-item">
        <img src="${dataURL}" alt="${label} #${idx+1}">
        <div class="tpl-idx">#${idx+1}</div>
        <button class="tpl-del-btn" onclick="window.__detector.deleteTpl('${cat}','${label}',${idx})">×</button>
      </div>
    `).join('');
  }

  function showTplPreview() {
    if (!state.lastBadgeCanvas) {
      document.getElementById('dTplPreview').style.display = 'none';
      return;
    }
    const preview = document.getElementById('dTplPreview');
    const canvas = document.getElementById('dTplCanvas');
    preview.style.display = 'flex';
    canvas.width = 64; canvas.height = 64;
    canvas.getContext('2d').imageSmoothingEnabled = false;
    canvas.getContext('2d').drawImage(state.lastBadgeCanvas, 0, 0, 64, 64);
  }

  // v0.6.4: 更新精簡模式的擷取預覽 3 張小圖
  function updateMiniPreview(mapRegion) {
    // 階段徽章預覽
    const badgeCan = document.getElementById('dMiniPrevBadge');
    if (badgeCan && state.lastBadgeCanvas) {
      badgeCan.width = state.lastBadgeCanvas.width;
      badgeCan.height = state.lastBadgeCanvas.height;
      const ctx = badgeCan.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.lastBadgeCanvas, 0, 0);
    }
    // 地圖預覽（直接從 video 擷取）
    const mapCan = document.getElementById('dMiniPrevMap');
    if (mapCan && state.regions.map) {
      const r = state.regions.map;
      mapCan.width = r.w;
      mapCan.height = r.h;
      const video = document.getElementById('dVideo');
      if (video && video.videoWidth) {
        mapCan.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      }
    }
    // 分流預覽
    const chCan = document.getElementById('dMiniPrevCh');
    if (chCan && state.lastChCanvas) {
      chCan.width = state.lastChCanvas.width;
      chCan.height = state.lastChCanvas.height;
      const ctx = chCan.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.lastChCanvas, 0, 0);
    }
  }

  function applyZoom() {
    const video = document.getElementById('dVideo');
    const zoomVal = document.getElementById('dZoomVal');
    if (!video || !video.videoWidth) return;
    video.style.width = (video.videoWidth * state.zoom) + 'px';
    video.style.height = (video.videoHeight * state.zoom) + 'px';
    if (zoomVal) zoomVal.textContent = state.zoom.toFixed(1) + 'x';
    for (const k of ['status', 'map', 'ch']) {
      if (state.regions[k]) drawRegionBox(k, state.regions[k]);
    }
  }

  function drawRegionBox(key, region) {
    const video = document.getElementById('dVideo');
    const boxId = 'dBox' + key.charAt(0).toUpperCase() + key.slice(1);
    const box = document.getElementById(boxId);
    if (!video.videoWidth) return;
    const cssScale = video.clientWidth / video.videoWidth;
    box.style.left = (region.x * cssScale) + 'px';
    box.style.top = (region.y * cssScale) + 'px';
    box.style.width = (region.w * cssScale) + 'px';
    box.style.height = (region.h * cssScale) + 'px';
    box.style.display = 'block';
  }

  function renderBadgeEditor() {
    const section = document.getElementById('dBadgeSection');
    if (!state.regions.status) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    const canvas = document.getElementById('dBadgeEditCanvas');
    const video = document.getElementById('dVideo');
    const region = state.regions.status;
    const editor = document.getElementById('dBadgeEditor');
    // editor 現在有 padding:8px，扣掉
    const maxContainerWidth = editor.clientWidth - 16 || 420;
    const maxContainerHeight = 280;
    const maxScaleByWidth = Math.floor(maxContainerWidth / region.w);
    const maxScaleByHeight = Math.floor(maxContainerHeight / region.h);
    const displayScale = Math.max(3, Math.min(maxScaleByWidth, maxScaleByHeight, 10));
    canvas.width = region.w * displayScale;
    canvas.height = region.h * displayScale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height);
    const badge = getBadgeRect(region);
    const editBox = document.getElementById('dBadgeEditBox');

    // ═══ 關鍵修正：等瀏覽器 layout 完再取 canvas 實際位置 ═══
    requestAnimationFrame(() => {
      const canvasOffsetX = canvas.offsetLeft;
      const canvasOffsetY = canvas.offsetTop;

      editBox.style.left = (canvasOffsetX + badge.x * displayScale) + 'px';
      editBox.style.top = (canvasOffsetY + badge.y * displayScale) + 'px';
      editBox.style.width = (badge.w * displayScale) + 'px';
      editBox.style.height = (badge.h * displayScale) + 'px';

      state._badgeDisplayScale = displayScale;
      state._badgeCanvasOffsetX = canvasOffsetX;
      state._badgeCanvasOffsetY = canvasOffsetY;
      state._badgeMaxX = canvas.width;
      state._badgeMaxY = canvas.height;
    });

    updateBadgeInfo();
    // v0.6.4: 同時更新擷取結果預覽
    updateBadgeCapturePreview();
  }

  // v0.6.4: 即時顯示「橘框範圍實際擷取出的圖片」
  function updateBadgeCapturePreview() {
    const region = state.regions.status;
    if (!region) return;
    const video = document.getElementById('dVideo');
    if (!video || !video.videoWidth) return;
    const captureCan = document.getElementById('dBadgeCaptureCanvas');
    const infoEl = document.getElementById('dBadgeCaptureInfo');
    if (!captureCan) return;

    // v0.7: 有校準資料 → 用校準比例擷取（標準化版）
    if (state.calibration && state.calibration.timing) {
      const cap = captureBadgeFromCalibration();
      captureCan.width = cap.width;
      captureCan.height = cap.height;
      captureCan.getContext('2d').drawImage(cap, 0, 0);
      if (infoEl) {
        const t = state.calibration.timing;
        infoEl.innerHTML = `<span style="color:#0f0">✨ 校準擷取</span> ${cap.width}×${cap.height}px｜模式：${t.mode === 'auto' ? '自動' : '手動'}`;
      }
      return;
    }

    // 舊版：手動拖曳橘框
    const badge = getBadgeRect(region);
    captureCan.width = badge.w;
    captureCan.height = badge.h;
    const cctx = captureCan.getContext('2d');
    cctx.imageSmoothingEnabled = false;
    cctx.drawImage(video,
      region.x + badge.x, region.y + badge.y, badge.w, badge.h,
      0, 0, badge.w, badge.h);
    if (infoEl) {
      infoEl.textContent = `${badge.w}×${badge.h}px @ video(${region.x + badge.x}, ${region.y + badge.y})`;
    }
  }

  function updateBadgeInfo() {
    const region = state.regions.status;
    if (!region) return;
    const badge = getBadgeRect(region);
    const el = document.getElementById('dBadgeInfo');
    if (el) el.textContent = `徽章：(${badge.x}, ${badge.y}) ${badge.w}×${badge.h} / 圖示 ${region.w}×${region.h}`;
  }

  function switchPanelMode(mode) {
    state.panelMode = mode;
    const panel = document.getElementById('detectorPanel');
    panel.className = mode + (panel.classList.contains('open') ? ' open' : '');
    const btn = document.getElementById('dToggleMode');
    if (btn) {
      btn.textContent = mode === 'compact' ? '⚙️' : '🗕';
      btn.title = mode === 'compact' ? '展開完整模式' : '收回精簡模式';
    }
    if (mode === 'full' && state.regions.status) {
      setTimeout(renderBadgeEditor, 100);
    }
  }

  function updateMuteUI() {
    const btn = document.getElementById('dMuteToggle');
    if (!btn) return;
    btn.textContent = state.muted ? '🔕' : '🔔';
    btn.title = state.muted ? '已靜音（點擊取消）' : '開啟中（點擊靜音）';
    btn.classList.toggle('muted', state.muted);
  }

  function loadMuteState() {
    const s = localStorage.getItem('tosm_detector_muted');
    state.muted = s === '1';
    updateMuteUI();
  }

  // v0.6.4: 訓練模式 UI 更新
  function updateTrainModeUI() {
    const btn = document.getElementById('dTrainToggle');
    const panel = document.getElementById('detectorPanel');
    if (!btn || !panel) return;
    btn.classList.toggle('training', state.trainingMode);
    panel.classList.toggle('training-mode', state.trainingMode);
    btn.title = state.trainingMode
      ? '訓練模式中（點擊切回一般模式）'
      : '點擊進入訓練模式（只存模板不送 Firebase）';
  }

  function loadTrainModeState() {
    const s = localStorage.getItem('tosm_detector_training_mode');
    state.trainingMode = s === '1';
    updateTrainModeUI();
  }

  // ═══════════════════════════════════════════════
  // v0.6.4 紅環偵測診斷
  // ═══════════════════════════════════════════════
  function runDiagnose() {
    if (!state.regions.status) {
      document.getElementById('dDiagResult').innerHTML =
        '<span style="color:#f33">❌ 請先框選狀態圖示區域</span>';
      return;
    }
    const video = document.getElementById('dVideo');
    if (!video || !video.videoWidth) {
      document.getElementById('dDiagResult').innerHTML =
        '<span style="color:#f33">❌ 請先開始擷取</span>';
      return;
    }

    const region = state.regions.status;

    // 讀取進階參數
    const redMin = parseInt(document.getElementById('dDiagRedMin')?.value) || 150;
    const redDom = parseInt(document.getElementById('dDiagRedDom')?.value) || 60;
    const offsetRatio = parseFloat(document.getElementById('dDiagOffsetRatio')?.value) || 0.95;
    const sizeRatio = parseFloat(document.getElementById('dDiagSizeRatio')?.value) || 0.65;

    // 偵測紅環
    const ring = detectRedRing(region, { redThreshold: redMin, redDominance: redDom });

    // 顯示原始圖
    const origCan = document.getElementById('dDiagOriginal');
    const annoCan = document.getElementById('dDiagAnnotated');
    const displayScale = 4;
    origCan.width = region.w * displayScale;
    origCan.height = region.h * displayScale;
    annoCan.width = region.w * displayScale;
    annoCan.height = region.h * displayScale;
    const oCtx = origCan.getContext('2d');
    const aCtx = annoCan.getContext('2d');
    oCtx.imageSmoothingEnabled = false;
    aCtx.imageSmoothingEnabled = false;
    oCtx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, origCan.width, origCan.height);
    aCtx.drawImage(video, region.x, region.y, region.w, region.h, 0, 0, annoCan.width, annoCan.height);

    // 在標註圖上：紅色像素塗綠
    if (ring && ring.found) {
      const annoData = aCtx.getImageData(0, 0, annoCan.width, annoCan.height);
      // v0.6.4: 雜訊紅色像素塗灰，inlier（真正在圓周上）塗綠
      const inlierSet = new Set(ring.inliers ? ring.inliers.map(p => `${p.x},${p.y}`) : []);
      for (const p of ring.redPixels) {
        const isInlier = inlierSet.has(`${p.x},${p.y}`);
        const colorR = isInlier ? 0   : 100;
        const colorG = isInlier ? 255 : 100;
        const colorB = isInlier ? 0   : 100;
        for (let dy = 0; dy < displayScale; dy++) {
          for (let dx = 0; dx < displayScale; dx++) {
            const px = p.x * displayScale + dx;
            const py = p.y * displayScale + dy;
            if (px >= 0 && px < annoCan.width && py >= 0 && py < annoCan.height) {
              const idx = (py * annoCan.width + px) * 4;
              annoData.data[idx] = colorR;
              annoData.data[idx+1] = colorG;
              annoData.data[idx+2] = colorB;
            }
          }
        }
      }
      aCtx.putImageData(annoData, 0, 0);

      // 畫圓心（紅點）
      aCtx.fillStyle = '#f00';
      aCtx.beginPath();
      aCtx.arc(ring.centerX * displayScale, ring.centerY * displayScale, 5, 0, Math.PI * 2);
      aCtx.fill();

      // 畫圓周（黃線）
      aCtx.strokeStyle = '#ff0';
      aCtx.lineWidth = 2;
      aCtx.beginPath();
      aCtx.arc(ring.centerX * displayScale, ring.centerY * displayScale, ring.radius * displayScale, 0, Math.PI * 2);
      aCtx.stroke();

      // 推導徽章區域
      const badge = deriveBadgeFromRing(ring, { offsetRatio, sizeRatio });
      if (badge) {
        // 畫徽章方框（藍色）
        aCtx.strokeStyle = '#0af';
        aCtx.lineWidth = 3;
        aCtx.strokeRect(
          badge.x * displayScale,
          badge.y * displayScale,
          badge.w * displayScale,
          badge.h * displayScale
        );
        // 畫徽章中心（藍點）
        aCtx.fillStyle = '#0af';
        aCtx.beginPath();
        aCtx.arc(badge.centerX * displayScale, badge.centerY * displayScale, 4, 0, Math.PI * 2);
        aCtx.fill();
      }

      // 文字結果
      const conf = (ring.confidence * 100).toFixed(0);
      const confColor = ring.confidence > 0.7 ? '#0f0' : ring.confidence > 0.4 ? '#fa0' : '#f33';
      const inlierRatio = ((ring.filteredCount / ring.redPixelCount) * 100).toFixed(0);
      document.getElementById('dDiagResult').innerHTML = `
        <div style="color:#0f0">✅ 找到紅環</div>
        <div>圓心：(${ring.centerX.toFixed(2)}, ${ring.centerY.toFixed(2)})</div>
        <div>半徑：${ring.radius.toFixed(2)} px</div>
        <div>紅色像素：${ring.redPixelCount}（其中 <b style="color:#0f0">${ring.filteredCount}</b> 在圓周上＝${inlierRatio}%）</div>
        <div>擬合平均誤差：${ring.meanErr.toFixed(2)} px</div>
        <div>圓擬合度：<span style="color:${confColor};font-weight:bold">${conf}%</span></div>
        ${badge ? `
          <div style="margin-top:6px;color:#0af">📐 推導徽章：</div>
          <div>位置：(${badge.x}, ${badge.y}) ${badge.w}×${badge.h}px</div>
        ` : ''}
        <div class="small" style="margin-top:6px;color:#666">🟢綠=紅環點 / ⚫灰=被排除的雜訊（王身上的紅、背景）</div>
      `;

      // 紀錄歷史
      state.diagHistory.push({
        time: Date.now(),
        cx: ring.centerX, cy: ring.centerY,
        r: ring.radius, conf: ring.confidence,
        badge
      });
      if (state.diagHistory.length > 30) state.diagHistory.shift();

      updateDiagStability();
    } else {
      document.getElementById('dDiagResult').innerHTML = `
        <div style="color:#f33">❌ 未找到紅環</div>
        <div>原因：${ring ? ring.reason : '未知'}</div>
        <div>紅色像素：${ring ? ring.redPixels : 0}</div>
        <div style="color:#888;margin-top:4px">建議：拉低「R 最低」門檻試試（進階參數）</div>
      `;
    }
  }

  function updateDiagStability() {
    const el = document.getElementById('dDiagStabilityResult');
    if (!el || state.diagHistory.length < 3) return;
    const cxArr = state.diagHistory.map(h => h.cx);
    const cyArr = state.diagHistory.map(h => h.cy);
    const rArr = state.diagHistory.map(h => h.r);
    const confArr = state.diagHistory.map(h => h.conf);

    const stat = (arr) => {
      const mean = arr.reduce((s, n) => s + n, 0) / arr.length;
      const variance = arr.reduce((s, n) => s + (n - mean) ** 2, 0) / arr.length;
      return { mean, std: Math.sqrt(variance), min: Math.min(...arr), max: Math.max(...arr) };
    };

    const cxs = stat(cxArr);
    const cys = stat(cyArr);
    const rs = stat(rArr);
    const confs = stat(confArr);

    // 評估穩定度
    const cxStable = cxs.std < 1 ? '🟢' : cxs.std < 3 ? '🟡' : '🔴';
    const cyStable = cys.std < 1 ? '🟢' : cys.std < 3 ? '🟡' : '🔴';
    const rStable = rs.std < 1 ? '🟢' : rs.std < 2 ? '🟡' : '🔴';

    el.innerHTML = `
      <div>樣本：${state.diagHistory.length} 次</div>
      <div>${cxStable} 圓心 X：平均 ${cxs.mean.toFixed(1)} ± ${cxs.std.toFixed(2)}（範圍 ${cxs.min.toFixed(1)}~${cxs.max.toFixed(1)}）</div>
      <div>${cyStable} 圓心 Y：平均 ${cys.mean.toFixed(1)} ± ${cys.std.toFixed(2)}（範圍 ${cys.min.toFixed(1)}~${cys.max.toFixed(1)}）</div>
      <div>${rStable} 半徑：  平均 ${rs.mean.toFixed(1)} ± ${rs.std.toFixed(2)}（範圍 ${rs.min.toFixed(1)}~${rs.max.toFixed(1)}）</div>
      <div>圓形度：平均 ${(confs.mean*100).toFixed(0)}%</div>
      <div style="margin-top:4px;color:${cxs.std < 2 && cys.std < 2 && rs.std < 2 ? '#0f0' : '#fa0'}">
        ${cxs.std < 2 && cys.std < 2 && rs.std < 2
          ? '✅ 穩定！可進行下一步（自動規範化）'
          : '⚠️ 不夠穩定，需調整參數或換思路'}
      </div>
    `;
  }


  function enableWindowDrag() {
    const panel = document.getElementById('detectorPanel');
    const header = document.getElementById('dPanelHeader');
    let dragging = false, startX, startY, panelX, panelY;
    header.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      panelX = rect.left; panelY = rect.top;
      panel.style.right = 'auto';
      panel.style.left = panelX + 'px';
      panel.style.top = panelY + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newX = panelX + (e.clientX - startX);
      const newY = panelY + (e.clientY - startY);
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - 40;
      panel.style.left = Math.max(0, Math.min(maxX, newX)) + 'px';
      panel.style.top = Math.max(0, Math.min(maxY, newY)) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        state.panelPos = {
          x: parseInt(panel.style.left),
          y: parseInt(panel.style.top)
        };
        localStorage.setItem('tosm_detector_panel_pos', JSON.stringify(state.panelPos));
      }
    });
  }

  function loadPanelPos() {
    const s = localStorage.getItem('tosm_detector_panel_pos');
    if (!s) return;
    try {
      const pos = JSON.parse(s);
      const panel = document.getElementById('detectorPanel');
      panel.style.right = 'auto';
      panel.style.left = pos.x + 'px';
      panel.style.top = pos.y + 'px';
      state.panelPos = pos;
    } catch(e) {}
  }

  function enableBadgeDrag() {
    const editor = document.getElementById('dBadgeEditor');
    const box = document.getElementById('dBadgeEditBox');
    if (!editor || !box) return;
    let dragMode = null;
    let startMouseX, startMouseY, startBoxX, startBoxY, startBoxW, startBoxH;
    box.addEventListener('mousedown', e => {
      if (!state.regions.status) return;
      const handleClass = e.target.classList[1];
      dragMode = (e.target.classList.contains('handle')) ? handleClass : 'move';
      startMouseX = e.clientX; startMouseY = e.clientY;
      startBoxX = parseInt(box.style.left) || 0;
      startBoxY = parseInt(box.style.top) || 0;
      startBoxW = parseInt(box.style.width) || 0;
      startBoxH = parseInt(box.style.height) || 0;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', e => {
      if (!dragMode || !state.regions.status) return;
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      const scale = state._badgeDisplayScale || 4;
      const offsetX = state._badgeCanvasOffsetX || 0;
      const offsetY = state._badgeCanvasOffsetY || 0;
      const canvasW = state._badgeMaxX || 0;
      const canvasH = state._badgeMaxY || 0;
      const minX = offsetX, minY = offsetY;
      const maxX = offsetX + canvasW, maxY = offsetY + canvasH;
      let nx = startBoxX, ny = startBoxY, nw = startBoxW, nh = startBoxH;
      if (dragMode === 'move') {
        nx = Math.max(minX, Math.min(maxX - startBoxW, startBoxX + dx));
        ny = Math.max(minY, Math.min(maxY - startBoxH, startBoxY + dy));
      } else if (dragMode === 'tl') {
        nx = Math.max(minX, Math.min(startBoxX + startBoxW - 20, startBoxX + dx));
        ny = Math.max(minY, Math.min(startBoxY + startBoxH - 20, startBoxY + dy));
        nw = startBoxW - (nx - startBoxX);
        nh = startBoxH - (ny - startBoxY);
      } else if (dragMode === 'tr') {
        ny = Math.max(minY, Math.min(startBoxY + startBoxH - 20, startBoxY + dy));
        nw = Math.max(20, Math.min(maxX - startBoxX, startBoxW + dx));
        nh = startBoxH - (ny - startBoxY);
      } else if (dragMode === 'bl') {
        nx = Math.max(minX, Math.min(startBoxX + startBoxW - 20, startBoxX + dx));
        nw = startBoxW - (nx - startBoxX);
        nh = Math.max(20, Math.min(maxY - startBoxY, startBoxH + dy));
      } else if (dragMode === 'br') {
        nw = Math.max(20, Math.min(maxX - startBoxX, startBoxW + dx));
        nh = Math.max(20, Math.min(maxY - startBoxY, startBoxH + dy));
      }
      box.style.left = nx + 'px';
      box.style.top = ny + 'px';
      box.style.width = nw + 'px';
      box.style.height = nh + 'px';
      state.badgeRect = {
        x: Math.round((nx - offsetX) / scale),
        y: Math.round((ny - offsetY) / scale),
        w: Math.round(nw / scale),
        h: Math.round(nh / scale)
      };
      updateBadgeInfo();
      updateBadgeCapturePreview();  // v0.6.4: 拖曳時即時更新預覽
    });
    window.addEventListener('mouseup', () => {
      if (dragMode) {
        dragMode = null;
        if (state.badgeRect) {
          localStorage.setItem('tosm_detector_badge_rect_v46', JSON.stringify(state.badgeRect));
          log(`🎯 徽章範圍已更新`, '#f80');
        }
      }
    });
  }

  function bindEvents() {
    const video = document.getElementById('dVideo');
    const preview = document.getElementById('dPreview');
    const drawBox = document.getElementById('dDrawBox');
    const scroll = document.getElementById('dPreviewScroll');

    enableWindowDrag();
    enableBadgeDrag();

    document.getElementById('dToggleMode').onclick = () => {
      switchPanelMode(state.panelMode === 'compact' ? 'full' : 'compact');
    };

    // 靜音切換
    document.getElementById('dMuteToggle').onclick = () => {
      state.muted = !state.muted;
      localStorage.setItem('tosm_detector_muted', state.muted ? '1' : '0');
      updateMuteUI();
      log(state.muted ? '🔕 已靜音' : '🔔 音效開啟', '#0f0');
    };

    // v0.6.4: 訓練模式切換
    document.getElementById('dTrainToggle').onclick = () => {
      state.trainingMode = !state.trainingMode;
      localStorage.setItem('tosm_detector_training_mode', state.trainingMode ? '1' : '0');
      updateTrainModeUI();
      log(state.trainingMode
        ? '🎯 已進入訓練模式（只存模板，不送 Firebase）'
        : '🔴 已切回一般模式（確認後會送 Firebase）',
        state.trainingMode ? '#fa0' : '#0f0');
    };

    // v0.6.4: 瀏覽模板類別/標籤變更
    const browseCat = document.getElementById('dBrowseCategory');
    const browseLabel = document.getElementById('dBrowseLabel');
    if (browseCat) browseCat.onchange = refreshBrowseLabels;
    if (browseLabel) browseLabel.onchange = renderBrowseGrid;

    // v0.5.1: 精簡模板庫收合
    const miniTplHeader = document.getElementById('dMiniTplHeader');
    if (miniTplHeader) {
      // 載入收合狀態
      const collapsed = localStorage.getItem('tosm_detector_mini_tpl_collapsed') === '1';
      if (collapsed) {
        miniTplHeader.classList.add('collapsed');
        document.getElementById('dMiniTplBody').classList.add('collapsed');
      }
      miniTplHeader.onclick = () => {
        const isCol = miniTplHeader.classList.toggle('collapsed');
        document.getElementById('dMiniTplBody').classList.toggle('collapsed', isCol);
        localStorage.setItem('tosm_detector_mini_tpl_collapsed', isCol ? '1' : '0');
      };
    }

    // v0.6.4: 精簡擷取預覽收合
    const miniPrevHeader = document.getElementById('dMiniPreviewHeader');
    if (miniPrevHeader) {
      const collapsed = localStorage.getItem('tosm_detector_mini_prev_collapsed') === '1';
      if (collapsed) {
        miniPrevHeader.classList.add('collapsed');
        document.getElementById('dMiniPreviewBody').classList.add('collapsed');
      }
      miniPrevHeader.onclick = () => {
        const isCol = miniPrevHeader.classList.toggle('collapsed');
        document.getElementById('dMiniPreviewBody').classList.toggle('collapsed', isCol);
        localStorage.setItem('tosm_detector_mini_prev_collapsed', isCol ? '1' : '0');
      };
    }

    document.getElementById('dStart').onclick = startCapture;
    document.getElementById('dStop').onclick = stopCapture;
    document.getElementById('dTest').onclick = () => detectOnce(false);
    document.getElementById('dAuto').onclick = startAuto;
    document.getElementById('dStopAuto').onclick = stopAuto;
    document.getElementById('dForceSubmit').onclick = forceSubmit;
    document.getElementById('dMiniStart').onclick = startCapture;
    document.getElementById('dMiniStop').onclick = stopCapture;
    document.getElementById('dMiniAuto').onclick = startAuto;
    document.getElementById('dMiniStopAuto').onclick = stopAuto;
    // v0.6: 偵錯比對按鈕
    document.getElementById('dMiniInspect').onclick = () => window.__detector.openInspect();
    // v0.7: 校準按鈕
    document.getElementById('dMiniCalibrate').onclick = () => window.__detector.openCalibration();
    // 點偵錯模態背景關閉
    document.getElementById('dInspectModal').addEventListener('click', e => {
      if (e.target.id === 'dInspectModal') window.__detector.closeInspect();
    });

    // 模板匯入
    document.getElementById('dTplImport').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const ok = await TemplateDB.import(file);
      if (ok) {
        log('📥 模板匯入成功', '#0f0');
        updateTplDisplay();
      }
      e.target.value = '';
    };

    document.getElementById('dDebugMode').onchange = (e) => {
      state.debugMode = e.target.checked;
      document.getElementById('dDebugBox').style.display = state.debugMode ? 'block' : 'none';
    };

    const zoomSlider = document.getElementById('dZoom');
    zoomSlider.oninput = () => {
      state.zoom = parseFloat(zoomSlider.value);
      applyZoom();
    };
    scroll.addEventListener('wheel', e => {
      if (!state.stream) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      state.zoom = Math.max(0.5, Math.min(4, state.zoom + delta));
      zoomSlider.value = state.zoom;
      applyZoom();
    }, { passive: false });

    document.querySelectorAll('#detectorPanel .mode-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#detectorPanel .mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentMode = btn.dataset.mode;
      };
    });

    let dragging = false, sx = 0, sy = 0;
    preview.addEventListener('mousedown', e => {
      if (!state.stream || state.currentMode === 'none') return;
      dragging = true;
      const rect = preview.getBoundingClientRect();
      sx = e.clientX - rect.left;
      sy = e.clientY - rect.top;
      drawBox.style.cssText = `left:${sx}px;top:${sy}px;width:0;height:0;display:block;position:absolute;border:2px dashed #fff;background:rgba(255,255,255,0.2);pointer-events:none`;
      e.preventDefault();
    });
    preview.addEventListener('mousemove', e => {
      if (!dragging) return;
      const rect = preview.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      drawBox.style.left = Math.min(x, sx) + 'px';
      drawBox.style.top = Math.min(y, sy) + 'px';
      drawBox.style.width = Math.abs(x - sx) + 'px';
      drawBox.style.height = Math.abs(y - sy) + 'px';
    });
    preview.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      drawBox.style.display = 'none';
      const cssScale = video.videoWidth / video.clientWidth;
      const region = {
        x: Math.round(parseInt(drawBox.style.left) * cssScale),
        y: Math.round(parseInt(drawBox.style.top) * cssScale),
        w: Math.round(parseInt(drawBox.style.width) * cssScale),
        h: Math.round(parseInt(drawBox.style.height) * cssScale)
      };
      if (region.w < 5 || region.h < 5) return;

      // v0.7: 如果在校準模式，把這次框選用於校準
      if (state._calibrating) {
        state._calibTempRegion = region;
        state._calibrating = false;
        hideCalibInstructions();
        // 把計時圈框也存為 status region（讓擷取系統能用）
        state.regions.status = region;
        state.badgeRect = null;
        drawRegionBox('status', region);
        localStorage.setItem('tosm_detector_regions_v5', JSON.stringify(state.regions));
        log(`📐 已選定校準範圍 (${region.w}×${region.h})，開始紅環偵測...`, '#08f');
        // 重新打開校準模態，自動進入紅環偵測
        document.getElementById('dCalibModal').classList.add('show');
        window.__detector.applyAutoCalibration();
        return;
      }

      state.regions[state.currentMode] = region;
      if (state.currentMode === 'status') {
        state.badgeRect = null;
        localStorage.removeItem('tosm_detector_badge_rect_v46');
      }
      drawRegionBox(state.currentMode, region);
      localStorage.setItem('tosm_detector_regions_v5', JSON.stringify(state.regions));
      log(`✅ ${state.currentMode} 區域 (${region.w}×${region.h})`, '#0f0');
      if (state.currentMode === 'status') setTimeout(renderBadgeEditor, 50);
    });
  }

  function loadRegions() {
    const s = localStorage.getItem('tosm_detector_regions_v5')
          || localStorage.getItem('tosm_detector_regions_v46')
          || localStorage.getItem('tosm_detector_regions_v45');
    if (s) {
      try { Object.assign(state.regions, JSON.parse(s)); } catch(e) {}
      for (const k of ['status', 'map', 'ch']) {
        if (state.regions[k]) drawRegionBox(k, state.regions[k]);
      }
      log('已載入區域設定', '#3f3');
    }
    const b = localStorage.getItem('tosm_detector_badge_rect_v46');
    if (b) {
      try { state.badgeRect = JSON.parse(b); } catch(e) {}
    }
    if (state.regions.status) setTimeout(renderBadgeEditor, 100);
  }

  async function startCapture() {
    try {
      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 }, audio: false
      });
      const video = document.getElementById('dVideo');
      video.srcObject = state.stream;
      await video.play();
      state.stream.getVideoTracks()[0].onended = stopCapture;
      updateCaptureUIState(true);
      video.addEventListener('loadedmetadata', () => {
        state.zoom = 1.0;
        applyZoom();
        setTimeout(loadRegions, 100);
      }, { once: true });
      log('🎬 擷取已啟動', '#0f0');
    } catch (e) {
      log('❌ 啟動失敗: ' + e.message, '#f33');
    }
  }
  function stopCapture() {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    stopAuto();
    updateCaptureUIState(false);
  }
  function updateCaptureUIState(isCapturing) {
    const statusText = isCapturing ? '✅ 擷取中' : '未啟動';
    document.getElementById('dStatus').textContent = statusText;
    document.getElementById('dCompactStatus').textContent = statusText;
    document.getElementById('dStart').disabled = isCapturing;
    document.getElementById('dStop').disabled = !isCapturing;
    document.getElementById('dTest').disabled = !isCapturing;
    document.getElementById('dAuto').disabled = !isCapturing;
    document.getElementById('dForceSubmit').disabled = !isCapturing;
    document.getElementById('dMiniStart').disabled = isCapturing;
    document.getElementById('dMiniStop').disabled = !isCapturing;
    document.getElementById('dMiniAuto').disabled = !isCapturing;
  }

  function updateConfBar(id, conf) {
    const bar = document.getElementById(id);
    if (!bar) return;
    bar.style.width = (conf * 100) + '%';
    bar.style.background = conf > 0.8 ? '#0f0' : conf > 0.5 ? '#fa0' : '#f33';
  }
  function phaseBadge(phase) { return phase === 'WAITING' ? '等待' : (phase || '?'); }
  function phaseColor(phase) {
    const m = { 'ON': '#f33', 'R1': '#fa3', 'R2': '#f83', 'R3': '#f63', 'R4': '#f33', 'WAITING': '#777' };
    return m[phase] || '#999';
  }

  async function detectOnce(silent = false) {
    let phase = null, phaseConf = 0, phaseMetrics = {}, phaseSource = '';
    let mapResult = null, mapConf = 0, mapRaw = '', mapMatchedName = '';
    let chResult = null, chConf = 0, chRaw = '', chSource = '';

    if (state.regions.status) {
      try {
        const r = await detectPhase(state.regions.status);
        phase = r.phase; phaseConf = r.confidence;
        phaseMetrics = r.metrics; phaseSource = r.source;
        const el = document.getElementById('dValStatus');
        if (el) el.innerHTML = `<span style="color:${phaseColor(phase)}">${phaseBadge(phase)}</span>`;
        const mini = document.getElementById('dMiniStatus');
        if (mini) { mini.textContent = phaseBadge(phase); mini.style.color = phaseColor(phase); }
        updateConfBar('dConfStatus', phaseConf);
        updateConfBar('dMiniConfStatus', phaseConf);
        const mEl = document.getElementById('dMetrics');
        if (mEl) {
          const srcIcon = { 'template': '🧠', 'template+ocr': '🧠+', 'ocr': '🔤', 'template-low': '🧠?', 'fallback': '❓' };
          mEl.innerHTML = `來源:${srcIcon[phaseSource]||'?'}<br>信心:${(phaseConf*100).toFixed(0)}%<br>紅環:${(phaseMetrics.redRatio*100).toFixed(0)}%`;
        }
      } catch (e) { if (!silent) log('狀態失敗：' + e.message, '#f33'); }
    }

    if (state.regions.map) {
      try {
        const ocr = await ocrMultiPass(state.regions.map, document.getElementById('dCanMap'), 'chi_tra');
        mapRaw = ocr.text;
        const match = matchMapName(mapRaw);
        mapResult = match.matched; mapConf = match.confidence * ocr.confidence;
        mapMatchedName = match.matchedName || '';
        const el = document.getElementById('dValMap');
        if (el) el.innerHTML = mapResult
          ? `<span style="color:#0f0">${mapResult}</span>${mapMatchedName ? `<br><span class="small">${mapMatchedName}</span>` : ''}<br><span class="small">${mapRaw||'?'}</span>`
          : `<span style="color:#f33">?</span><br><span class="small">${mapRaw||'無'}</span>`;
        const mini = document.getElementById('dMiniMap');
        if (mini) { mini.textContent = mapResult || '?'; mini.style.color = mapResult ? '#0f0' : '#f33'; }
        updateConfBar('dConfMap', mapConf);
        updateConfBar('dMiniConfMap', mapConf);
      } catch (e) { if (!silent) log('地圖失敗', '#f33'); }
    }

    if (state.regions.ch) {
      try {
        const r = await detectCh(state.regions.ch);
        chResult = r.ch; chConf = r.confidence; chSource = r.source; chRaw = r.raw || '';
        const el = document.getElementById('dValCh');
        if (el) { el.textContent = chResult || '?'; el.style.color = chResult ? '#0f0' : '#f33'; }
        const mini = document.getElementById('dMiniCh');
        if (mini) { mini.textContent = chResult || '?'; mini.style.color = chResult ? '#0f0' : '#f33'; }
        updateConfBar('dConfCh', chConf);
        updateConfBar('dMiniConfCh', chConf);
      } catch (e) {}
    }

    state.lastResult = { phase, phaseConf, phaseMetrics, phaseSource, mapResult, mapConf, mapRaw, mapMatchedName, chResult, chConf, chRaw, chSource };

    // 更新模板預覽
    showTplPreview();
    // v0.6.4: 更新精簡模式的擷取預覽
    updateMiniPreview();

    return state.lastResult;
  }

  async function forceSubmit() {
    const result = await detectOnce(false);
    if (!result.phase || result.phase === 'UNKNOWN') { log('❌ 無法辨識', '#f33'); return; }
    if (!result.mapResult || !result.chResult) { log('❌ 地圖/分流無法辨識', '#f33'); return; }
    let val = null;
    if (result.phase === 'ON') val = 'ON';
    else if (result.phase === 'WAITING') val = 'DE1';
    else if (['R1','R2','R3','R4'].includes(result.phase)) val = result.phase;
    if (!val) return;
    doSubmit(result.mapResult, result.chResult, val);
  }

  async function monitorTick() {
    const result = await detectOnce(true);
    if (!result.phase) return;
    if (result.phase === 'UNKNOWN') { state.stableCount = 0; return; }
    if (result.phase === state.lastPhase) {
      state.stableCount++;
    } else {
      if (state.stableCount >= 2 && state.lastPhase !== null) {
        handlePhaseChange(state.lastPhase, result.phase, result);
      }
      state.lastPhase = result.phase;
      state.stableCount = 0;
    }
  }

  function handlePhaseChange(from, to, result) {
    let val = null, label = '';
    if (to === 'ON') { val = 'ON'; label = '⚔️ 王已重生'; }
    else if (to === 'WAITING') { val = 'DE1'; label = '💀 王已擊殺'; }
    else if (['R1','R2','R3','R4'].includes(to)) { val = to; label = `🔸 進入 ${to}`; }
    else return;

    // v0.6.4: 地圖或分流辨識不出來 → 完全不通知（避免垃圾警示）
    if (!result.mapResult || !result.chResult) {
      if (state.debugMode) {
        log(`⏭️ 略過：${label}（地圖/分流無法辨識）`, '#666');
      }
      return;
    }

    const cooldownSec = parseInt(document.getElementById('dCooldown').value) || 0;
    if (cooldownSec > 0
        && result.mapResult === state.lastSubmitted.map
        && result.chResult === state.lastSubmitted.ch
        && val === state.lastSubmitted.val) {
      const elapsed = (Date.now() - state.lastSubmitted.time) / 1000;
      if (elapsed < cooldownSec) return;
    }

    const minConf = parseFloat(document.getElementById('dMinConf').value) || 0.5;
    const autoSubmit = document.getElementById('dAutoSubmit').checked;
    const overallConf = Math.min(result.phaseConf, result.mapConf || 0, result.chConf || 0);

    log(`${label} | ${result.mapResult} ${result.chResult} (${(overallConf*100)|0}%)`, '#f90');

    // v0.6.4: 訓練模式下「自動送出」= 自動存模板
    if (autoSubmit && overallConf >= minConf) {
      doSubmit(result.mapResult, result.chResult, val);
      return;
    }
    showConfirmPrompt(result, val, label, overallConf, minConf);
  }

  // v0.6.4: 顯示用的中文化轉換（只改顯示，輸入給 saveBoss 仍是原格式）
  function valToDisplay(val) {
    if (val === 'ON') return 'ON';
    if (val === 'DE1') return '擊殺';
    if (/^R\d+(\.\d+)?$/.test(val)) return '階段' + val.substring(1);
    return val;
  }

  function showConfirmPrompt(result, val, label, conf, minConf) {
    const isLow = conf < minConf;
    const cls = val === 'ON' ? 'on' : val === 'DE1' ? 'waiting' : '';
    const area = document.getElementById('dConfirmArea');
    const trainHint = state.trainingMode
      ? '<div style="background:#fa0;color:#000;padding:4px;border-radius:3px;margin-bottom:4px;font-size:10px">🎯 訓練模式：僅存模板，不送 Firebase</div>'
      : '';
    const btnLabel = state.trainingMode ? '💾 存模板' : '✓確認';
    // v0.6.4: 中文化顯示
    const displayVal = valToDisplay(val);
    const displayCh = `分流${result.chResult}`;
    area.innerHTML = `
      <div class="confirm-banner ${cls} ${isLow ? 'low-conf' : ''}">
        ${trainHint}
        ${label}<br>
        <b>${result.mapResult} ${displayCh} ${displayVal}</b> (${(conf*100)|0}%)<br>
        <button class="dbtn" onclick="window.__detector.confirm('${result.mapResult}','${result.chResult}','${val}')">${btnLabel}</button>
        <button class="dbtn gray" onclick="window.__detector.showEdit('${result.mapResult}','${result.chResult}','${val}','${result.mapRaw}')">✏️</button>
        <button class="dbtn red" onclick="window.__detector.cancel()">✗</button>
      </div>
    `;
    beep(val === 'ON' ? 880 : val === 'DE1' ? 440 : 660);
  }
  function showCorrectionPrompt(result, val, label) {
    const area = document.getElementById('dConfirmArea');
    area.innerHTML = `
      <div class="confirm-banner low-conf">
        ${label} ⚠️ 無法辨識<br>
        <div class="correction-row">
          <input type="text" id="dFixMap" placeholder="地圖" value="${result.mapResult||''}" style="width:60px">
          <input type="text" id="dFixCh" placeholder="CH" value="${result.chResult||''}" style="width:40px">
          <button class="dbtn" onclick="window.__detector.confirmManual('${val}','${result.mapRaw}')">送</button>
          <button class="dbtn red" onclick="window.__detector.cancel()">取消</button>
        </div>
      </div>
    `;
  }

  function doSubmit(map, ch, val) {
    try {
      // v0.6.4: 訓練模式 → 只存模板，不送 Firebase
      if (state.trainingMode) {
        let phaseLabel = null;
        if (val === 'ON') phaseLabel = 'ON';
        else if (val === 'DE1') phaseLabel = 'WAITING';
        else if (['R1','R2','R3','R4'].includes(val)) phaseLabel = val;

        let added = 0;
        if (phaseLabel && state.lastBadgeCanvas) {
          if (TemplateDB.add('phase', phaseLabel, state.lastBadgeCanvas)) added++;
        }
        if (ch && state.lastChCanvas) {
          if (TemplateDB.add('ch', ch, state.lastChCanvas)) added++;
        }

        if (added > 0) {
          log(`🎯 [訓練] 已加入 ${added} 個模板：${phaseLabel || '?'} / CH.${ch || '?'}`, '#fa0');
        } else {
          log(`🎯 [訓練] 模板已存在，略過`, '#888');
        }
        state.lastSubmitted = { map, ch, val, time: Date.now() };
        document.getElementById('dConfirmArea').innerHTML = '';
        updateTplDisplay();
        return;
      }

      // 一般模式：正常送 Firebase
      if (typeof saveBoss !== 'function') { log('❌ saveBoss 不存在', '#f33'); return; }
      saveBoss(map, ch, val);
      state.lastSubmitted = { map, ch, val, time: Date.now() };
      log(`📤 已送出：${map} ${ch} ${val}`, '#0f0');
      document.getElementById('dConfirmArea').innerHTML = '';

      // 自動學習
      const autoLearn = document.getElementById('dAutoLearn')?.checked;
      if (autoLearn && state.lastBadgeCanvas) {
        let phaseLabel = null;
        if (val === 'ON') phaseLabel = 'ON';
        else if (val === 'DE1') phaseLabel = 'WAITING';
        else if (['R1','R2','R3','R4'].includes(val)) phaseLabel = val;
        if (phaseLabel) {
          const added = TemplateDB.add('phase', phaseLabel, state.lastBadgeCanvas);
          if (added) log(`🧠 已自動學習階段模板 ${phaseLabel}`, '#fa0');
        }
      }
      if (autoLearn && state.lastChCanvas && ch) {
        const added = TemplateDB.add('ch', ch, state.lastChCanvas);
        if (added) log(`🧠 已自動學習 CH.${ch} 模板`, '#fa0');
      }
      updateTplDisplay();
    } catch (e) { log('❌ 失敗：' + e.message, '#f33'); }
  }

  function startAuto() {
    const ms = +document.getElementById('dInterval').value || 1500;
    state.lastPhase = null; state.stableCount = 0;
    clearInterval(state.autoTimer);
    state.autoTimer = setInterval(monitorTick, ms);
    document.getElementById('dAuto').disabled = true;
    document.getElementById('dStopAuto').disabled = false;
    document.getElementById('dMiniAuto').disabled = true;
    document.getElementById('dMiniStopAuto').disabled = false;
    const ms_el = document.getElementById('dMonitorStatus');
    if (ms_el) { ms_el.textContent = '監控中'; ms_el.className = 'monitor-status active'; }
    const prevStatus = document.getElementById('dMiniPreviewStatus');
    if (prevStatus) { prevStatus.textContent = '監控中'; prevStatus.style.color = '#0f0'; }
    log(`▶️ 監控啟動`, '#0f0');
  }
  function stopAuto() {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
    document.getElementById('dAuto').disabled = false;
    document.getElementById('dStopAuto').disabled = true;
    document.getElementById('dMiniAuto').disabled = !state.stream;
    document.getElementById('dMiniStopAuto').disabled = true;
    const ms_el = document.getElementById('dMonitorStatus');
    if (ms_el) { ms_el.textContent = '閒置'; ms_el.className = 'monitor-status'; }
    const prevStatus = document.getElementById('dMiniPreviewStatus');
    if (prevStatus) { prevStatus.textContent = '閒置'; prevStatus.style.color = '#888'; }
  }

  function togglePanel() {
    document.getElementById('detectorPanel').classList.toggle('open');
  }

  window.__detector = {
    close: () => document.getElementById('detectorPanel').classList.remove('open'),
    confirm: (map, ch, val) => doSubmit(map, ch, val),
    cancel: () => { document.getElementById('dConfirmArea').innerHTML = ''; },
    resetZoom: () => {
      state.zoom = 1.0;
      document.getElementById('dZoom').value = 1.0;
      applyZoom();
    },
    resetBadge: () => {
      state.badgeRect = null;
      localStorage.removeItem('tosm_detector_badge_rect_v46');
      if (state.regions.status) renderBadgeEditor();
      log('🎯 徽章範圍已重設', '#f80');
    },
    addTpl: () => {
      if (!state.lastBadgeCanvas) { log('❌ 沒有當前圖片', '#f33'); return; }
      const category = document.getElementById('dTplCategory').value;
      const label = document.getElementById('dTplLabel').value;
      const canvas = category === 'phase' ? state.lastBadgeCanvas : state.lastChCanvas;
      if (!canvas) { log('❌ 沒有對應的圖片', '#f33'); return; }
      const added = TemplateDB.add(category, label, canvas);
      if (added) {
        log(`📌 已儲存模板：${category}=${label}`, '#0f0');
        updateTplDisplay();
      } else {
        log('⚠️ 此模板已存在，略過', '#fa0');
      }
    },
    exportTpl: () => {
      TemplateDB.export();
      log('📤 已匯出模板檔', '#0f0');
    },
    clearTpl: () => {
      if (!confirm('確定要清空所有模板？此動作無法復原')) return;
      TemplateDB.data = { phase: {}, ch: {} };
      TemplateDB.save();
      log('🗑 已清空所有模板', '#f33');
      updateTplDisplay();
    },
    // v0.6.4: 刪除單張模板
    deleteTpl: (category, label, index) => {
      if (!confirm(`確定要刪除 ${category === 'ch' ? 'CH.'+label : label} 的第 ${index+1} 張模板？`)) return;
      const ok = TemplateDB.deleteAt(category, label, index);
      if (ok) {
        log(`🗑 已刪除 ${category === 'ch' ? 'CH.'+label : label} #${index+1}`, '#f80');
        updateTplDisplay();
      }
    },
    // v0.6.4: 精簡模式的快速標記
    quickSavePhase: () => {
      if (!state.lastBadgeCanvas) { log('❌ 尚無徽章圖片（需先擷取）', '#f33'); return; }
      const label = document.getElementById('dQuickPhaseLabel').value;
      const added = TemplateDB.add('phase', label, state.lastBadgeCanvas);
      if (added) {
        log(`📌 已儲存階段模板：${label}`, '#0f0');
        updateTplDisplay();
      } else {
        log('⚠️ 此模板已存在', '#fa0');
      }
    },
    quickSaveCh: () => {
      if (!state.lastChCanvas) { log('❌ 尚無分流圖片（需先擷取）', '#f33'); return; }
      const label = document.getElementById('dQuickChLabel').value.trim();
      if (!label || !/^\d+$/.test(label)) { log('❌ 請輸入 CH 數字', '#f33'); return; }
      const added = TemplateDB.add('ch', label, state.lastChCanvas);
      if (added) {
        log(`📌 已儲存分流模板：CH.${label}`, '#0f0');
        updateTplDisplay();
      } else {
        log('⚠️ 此模板已存在', '#fa0');
      }
    },

    // v0.6: 偵錯比對
    openInspect: async () => {
      if (!state.lastBadgeCanvas && !state.lastChCanvas) {
        log('❌ 尚未擷取任何畫面', '#f33');
        return;
      }
      const modal = document.getElementById('dInspectModal');
      const body = document.getElementById('dInspectBody');

      let html = '';

      // 階段比對
      if (state.lastBadgeCanvas && Object.keys(TemplateDB.data.phase).length > 0) {
        const m = await TemplateDB.match('phase', state.lastBadgeCanvas);
        const queryDataURL = TemplateDB.normalize(state.lastBadgeCanvas).toDataURL('image/png');
        html += `
          <div style="margin-bottom:8px;color:#08f;font-weight:bold">📌 階段比對</div>
          <div class="inspect-query">
            <canvas width="64" height="64" id="dInspectQueryPhase"></canvas>
            <div>
              <div>當前畫面（已正規化為 32×32 灰階）</div>
              <div style="margin-top:4px;font-size:11px;color:#888">
                系統判定：<span style="color:#0f0;font-weight:bold">${m.label}</span>
                （信心度 ${(m.similarity*100).toFixed(1)}%）
              </div>
            </div>
          </div>
          <table class="inspect-table">
            <thead>
              <tr>
                <th>圖</th><th>標籤</th><th>歐氏</th><th>餘弦</th><th>pHash</th>
                <th>總分</th><th></th>
              </tr>
            </thead>
            <tbody>`;
        for (const item of m.allMatches) {
          const tplDataURL = TemplateDB.data.phase[item.label][item.idx];
          const isWinner = item === m.allMatches[0];
          const isSuspect = !isWinner && (m.allMatches[0].label !== item.label) && item.combined > 0.7;
          html += `
            <tr class="${isWinner ? 'winner' : (isSuspect ? 'suspect' : '')}">
              <td><img class="tpl-thumb" src="${tplDataURL}"></td>
              <td><b>${item.label}</b><br><span style="color:#666">#${item.idx+1}</span></td>
              <td>${(item.eucSim*100).toFixed(0)}%</td>
              <td>${(item.cosSim*100).toFixed(0)}%</td>
              <td>${(item.hashSim*100).toFixed(0)}%</td>
              <td><b>${(item.combined*100).toFixed(0)}%</b>
                <span class="inspect-bar"><span class="inspect-bar-fill" style="width:${item.combined*100}%"></span></span>
              </td>
              <td><button class="del-tpl" onclick="window.__detector.deleteTplFromInspect('phase','${item.label}',${item.idx})">🗑</button></td>
            </tr>`;
        }
        html += `</tbody></table>`;
      }

      // 分流比對
      if (state.lastChCanvas && Object.keys(TemplateDB.data.ch).length > 0) {
        const m = await TemplateDB.match('ch', state.lastChCanvas);
        html += `
          <div style="margin:14px 0 8px 0;color:#08f;font-weight:bold">📌 分流比對</div>
          <div class="inspect-query">
            <canvas width="64" height="64" id="dInspectQueryCh"></canvas>
            <div>
              <div>當前分流畫面</div>
              <div style="margin-top:4px;font-size:11px;color:#888">
                系統判定：<span style="color:#0f0;font-weight:bold">CH.${m.label}</span>
                （${(m.similarity*100).toFixed(1)}%）
              </div>
            </div>
          </div>
          <table class="inspect-table">
            <thead>
              <tr>
                <th>圖</th><th>標籤</th><th>歐氏</th><th>餘弦</th><th>pHash</th>
                <th>總分</th><th></th>
              </tr>
            </thead>
            <tbody>`;
        for (const item of m.allMatches) {
          const tplDataURL = TemplateDB.data.ch[item.label][item.idx];
          const isWinner = item === m.allMatches[0];
          const isSuspect = !isWinner && (m.allMatches[0].label !== item.label) && item.combined > 0.7;
          html += `
            <tr class="${isWinner ? 'winner' : (isSuspect ? 'suspect' : '')}">
              <td><img class="tpl-thumb" src="${tplDataURL}"></td>
              <td><b>CH.${item.label}</b><br><span style="color:#666">#${item.idx+1}</span></td>
              <td>${(item.eucSim*100).toFixed(0)}%</td>
              <td>${(item.cosSim*100).toFixed(0)}%</td>
              <td>${(item.hashSim*100).toFixed(0)}%</td>
              <td><b>${(item.combined*100).toFixed(0)}%</b>
                <span class="inspect-bar"><span class="inspect-bar-fill" style="width:${item.combined*100}%"></span></span>
              </td>
              <td><button class="del-tpl" onclick="window.__detector.deleteTplFromInspect('ch','${item.label}',${item.idx})">🗑</button></td>
            </tr>`;
        }
        html += `</tbody></table>`;
      }

      if (!html) {
        html = '<div style="text-align:center;color:#888;padding:20px">尚無模板可比對<br>請先累積一些模板再使用此功能</div>';
      } else {
        html += `<div style="margin-top:10px;font-size:10px;color:#888">
          🟢 綠色 = 系統選的（最高分） &nbsp;
          🔴 紅色 = 嫌疑（不同標籤但分數很接近）
        </div>`;
      }

      body.innerHTML = html;
      modal.classList.add('show');

      // 畫上 query 圖
      if (state.lastBadgeCanvas) {
        const qC = document.getElementById('dInspectQueryPhase');
        if (qC) {
          const ctx = qC.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(state.lastBadgeCanvas, 0, 0, 64, 64);
        }
      }
      if (state.lastChCanvas) {
        const qC = document.getElementById('dInspectQueryCh');
        if (qC) {
          const ctx = qC.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(state.lastChCanvas, 0, 0, 64, 64);
        }
      }
    },

    closeInspect: () => {
      document.getElementById('dInspectModal').classList.remove('show');
    },

    // ═══════════════════════════════════════════════
    // v0.7: 校準工作流程
    // ═══════════════════════════════════════════════
    openCalibration: () => {
      const modal = document.getElementById('dCalibModal');
      modal.classList.add('show');
      renderCalibStep1();
    },
    closeCalibration: () => {
      document.getElementById('dCalibModal').classList.remove('show');
    },

    // 步驟 1：使用者按「開始框選計時圈」
    startCalibFrameSelect: () => {
      // 進入「框選計時圈」模式（類似框選 region 但專用）
      const modal = document.getElementById('dCalibModal');
      modal.classList.remove('show');
      // 切到完整模式
      if (state.panelMode !== 'full') togglePanelMode();
      // 啟用框選模式（用 timing 模式）
      enterCalibFrameMode();
    },

    // 步驟 2：套用紅環校準結果
    applyAutoCalibration: async () => {
      const region = state._calibTempRegion;
      if (!region) return;
      const body = document.getElementById('dCalibBody');
      body.innerHTML = '<div style="text-align:center;padding:20px">🔄 正在偵測紅環（10 次取樣中）...</div>';

      const result = await runRingCalibration(region, { samples: 10 });
      if (!result.success) {
        renderCalibFailure(result.reason);
        return;
      }
      renderCalibAutoResult(region, result);
    },

    confirmAutoCalibration: () => {
      const region = state._calibTempRegion;
      const result = state._calibTempResult;
      if (!region || !result) return;
      applyCalibration(region, result, false);
      log(`✨ 校準成功！紅環中心 (${(result.ringCenterRatio.x*100).toFixed(1)}%, ${(result.ringCenterRatio.y*100).toFixed(1)}%)，半徑比 ${(result.ringRadiusRatio*100).toFixed(1)}%`, '#0f0');
      updateCalibStatus();
      window.__detector.closeCalibration();
      // 重新渲染預覽
      if (state.regions.status) renderBadgeEditor();
    },

    // 步驟 3：跳過校準（手動）
    skipCalibration: () => {
      const region = state._calibTempRegion;
      if (!region) return;
      applyCalibration(region, null, true);  // 用預設比例
      log(`⚠️ 已跳過自動校準，使用預設比例（之後可在徽章編輯器手動微調）`, '#fa0');
      updateCalibStatus();
      window.__detector.closeCalibration();
      if (state.regions.status) renderBadgeEditor();
    },

    // 重設校準
    resetCalibration: () => {
      if (!confirm('確定要清除校準資料？這會回到「手動拖曳橘框」模式。')) return;
      clearCalibration();
      updateCalibStatus();
      log('🗑 已清除校準資料', '#fa0');
      window.__detector.closeCalibration();
      if (state.regions.status) renderBadgeEditor();
    },

    // 重新開始校準
    restartCalibration: () => {
      renderCalibStep1();
    },

    // 取消校準框選（從浮動提示按取消）
    cancelCalibFrame: () => {
      state._calibrating = false;
      hideCalibInstructions();
      log('已取消校準', '#888');
    },

    // 從偵錯模態刪模板，並重新整理
    deleteTplFromInspect: async (category, label, index) => {
      if (!confirm(`確定要刪除 ${category === 'ch' ? 'CH.'+label : label} 的第 ${index+1} 張模板？`)) return;
      const ok = TemplateDB.deleteAt(category, label, index);
      if (ok) {
        log(`🗑 已刪除 ${category === 'ch' ? 'CH.'+label : label} #${index+1}`, '#f80');
        updateTplDisplay();
        await window.__detector.openInspect();
      }
    },

    // v0.6.4 紅環偵測診斷
    toggleDiagAdvanced: () => {
      const adv = document.getElementById('dDiagAdvanced');
      adv.style.display = adv.style.display === 'none' ? 'block' : 'none';
    },

    runDiagnose: () => {
      runDiagnose();
    },

    toggleDiagnoseLoop: () => {
      const btn = document.getElementById('dDiagLoopBtn');
      if (state.diagLoopTimer) {
        clearInterval(state.diagLoopTimer);
        state.diagLoopTimer = null;
        btn.textContent = '🔁 連續測試';
        btn.classList.remove('red');
        btn.classList.add('orange');
        log('⏹ 連續診斷已停止', '#888');
      } else {
        state.diagHistory = [];
        document.getElementById('dDiagStability').style.display = 'block';
        runDiagnose();
        state.diagLoopTimer = setInterval(runDiagnose, 1000);
        btn.textContent = '⏸ 停止測試';
        btn.classList.remove('orange');
        btn.classList.add('red');
        log('▶️ 開始連續診斷（每秒 1 次）', '#fa0');
      }
    },
    showEdit: (map, ch, val, mapRaw) => {
      const area = document.getElementById('dConfirmArea');
      area.innerHTML = `
        <div class="confirm-banner">
          修改送出：
          <div class="correction-row">
            <input type="text" id="dEditMap" value="${map}" style="width:60px">
            <input type="text" id="dEditCh" value="${ch}" style="width:40px">
            <select id="dEditVal" style="padding:3px">
              <option ${val==='ON'?'selected':''}>ON</option>
              <option ${val==='R1'?'selected':''}>R1</option>
              <option ${val==='R2'?'selected':''}>R2</option>
              <option ${val==='R3'?'selected':''}>R3</option>
              <option ${val==='R4'?'selected':''}>R4</option>
              <option ${val==='DE1'?'selected':''}>DE1</option>
            </select>
            <button class="dbtn" onclick="window.__detector.confirmEdit('${mapRaw}')">✓</button>
          </div>
        </div>`;
    },
    confirmEdit: (mapRaw) => {
      const map = document.getElementById('dEditMap').value.trim();
      const ch = document.getElementById('dEditCh').value.trim();
      const val = document.getElementById('dEditVal').value;
      if (!map || !ch) return;
      doSubmit(map, ch, val);
      if (document.getElementById('dContribute').checked) contributeMapAlias(mapRaw, map);
    },
    confirmManual: (val, mapRaw) => {
      const map = document.getElementById('dFixMap').value.trim();
      const ch = document.getElementById('dFixCh').value.trim();
      if (!map || !ch) return;
      doSubmit(map, ch, val);
      if (document.getElementById('dContribute').checked && mapRaw) contributeMapAlias(mapRaw, map);
    },
    submitCorrection: () => {
      const raw = document.getElementById('dCorrectRaw').value.trim();
      const code = document.getElementById('dCorrectCode').value.trim();
      if (!raw || !code) return;
      contributeMapAlias(raw, code);
      document.getElementById('dCorrectRaw').value = '';
      document.getElementById('dCorrectCode').value = '';
    }
  };

  loadTesseract(() => {
    waitForApp(() => {
      injectUI();
      console.log(DEBUG_PREFIX, 'v0.7.0 Beta 已就緒');
    });
  });

})();
