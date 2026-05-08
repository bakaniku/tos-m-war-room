/**
 * ═══════════════════════════════════════════════════════════════════════
 * 📷 TOS M FB TIME - 螢幕偵測模組 v0.9.1 (文字主體中心化)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 【v0.9.1 唯一改動 — 解決 1↔7、2↔7、3↔2 誤判】
 *
 * 從 v0.9.0 的差異:只有一個改動,聚焦解決「相似度都擠在 92~99%」的問題
 *
 * 問題分析:
 *   舊版直接拿 32×32 標準化圖做特徵比對,但 32×32 中真正的「字」
 *   只佔 15~20% 像素,其餘 80% 是 BOSS 身體紋路(背景)。
 *   結果:三特徵分數主要在比背景而非比字,差距 0~1% 無法區分。
 *
 * 改動內容:
 *   在 extractFeatures 開頭加入 _textCenterCrop:
 *   1. 找出圖中亮白色像素(g > 180)的 bounding box
 *   2. 合理性檢查(白點數 20~600、bbox 4~28 px)
 *   3. 把 bbox 等比例縮放到 24×24,置中於 32×32
 *   4. 周圍補真實背景色(避免引入新邊緣)
 *
 * 既有模板自動生效:dataURLToFeatures 載入時也會走相同流程,
 * query 與 template 兩邊一致,不需要重訓。
 *
 * Fallback:若白點偵測失敗(例如 WAITING 沒字、整片黑),fallback
 * 到原 32×32 行為,完全不影響。
 *
 * 從 v0.9.0 全部保留:
 *   - 時間域 5-of-5 滑動視窗投票
 *   - 拒答規則 3 標籤共識
 *   - 模板智慧丟舊
 *   - 雙信號融合(模板 + 公告 OCR)
 *   - 狀態轉移約束
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

(function() {
  'use strict';

  const DEBUG_PREFIX = '[偵測器]';
  const TEMPLATE_SIZE = 32;
  const TEMPLATE_STORAGE_KEY = 'tosm_detector_templates_v5';

  // ═══ v0.7.1 精準優先門檻 ═══
  const TEMPLATE_MIN_SIM = 0.92;       // 提高(原 0.85)
  const TEMPLATE_AMBIGUOUS = 0.85;     // 提高(原 0.70)
  const MAX_TEMPLATES_PER_LABEL = 15;  // v0.9.0: 30 → 15(防止過多模板稀釋判定)
  const ALIGN_RADIUS = 3;              // 錨點對齊搜尋半徑(±px)
  const REJECT_TOP1_MIN = 0.92;        // 拒答:最高分必須達此值
  const REJECT_RIVAL_DIFF = 0.05;      // 拒答:最高分與不同標籤次高分至少差此值
  // v0.9.0 移除 REJECT_LABEL_AVG,改用「前 3 名標籤一致性」檢查
  const REJECT_TOP3_CONSENSUS = 2;     // 前 3 名至少 N 名為同標籤才算共識通過
  // v0.9.2 short-circuit:強信心直通,繞過 rival diff 檢查
  const SHORTCIRCUIT_ABSOLUTE_CONF = 0.95;   // top1 sim 達此即直通(Solution 2)
  const SHORTCIRCUIT_TOPN_CONSENSUS = 5;     // 前 N 個別 template 同 label 即直通(Solution 3)

  // ═══ v0.8.0 雙信號融合常數(v0.9.0 配合 3s 掃描調整)═══
  const ANNOUNCEMENT_HISTORY_SIZE = 5;     // v0.9.0: 3 → 5
  const ANNOUNCEMENT_VOTE_MIN = 3;         // v0.9.0: 2 → 3(5 次中至少 3 次同 phase)
  const ANNOUNCEMENT_TTL_MS = 12000;       // v0.9.0: 5s → 12s(配合 3s 掃描頻率)
  const ANNOUNCEMENT_MIN_CONF = 0.5;
  const STAGE_RANK = { 'WAITING': 0, 'R1': 1, 'R2': 2, 'R3': 3, 'R4': 4, 'ON': 5 };

  // ═══ v0.9.0 時間域投票 ═══
  const PHASE_VOTE_WINDOW = 5;             // 5 次決策投票
  const PHASE_VOTE_MIN = 3;                // 至少 3 次同 phase 才送出
  const DEFAULT_SCAN_INTERVAL_MS = 3000;   // 預設掃描間隔(原 1500)

  const CALIBRATION_STORAGE_KEY = 'tosm_detector_calibration_v7';
  const DEFAULT_RING_RATIOS = {
    ringCenterRatio: { x: 0.3, y: 0.6 },
    ringRadiusRatio: 0.25,
    badgeOffsetRatio: 0.95,
    badgeSizeRatio: 0.65
  };
  const DATA_COLLECTION_CONFIG_DEFAULT = Object.freeze({
    dataCollectionEnabled: false,
    shadowLoggingEnabled: false,
    collectorIdRequired: true,
    dailyStorageLimitMB: 500,
    sampleRate: 1.0,
    archiveAfterDays: 7
  });
  const DATA_COLLECTION_LOCAL_KEY = 'tosm_detector_shadow_records_v1';
  const DATA_COLLECTION_COLLECTOR_KEY = 'tosm_detector_collector_id_v1';
  const DATA_COLLECTION_SESSION_KEY = 'tosm_detector_session_id_v1';
  const SHADOW_DB_NAME = 'tosm_detector_shadow_db_v1';
  const SHADOW_DB_VERSION = 1;
  const SHADOW_STORE_EVENTS = 'events';
  const SHADOW_STORE_CROPS = 'crops';
  const SHADOW_STORE_LABELS = 'labels';
  const SHADOW_STORE_CANDIDATES = 'candidates';
  const SHADOW_KEY_MAX_LEN = 200;
  const SHADOW_LOCAL_RECORD_LIMIT = 1000;
  const SHADOW_DAILY_LIMIT_BYTES = 500 * 1024 * 1024;
  const SHADOW_STORAGE_STATUS = Object.freeze({
    SAVED_INDEXEDDB: 'saved_indexeddb',
    METADATA_ONLY_PRUNED_STORAGE: 'metadata_only_pruned_storage',
    INDEXEDDB_UNAVAILABLE: 'indexeddb_unavailable',
    DAILY_LIMIT_EXCEEDED: 'daily_limit_exceeded',
    CROP_CAPTURE_FAILED: 'crop_capture_failed',
    PARTIAL_CROP_SAVED: 'partial_crop_saved',
    SAMPLED_OUT: 'sampled_out',
    LEGACY_METADATA_ONLY: 'legacy_metadata_only'
  });

  // ═══════════════════════════════════════════════
  // 模板資料庫 (v0.7.1 精準優先版)
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
        console.error(DEBUG_PREFIX, '模板儲存失敗(容量可能已滿)', e);
      }
    },

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

    // ═══ v0.9.1 文字主體中心化(配合 v0.7.1 三特徵)═══
    // 設計目的:消除背景污染。舊版直接用整張 32×32,背景紋路佔大部分像素
    // 導致同數字 vs 異數字相似度都擠在 92~99%(0~1% 差距)無法區分。
    // 新版:找白色文字 bbox,把它中心化縮放到 24×24,周圍 4px 邊框留空。
    // 既有模板自動生效(dataURLToFeatures 也會走相同流程)。
    extractFeatures(canvas) {
      // Step 1: 文字主體中心化(若失敗,fallback 用原圖)
      const centered = this._textCenterCrop(canvas);
      const target = centered || canvas;

      const ctx = target.getContext('2d');
      const img = ctx.getImageData(0, 0, target.width, target.height);
      const w = target.width, h = target.height;
      const len = w * h;
      const gray = new Float32Array(len);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
        gray[j] = img.data[i];
      }
      const binary = this._otsuBinarize(gray);
      const edge = this._sobelEdge(gray, w, h);
      const zone = this._zoneFeatures(binary, w, h);

      // 為向下相容,保留 pixels / magnitude / hash 欄位
      let mag = 0;
      for (let i = 0; i < len; i++) mag += gray[i] * gray[i];

      return {
        gray, binary, edge, zone, w, h,
        pixels: gray,
        magnitude: Math.sqrt(mag),
        hash: null,
        _wasCentered: !!centered   // debug 用:標記這個特徵是否經過中心化
      };
    },

    // ─── v0.9.1 新增:文字主體中心化 ───
    // 找出 32×32 圖中亮白色像素的 bounding box,確認合理性後
    // 把該 box 中心縮放到 24×24 並置於 32×32 中心(周圍補背景色)
    // 失敗回傳 null,讓上層 fallback 用原圖
    _textCenterCrop(srcCanvas) {
      const W = srcCanvas.width, H = srcCanvas.height;
      // 只對 32×32 標準大小做(模板都是這個尺寸)
      if (W !== 32 || H !== 32) return null;

      const ctx = srcCanvas.getContext('2d');
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;

      // 找亮白色像素(絕對亮度 > 180,避免 Otsu 在純色域失靈)
      const WHITE_THRESHOLD = 180;
      let minX = W, minY = H, maxX = -1, maxY = -1;
      let whiteCount = 0;
      // 順便算一下背景平均色(非白像素的平均),用來填補裁切後的邊框
      let bgR = 0, bgG = 0, bgB = 0, bgN = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          // 用灰階亮度判定(因為 normalize 後 r=g=b)
          const v = d[i];
          if (v > WHITE_THRESHOLD) {
            whiteCount++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          } else {
            bgR += d[i];
            bgG += d[i+1];
            bgB += d[i+2];
            bgN++;
          }
        }
      }

      // 合理性檢查
      if (whiteCount < 12) return null;   // 太少:可能根本沒字(降低門檻以支援細筆劃)
      if (whiteCount > 600) return null;  // 太多:可能整片白(WAITING / 異常擷取)
      if (maxX < 0) return null;          // 沒找到任何白點
      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      if (bboxW < 2 || bboxH < 2) return null;  // 太細小:可能是雜訊(僅 1 px 寬高才放棄)
      if (bboxW > 28 || bboxH > 28) return null; // 太大:擠不進 24×24,放棄

      // 平均背景色
      if (bgN === 0) return null;
      const avgR = Math.round(bgR / bgN);
      const avgG = Math.round(bgG / bgN);
      const avgB = Math.round(bgB / bgN);

      // 計算等比例縮放後的尺寸,讓 bbox 最長邊縮到 24
      const TARGET = 24;
      const scale = TARGET / Math.max(bboxW, bboxH);
      const newW = Math.max(1, Math.round(bboxW * scale));
      const newH = Math.max(1, Math.round(bboxH * scale));

      // 建一個 32×32 結果 canvas,先填背景色
      const out = document.createElement('canvas');
      out.width = 32;
      out.height = 32;
      const octx = out.getContext('2d');
      octx.fillStyle = `rgb(${avgR},${avgG},${avgB})`;
      octx.fillRect(0, 0, 32, 32);

      // 把 bbox 區域 drawImage 進中心
      const dx = Math.round((32 - newW) / 2);
      const dy = Math.round((32 - newH) / 2);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(srcCanvas,
        minX, minY, bboxW, bboxH,
        dx, dy, newW, newH);

      // 再 grayscale 一次(drawImage 會有抗鋸齒讓 r/g/b 略有差,統一一下)
      const outImg = octx.getImageData(0, 0, 32, 32);
      const od = outImg.data;
      for (let i = 0; i < od.length; i += 4) {
        const g = 0.299 * od[i] + 0.587 * od[i+1] + 0.114 * od[i+2];
        od[i] = od[i+1] = od[i+2] = g;
      }
      octx.putImageData(outImg, 0, 0);

      return out;
    },

    // ─── v0.7.1 新增:Otsu 二值化 ───
    _otsuBinarize(gray) {
      const n = gray.length;
      const hist = new Array(256).fill(0);
      for (let i = 0; i < n; i++) hist[Math.round(gray[i])]++;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, maxVar = 0, th = 127;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (wB === 0) continue;
        const wF = n - wB;
        if (wF === 0) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > maxVar) { maxVar = v; th = t; }
      }
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = gray[i] > th ? 255 : 0;
      return out;
    },

    // ─── v0.7.1 新增:Sobel 邊緣強度 ───
    _sobelEdge(gray, w, h) {
      const out = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const tl = gray[i - w - 1], t = gray[i - w], tr = gray[i - w + 1];
          const l  = gray[i - 1],                       r = gray[i + 1];
          const bl = gray[i + w - 1], b = gray[i + w], br = gray[i + w + 1];
          const gx = -tl - 2*l - bl + tr + 2*r + br;
          const gy = -tl - 2*t - tr + bl + 2*b + br;
          out[i] = Math.sqrt(gx*gx + gy*gy);
        }
      }
      return out;
    },

    // ─── v0.7.1 新增:Zone 二值密度(8×8 = 64 維)───
    _zoneFeatures(binary, w, h) {
      const features = new Float32Array(64);
      const zoneW = w / 8, zoneH = h / 8;
      for (let zy = 0; zy < 8; zy++) {
        for (let zx = 0; zx < 8; zx++) {
          let blackCount = 0, total = 0;
          const x0 = Math.floor(zx * zoneW), x1 = Math.floor((zx + 1) * zoneW);
          const y0 = Math.floor(zy * zoneH), y1 = Math.floor((zy + 1) * zoneH);
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              if (binary[y * w + x] === 0) blackCount++;
              total++;
            }
          }
          features[zy * 8 + zx] = total > 0 ? blackCount / total : 0;
        }
      }
      return features;
    },

    // ─── v0.7.1 新增:NCC ───
    _ncc(a, b) {
      const n = a.length;
      let sumA = 0, sumB = 0;
      for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
      const mA = sumA / n, mB = sumB / n;
      let num = 0, denA = 0, denB = 0;
      for (let i = 0; i < n; i++) {
        const da = a[i] - mA, db = b[i] - mB;
        num += da * db;
        denA += da * da;
        denB += db * db;
      }
      const den = Math.sqrt(denA * denB);
      if (den < 1e-9) return 0;
      return num / den;
    },

    _nccSim01(a, b) {
      return Math.max(0, (this._ncc(a, b) + 1) / 2);
    },

    _cosineSim01(a, b) {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      if (magA === 0 || magB === 0) return 0;
      return Math.max(0, dot / Math.sqrt(magA * magB));
    },

    // ─── v0.7.1 新增:像素位移(用於錨點對齊)───
    _shiftPixels(pixels, w, h, dx, dy) {
      const out = new Float32Array(pixels.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sx = x - dx, sy = y - dy;
          if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
            out[y * w + x] = pixels[sy * w + sx];
          }
        }
      }
      return out;
    },

    // ─── v0.7.1 新增:錨點對齊 + 三特徵組合分數 ───
    _alignAndScore(queryFeat, tplFeat) {
      const w = queryFeat.w, h = queryFeat.h;
      let bestNcc = -1;
      let bestShifted = null;
      let bestOffset = { dx: 0, dy: 0 };
      for (let dy = -ALIGN_RADIUS; dy <= ALIGN_RADIUS; dy++) {
        for (let dx = -ALIGN_RADIUS; dx <= ALIGN_RADIUS; dx++) {
          const shifted = this._shiftPixels(queryFeat.gray, w, h, dx, dy);
          const c = this._ncc(shifted, tplFeat.gray);
          if (c > bestNcc) {
            bestNcc = c;
            bestShifted = shifted;
            bestOffset = { dx, dy };
          }
        }
      }
      const shiftedEdge = this._sobelEdge(bestShifted, w, h);
      const shiftedBinary = this._otsuBinarize(bestShifted);
      const shiftedZone = this._zoneFeatures(shiftedBinary, w, h);

      const simEdge  = this._nccSim01(shiftedEdge,  tplFeat.edge);
      const simZone  = this._cosineSim01(shiftedZone, tplFeat.zone);
      const simPixel = Math.max(0, (bestNcc + 1) / 2);

      // 精準優先版權重:邊緣最重要(對筆劃形狀最敏感)
      const combined = simEdge * 0.5 + simZone * 0.35 + simPixel * 0.15;

      return { combined, simEdge, simZone, simPixel, offset: bestOffset };
    },

    // ─── 保留舊 API 向下相容 ───
    getPixels(canvas) {
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = new Float32Array(canvas.width * canvas.height);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
        pixels[j] = img.data[i];
      }
      return pixels;
    },

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

    cosineSim(a, b, magA, magB) {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      if (magA === 0 || magB === 0) return 0;
      return dot / (magA * magB);
    },

    pHashSim(hashA, hashB) {
      if (!hashA || !hashB) return 0;
      let diff = 0;
      for (let i = 0; i < hashA.length; i++) {
        if (hashA[i] !== hashB[i]) diff++;
      }
      return 1 - (diff / hashA.length);
    },

    euclideanDistance(a, b) {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
      }
      return Math.sqrt(sum);
    },

    add(category, label, sourceCanvas) {
      const norm = this.normalize(sourceCanvas);
      const dataURL = norm.toDataURL('image/png');
      if (!this.data[category][label]) this.data[category][label] = [];
      if (this.data[category][label].includes(dataURL)) return false;
      this.data[category][label].push(dataURL);
      if (this.data[category][label].length > MAX_TEMPLATES_PER_LABEL) {
        // v0.9.0: 智慧丟舊 — 找「跟其他模板最像」的那張丟掉,保留多樣性最高的
        // 注意:add 是同步方法,我們用 dataURL 比對近似度(粗略但足夠)
        // 真正精確的丟法需要 async,這邊用 fire-and-forget 在背景執行
        this._smartPrune(category, label);
      }
      this.save();
      return true;
    },

    // v0.9.0 新增:智慧丟舊
    // 策略:對每張模板,計算它對其他模板的平均相似度;丟掉「最像其他人」的那張
    // 這樣保留下來的就是「最有差異性」的代表樣本
    async _smartPrune(category, label) {
      const arr = this.data[category][label];
      if (!arr || arr.length <= MAX_TEMPLATES_PER_LABEL) return;

      try {
        // 提取每張的特徵
        const feats = [];
        for (const url of arr) {
          feats.push(await this.dataURLToFeatures(url));
        }

        // 計算每張對其他所有張的平均相似度(用 zone cosine,粗略但快)
        const avgSims = feats.map((f, i) => {
          let sum = 0, count = 0;
          for (let j = 0; j < feats.length; j++) {
            if (i === j) continue;
            sum += this._cosineSim01(f.zone, feats[j].zone);
            count++;
          }
          return count > 0 ? sum / count : 0;
        });

        // 找 avgSims 最大的那張(最像其他人 = 最沒貢獻多樣性)
        let maxIdx = 0;
        for (let i = 1; i < avgSims.length; i++) {
          if (avgSims[i] > avgSims[maxIdx]) maxIdx = i;
        }

        arr.splice(maxIdx, 1);
        this.save();
        if (typeof log === 'function') {
          log(`🧹 模板智慧丟舊 ${label}: 移除 #${maxIdx+1}(最像其他模板)`, '#888');
        }
      } catch (e) {
        // 失敗 fallback 到簡單 FIFO
        arr.shift();
        this.save();
      }
    },

    clearCategory(category, label) {
      if (label) delete this.data[category][label];
      else this.data[category] = {};
      this.save();
    },

    deleteAt(category, label, index) {
      if (!this.data[category] || !this.data[category][label]) return false;
      if (index < 0 || index >= this.data[category][label].length) return false;
      this.data[category][label].splice(index, 1);
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

    // ═══ v0.7.1 新版 match:錨點對齊 + 拒答機制 ═══
    async match(category, sourceCanvas) {
      const templates = this.data[category];
      if (!templates || Object.keys(templates).length === 0) return null;
      const norm = this.normalize(sourceCanvas);
      const queryFeat = this.extractFeatures(norm);

      const results = [];
      const allMatches = [];

      for (const [label, dataURLs] of Object.entries(templates)) {
        let bestSim = -1;
        let bestDetail = null;
        for (let idx = 0; idx < dataURLs.length; idx++) {
          const dataURL = dataURLs[idx];
          const tplFeat = await this.dataURLToFeatures(dataURL);
          const r = this._alignAndScore(queryFeat, tplFeat);

          // 沿用既有偵錯介面欄位名,但意義已變
          // eucSim=像素NCC, cosSim=Zone cosine, hashSim=邊緣NCC
          const matchEntry = {
            label, idx,
            eucSim: r.simPixel,
            cosSim: r.simZone,
            hashSim: r.simEdge,
            combined: r.combined,
            offset: r.offset
          };
          allMatches.push(matchEntry);

          if (r.combined > bestSim) {
            bestSim = r.combined;
            bestDetail = matchEntry;
          }
        }
        results.push({ label, similarity: bestSim, detail: bestDetail });
      }

      results.sort((a, b) => b.similarity - a.similarity);
      allMatches.sort((a, b) => b.combined - a.combined);

      // ═══ 拒答機制 ═══
      const top1 = results[0];
      const rival = results.find(r => r.label !== top1.label);
      let rejection = null;
      let shortCircuit = null;

      // ─── v0.9.2 short-circuit:強信心直通 ───
      // 動機:production 觀察到「前 N 名全同 label、top1 sim 0.99x」仍因 rival 接近被誤拒
      //       (例如 R3=0.9932 vs R1=0.9576,diff=0.0356 < REJECT_RIVAL_DIFF=0.05)
      // 兩個獨立短路條件,任一觸發即跳過所有拒答檢查
      const isAbsoluteConfidence = top1.similarity >= SHORTCIRCUIT_ABSOLUTE_CONF;
      const topN = allMatches.slice(0, SHORTCIRCUIT_TOPN_CONSENSUS);
      const isTopNConsensus = topN.length >= SHORTCIRCUIT_TOPN_CONSENSUS
                           && topN.every(m => m.label === top1.label);

      if (isAbsoluteConfidence || isTopNConsensus) {
        // 兩個都觸發時優先 absolute_conf(更強訊號)
        shortCircuit = isAbsoluteConfidence ? 'absolute_conf' : 'topN_consensus';
        // rejection 留 null,直通
      } else if (top1.similarity < REJECT_TOP1_MIN) {
        rejection = {
          reason: 'low_confidence',
          detail: `top1=${top1.similarity.toFixed(3)} < ${REJECT_TOP1_MIN}`
        };
      } else if (rival && (top1.similarity - rival.similarity) < REJECT_RIVAL_DIFF) {
        rejection = {
          reason: 'ambiguous',
          detail: `${top1.label}(${top1.similarity.toFixed(3)}) vs ${rival.label}(${rival.similarity.toFixed(3)})`,
          top1Label: top1.label, top1Sim: top1.similarity,
          rivalLabel: rival.label, rivalSim: rival.similarity
        };
      } else {
        // v0.9.0: 改成「前 3 名 allMatches 中,top1 標籤是否佔多數」
        // 原邏輯看「平均分」會在「模板數量多但每張平均分不高」時誤觸發
        // (例如 30 張背景多變的 CH.7 模板,雖然能正確判定但平均拖低)
        // 新邏輯只看「前 3 名是否都是同一個標籤」,符合「共識」的本意
        const top3 = allMatches.slice(0, 3);
        if (top3.length >= 3) {
          const sameLabelInTop3 = top3.filter(m => m.label === top1.label).length;
          if (sameLabelInTop3 < REJECT_TOP3_CONSENSUS) {
            // 前 3 名混雜不同標籤 → 真的有共識問題
            rejection = {
              reason: 'no_top3_consensus',
              detail: `top3 中只有 ${sameLabelInTop3}/${top3.length} 是 ${top1.label}`,
              top3Labels: top3.map(m => m.label)
            };
          }
        }
      }

      return {
        label: top1.label,
        similarity: top1.similarity,
        topN: results.slice(0, 5),
        allMatches: allMatches.slice(0, 10),
        rejection,
        shortCircuit
      };
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
        alert('❌ 匯入失敗:' + e.message);
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
    "那魯巴斯寺院別館": "153",
    "史達里小鎮": "155", "貝拉因小鎮": "157", "斯貝托溫小鎮": "159",
    "巴爾堤內紀念區": "161", "克利黑爾紀念區": "163"
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
    regions: { status: null, map: null, ch: null, announcement: null },  // v0.8.0: +announcement
    badgeRect: null,
    lastPhase: null, stableCount: 0,
    lastSubmitted: { map: null, ch: null, val: null, time: 0 },
    mapDictionary: { ...BUILTIN_MAP_DICTIONARY },
    lastResult: null, zoom: 1.0, debugMode: false,
    panelMode: 'compact', dictLoaded: false,
    panelPos: { x: null, y: null },
    lastBadgeCanvas: null,
    lastChCanvas: null,
    lastAnnouncementCanvas: null,         // v0.8.0
    muted: false,
    trainingMode: false,
    calibration: null,
    diagLoopTimer: null,
    diagHistory: [],
    // ═══ v0.8.0 雙信號融合相關狀態 ═══
    announcementHistory: [],              // 滑動視窗 [{phase, confidence, raw, time}]
    lastDecisionDetail: null,             // 最近一次決策細節(供 UI 顯示)
    // ═══ v0.9.0 時間域投票 ═══
    phaseHistory: [],                      // 最近 N 次 fused 結果 [{phase, confidence, time}]
    detectorConfig: { ...DATA_COLLECTION_CONFIG_DEFAULT },
    detectorConfigLoaded: false,
    collectorId: '',
    sessionId: null,
    frameSeq: 0,
    lastShadowRecord: null,
    shadowRecordCount: 0,
    shadowDB: null,
    shadowDBStatus: 'idle',
    shadowDBError: '',
    shadowDBStats: null,
    shadowDBSpikeLayer: null,
    shadowMigration: { attempted: false, migrated: 0, failed: 0, error: '' }
  };

  function ensureSessionId() {
    if (state.sessionId) return state.sessionId;
    try {
      const existing = sessionStorage.getItem(DATA_COLLECTION_SESSION_KEY);
      if (existing) {
        state.sessionId = existing;
        return existing;
      }
    } catch (e) {}
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    state.sessionId = id;
    try { sessionStorage.setItem(DATA_COLLECTION_SESSION_KEY, id); } catch (e) {}
    return id;
  }

  function getCollectorId() {
    const input = document.getElementById('dCollectorId');
    const fromInput = input ? input.value.trim() : '';
    if (fromInput) return fromInput;
    if (state.collectorId) return state.collectorId;
    try { return localStorage.getItem(DATA_COLLECTION_COLLECTOR_KEY) || ''; } catch (e) { return ''; }
  }

  function saveCollectorId(value) {
    const id = (value || '').trim();
    state.collectorId = id;
    const input = document.getElementById('dCollectorId');
    if (input && input.value.trim() !== id) input.value = id;
    try { localStorage.setItem(DATA_COLLECTION_COLLECTOR_KEY, id); } catch (e) {}
    updateDataCollectionUI();
    return id;
  }

  function applyDetectorConfig(config) {
    state.detectorConfig = { ...DATA_COLLECTION_CONFIG_DEFAULT, ...(config || {}) };
    state.detectorConfigLoaded = true;
    updateDataCollectionUI();
  }

  function loadDetectorConfig() {
    applyDetectorConfig({});
    try {
      db.ref('shared/detectorConfig').on('value', snap => {
        applyDetectorConfig(snap.val() || {});
      }, err => {
        state.detectorConfigLoaded = true;
        updateDataCollectionUI(`config read failed: ${err.message || err}`);
      });
    } catch (e) {
      state.detectorConfigLoaded = true;
      updateDataCollectionUI(`config unavailable: ${e.message || e}`);
    }
  }

  function updateDataCollectionUI(extra) {
    const input = document.getElementById('dCollectorId');
    if (input && !input.value) input.value = state.collectorId || getCollectorId();
    const el = document.getElementById('dDataCollectionStatus');
    if (!el) return;
    const cfg = state.detectorConfig || DATA_COLLECTION_CONFIG_DEFAULT;
    const collectorId = getCollectorId();
    const missingCollector = cfg.collectorIdRequired && !collectorId;
    const enabled = !!cfg.dataCollectionEnabled && !!cfg.shadowLoggingEnabled && !missingCollector;
    const parts = [
      `config=${state.detectorConfigLoaded ? 'loaded' : 'loading'}`,
      `collect=${cfg.dataCollectionEnabled ? 'on' : 'off'}`,
      `shadow=${cfg.shadowLoggingEnabled ? 'on' : 'off'}`,
      `collector=${collectorId || 'missing'}`,
      `localRecords=${state.shadowRecordCount || 0}`,
      `indexeddb=${state.shadowDBStatus || 'idle'}`
    ];
    if (state.shadowDBError) parts.push(`idb_error=${state.shadowDBError}`);
    if (state.shadowMigration?.attempted) {
      parts.push(state.shadowMigration.error
        ? `migration=failed:${state.shadowMigration.error}`
        : `migration=${state.shadowMigration.migrated}`);
    }
    if (missingCollector) parts.push('blocked=collector_id_required');
    if (extra) parts.push(extra);
    el.textContent = parts.join(' | ');
    el.style.color = enabled ? '#0f0' : (missingCollector ? '#fa0' : '#888');
  }

  function plainResult(result) {
    if (!result) return null;
    return {
      phase: result.phase ? {
        label: result.phase.phase || null,
        confidence: result.phase.confidence || 0,
        source: result.phase.source || '',
        raw: result.phase.ocrText || ''
      } : null,
      fused: result.fused ? {
        label: result.fused.phase || null,
        confidence: result.fused.confidence || 0,
        source: result.fused.source || '',
        policy: result.fused.phase && result.fused.phase !== 'UNKNOWN' ? 'ANSWER' : 'UNKNOWN'
      } : null,
      map: result.map ? {
        label: result.map.matched || null,
        confidence: result.map.confidence || 0,
        raw: result.map.raw || '',
        matchedName: result.map.matchedName || ''
      } : null,
      ch: result.ch ? {
        label: result.ch.ch || null,
        confidence: result.ch.confidence || 0,
        source: result.ch.source || '',
        raw: result.ch.raw || ''
      } : null,
      announcement: result.announcement ? {
        label: result.announcement.phase || null,
        confidence: result.announcement.confidence || 0,
        raw: result.announcement.raw || ''
      } : null
    };
  }

  function buildFrameSampleRecord(result) {
    const cfg = state.detectorConfig || DATA_COLLECTION_CONFIG_DEFAULT;
    const video = document.getElementById('dVideo');
    const frameId = `f_${Date.now().toString(36)}_${(++state.frameSeq).toString(36)}`;
    return {
      schema_version: 1,
      timestamp: new Date().toISOString(),
      collector_id: getCollectorId(),
      session_id: ensureSessionId(),
      frame_id: frameId,
      source: 'getDisplayMedia',
      image_size: video && video.videoWidth ? [video.videoWidth, video.videoHeight] : null,
      regions: {
        status: state.regions.status,
        stage: state.regions.status,
        map: state.regions.map,
        ch: state.regions.ch,
        announcement: state.regions.announcement
      },
      crops: {
        stage_path: null,
        map_path: null,
        ch_path: null,
        saved: false,
        storage_status: 'day1_metadata_only'
      },
      v091: plainResult(result),
      new_detector: null,
      disagreement: false,
      human_label: null,
      split: 'shadow_only',
      config: {
        dataCollectionEnabled: !!cfg.dataCollectionEnabled,
        shadowLoggingEnabled: !!cfg.shadowLoggingEnabled,
        collectorIdRequired: !!cfg.collectorIdRequired,
        sampleRate: Number(cfg.sampleRate || 0),
        dailyStorageLimitMB: Number(cfg.dailyStorageLimitMB || 0)
      },
      production: {
        trainingMode: !!state.trainingMode,
        autoTimerActive: !!state.autoTimer,
        autoSubmitChecked: !!document.getElementById('dAutoSubmit')?.checked
      },
      notes: ''
    };
  }

  function readLocalShadowRecords() {
    try {
      const arr = JSON.parse(localStorage.getItem(DATA_COLLECTION_LOCAL_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function initLocalShadowRecordCount() {
    const arr = readLocalShadowRecords();
    state.shadowRecordCount = arr.length;
    updateDataCollectionUI();
    return arr.length;
  }

  function appendLocalShadowRecord(record) {
    let arr = readLocalShadowRecords();
    arr.push(record);
    if (arr.length > SHADOW_LOCAL_RECORD_LIMIT) arr = arr.slice(arr.length - SHADOW_LOCAL_RECORD_LIMIT);
    localStorage.setItem(DATA_COLLECTION_LOCAL_KEY, JSON.stringify(arr));
    state.shadowRecordCount = arr.length;
  }

  function writeShadowLog(record) {
    const cfg = state.detectorConfig || DATA_COLLECTION_CONFIG_DEFAULT;
    if (!cfg.dataCollectionEnabled || !cfg.shadowLoggingEnabled) {
      updateDataCollectionUI();
      return false;
    }
    if (cfg.collectorIdRequired && !record.collector_id) {
      updateDataCollectionUI('last=blocked_missing_collector');
      return false;
    }
    const sampleRate = Math.max(0, Math.min(1, Number(cfg.sampleRate ?? 1)));
    if (sampleRate < 1 && Math.random() > sampleRate) {
      record.crops = record.crops || {};
      record.crops.storage_status = SHADOW_STORAGE_STATUS.SAMPLED_OUT;
      updateDataCollectionUI('last=sampled_out');
      return false;
    }
    try {
      appendLocalShadowRecord(record);
      state.lastShadowRecord = record;
      updateDataCollectionUI(`last=${record.frame_id}`);
      return true;
    } catch (e) {
      updateDataCollectionUI(`last=write_failed:${e.message || e}`);
      return false;
    }
  }

  function captureShadowSample(result) {
    const record = buildFrameSampleRecord(result);
    const accepted = writeShadowLog(record);
    if (accepted) {
      persistShadowSampleIndexedDB(record).catch(e => {
        state.shadowDBStatus = 'failed';
        state.shadowDBError = String(e?.message || e).slice(0, 80);
        updateDataCollectionUI(`idb_write=failed:${state.shadowDBError}`);
      });
    }
    return record;
  }

  function shortShadowHash(value) {
    const s = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function shadowKeyPart(value, maxLen = 48) {
    const s = String(value || 'missing').trim().replace(/[^A-Za-z0-9_.-]+/g, '_') || 'missing';
    if (s.length <= maxLen) return s;
    return `${s.slice(0, Math.max(8, maxLen - 9))}_${shortShadowHash(s)}`;
  }

  function buildShadowKey(parts) {
    const key = parts.map(p => shadowKeyPart(p)).join('_');
    if (key.length <= SHADOW_KEY_MAX_LEN) return key;
    const last = shadowKeyPart(parts[parts.length - 1], 32);
    const prefix = shadowKeyPart(parts.slice(0, -1).join('_'), SHADOW_KEY_MAX_LEN - last.length - 2);
    return `${prefix}_${last}`;
  }

  function eventIdFromRecord(record) {
    return buildShadowKey([record.collector_id, record.session_id, record.frame_id, 'event']);
  }

  function cropIdFromParts(record, kind) {
    return buildShadowKey([record.collector_id, record.session_id, record.frame_id, kind, 'crop']);
  }

  function openShadowDB() {
    if (!window.indexedDB) return Promise.reject(new Error('indexedDB_api_unavailable'));
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(SHADOW_DB_NAME, SHADOW_DB_VERSION);
      req.onerror = () => reject(req.error || new Error('indexeddb_open_failed'));
      req.onblocked = () => reject(new Error('indexeddb_open_blocked'));
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SHADOW_STORE_EVENTS)) {
          const events = db.createObjectStore(SHADOW_STORE_EVENTS, { keyPath: 'event_id' });
          events.createIndex('by_frame_id', 'frame_id', { unique: false });
          events.createIndex('by_collector_session', ['collector_id', 'session_id'], { unique: false });
          events.createIndex('by_storage_status', 'storage_status', { unique: false });
          events.createIndex('by_timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(SHADOW_STORE_CROPS)) {
          const crops = db.createObjectStore(SHADOW_STORE_CROPS, { keyPath: 'crop_id' });
          crops.createIndex('by_frame_id', 'frame_id', { unique: false });
          crops.createIndex('by_event_id', 'event_id', { unique: false });
          crops.createIndex('by_kind', 'kind', { unique: false });
          crops.createIndex('by_created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains(SHADOW_STORE_LABELS)) {
          const labels = db.createObjectStore(SHADOW_STORE_LABELS, { keyPath: 'label_id' });
          labels.createIndex('by_frame_id', 'frame_id', { unique: false });
          labels.createIndex('by_crop_id', 'crop_id', { unique: false });
          labels.createIndex('by_status', 'status', { unique: false });
          labels.createIndex('by_created_at', 'created_at', { unique: false });
        }
        if (!db.objectStoreNames.contains(SHADOW_STORE_CANDIDATES)) {
          const candidates = db.createObjectStore(SHADOW_STORE_CANDIDATES, { keyPath: 'candidate_id' });
          candidates.createIndex('by_crop_id', 'crop_id', { unique: false });
          candidates.createIndex('by_status', 'status', { unique: false });
          candidates.createIndex('by_created_at', 'created_at', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  async function ensureShadowDB() {
    if (state.shadowDB) return state.shadowDB;
    try {
      state.shadowDB = await openShadowDB();
      state.shadowDBStatus = 'ok';
      state.shadowDBError = '';
      updateDataCollectionUI();
      return state.shadowDB;
    } catch (e) {
      state.shadowDBStatus = 'failed';
      state.shadowDBError = String(e?.message || e).slice(0, 80);
      updateDataCollectionUI();
      throw e;
    }
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexeddb_request_failed'));
    });
  }

  function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('indexeddb_tx_failed'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb_tx_aborted'));
    });
  }

  async function putShadowEvent(event) {
    const db = await ensureShadowDB();
    const record = {
      ...event,
      event_id: event.event_id || eventIdFromRecord(event),
      storage_status: event.storage_status || 'saved_indexeddb',
      schema_version: event.schema_version || 2,
      crop_ids: event.crop_ids || [],
      missing_crop_kinds: event.missing_crop_kinds || []
    };
    const tx = db.transaction(SHADOW_STORE_EVENTS, 'readwrite');
    tx.objectStore(SHADOW_STORE_EVENTS).put(record);
    await idbTxDone(tx);
    return record;
  }

  async function putShadowCrop(crop) {
    const db = await ensureShadowDB();
    const tx = db.transaction(SHADOW_STORE_CROPS, 'readwrite');
    tx.objectStore(SHADOW_STORE_CROPS).put(crop);
    await idbTxDone(tx);
    return crop;
  }

  async function deleteFromStore(storeName, key) {
    const db = await ensureShadowDB();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    await idbTxDone(tx);
  }

  async function getProtectedCropIds() {
    try {
      const labels = await getAllFromStore(SHADOW_STORE_LABELS);
      return new Set(labels.filter(l => l && l.crop_id && l.status !== 'rejected').map(l => l.crop_id));
    } catch (e) {
      return new Set();
    }
  }

  function cropImportanceScore(crop, protectedIds) {
    if (protectedIds.has(crop.crop_id)) return Number.POSITIVE_INFINITY;
    const raw = crop.raw_data || {};
    let score = 0;
    if (raw.disagreement) score += 1;
    if (raw.low_confidence) score += 1;
    if (raw.unknown_result) score += 1;
    if (raw.rare_kind) score += 1;
    if (Date.now() - Date.parse(crop.created_at || 0) < 60 * 60 * 1000) score += 1;
    if (raw.has_correction) score += 1;
    if (raw.class_balance) score += 1;
    return score;
  }

  async function getDailyCropUsageBytes(date) {
    const crops = await getAllFromStore(SHADOW_STORE_CROPS);
    return crops
      .filter(c => (c.date || String(c.created_at || '').slice(0, 10)) === date)
      .reduce((sum, c) => sum + Number(c.byte_size || 0), 0);
  }

  async function pruneCropsForSpace(date, bytesNeeded) {
    const crops = (await getAllFromStore(SHADOW_STORE_CROPS))
      .filter(c => (c.date || String(c.created_at || '').slice(0, 10)) === date);
    const protectedIds = await getProtectedCropIds();
    const candidates = crops
      .filter(c => !protectedIds.has(c.crop_id))
      .map(c => ({ crop: c, score: cropImportanceScore(c, protectedIds) }))
      .sort((a, b) => a.score - b.score || String(a.crop.created_at || '').localeCompare(String(b.crop.created_at || '')));
    let freed = 0;
    for (const item of candidates) {
      await deleteFromStore(SHADOW_STORE_CROPS, item.crop.crop_id);
      freed += Number(item.crop.byte_size || 0);
      if (freed >= bytesNeeded) break;
    }
    return freed;
  }

  async function ensureDailyStorageRoom(date, incomingBytes) {
    const used = await getDailyCropUsageBytes(date);
    if (used + incomingBytes <= SHADOW_DAILY_LIMIT_BYTES) return { ok: true, used, freed: 0 };
    const freed = await pruneCropsForSpace(date, used + incomingBytes - SHADOW_DAILY_LIMIT_BYTES);
    const after = await getDailyCropUsageBytes(date);
    return { ok: after + incomingBytes <= SHADOW_DAILY_LIMIT_BYTES, used: after, freed };
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (!canvas || !canvas.width || !canvas.height) {
        reject(new Error('empty_canvas'));
        return;
      }
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('canvas_to_blob_failed'));
      }, 'image/png');
    });
  }

  function getShadowCropCanvases() {
    const crops = [];
    if (state.lastBadgeCanvas) crops.push({ kind: 'stage_badge', canvas: state.lastBadgeCanvas });
    if (state.regions.map) crops.push({ kind: 'map', canvas: captureRegionCanvas(state.regions.map, 'shadow_map') });
    if (state.lastChCanvas) crops.push({ kind: 'ch', canvas: state.lastChCanvas });
    else if (state.regions.ch) crops.push({ kind: 'ch', canvas: captureRegionCanvas(state.regions.ch, 'shadow_ch') });
    if (state.regions.announcement) crops.push({ kind: 'announcement', canvas: captureRegionCanvas(state.regions.announcement, 'shadow_announcement') });
    return crops;
  }

  async function persistShadowSampleIndexedDB(record) {
    const event = {
      ...record,
      event_id: eventIdFromRecord(record),
      schema_version: 2,
      storage_status: SHADOW_STORAGE_STATUS.SAVED_INDEXEDDB,
      crop_ids: [],
      missing_crop_kinds: []
    };
    const expected = ['stage_badge', 'map', 'ch'];
    const cropInputs = getShadowCropCanvases();
    const byKind = new Map(cropInputs.map(c => [c.kind, c.canvas]));
    let cropFailure = false;
    let prunedForStorage = false;

    for (const kind of [...expected, ...(state.regions.announcement ? ['announcement'] : [])]) {
      const canvas = byKind.get(kind);
      if (!canvas) {
        event.missing_crop_kinds.push(kind);
        cropFailure = true;
        continue;
      }
      try {
        const blob = await canvasToPngBlob(canvas);
        const date = String(record.timestamp || new Date().toISOString()).slice(0, 10);
        const room = await ensureDailyStorageRoom(date, blob.size);
        if (!room.ok) {
          event.missing_crop_kinds.push(kind);
          prunedForStorage = true;
          continue;
        }
        const crop = {
          crop_id: cropIdFromParts(record, kind),
          event_id: event.event_id,
          frame_id: record.frame_id,
          kind,
          collector_id: record.collector_id,
          session_id: record.session_id,
          date,
          width: canvas.width,
          height: canvas.height,
          byte_size: blob.size,
          mime_type: 'image/png',
          blob,
          created_at: new Date().toISOString(),
          raw_data: {}
        };
        await putShadowCrop(crop);
        event.crop_ids.push(crop.crop_id);
      } catch (e) {
        event.missing_crop_kinds.push(kind);
        cropFailure = true;
      }
    }

    if (event.crop_ids.length === 0 && (cropFailure || prunedForStorage)) {
      event.storage_status = prunedForStorage ? SHADOW_STORAGE_STATUS.DAILY_LIMIT_EXCEEDED : SHADOW_STORAGE_STATUS.CROP_CAPTURE_FAILED;
    } else if (event.missing_crop_kinds.length > 0) {
      event.storage_status = prunedForStorage ? SHADOW_STORAGE_STATUS.METADATA_ONLY_PRUNED_STORAGE : SHADOW_STORAGE_STATUS.PARTIAL_CROP_SAVED;
    }

    try {
      await putShadowEvent(event);
      record.crops = {
        ...(record.crops || {}),
        saved: event.crop_ids.length > 0,
        storage_status: event.storage_status,
        crop_ids: event.crop_ids,
        missing_crop_kinds: event.missing_crop_kinds
      };
      state.lastShadowRecord = record;
      const stats = await getShadowDBStats();
      updateDataCollectionUI(`last=${record.frame_id} idb=${stats.events}/${stats.crops}`);
      return event;
    } catch (e) {
      event.storage_status = SHADOW_STORAGE_STATUS.METADATA_ONLY_PRUNED_STORAGE;
      try { await putShadowEvent(event); } catch (_) {}
      updateDataCollectionUI(`last=${record.frame_id} idb_write=failed`);
      throw e;
    }
  }

  async function migrateLegacyShadowRecords() {
    const records = readLocalShadowRecords();
    state.shadowRecordCount = records.length;
    if (!records.length) {
      state.shadowMigration = { attempted: true, migrated: 0, failed: 0, error: '' };
      updateDataCollectionUI();
      return state.shadowMigration;
    }
    let migrated = 0, failed = 0;
    try {
      for (const rec of records) {
        if (!rec || !rec.frame_id) continue;
        const event = {
          ...rec,
          event_id: eventIdFromRecord(rec),
          schema_version: 2,
          storage_status: SHADOW_STORAGE_STATUS.LEGACY_METADATA_ONLY,
          crop_ids: [],
          missing_crop_kinds: ['stage_badge', 'map', 'ch']
        };
        try {
          await putShadowEvent(event);
          migrated++;
        } catch (e) {
          failed++;
        }
      }
      state.shadowMigration = { attempted: true, migrated, failed, error: failed ? `${failed}_failed` : '' };
      updateDataCollectionUI();
    } catch (e) {
      state.shadowMigration = { attempted: true, migrated, failed, error: String(e?.message || e).slice(0, 80) };
      updateDataCollectionUI();
    }
    return state.shadowMigration;
  }

  function initShadowCollectionStorage() {
    initLocalShadowRecordCount();
    migrateLegacyShadowRecords().catch(e => {
      state.shadowMigration = { attempted: true, migrated: 0, failed: 0, error: String(e?.message || e).slice(0, 80) };
      updateDataCollectionUI();
    });
  }
  async function getAllFromStore(storeName) {
    const db = await ensureShadowDB();
    const tx = db.transaction(storeName, 'readonly');
    const result = await idbRequest(tx.objectStore(storeName).getAll());
    await idbTxDone(tx);
    return result || [];
  }

  async function getShadowDBStats() {
    const db = await ensureShadowDB();
    const tx = db.transaction([SHADOW_STORE_EVENTS, SHADOW_STORE_CROPS, SHADOW_STORE_LABELS, SHADOW_STORE_CANDIDATES], 'readonly');
    const events = await idbRequest(tx.objectStore(SHADOW_STORE_EVENTS).count());
    const crops = await idbRequest(tx.objectStore(SHADOW_STORE_CROPS).count());
    const labels = await idbRequest(tx.objectStore(SHADOW_STORE_LABELS).count());
    const candidates = await idbRequest(tx.objectStore(SHADOW_STORE_CANDIDATES).count());
    await idbTxDone(tx);
    state.shadowDBStats = { events, crops, labels, candidates };
    return state.shadowDBStats;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('blob_read_failed'));
      reader.readAsDataURL(blob);
    });
  }

  async function exportShadowData() {
    const [events, crops, labels, candidates] = await Promise.all([
      getAllFromStore(SHADOW_STORE_EVENTS),
      getAllFromStore(SHADOW_STORE_CROPS),
      getAllFromStore(SHADOW_STORE_LABELS),
      getAllFromStore(SHADOW_STORE_CANDIDATES)
    ]);
    const exportedCrops = [];
    for (const crop of crops) {
      const copy = { ...crop };
      if (copy.blob) {
        copy.data_url = await blobToDataURL(copy.blob);
        delete copy.blob;
      }
      exportedCrops.push(copy);
    }
    const bundle = {
      manifest: {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        db_name: SHADOW_DB_NAME,
        db_version: SHADOW_DB_VERSION,
        origin: location.origin,
        collector_id: getCollectorId(),
        counts: { events: events.length, crops: exportedCrops.length, labels: labels.length, candidates: candidates.length }
      },
      events,
      crops: exportedCrops,
      labels,
      candidates
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
    const collector = shadowKeyPart(getCollectorId(), 40);
    a.href = url;
    a.download = `tosm_shadow_${collector}_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    updateDataCollectionUI(`export=${events.length}/${exportedCrops.length}`);
    return bundle;
  }

  async function runShadowDBSpike() {
    try {
      state.shadowDBStatus = 'testing';
      state.shadowDBError = '';
      updateDataCollectionUI('spike=running');
      const base = buildFrameSampleRecord({});
      const event = {
        ...base,
        event_id: eventIdFromRecord(base),
        schema_version: 2,
        storage_status: 'saved_indexeddb',
        crop_ids: [],
        missing_crop_kinds: [],
        notes: 'indexeddb_spike'
      };
      let lastError = null;
      for (let i = 0; i < 3; i++) {
        try {
          await putShadowEvent(event);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) throw lastError;
      const db = await ensureShadowDB();
      const tx = db.transaction(SHADOW_STORE_EVENTS, 'readonly');
      const readBack = await idbRequest(tx.objectStore(SHADOW_STORE_EVENTS).get(event.event_id));
      await idbTxDone(tx);
      if (!readBack) throw new Error('indexeddb_silent_write_failure');
      const stats = await getShadowDBStats();
      if (!stats.events) throw new Error('indexeddb_stats_zero_after_write');
      state.shadowDBStatus = 'ok';
      state.shadowDBSpikeLayer = 1;
      state.shadowDBError = '';
      updateDataCollectionUI(`spike=ok layer=1 events=${stats.events}`);
      log(`Shadow IndexedDB spike OK: events=${stats.events}`, '#0f0');
      return { layer: 1, stats, event_id: event.event_id };
    } catch (e) {
      state.shadowDBStatus = 'failed';
      state.shadowDBSpikeLayer = 3;
      state.shadowDBError = String(e?.message || e).slice(0, 80);
      updateDataCollectionUI('spike=failed layer=3');
      log(`Shadow IndexedDB spike failed: ${state.shadowDBError}`, '#f33');
      throw e;
    }
  }
  function isLegacyBadgeRectDefault(statusRegion, badgeRect) {
    if (!statusRegion || !badgeRect) return false;
    return badgeRect.x === Math.floor(statusRegion.w * 0.5)
      && badgeRect.y === 0
      && badgeRect.w === Math.ceil(statusRegion.w * 0.5)
      && badgeRect.h === Math.floor(statusRegion.h * 0.5);
  }

  function getBadgeRect(statusRegion) {
    if (state.badgeRect && !isLegacyBadgeRectDefault(statusRegion, state.badgeRect)) return { ...state.badgeRect };
    // v0.9.0: 預設位置改為更靠右上角(原 0.55/0/0.45/0.5 → 0.65/0/0.35/0.4)
    // 這樣比較不會抓到圈圈中央的圖案,而是抓到右上角的計時徽章
    return {
      x: Math.floor(statusRegion.w * 0.65),
      y: 0,
      w: Math.ceil(statusRegion.w * 0.35),
      h: Math.floor(statusRegion.h * 0.4)
    };
  }

  function captureRegionCanvas(region, debugName = 'region') {
    const canvas = document.createElement('canvas');
    const video = document.getElementById('dVideo');
    const requestedW = Math.max(1, Math.round(Number(region?.w) || 0));
    const requestedH = Math.max(1, Math.round(Number(region?.h) || 0));
    canvas.width = requestedW;
    canvas.height = requestedH;
    if (!region || !video || !video.videoWidth || !video.videoHeight) {
      if (state.debugMode) console.warn(DEBUG_PREFIX, `${debugName} ROI skipped: video not ready`, { region });
      return canvas;
    }
    const x = Math.round(Number(region.x) || 0);
    const y = Math.round(Number(region.y) || 0);
    const w = requestedW;
    const h = requestedH;
    const sx = Math.max(0, Math.min(x, video.videoWidth));
    const sy = Math.max(0, Math.min(y, video.videoHeight));
    const sw = Math.max(0, Math.min(w, video.videoWidth - sx));
    const sh = Math.max(0, Math.min(h, video.videoHeight - sy));
    if (sw <= 0 || sh <= 0) {
      if (state.debugMode) console.warn(DEBUG_PREFIX, `${debugName} ROI outside video`, { region, videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      return canvas;
    }
    canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
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

  // ═══ 擷取徽章 ═══
  function captureBadgeCanvas(region) {
    if (state.calibration && state.calibration.timing) {
      return captureBadgeFromCalibration();
    }
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

  function captureBadgeFromCalibration() {
    const cal = state.calibration.timing;
    const region = cal.region;
    const ringX = region.x + region.w * cal.ringCenterRatio.x;
    const ringY = region.y + region.h * cal.ringCenterRatio.y;
    const ringR = region.w * cal.ringRadiusRatio;
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

  function updateCalibStatus() {
    const el = document.getElementById('dCalibStatus');
    if (!el) return;
    // v0.9.0: 紅環校準 UI 已移除,只在有歷史校準資料時顯示提示
    if (!state.calibration || !state.calibration.timing) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    el.innerHTML = `<span style="color:#888">📌 使用歷史校準擷取(來自舊版校準)</span>`;
  }

  // v0.8.0: 顯示公告偵測狀態
  function updateAnnStatus() {
    const el = document.getElementById('dAnnStatus');
    if (!el) return;
    if (!state.regions.announcement) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'block';
    const stable = getStableAnnouncement();
    if (stable) {
      el.innerHTML = `📢 公告:<b>${stable.phase}</b> @${(stable.confidence*100).toFixed(0)}% (${stable.voteCount}/${stable.windowSize})`;
      el.style.color = '#0f0';
    } else if (state.announcementHistory.length > 0) {
      const recent = state.announcementHistory.slice(-3).map(a => a.phase || '?').join(',');
      el.innerHTML = `📢 公告累積中 [${recent}]`;
      el.style.color = '#888';
    } else {
      el.innerHTML = `📢 公告區已設定,等待擷取`;
      el.style.color = '#888';
    }
  }


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
          <div>模式:<b>${t.mode === 'auto' ? '✨ 自動' : '⚠️ 手動'}</b></div>
          <div>紅環中心比例:(${(t.ringCenterRatio.x*100).toFixed(1)}%, ${(t.ringCenterRatio.y*100).toFixed(1)}%)</div>
          <div>紅環半徑比例:${(t.ringRadiusRatio*100).toFixed(1)}%</div>
          <div>校準時間:${new Date(t.calibratedAt).toLocaleString('zh-TW')}</div>
          <div class="calib-actions">
            <button class="dbtn red" onclick="window.__detector.resetCalibration()">🗑 清除校準</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = `
      ${currentInfo}
      <div class="calib-step active">
        <h4>📐 步驟 1:框選計時圈</h4>
        <div style="line-height:1.7">
          請框選遊戲畫面右上方的「<b>計時圈完整區域</b>」<br>
          ─ 包含 <span style="color:#f33">紅環</span>+<span style="color:#0af">徽章</span>(On / R1 / R2 等文字)<br>
          ─ 範圍可以稍微大一點(系統會自動偵測精確位置)
        </div>
        <div class="calib-actions">
          ${hasRegion
            ? `<button class="dbtn" onclick="window.__detector.startCalibFrameSelect()">🎯 開始框選</button>
               <span style="font-size:11px;color:#888">(之前框過 status,校準會覆蓋它)</span>`
            : `<span style="color:#fa0">⚠️ 請先開啟擷取,再回來校準</span>`
          }
        </div>
      </div>
      <div class="calib-step" style="opacity:0.5">
        <h4>📐 步驟 2:自動偵測紅環</h4>
        <div>系統會在框內偵測紅環中心和半徑(10 次取樣,取中位數)</div>
      </div>
      <div class="calib-step" style="opacity:0.5">
        <h4>📐 步驟 3:套用比例</h4>
        <div>用紅環中心+半徑算出徽章位置,之後就用這個比例擷取</div>
      </div>
    `;
  }

  function renderCalibFailure(reason) {
    const body = document.getElementById('dCalibBody');
    body.innerHTML = `
      <div class="calib-step active" style="border-color:#f33">
        <h4 style="color:#f33">❌ 紅環偵測失敗</h4>
        <div>原因:${reason}</div>
        <div style="margin-top:8px;color:#888;font-size:11px">
          可能的解決方式:<br>
          1. 確認遊戲畫面中目前有可見的紅環(王重生倒數中)<br>
          2. 重新框選,包含整個紅環<br>
          3. 跳過校準,使用預設比例(之後可手動調整)
        </div>
        <div class="calib-actions">
          <button class="dbtn" onclick="window.__detector.restartCalibration()">🔄 重新校準</button>
          <button class="dbtn gray" onclick="window.__detector.skipCalibration()">⏭️ 跳過(手動模式)</button>
        </div>
      </div>
    `;
  }

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
            <div style="color:#888;font-size:11px;margin-bottom:4px">擷取出的徽章區(標準化 32×32)</div>
            <canvas class="calib-canvas" id="dCalibBadge" style="max-width:128px;width:128px;height:128px"></canvas>
          </div>
        </div>
        <div style="margin-top:10px">
          <div class="stab-row">${cxStable} 圓心 X 穩定度:std ${stab.cxStd.toFixed(2)}</div>
          <div class="stab-row">${cyStable} 圓心 Y 穩定度:std ${stab.cyStd.toFixed(2)}</div>
          <div class="stab-row">${rStable} 半徑穩定度:std ${stab.rStd.toFixed(2)}</div>
          <div class="stab-row">圓擬合度:${(stab.confidence*100).toFixed(0)}%</div>
        </div>
        <div style="margin-top:8px;padding:6px;background:${allStable ? 'rgba(0,255,0,0.1)' : 'rgba(255,170,0,0.1)'};border-radius:4px;font-size:11px">
          ${allStable
            ? '<span style="color:#0f0">✅ 校準品質良好!</span>'
            : '<span style="color:#fa0">⚠️ 偵測有些晃動,建議畫面靜止後重試。也可以直接套用,效果通常還是比手動好。</span>'}
        </div>
        <div class="calib-actions">
          <button class="dbtn" onclick="window.__detector.confirmAutoCalibration()">✅ 套用此校準</button>
          <button class="dbtn gray" onclick="window.__detector.restartCalibration()">🔄 重新框選</button>
          <button class="dbtn gray" onclick="window.__detector.skipCalibration()">⏭️ 跳過(手動模式)</button>
        </div>
      </div>
    `;

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

  function enterCalibFrameMode() {
    state._calibrating = true;
    setMode('status');
    log('📐 校準中:請在影片上框選計時圈完整區域', '#08f');
    showCalibInstructions();
  }

  function setMode(mode) {
    state.currentMode = mode;
    document.querySelectorAll('#detectorPanel .mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }

  function showCalibInstructions() {
    let hint = document.getElementById('dCalibHint');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = 'dCalibHint';
      hint.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#08f;color:#fff;padding:8px 16px;border-radius:6px;z-index:10001;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.5)';
      document.body.appendChild(hint);
    }
    hint.innerHTML = '📐 校準中:請框選遊戲畫面的<b>計時圈</b>區域 <button onclick="window.__detector.cancelCalibFrame()" style="margin-left:10px;background:none;border:1px solid #fff;color:#fff;padding:2px 8px;border-radius:3px;cursor:pointer">取消</button>';
    hint.style.display = 'block';
  }

  function hideCalibInstructions() {
    const hint = document.getElementById('dCalibHint');
    if (hint) hint.style.display = 'none';
  }

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
      return { success: false, reason: '無法偵測到紅環(請確認當前畫面有紅環)' };
    }

    const sortBy = (key) => results.slice().sort((a, b) => a[key] - b[key]);
    const median = (arr, key) => arr[Math.floor(arr.length / 2)][key];
    const cxMed = median(sortBy('centerX'), 'centerX');
    const cyMed = median(sortBy('centerY'), 'centerY');
    const rMed = median(sortBy('radius'), 'radius');

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

  function captureChCanvas(region) {
    return captureRegionCanvas(region, 'ch');
  }

  // ═══════════════════════════════════════════════
  // 紅環偵測(RANSAC)
  // ═══════════════════════════════════════════════

  function circleFrom3Points(p1, p2, p3) {
    const ax = p1.x, ay = p1.y;
    const bx = p2.x, by = p2.y;
    const cx = p3.x, cy = p3.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-3) return null;
    const ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / d;
    const uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / d;
    const r = Math.sqrt((ax - ux) ** 2 + (ay - uy) ** 2);
    return { centerX: ux, centerY: uy, radius: r };
  }

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
      return { found: false, reason: '紅色像素太少(<20)。試試降低紅色門檻', redPixels: redPixels.length };
    }

    let circle, inliers = redPixels;
    if (useRansac) {
      const ransac = ransacCircle(redPixels, {
        iterations: 200,
        tolerance: 2,
        minRadius: Math.min(region.w, region.h) * 0.15,
        maxRadius: Math.min(region.w, region.h) * 0.45
      });
      if (!ransac) {
        return { found: false, reason: 'RANSAC 找不到合適的圓(紅環可能被雜訊淹沒)', redPixels: redPixels.length };
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

    // v0.9.0: 移除 dDebugCanvas 視覺化(留 metrics 計算即可)
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
        if (isRed) redCount++;
        if (isBrightWhite) whiteCount++;
        if (x >= badgeX1 && x < badgeX2 && y >= badgeY1 && y < badgeY2) {
          badgeTotalPx++;
          if (isBrightWhite) badgeWhiteCount++;
        }
      }
    }
    return {
      redRatio: redCount / n,
      whiteRatio: whiteCount / n,
      badgeWhiteRatio: badgeTotalPx > 0 ? badgeWhiteCount / badgeTotalPx : 0,
      avgTotalBright: totalBright / n
    };
  }

  // Horizontal-only morphological dilation: thickens vertical strokes so
  // feature-poor glyphs ("1" — single thin stem, no foot, no flag) gain
  // enough horizontal mass for the LSTM to anchor. Used only by
  // ocrBadgeFallback (badge-isolated; no map / ch leak).
  function dilateHorizontal(canvas, radius = 2) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const inCtx = canvas.getContext('2d');
    const outCtx = out.getContext('2d');
    const inImg = inCtx.getImageData(0, 0, canvas.width, canvas.height);
    const outImg = outCtx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        let v = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= canvas.width) continue;
          v = Math.max(v, inImg.data[(y * canvas.width + nx) * 4]);
        }
        const i = (y * canvas.width + x) * 4;
        outImg.data[i] = outImg.data[i+1] = outImg.data[i+2] = v;
        outImg.data[i+3] = 255;
      }
    }
    outCtx.putImageData(outImg, 0, 0);
    return out;
  }

  async function ocrBadgeFallback(badgeCanvas) {
    const passes = [
      { preprocess: (s) => extractBrightPixels(upscale(s, 8), 180) },
      { preprocess: (s) => extractBrightPixels(upscale(s, 8), 210) },
      { preprocess: (s) => preprocessForOCR(s, { scale: 8 }) },
      { preprocess: (s) => preprocessForOCR(s, { scale: 8, invert: true }) },
      { preprocess: (s) => dilateHorizontal(extractBrightPixels(upscale(s, 8), 180), 3) },
      { preprocess: (s) => dilateHorizontal(preprocessForOCR(s, { scale: 8 }), 2) }
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
  // ═══ v0.7.1 階段偵測:模板比對為主,加入拒答機制 ═══
  async function detectPhase(region) {
    const metrics = analyzeStatusMetrics(region);
    const badgeCanvas = captureBadgeCanvas(region);
    state.lastBadgeCanvas = badgeCanvas;

    const templateMatch = await TemplateDB.match('phase', badgeCanvas);

    if (state.debugMode) {
      console.log(DEBUG_PREFIX, 'detectPhase', {
        metrics,
        template: templateMatch
      });
    }

    // 【情境 1】模板匹配超高信心 + 沒有拒答
    if (templateMatch && templateMatch.similarity >= TEMPLATE_MIN_SIM
        && !templateMatch.rejection) {
      return {
        phase: templateMatch.label,
        confidence: templateMatch.similarity,
        metrics,
        source: 'template',
        templateMatch
      };
    }

    // 【新增情境】明確拒答 → 直接回 UNKNOWN,不做 OCR fallback
    // 因為 OCR 在低信心情境下也不可靠,硬上會把不確定變成確定錯
    if (templateMatch && templateMatch.rejection) {
      if (state.debugMode) {
        console.log(DEBUG_PREFIX, '階段拒答:', templateMatch.rejection);
      }
      return {
        phase: 'UNKNOWN',
        confidence: 0,
        metrics,
        source: 'rejected:' + templateMatch.rejection.reason,
        templateMatch
      };
    }

    // 【情境 2】無模板 → OCR fallback
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

    // 【情境 4】模板不確定,但 OCR 有結果
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

    // 【情境 5】模板有一定信心(雖未達 0.92,但達 0.85)
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
    const src = captureRegionCanvas(region, 'ocr');
    if (targetCanvas) {
      targetCanvas.width = src.width; targetCanvas.height = src.height;
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

  // ═══ v0.7.1 分流偵測:加入拒答機制 ═══
  async function detectCh(region) {
    const chCanvas = captureChCanvas(region);
    state.lastChCanvas = chCanvas;

    const templateMatch = await TemplateDB.match('ch', chCanvas);

    const debugCh = document.getElementById('dCanCh');
    if (debugCh) {
      debugCh.width = chCanvas.width;
      debugCh.height = chCanvas.height;
      debugCh.getContext('2d').drawImage(chCanvas, 0, 0);
    }

    // 高信心 + 未拒答
    if (templateMatch && templateMatch.similarity >= TEMPLATE_MIN_SIM
        && !templateMatch.rejection) {
      return {
        ch: templateMatch.label,
        confidence: templateMatch.similarity,
        source: 'template',
        templateMatch,
        raw: ''
      };
    }

    // 明確拒答 → ch=null,不做 OCR
    if (templateMatch && templateMatch.rejection) {
      if (state.debugMode) {
        console.log(DEBUG_PREFIX, '分流拒答:', templateMatch.rejection);
      }
      return {
        ch: null,
        confidence: 0,
        source: 'rejected:' + templateMatch.rejection.reason,
        templateMatch,
        raw: ''
      };
    }

    // OCR fallback
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

  // ═══════════════════════════════════════════════
  // v0.8.0 公告 OCR 與雙信號融合
  // ═══════════════════════════════════════════════

  // 從中央公告區擷取並 OCR,辨識「警戒提升至 X 階段」等文字
  async function detectAnnouncement(region) {
    if (!region) return null;
    const canvas = document.createElement('canvas');
    canvas.width = region.w;
    canvas.height = region.h;
    const video = document.getElementById('dVideo');
    if (!video || !video.videoWidth) return null;
    canvas.getContext('2d').drawImage(video,
      region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
    state.lastAnnouncementCanvas = canvas;

    // 公告字體可能是紅或白,做兩次 OCR(原色 + 反色)取較好結果
    let bestText = '', bestConf = 0;
    const variants = [
      { invert: false, scale: 3 },
      { invert: true, scale: 3 }
    ];
    for (const v of variants) {
      try {
        const proc = preprocessForOCR(canvas, { scale: v.scale, invert: v.invert });
        const { data } = await Tesseract.recognize(proc, 'chi_tra+eng', {
          logger: () => {},
          tessedit_pageseg_mode: '6'
        });
        const text = (data.text || '').replace(/\s+/g, '');
        const conf = data.confidence / 100;
        if (conf > bestConf || (conf === bestConf && text.length > bestText.length)) {
          bestText = text;
          bestConf = conf;
        }
      } catch (e) {}
    }

    return parseAnnouncementText(bestText, bestConf);
  }

  // 從 OCR 文字解析出階段
  function parseAnnouncementText(text, ocrConf) {
    const raw = text || '';
    if (!raw) return { phase: null, confidence: 0, raw, time: Date.now() };

    // 「警戒提升至 X 階段」、「憤怒提升至 X 階段」、單純「X階段」
    let m = raw.match(/(?:警戒|憤怒|慎怒|提升|升)[^1-4]{0,8}([1-4])[^階段]{0,3}階段/);
    if (!m) m = raw.match(/([1-4])\s*階\s*段/);
    if (!m) m = raw.match(/階段\s*([1-4])/);
    if (m) {
      return {
        phase: 'R' + m[1],
        confidence: Math.max(ocrConf, 0.85),  // 文字命中 → 高信心
        raw, time: Date.now()
      };
    }

    // ON / 復活 / 出現
    if (/(?:^|[^A-Z])ON(?:[^A-Z]|$)|復活|出現|甦醒/i.test(raw)) {
      return { phase: 'ON', confidence: Math.max(ocrConf, 0.75), raw, time: Date.now() };
    }

    return { phase: null, confidence: 0, raw, time: Date.now() };
  }

  // 把單次公告結果加入滑動視窗
  function pushAnnouncement(annResult) {
    if (!annResult) return;
    state.announcementHistory.push(annResult);
    while (state.announcementHistory.length > ANNOUNCEMENT_HISTORY_SIZE) {
      state.announcementHistory.shift();
    }
  }

  // 從滑動視窗取得「強信號」(多數決 + TTL)
  function getStableAnnouncement() {
    const now = Date.now();
    const fresh = state.announcementHistory.filter(a =>
      a && a.phase && a.confidence >= ANNOUNCEMENT_MIN_CONF
      && (now - a.time) < ANNOUNCEMENT_TTL_MS
    );
    if (fresh.length < ANNOUNCEMENT_VOTE_MIN) return null;

    // 多數決
    const votes = {};
    for (const a of fresh) {
      votes[a.phase] = (votes[a.phase] || 0) + 1;
    }
    let bestPhase = null, bestVotes = 0;
    for (const [phase, count] of Object.entries(votes)) {
      if (count > bestVotes) { bestPhase = phase; bestVotes = count; }
    }
    if (bestVotes < ANNOUNCEMENT_VOTE_MIN) return null;

    // 信心 = 該 phase 在視窗內的平均信心
    const matching = fresh.filter(a => a.phase === bestPhase);
    const avgConf = matching.reduce((s, a) => s + a.confidence, 0) / matching.length;
    return {
      phase: bestPhase,
      confidence: avgConf,
      voteCount: bestVotes,
      windowSize: fresh.length,
      raw: matching[matching.length - 1].raw  // 最新一筆原文
    };
  }

  // 兩信號融合決策
  function fuseDualSignals(templatePhase, templateMatch, announcement) {
    // templatePhase: 'R1'/'R2'/.../'ON'/'WAITING'/'UNKNOWN'/null
    // templateMatch: TemplateDB.match 回傳的物件(可能含 rejection)
    // announcement: getStableAnnouncement() 回傳的物件(可能 null)

    const hasTemplateMatch = !!templateMatch && typeof templateMatch.similarity === 'number';
    const tplOk = hasTemplateMatch && templatePhase && templatePhase !== 'UNKNOWN' && !templateMatch.rejection;
    const tplRejected = hasTemplateMatch && !!templateMatch.rejection;
    const annOk = !!announcement;

    // 全新瀏覽器/無模板資料時,detectPhase 可能 fallback 出 WAITING,但那不是模板信號。
    // 為了 precision 優先,無模板且無穩定公告時拒答,不要把 fallback 當成可送出的階段。
    if (!hasTemplateMatch) {
      if (annOk) {
        return {
          phase: announcement.phase,
          confidence: announcement.confidence * 0.8,
          source: 'announcement(no-template)',
          detail: {
            annConf: announcement.confidence,
            annVotes: `${announcement.voteCount}/${announcement.windowSize}`
          }
        };
      }
      return {
        phase: 'UNKNOWN',
        confidence: 0,
        source: 'rejected:no_template_match',
        detail: { templatePhase: templatePhase || null }
      };
    }

    // Case A: 兩信號都有 + 一致 → 高信心採信(信心增益)
    if (tplOk && annOk && templatePhase === announcement.phase) {
      return {
        phase: templatePhase,
        confidence: Math.min(0.99, Math.max(templateMatch.similarity, announcement.confidence) + 0.05),
        source: 'template+announcement',
        detail: { templateSim: templateMatch.similarity, annConf: announcement.confidence }
      };
    }

    // Case B: 兩信號都有 + 衝突 → UNKNOWN
    if (tplOk && annOk && templatePhase !== announcement.phase) {
      return {
        phase: 'UNKNOWN', confidence: 0,
        source: 'rejected:signal_conflict',
        detail: {
          templatePhase, templateSim: templateMatch.similarity,
          annPhase: announcement.phase, annConf: announcement.confidence
        }
      };
    }

    // Case C: 模板通過 + 公告無 → 採信模板(等同 v0.7.1 行為)
    if (tplOk && !annOk) {
      return {
        phase: templatePhase,
        confidence: templateMatch.similarity,
        source: 'template',
        detail: { templateSim: templateMatch.similarity }
      };
    }

    // Case D: 模板拒答 + 公告強信號 → 採信公告(信心打折)
    if (tplRejected && annOk) {
      return {
        phase: announcement.phase,
        confidence: announcement.confidence * 0.85,
        source: 'announcement(template-rejected)',
        detail: {
          rejection: templateMatch.rejection,
          annConf: announcement.confidence,
          annVotes: `${announcement.voteCount}/${announcement.windowSize}`
        }
      };
    }

    // Case E: 模板拒答 + 公告無 → UNKNOWN(等同 v0.7.1 行為)
    if (tplRejected && !annOk) {
      return {
        phase: 'UNKNOWN', confidence: 0,
        source: 'rejected:' + templateMatch.rejection.reason,
        detail: { rejection: templateMatch.rejection }
      };
    }

    // Case F: 模板低信心(0.85~0.92 區間) + 公告通過且一致 → 信公告(信心提升)
    // 註:模板通過 + 公告衝突的情況,前面 Case B 已攔截;此處只處理一致情境
    if (templatePhase && annOk && templateMatch?.similarity >= TEMPLATE_AMBIGUOUS
        && templatePhase === announcement.phase) {
      return {
        phase: announcement.phase,
        confidence: Math.max(templateMatch.similarity, announcement.confidence),
        source: 'template-low+announcement',
        detail: { templateSim: templateMatch.similarity, annConf: announcement.confidence }
      };
    }

    // Case G: 其他(包含 WAITING)→ 沿用 templatePhase
    return {
      phase: templatePhase || 'UNKNOWN',
      confidence: templateMatch?.similarity || 0,
      source: 'template-fallback',
      detail: {}
    };
  }

  // ═══ 狀態轉移約束 ═══
  function isAllowedTransition(currentPhase, newPhase) {
    // 沒有當前狀態 → 任何新狀態都允許
    if (!currentPhase) return true;
    // 相同狀態 → 允許(會被冷卻機制擋,不在這層處理)
    if (currentPhase === newPhase) return true;
    // 不在 rank 表的階段(例:UNKNOWN)→ 允許,讓上層判斷
    const a = STAGE_RANK[currentPhase];
    const b = STAGE_RANK[newPhase];
    if (a === undefined || b === undefined) return true;
    // ON 之後只能進 WAITING(即重生倒數結束 → 重新計時)
    if (currentPhase === 'ON') return newPhase === 'WAITING';
    // 其餘只能單調遞進(WAITING → R1 → R2 → R3 → R4 → ON)
    return b >= a;
  }

  // 從 window.currentData 讀回某 boss 的當前狀態
  function readCurrentBossState(map, ch) {
    if (!map || !ch) return null;
    if (typeof window.currentData !== 'object' || !window.currentData) return null;
    const id = `${map}_${ch}`;
    const b = window.currentData[id];
    if (!b) return null;
    // 嘗試從 lastInput 解析(主程式格式)
    const input = String(b.lastInput || '').toUpperCase();
    if (input === 'ON') return 'ON';
    if (input.startsWith('XX') || input.startsWith('DE') || input === 'WAITING') return 'WAITING';
    const r = input.match(/^R([1-4])/);
    if (r) return 'R' + r[1];
    // 退而求其次,從 displayValue 解析
    const dv = String(b.displayValue || '').toUpperCase();
    if (dv === 'ON') return 'ON';
    const dvr = dv.match(/階段\s*([1-4])|R([1-4])/);
    if (dvr) return 'R' + (dvr[1] || dvr[2]);
    return null;
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
      .then(() => log(`🎓 已貢獻:「${ocrRaw}」= ${correctCode}`, '#ff0'))
      .catch(e => log('❌ 貢獻失敗:' + e.message, '#f33'));
  }

  function getMainVolume() {
    if (state.muted) return 0;
    const slider = document.querySelector('#volRange, input.vol-range');
    if (slider) {
      const val = parseFloat(slider.value);
      return parseFloat(slider.max) > 10 ? val / 100 : val;
    }
    return 0.5;
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
    btn.title = '螢幕偵測 v0.7.1';
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
      #detectorPanel .panel-ctrl-btn.training {
        color: #fa0; border-color: #fa0;
        background: rgba(255, 170, 0, 0.15);
        box-shadow: 0 0 5px rgba(255, 170, 0, 0.4);
      }
      body.light #detectorPanel .panel-ctrl-btn.training {
        color: #c87c00; border-color: #c87c00;
        background: rgba(200, 124, 0, 0.15);
      }
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
      #detectorPanel .region.announcement { border-color: #08f; }
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
      #dBadgeEditBox .handle.tl { top: -5px; left: -5px; cursor: nw-resize; }
      #dBadgeEditBox .handle.tr { top: -5px; right: -5px; cursor: ne-resize; }
      #dBadgeEditBox .handle.bl { bottom: -5px; left: -5px; cursor: sw-resize; }
      #dBadgeEditBox .handle.br { bottom: -5px; right: -5px; cursor: se-resize; }
      #dBadgeEditBox::after {
        content: '徽章'; position: absolute; top: 2px; left: 4px;
        color: #f80; font-size: 10px; font-weight: bold;
        text-shadow: 1px 1px 2px #000;
      }

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
        <h3>📷 偵測器 <span class="small">v0.9.1</span></h3>
        <div>
          <button class="panel-ctrl-btn" id="dTrainToggle" title="訓練模式:只存模板不送 Firebase">🎯</button>
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
              <button class="dbtn blue" id="dMiniCalibrate" title="切換至完整模式並打開徽章微調">🎯 徽章微調</button>
            </div>
            <div id="dCalibStatus" style="font-size:10px;text-align:center;margin-top:4px;color:#888;display:none"></div>
            <div id="dAnnStatus" style="font-size:10px;text-align:center;margin-top:2px;color:#08f;display:none"></div>
          </div>
          <div class="sec" style="padding:6px;border:1px solid #08f;background:rgba(0,136,255,0.05)">
            <div class="mini-tpl-header" id="dMiniPreviewHeader" style="color:#08f">
              <span class="collapse-arrow" id="dMiniPreviewArrow">▼</span>
              <span>📸 擷取預覽</span>
              <span class="small" id="dMiniPreviewStatus" style="margin-left:auto;color:#888">閒置</span>
            </div>
            <div id="dMiniPreviewBody" style="margin-top:6px">
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

          <div class="sec learn" style="padding:6px">
            <div class="mini-tpl-header" id="dMiniTplHeader">
              <span class="collapse-arrow" id="dMiniTplArrow">▼</span>
              <span>🧠 模板庫</span>
              <span class="small" id="dMiniTplTotal" style="margin-left:auto"></span>
            </div>
            <div id="dMiniTplBody" style="margin-top:6px">
              <div class="small" style="color:#fa0">階段:</div>
              <div class="tpl-stats-mini" id="dMiniTplPhase"></div>
              <div class="small" style="color:#fa0;margin-top:4px">分流:</div>
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
            <button class="mode-btn" data-mode="announcement">📢 公告(選填)</button>
            <button class="mode-btn" data-mode="none">✋ 停</button>
            <div class="tip-box">💡 狀態圖示框整個圓圈(含右上徽章)<br>📢 公告區(選填):框畫面中央會跳「警戒提升至 X 階段」字樣的位置,有框會啟用雙信號融合,沒框則維持單一徽章判定</div>
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
                <div class="region announcement" id="dBoxAnnouncement" style="display:none">📢公告</div>
              </div>
            </div>
          </div>

          <div class="sec" id="dBadgeSection" style="display:none">
            <div style="margin-bottom:6px"><b>🎯 徽章範圍微調</b>
              <button class="dbtn gray" onclick="window.__detector.resetBadge()" style="padding:2px 6px;font-size:10px;float:right">重設</button>
            </div>
            <div class="small">拖曳橘框調整位置,拖曳四角調整大小</div>
            <div id="dBadgeEditor">
              <canvas id="dBadgeEditCanvas"></canvas>
              <div id="dBadgeEditBox">
                <div class="handle tl"></div>
                <div class="handle tr"></div>
                <div class="handle bl"></div>
                <div class="handle br"></div>
              </div>
            </div>
            <div id="dBadgeCapturePreview" style="display:flex;gap:8px;align-items:center;margin-top:6px;padding:6px;background:#0a0a0a;border:1px solid #08f;border-radius:4px">
              <canvas id="dBadgeCaptureCanvas" style="width:64px;height:64px;image-rendering:pixelated;border:1px solid #555;background:#000;object-fit:contain"></canvas>
              <div style="flex:1">
                <div class="small" style="color:#08f;font-weight:bold">📸 實際擷取(將存為模板的範圍)</div>
                <div class="small" id="dBadgeCaptureInfo" style="font-family:monospace"></div>
              </div>
            </div>
            <div class="small" id="dBadgeInfo" style="margin-top:4px;font-family:monospace"></div>
          </div>

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
            <div class="small" style="color:#fa0">階段模板:</div>
            <div class="tpl-stats" id="dTplPhase"></div>
            <div class="small" style="color:#fa0;margin-top:4px">分流模板:</div>
            <div class="tpl-stats" id="dTplCh"></div>

            <div class="tpl-preview" id="dTplPreview" style="display:none">
              <canvas id="dTplCanvas"></canvas>
              <div style="flex:1">
                <div class="small">當前偵測到的圖片,可標記為模板:</div>
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


          <div class="sec" id="dDataCollectionSec">
            <div style="margin-bottom:6px"><b>Shadow Data</b> <span class="small">metadata only / no Firebase submit</span></div>
            <div class="correction-row">
              <input type="text" id="dCollectorId" placeholder="collector_id" style="flex:1">
              <button class="dbtn gray" id="dSaveCollectorId" style="padding:3px 8px;font-size:10px">Save</button>
            </div>
            <div class="correction-row" style="margin-top:4px">
              <button class="dbtn gray" id="dTestShadowDB" style="padding:3px 8px;font-size:10px">Test DB</button>
              <button class="dbtn gray" id="dExportShadowData" style="padding:3px 8px;font-size:10px">Export</button>
            </div>
            <div class="small" id="dDataCollectionStatus" style="margin-top:4px;font-family:monospace">config=loading</div>
          </div>
          <div class="sec important">
            <div style="margin-bottom:6px"><b>② 偵測設定</b></div>
            <div class="threshold-row">
              <label>間隔 <input type="number" id="dInterval" value="3000" style="width:55px">ms</label>
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

    bindEvents();
    initLearning();
    initShadowCollectionStorage();
    loadDetectorConfig();
    loadPanelPos();
    loadMuteState();
    loadTrainModeState();
    loadCalibration();
    updateCalibStatus();
    updateAnnStatus();
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
    el.innerHTML = `📚 共 <b style="color:#0f0">${total}</b> 筆(內建 ${builtin} + 貢獻 ${custom})`;
  }

  function updateTplDisplay() {
    const stats = TemplateDB.getStats();
    const phaseLabels = ['R1','R2','R3','R4','ON','WAITING'];

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

    const totalEl = document.getElementById('dTplTotal');
    const miniTotalEl = document.getElementById('dMiniTplTotal');
    const phaseTotal = Object.values(stats.phase).reduce((s, n) => s + n, 0);
    const chTotal = Object.values(stats.ch).reduce((s, n) => s + n, 0);
    const kb = (stats.totalSize / 1024).toFixed(1);
    if (totalEl) totalEl.textContent = `(階段 ${phaseTotal} + 分流 ${chTotal},約 ${kb} KB)`;
    if (miniTotalEl) miniTotalEl.textContent = `${phaseTotal}+${chTotal}`;

    refreshBrowseLabels();
  }

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

  function updateMiniPreview(mapRegion) {
    const badgeCan = document.getElementById('dMiniPrevBadge');
    if (badgeCan && state.lastBadgeCanvas) {
      badgeCan.width = state.lastBadgeCanvas.width;
      badgeCan.height = state.lastBadgeCanvas.height;
      const ctx = badgeCan.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(state.lastBadgeCanvas, 0, 0);
    }
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
    for (const k of ['status', 'map', 'ch', 'announcement']) {
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
    updateBadgeCapturePreview();
  }

  function updateBadgeCapturePreview() {
    const region = state.regions.status;
    if (!region) return;
    const video = document.getElementById('dVideo');
    if (!video || !video.videoWidth) return;
    const captureCan = document.getElementById('dBadgeCaptureCanvas');
    const infoEl = document.getElementById('dBadgeCaptureInfo');
    if (!captureCan) return;

    if (state.calibration && state.calibration.timing) {
      const cap = captureBadgeFromCalibration();
      captureCan.width = cap.width;
      captureCan.height = cap.height;
      captureCan.getContext('2d').drawImage(cap, 0, 0);
      if (infoEl) {
        const t = state.calibration.timing;
        infoEl.innerHTML = `<span style="color:#0f0">✨ 校準擷取</span> ${cap.width}×${cap.height}px｜模式:${t.mode === 'auto' ? '自動' : '手動'}`;
      }
      return;
    }

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
    if (el) el.textContent = `徽章:(${badge.x}, ${badge.y}) ${badge.w}×${badge.h} / 圖示 ${region.w}×${region.h}`;
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
    btn.title = state.muted ? '已靜音(點擊取消)' : '開啟中(點擊靜音)';
    btn.classList.toggle('muted', state.muted);
  }

  function loadMuteState() {
    const s = localStorage.getItem('tosm_detector_muted');
    state.muted = s === '1';
    updateMuteUI();
  }

  function updateTrainModeUI() {
    const btn = document.getElementById('dTrainToggle');
    const panel = document.getElementById('detectorPanel');
    if (!btn || !panel) return;
    btn.classList.toggle('training', state.trainingMode);
    panel.classList.toggle('training-mode', state.trainingMode);
    btn.title = state.trainingMode
      ? '訓練模式中(點擊切回一般模式)'
      : '點擊進入訓練模式(只存模板不送 Firebase)';
  }

  function loadTrainModeState() {
    const s = localStorage.getItem('tosm_detector_training_mode');
    state.trainingMode = s === '1';
    updateTrainModeUI();
  }

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
    const redMin = parseInt(document.getElementById('dDiagRedMin')?.value) || 150;
    const redDom = parseInt(document.getElementById('dDiagRedDom')?.value) || 60;
    const offsetRatio = parseFloat(document.getElementById('dDiagOffsetRatio')?.value) || 0.95;
    const sizeRatio = parseFloat(document.getElementById('dDiagSizeRatio')?.value) || 0.65;

    const ring = detectRedRing(region, { redThreshold: redMin, redDominance: redDom });

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

    if (ring && ring.found) {
      const annoData = aCtx.getImageData(0, 0, annoCan.width, annoCan.height);
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

      aCtx.fillStyle = '#f00';
      aCtx.beginPath();
      aCtx.arc(ring.centerX * displayScale, ring.centerY * displayScale, 5, 0, Math.PI * 2);
      aCtx.fill();

      aCtx.strokeStyle = '#ff0';
      aCtx.lineWidth = 2;
      aCtx.beginPath();
      aCtx.arc(ring.centerX * displayScale, ring.centerY * displayScale, ring.radius * displayScale, 0, Math.PI * 2);
      aCtx.stroke();

      const badge = deriveBadgeFromRing(ring, { offsetRatio, sizeRatio });
      if (badge) {
        aCtx.strokeStyle = '#0af';
        aCtx.lineWidth = 3;
        aCtx.strokeRect(
          badge.x * displayScale,
          badge.y * displayScale,
          badge.w * displayScale,
          badge.h * displayScale
        );
        aCtx.fillStyle = '#0af';
        aCtx.beginPath();
        aCtx.arc(badge.centerX * displayScale, badge.centerY * displayScale, 4, 0, Math.PI * 2);
        aCtx.fill();
      }

      const conf = (ring.confidence * 100).toFixed(0);
      const confColor = ring.confidence > 0.7 ? '#0f0' : ring.confidence > 0.4 ? '#fa0' : '#f33';
      const inlierRatio = ((ring.filteredCount / ring.redPixelCount) * 100).toFixed(0);
      document.getElementById('dDiagResult').innerHTML = `
        <div style="color:#0f0">✅ 找到紅環</div>
        <div>圓心:(${ring.centerX.toFixed(2)}, ${ring.centerY.toFixed(2)})</div>
        <div>半徑:${ring.radius.toFixed(2)} px</div>
        <div>紅色像素:${ring.redPixelCount}(其中 <b style="color:#0f0">${ring.filteredCount}</b> 在圓周上=${inlierRatio}%)</div>
        <div>擬合平均誤差:${ring.meanErr.toFixed(2)} px</div>
        <div>圓擬合度:<span style="color:${confColor};font-weight:bold">${conf}%</span></div>
        ${badge ? `
          <div style="margin-top:6px;color:#0af">📐 推導徽章:</div>
          <div>位置:(${badge.x}, ${badge.y}) ${badge.w}×${badge.h}px</div>
        ` : ''}
        <div class="small" style="margin-top:6px;color:#666">🟢綠=紅環點 / ⚫灰=被排除的雜訊(王身上的紅、背景)</div>
      `;

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
        <div>原因:${ring ? ring.reason : '未知'}</div>
        <div>紅色像素:${ring ? ring.redPixels : 0}</div>
        <div style="color:#888;margin-top:4px">建議:拉低「R 最低」門檻試試(進階參數)</div>
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

    const cxStable = cxs.std < 1 ? '🟢' : cxs.std < 3 ? '🟡' : '🔴';
    const cyStable = cys.std < 1 ? '🟢' : cys.std < 3 ? '🟡' : '🔴';
    const rStable = rs.std < 1 ? '🟢' : rs.std < 2 ? '🟡' : '🔴';

    el.innerHTML = `
      <div>樣本:${state.diagHistory.length} 次</div>
      <div>${cxStable} 圓心 X:平均 ${cxs.mean.toFixed(1)} ± ${cxs.std.toFixed(2)}(範圍 ${cxs.min.toFixed(1)}~${cxs.max.toFixed(1)})</div>
      <div>${cyStable} 圓心 Y:平均 ${cys.mean.toFixed(1)} ± ${cys.std.toFixed(2)}(範圍 ${cys.min.toFixed(1)}~${cys.max.toFixed(1)})</div>
      <div>${rStable} 半徑:  平均 ${rs.mean.toFixed(1)} ± ${rs.std.toFixed(2)}(範圍 ${rs.min.toFixed(1)}~${rs.max.toFixed(1)})</div>
      <div>圓形度:平均 ${(confs.mean*100).toFixed(0)}%</div>
      <div style="margin-top:4px;color:${cxs.std < 2 && cys.std < 2 && rs.std < 2 ? '#0f0' : '#fa0'}">
        ${cxs.std < 2 && cys.std < 2 && rs.std < 2
          ? '✅ 穩定!可進行下一步(自動規範化)'
          : '⚠️ 不夠穩定,需調整參數或換思路'}
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
      updateBadgeCapturePreview();
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
    const $ = id => document.getElementById(id);

    enableWindowDrag();
    enableBadgeDrag();

    $('dToggleMode').onclick = () => {
      switchPanelMode(state.panelMode === 'compact' ? 'full' : 'compact');
    };

    $('dMuteToggle').onclick = () => {
      state.muted = !state.muted;
      localStorage.setItem('tosm_detector_muted', state.muted ? '1' : '0');
      updateMuteUI();
      log(state.muted ? '🔕 已靜音' : '🔔 已解除靜音', '#fa0');
    };

    $('dTrainToggle').onclick = () => {
      state.trainingMode = !state.trainingMode;
      localStorage.setItem('tosm_detector_training_mode', state.trainingMode ? '1' : '0');
      updateTrainModeUI();
      log(state.trainingMode ? '🎯 進入訓練模式(只存模板,不送 Firebase)' : '✅ 退出訓練模式', '#fa0');
    };

    $('dBrowseCategory').onchange = refreshBrowseLabels;
    $('dBrowseLabel').onchange = renderBrowseGrid;

    const collectorInput = $('dCollectorId');
    const collectorSave = $('dSaveCollectorId');
    if (collectorInput) {
      collectorInput.value = state.collectorId || getCollectorId();
      collectorInput.onchange = () => saveCollectorId(collectorInput.value);
      collectorInput.onkeydown = (e) => {
        if (e.key === 'Enter') saveCollectorId(collectorInput.value);
      };
    }
    if (collectorSave) {
      collectorSave.onclick = () => {
        const id = saveCollectorId(collectorInput ? collectorInput.value : getCollectorId());
        log(id ? `Shadow collector_id saved: ${id}` : 'Shadow collector_id cleared', id ? '#0f0' : '#fa0');
      };
    }
    const testShadowDB = $('dTestShadowDB');
    if (testShadowDB) {
      testShadowDB.onclick = async () => {
        try { await runShadowDBSpike(); }
        catch (e) { console.error(DEBUG_PREFIX, 'Shadow IndexedDB spike failed', e); }
      };
    }
    const exportShadow = $('dExportShadowData');
    if (exportShadow) {
      exportShadow.onclick = async () => {
        try { await exportShadowData(); }
        catch (e) {
          state.shadowDBStatus = 'failed';
          state.shadowDBError = String(e?.message || e).slice(0, 80);
          updateDataCollectionUI('export=failed');
          console.error(DEBUG_PREFIX, 'Shadow export failed', e);
        }
      };
    }

    const miniTplHeader = $('dMiniTplHeader');
    const miniTplBody = $('dMiniTplBody');
    const tplCollapsed = localStorage.getItem('tosm_detector_mini_tpl_collapsed') === '1';
    if (tplCollapsed) {
      miniTplHeader.classList.add('collapsed');
      miniTplBody.classList.add('collapsed');
    }
    miniTplHeader.onclick = () => {
      const collapsed = miniTplHeader.classList.toggle('collapsed');
      miniTplBody.classList.toggle('collapsed', collapsed);
      localStorage.setItem('tosm_detector_mini_tpl_collapsed', collapsed ? '1' : '0');
    };

    const miniPrevHeader = $('dMiniPreviewHeader');
    const miniPrevBody = $('dMiniPreviewBody');
    const prevCollapsed = localStorage.getItem('tosm_detector_mini_prev_collapsed') === '1';
    if (prevCollapsed) {
      miniPrevHeader.classList.add('collapsed');
      miniPrevBody.classList.add('collapsed');
    }
    miniPrevHeader.onclick = () => {
      const collapsed = miniPrevHeader.classList.toggle('collapsed');
      miniPrevBody.classList.toggle('collapsed', collapsed);
      localStorage.setItem('tosm_detector_mini_prev_collapsed', collapsed ? '1' : '0');
    };

    $('dStart').onclick = startCapture;
    $('dStop').onclick = stopCapture;
    $('dTest').onclick = detectOnce;
    $('dAuto').onclick = startAuto;
    $('dStopAuto').onclick = stopAuto;
    $('dForceSubmit').onclick = forceSubmit;

    $('dMiniStart').onclick = startCapture;
    $('dMiniStop').onclick = stopCapture;
    $('dMiniAuto').onclick = startAuto;
    $('dMiniStopAuto').onclick = stopAuto;

    $('dMiniInspect').onclick = () => window.__detector.openInspect();
    $('dMiniCalibrate').onclick = () => {
      // v0.9.0: 改成切換到完整模式並把徽章編輯器滾入視野
      switchPanelMode('full');
      setTimeout(() => {
        const section = document.getElementById('dBadgeSection');
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 300);
    };

    $('dInspectModal').onclick = (e) => {
      if (e.target.id === 'dInspectModal') window.__detector.closeInspect();
    };

    $('dTplImport').onchange = async (e) => {
      const file = e.target.files[0];
      if (file && await TemplateDB.import(file)) {
        log('📥 模板已匯入', '#0f0');
        updateTplDisplay();
      }
      e.target.value = '';
    };

    $('dDebugMode').onchange = (e) => {
      state.debugMode = e.target.checked;
      // v0.9.0: 不再有 dDebugBox 視覺化,只切換 console.log 與 metrics 顯示
    };

    $('dZoom').oninput = (e) => {
      state.zoom = parseFloat(e.target.value);
      applyZoom();
    };
    $('dPreviewScroll').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      state.zoom = Math.max(0.5, Math.min(4, state.zoom + delta));
      $('dZoom').value = state.zoom;
      applyZoom();
    });

    document.querySelectorAll('#detectorPanel .mode-btn').forEach(b => {
      b.onclick = () => setMode(b.dataset.mode);
    });

    const preview = $('dPreview');
    let drawing = false, startPt = null;
    const drawBox = $('dDrawBox');
    drawBox.style.cssText = 'position:absolute;border:2px dashed #fff;background:rgba(255,255,255,0.1);pointer-events:none;z-index:5';

    preview.addEventListener('mousedown', e => {
      if (state.currentMode === 'none') return;
      const video = $('dVideo');
      if (!video.videoWidth) return;
      const rect = video.getBoundingClientRect();
      startPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      drawing = true;
      drawBox.style.display = 'block';
      drawBox.style.left = startPt.x + 'px';
      drawBox.style.top = startPt.y + 'px';
      drawBox.style.width = '0';
      drawBox.style.height = '0';
      e.preventDefault();
    });
    preview.addEventListener('mousemove', e => {
      if (!drawing) return;
      const video = $('dVideo');
      const rect = video.getBoundingClientRect();
      const cur = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const x = Math.min(startPt.x, cur.x), y = Math.min(startPt.y, cur.y);
      const w = Math.abs(cur.x - startPt.x), h = Math.abs(cur.y - startPt.y);
      drawBox.style.left = x + 'px';
      drawBox.style.top = y + 'px';
      drawBox.style.width = w + 'px';
      drawBox.style.height = h + 'px';
    });
    preview.addEventListener('mouseup', e => {
      if (!drawing) return;
      drawing = false;
      drawBox.style.display = 'none';
      const video = $('dVideo');
      if (!video.videoWidth) return;
      const rect = video.getBoundingClientRect();
      const endPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const cssScale = video.clientWidth / video.videoWidth;
      const region = {
        x: Math.round(Math.min(startPt.x, endPt.x) / cssScale),
        y: Math.round(Math.min(startPt.y, endPt.y) / cssScale),
        w: Math.round(Math.abs(endPt.x - startPt.x) / cssScale),
        h: Math.round(Math.abs(endPt.y - startPt.y) / cssScale)
      };
      if (region.w < 10 || region.h < 10) return;

      state.regions[state.currentMode] = region;
      drawRegionBox(state.currentMode, region);
      const labelMap = {
        status: '🔴 狀態圖示',
        map: '🟢 地圖名',
        ch: '🟡 分流',
        announcement: '📢 公告區'
      };
      log(`已框選 ${labelMap[state.currentMode]}: ${region.w}×${region.h}px`, '#0f0');
      localStorage.setItem('tosm_detector_regions_v5', JSON.stringify(state.regions));
      if (state.currentMode === 'status') {
        state.badgeRect = null;
        localStorage.removeItem('tosm_detector_badge_rect_v46');
        renderBadgeEditor();
      }
      if (state.currentMode === 'announcement') {
        // 重新框選公告區 → 清空歷史避免舊資料污染
        state.announcementHistory = [];
        updateAnnStatus();
      }
    });
  }

  function loadRegions() {
    const s = localStorage.getItem('tosm_detector_regions_v5')
           || localStorage.getItem('tosm_detector_regions_v46')
           || localStorage.getItem('tosm_detector_regions_v45');
    if (s) {
      try {
        const r = JSON.parse(s);
        state.regions = {
          status: r.status || null,
          map: r.map || null,
          ch: r.ch || null,
          announcement: r.announcement || null   // v0.8.0
        };
        for (const k of ['status', 'map', 'ch', 'announcement']) {
          if (state.regions[k]) drawRegionBox(k, state.regions[k]);
        }
      } catch (e) {}
    }
    const br = localStorage.getItem('tosm_detector_badge_rect_v46');
    if (br) {
      try {
        const parsedBadgeRect = JSON.parse(br);
        state.badgeRect = isLegacyBadgeRectDefault(state.regions.status, parsedBadgeRect) ? null : parsedBadgeRect;
      } catch (e) {}
    }
  }

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 }
      });
      state.stream = stream;
      const video = document.getElementById('dVideo');
      video.srcObject = stream;
      await video.play();
      stream.getVideoTracks()[0].onended = stopCapture;
      log(`📺 擷取啟動 (${video.videoWidth}×${video.videoHeight})`, '#0f0');
      updateCaptureUIState(true);
      setTimeout(() => {
        applyZoom();
        loadRegions();
        if (state.regions.status && state.panelMode === 'full') renderBadgeEditor();
      }, 200);
    } catch (e) {
      log('❌ 擷取失敗:' + e.message, '#f33');
    }
  }

  function stopCapture() {
    if (state.autoTimer) stopAuto();
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }
    log('⏹ 擷取停止', '#888');
    updateCaptureUIState(false);
  }

  function updateCaptureUIState(active) {
    const ids = ['dStart','dStop','dTest','dAuto','dStopAuto','dForceSubmit',
                 'dMiniStart','dMiniStop','dMiniAuto','dMiniStopAuto'];
    const setDis = (id, dis) => { const el = document.getElementById(id); if (el) el.disabled = dis; };
    setDis('dStart', active);
    setDis('dStop', !active);
    setDis('dTest', !active);
    setDis('dAuto', !active);
    setDis('dStopAuto', true);
    setDis('dForceSubmit', !active);
    setDis('dMiniStart', active);
    setDis('dMiniStop', !active);
    setDis('dMiniAuto', !active);
    setDis('dMiniStopAuto', true);
    document.getElementById('dStatus').textContent = active ? '✅ 擷取中' : '未啟動';
    const cs = document.getElementById('dCompactStatus');
    if (cs) {
      cs.textContent = active ? '✅ 擷取中' : '未啟動';
      cs.style.color = active ? '#0f0' : '#888';
    }
  }

  function updateConfBar(id, conf) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.width = (conf * 100) + '%';
    if (conf >= 0.7) el.style.background = '#0f0';
    else if (conf >= 0.5) el.style.background = '#fa0';
    else el.style.background = '#f33';
  }

  function phaseBadge(phase) {
    const map = {
      'ON': '🔴 ON',
      'R1': 'R1', 'R2': 'R2', 'R3': 'R3', 'R4': 'R4',
      'WAITING': '等待中',
      'UNKNOWN': '❓'
    };
    return map[phase] || phase || '—';
  }

  function phaseColor(phase) {
    if (phase === 'ON') return '#f33';
    if (['R1','R2','R3','R4'].includes(phase)) return '#fa0';
    if (phase === 'WAITING') return '#888';
    return '#666';
  }

  async function detectOnce() {
    if (!state.regions.status) {
      log('⚠️ 請先框選狀態圖示', '#f33');
      return null;
    }

    const monStatus = document.getElementById('dMonitorStatus');
    if (monStatus && state.autoTimer) {
      monStatus.classList.add('active');
      monStatus.textContent = '👁 偵測中';
    }

    // ─── 1. 徽章模板判定(主信號)───
    const phaseResult = await detectPhase(state.regions.status);

    // ─── 2. 中央公告 OCR(第二信號,可選)───
    let annResult = null;
    if (state.regions.announcement) {
      annResult = await detectAnnouncement(state.regions.announcement);
      if (annResult) pushAnnouncement(annResult);
    }
    const stableAnn = getStableAnnouncement();

    // ─── 3. 雙信號融合 ───
    const fused = fuseDualSignals(
      phaseResult.phase,
      phaseResult.templateMatch,
      stableAnn
    );
    state.lastDecisionDetail = fused;

    // ─── 4. UI 更新(顯示融合後的最終判定)───
    document.getElementById('dValStatus').textContent = phaseBadge(fused.phase);
    document.getElementById('dValStatus').style.color = phaseColor(fused.phase);
    updateConfBar('dConfStatus', fused.confidence);
    document.getElementById('dMiniStatus').textContent = phaseBadge(fused.phase);
    document.getElementById('dMiniStatus').style.color = phaseColor(fused.phase);
    updateConfBar('dMiniConfStatus', fused.confidence);

    const m = phaseResult.metrics;
    let metricsHTML =
      `紅:${(m.redRatio*100).toFixed(1)}% 白:${(m.whiteRatio*100).toFixed(1)}% 徽白:${(m.badgeWhiteRatio*100).toFixed(1)}%<br>` +
      `源:<b style="color:#0af">${fused.source}</b>`;
    if (phaseResult.templateMatch) {
      metricsHTML += ` | 徽章:${phaseResult.templateMatch.label}@${(phaseResult.templateMatch.similarity*100).toFixed(0)}%`;
    }
    if (stableAnn) {
      metricsHTML += `<br>📢 公告:${stableAnn.phase}@${(stableAnn.confidence*100).toFixed(0)}% (${stableAnn.voteCount}/${stableAnn.windowSize})`;
    } else if (state.regions.announcement) {
      const recent = state.announcementHistory.slice(-3).map(a => a.phase || '?').join(',');
      metricsHTML += `<br>📢 公告:累積中 [${recent}]`;
    }
    document.getElementById('dMetrics').innerHTML = metricsHTML;

    // 地圖
    let mapResult = null;
    if (state.regions.map) {
      const mapCanvas = document.getElementById('dCanMap');
      const ocr = await ocrMultiPass(state.regions.map, mapCanvas, 'chi_tra+eng', null, '7');
      mapResult = matchMapName(ocr.text);
      document.getElementById('dValMap').textContent = mapResult.matched
        ? `🟢 ${mapResult.matched}` + (mapResult.matchedName ? `\n${mapResult.matchedName.slice(0,8)}` : '')
        : `❌ ${ocr.text.slice(0,10) || '無'}`;
      updateConfBar('dConfMap', mapResult.confidence);
      document.getElementById('dMiniMap').textContent = mapResult.matched || '—';
      updateConfBar('dMiniConfMap', mapResult.confidence);
    }

    // 分流
    let chResult = null;
    if (state.regions.ch) {
      chResult = await detectCh(state.regions.ch);
      document.getElementById('dValCh').textContent = chResult.ch ? `CH.${chResult.ch}` : '—';
      updateConfBar('dConfCh', chResult.confidence);
      document.getElementById('dMiniCh').textContent = chResult.ch ? `CH.${chResult.ch}` : '—';
      updateConfBar('dMiniConfCh', chResult.confidence);
    }

    state.lastResult = {
      phase: phaseResult,                 // 模板原始結果(保留,inspect 用)
      announcement: stableAnn,            // 公告穩定結果
      announcementRaw: annResult,         // 本次原始公告 OCR(debug 用)
      fused,                              // 融合後的最終決策(主要使用)
      map: mapResult,
      ch: chResult
    };
    showTplPreview();
    updateMiniPreview();
    updateAnnStatus();
    captureShadowSample(state.lastResult);

    if (monStatus && state.autoTimer) {
      setTimeout(() => {
        monStatus.classList.remove('active');
        monStatus.textContent = '🔄 監控中';
      }, 200);
    }

    return state.lastResult;
  }

  async function forceSubmit() {
    if (!state.lastResult) {
      log('⚠️ 尚無偵測結果,請先點測試讀取', '#f33');
      return;
    }
    const r = state.lastResult;
    const map = r.map?.matched;
    const ch = r.ch?.ch;
    if (!map || !ch) {
      log('⚠️ 缺少地圖或分流,無法送出', '#f33');
      return;
    }
    // v0.8.0: 用 fused 結果而非原始 phaseResult
    const fusedPhase = r.fused?.phase;
    if (!fusedPhase || fusedPhase === 'UNKNOWN') {
      log('⚠️ 階段未知,請手動指定', '#f33');
      showCorrectionPrompt(map, ch, r.fused);
      return;
    }
    let val;
    if (fusedPhase === 'ON') val = 'on';
    else if (fusedPhase === 'R1') val = -1;
    else if (fusedPhase === 'R2') val = -2;
    else if (fusedPhase === 'R3') val = -3;
    else if (fusedPhase === 'R4') val = -4;
    else if (fusedPhase === 'WAITING') val = 'waiting';
    else val = -1;
    showConfirmPrompt(map, ch, val, fusedPhase, true);
  }

  async function monitorTick() {
    const result = await detectOnce();
    if (!result) return;
    if (!result.fused) return;

    // v0.9.0: 把每次 tick 的結果 push 進 phaseHistory
    // UNKNOWN 也算一票(代表「不確定」),這樣多數決才公平
    state.phaseHistory.push({
      phase: result.fused.phase,
      confidence: result.fused.confidence,
      time: Date.now(),
      map: result.map?.matched,
      ch: result.ch?.ch
    });
    while (state.phaseHistory.length > PHASE_VOTE_WINDOW) {
      state.phaseHistory.shift();
    }

    // 視窗未滿就先不決策(避免一啟動就用少量樣本誤送)
    if (state.phaseHistory.length < PHASE_VOTE_WINDOW) {
      updateVoteUI();
      return;
    }

    // 視窗滿了 → 多數決
    const voted = computePhaseVote();
    updateVoteUI(voted);

    if (!voted || voted.phase === 'UNKNOWN') return;
    handlePhaseChange(voted, result);
  }

  // v0.9.0: 對 phaseHistory 做多數決
  // 回傳:{phase, confidence, votes, total} 或 null
  function computePhaseVote() {
    const history = state.phaseHistory;
    if (history.length < PHASE_VOTE_MIN) return null;

    // 用最新一次的 map/ch(投票期間若 map/ch 變了,以最新為準)
    const latest = history[history.length - 1];

    // 統計各 phase 票數,UNKNOWN 不算「正常票」但也不會勝出
    const votes = {};
    for (const h of history) {
      const p = h.phase || 'UNKNOWN';
      votes[p] = (votes[p] || 0) + 1;
    }
    let bestPhase = null, bestCount = 0;
    for (const [p, c] of Object.entries(votes)) {
      if (c > bestCount) { bestPhase = p; bestCount = c; }
    }
    if (bestPhase === 'UNKNOWN' || bestCount < PHASE_VOTE_MIN) {
      return {
        phase: 'UNKNOWN',
        confidence: 0,
        votes: bestCount,
        total: history.length,
        bestPhase,
        map: latest.map,
        ch: latest.ch
      };
    }

    // 該 phase 在視窗內的平均信心
    const matching = history.filter(h => h.phase === bestPhase);
    const avgConf = matching.reduce((s, h) => s + (h.confidence || 0), 0) / matching.length;

    return {
      phase: bestPhase,
      confidence: avgConf,
      votes: bestCount,
      total: history.length,
      map: latest.map,
      ch: latest.ch
    };
  }

  // v0.9.0: 把投票進度顯示到 UI
  function updateVoteUI(voted) {
    const el = document.getElementById('dCompactStatus');
    if (!el) return;
    const len = state.phaseHistory.length;
    const recent = state.phaseHistory.map(h => (h.phase || '?')).join(',');
    if (len < PHASE_VOTE_WINDOW) {
      el.textContent = `🗳 投票累積中 ${len}/${PHASE_VOTE_WINDOW} [${recent}]`;
      el.style.color = '#888';
      return;
    }
    if (voted && voted.phase !== 'UNKNOWN') {
      el.textContent = `🗳 ${voted.phase} 勝出 ${voted.votes}/${voted.total} [${recent}]`;
      el.style.color = '#0f0';
    } else {
      el.textContent = `🗳 無共識 [${recent}]`;
      el.style.color = '#fa0';
    }
  }

  function handlePhaseChange(voted, latestResult) {
    // v0.9.0: voted 是滑動視窗多數決結果
    //         latestResult 是最近一次原始 detectOnce 結果(取 map/ch)
    const map = voted.map || latestResult.map?.matched;
    const ch = voted.ch || latestResult.ch?.ch;
    const phase = voted.phase;
    const confidence = voted.confidence;

    if (!map || !ch || !phase || phase === 'UNKNOWN') return;

    const minConf = parseFloat(document.getElementById('dMinConf').value) || 0.5;
    if (confidence < minConf) return;

    // ═══ 狀態轉移約束 ═══
    const currentState = readCurrentBossState(map, ch);
    if (currentState && !isAllowedTransition(currentState, phase)) {
      if (state.debugMode) {
        console.log(DEBUG_PREFIX, '狀態轉移違規,跳過:', currentState, '→', phase);
      }
      log(`⚠️ 狀態轉移違規:${currentState} → ${phase},跳過`, '#fa0');
      // 重置投票歷史,避免一直累積違規票
      state.phaseHistory = [];
      return;
    }

    // ═══ 現狀比對 ═══
    if (currentState === phase) {
      if (state.debugMode) {
        console.log(DEBUG_PREFIX, '現狀已是', phase, ',跳過');
      }
      return;
    }

    const cooldownSec = parseInt(document.getElementById('dCooldown').value) || 30;
    const now = Date.now();
    const last = state.lastSubmitted;
    if (last.map === map && last.ch === ch
        && (now - last.time) < cooldownSec * 1000) {
      return;
    }

    let val;
    if (phase === 'ON') val = 'on';
    else if (phase === 'R1') val = -1;
    else if (phase === 'R2') val = -2;
    else if (phase === 'R3') val = -3;
    else if (phase === 'R4') val = -4;
    else if (phase === 'WAITING') return;
    else return;

    const onlyChange = document.getElementById('dOnlyChange').checked;
    if (onlyChange && last.map === map && last.ch === ch && last.val === val) {
      return;
    }

    const autoSubmit = document.getElementById('dAutoSubmit').checked;
    if (autoSubmit) {
      doSubmit(map, ch, val, phase);
    } else {
      showConfirmPrompt(map, ch, val, phase);
    }
  }

  function valToDisplay(val) {
    if (val === 'on') return '🔴 ON';
    if (val === 'waiting') return '⏳ 等待中';
    if (val === -1) return 'R1';
    if (val === -2) return 'R2';
    if (val === -3) return 'R3';
    if (val === -4) return 'R4';
    return String(val);
  }

  function showConfirmPrompt(map, ch, val, phase, force = false) {
    const area = document.getElementById('dConfirmArea');
    if (!area) return;
    const valDisplay = valToDisplay(val);
    const isOn = val === 'on';
    const cls = isOn ? 'on' : (force ? 'low-conf' : '');
    area.innerHTML = `
      <div class="confirm-banner ${cls}">
        ⚠️ 確認送出?<br>
        地圖 <b>${map}</b> / CH.<b>${ch}</b> / <b>${valDisplay}</b>
        <div style="margin-top:6px">
          <button class="dbtn" onclick="window.__detector.confirm('${map}','${ch}','${val}','${phase}')">✅ 確認</button>
          <button class="dbtn red" onclick="window.__detector.cancel()">❌ 取消</button>
          <button class="dbtn gray" onclick="window.__detector.showEdit('${map}','${ch}','${val}','${phase}')">✏️ 修改</button>
        </div>
      </div>
    `;
    beep(880);
  }

  function showCorrectionPrompt(map, ch, phaseResult) {
    const area = document.getElementById('dConfirmArea');
    if (!area) return;
    area.innerHTML = `
      <div class="confirm-banner low-conf">
        ⚠️ 階段無法判定,請手動選擇<br>
        地圖 <b>${map}</b> / CH.<b>${ch}</b>
        <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">
          <button class="dbtn" onclick="window.__detector.confirmManual('${map}','${ch}','on','ON')">🔴 ON</button>
          <button class="dbtn" onclick="window.__detector.confirmManual('${map}','${ch}','-1','R1')">R1</button>
          <button class="dbtn" onclick="window.__detector.confirmManual('${map}','${ch}','-2','R2')">R2</button>
          <button class="dbtn" onclick="window.__detector.confirmManual('${map}','${ch}','-3','R3')">R3</button>
          <button class="dbtn" onclick="window.__detector.confirmManual('${map}','${ch}','-4','R4')">R4</button>
          <button class="dbtn red" onclick="window.__detector.cancel()">取消</button>
        </div>
      </div>
    `;
  }

  function doSubmit(map, ch, val, phase) {
    if (state.trainingMode) {
      log(`🎯 訓練模式:${map}/CH.${ch}/${valToDisplay(val)}(未送 Firebase)`, '#fa0');
      const autoLearn = document.getElementById('dAutoLearn')?.checked;
      if (autoLearn && state.lastBadgeCanvas && phase) {
        const added = TemplateDB.add('phase', phase, state.lastBadgeCanvas);
        if (added) log(`🎓 已加入階段模板:${phase}`, '#fa0');
      }
      if (autoLearn && state.lastChCanvas && ch) {
        const added = TemplateDB.add('ch', ch, state.lastChCanvas);
        if (added) log(`🎓 已加入分流模板:CH.${ch}`, '#fa0');
      }
      updateTplDisplay();
      state.lastSubmitted = { map, ch, val, time: Date.now() };
      document.getElementById('dConfirmArea').innerHTML = '';
      return;
    }

    try {
      saveBoss(map, ch, val);
      log(`✅ 送出 ${map}/CH.${ch}/${valToDisplay(val)}`, '#0f0');
      state.lastSubmitted = { map, ch, val, time: Date.now() };
      beep(1320);

      const autoLearn = document.getElementById('dAutoLearn')?.checked;
      if (autoLearn && state.lastBadgeCanvas && phase) {
        const added = TemplateDB.add('phase', phase, state.lastBadgeCanvas);
        if (added) log(`🎓 已加入階段模板:${phase}`, '#fa0');
      }
      if (autoLearn && state.lastChCanvas && ch) {
        const added = TemplateDB.add('ch', ch, state.lastChCanvas);
        if (added) log(`🎓 已加入分流模板:CH.${ch}`, '#fa0');
      }
      updateTplDisplay();
    } catch (e) {
      log('❌ 送出失敗:' + e.message, '#f33');
    }
    document.getElementById('dConfirmArea').innerHTML = '';
  }

  function startAuto() {
    if (state.autoTimer) return;
    const interval = parseInt(document.getElementById('dInterval').value) || DEFAULT_SCAN_INTERVAL_MS;
    // v0.9.0: 啟動時清空投票歷史,確保每次重新監控都從乾淨狀態開始
    state.phaseHistory = [];
    state.announcementHistory = [];
    state.autoTimer = setInterval(monitorTick, interval);
    log(`🔄 自動監控已啟動(每 ${interval}ms 掃描,${PHASE_VOTE_WINDOW}-of-${PHASE_VOTE_MIN} 投票)`, '#0f0');
    document.getElementById('dAuto').disabled = true;
    document.getElementById('dStopAuto').disabled = false;
    document.getElementById('dMiniAuto').disabled = true;
    document.getElementById('dMiniStopAuto').disabled = false;
    const monStatus = document.getElementById('dMonitorStatus');
    if (monStatus) {
      monStatus.classList.add('active');
      monStatus.textContent = '🔄 監控中';
    }
    monitorTick();
  }

  function stopAuto() {
    if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    log('⏸ 自動監控已停止', '#888');
    document.getElementById('dAuto').disabled = false;
    document.getElementById('dStopAuto').disabled = true;
    document.getElementById('dMiniAuto').disabled = false;
    document.getElementById('dMiniStopAuto').disabled = true;
    const monStatus = document.getElementById('dMonitorStatus');
    if (monStatus) {
      monStatus.classList.remove('active');
      monStatus.textContent = '閒置';
    }
    state.lastPhase = null;
    state.stableCount = 0;
    state.phaseHistory = [];          // v0.9.0
  }

  function togglePanel() {
    const panel = document.getElementById('detectorPanel');
    if (panel.classList.contains('open')) {
      panel.classList.remove('open');
    } else {
      panel.classList.add('open');
    }
  }

  // ═══════════════════════════════════════════════
  // window.__detector 全域 API
  // ═══════════════════════════════════════════════
  window.__detector = {
    close: () => document.getElementById('detectorPanel').classList.remove('open'),

    confirm: (map, ch, val, phase) => {
      const v = (val === 'on' || val === 'waiting') ? val : parseInt(val);
      doSubmit(map, ch, v, phase);
    },

    cancel: () => {
      document.getElementById('dConfirmArea').innerHTML = '';
      log('❌ 已取消', '#888');
    },

    confirmManual: (map, ch, val, phase) => {
      const v = (val === 'on' || val === 'waiting') ? val : parseInt(val);
      doSubmit(map, ch, v, phase);
    },

    showEdit: (map, ch, val, phase) => {
      const area = document.getElementById('dConfirmArea');
      area.innerHTML = `
        <div class="confirm-banner">
          ✏️ 修改後送出
          <div class="correction-row">
            <input type="text" id="dEditMap" value="${map}" style="width:60px">
            <input type="text" id="dEditCh" value="${ch}" style="width:50px">
            <select id="dEditVal">
              <option value="on" ${val==='on'?'selected':''}>ON</option>
              <option value="-1" ${val==='-1'||val==-1?'selected':''}>R1</option>
              <option value="-2" ${val==='-2'||val==-2?'selected':''}>R2</option>
              <option value="-3" ${val==='-3'||val==-3?'selected':''}>R3</option>
              <option value="-4" ${val==='-4'||val==-4?'selected':''}>R4</option>
            </select>
            <button class="dbtn" onclick="window.__detector.confirmEdit()">✅</button>
          </div>
        </div>
      `;
    },

    confirmEdit: () => {
      const map = document.getElementById('dEditMap').value.trim();
      const ch = document.getElementById('dEditCh').value.trim();
      const valRaw = document.getElementById('dEditVal').value;
      const val = valRaw === 'on' ? 'on' : parseInt(valRaw);
      const phaseMap = { 'on': 'ON', '-1': 'R1', '-2': 'R2', '-3': 'R3', '-4': 'R4' };
      const phase = phaseMap[valRaw];

      if (state.lastResult?.map?.raw && state.lastResult.map.raw !== map
          && document.getElementById('dContribute').checked) {
        contributeMapAlias(state.lastResult.map.raw, map);
      }
      doSubmit(map, ch, val, phase);
    },

    submitCorrection: () => {
      const raw = document.getElementById('dCorrectRaw').value.trim();
      const code = document.getElementById('dCorrectCode').value.trim();
      if (!raw || !code) { alert('請填寫兩個欄位'); return; }
      contributeMapAlias(raw, code);
      document.getElementById('dCorrectRaw').value = '';
      document.getElementById('dCorrectCode').value = '';
    },

    resetZoom: () => {
      state.zoom = 1.0;
      document.getElementById('dZoom').value = 1;
      applyZoom();
    },

    resetBadge: () => {
      state.badgeRect = null;
      localStorage.removeItem('tosm_detector_badge_rect_v46');
      renderBadgeEditor();
      log('🎯 徽章範圍已重設為預設', '#888');
    },

    addTpl: () => {
      if (!state.lastBadgeCanvas) return;
      const cat = document.getElementById('dTplCategory').value;
      const label = document.getElementById('dTplLabel').value;
      const canvas = (cat === 'ch' && state.lastChCanvas) ? state.lastChCanvas : state.lastBadgeCanvas;
      const added = TemplateDB.add(cat, label, canvas);
      log(added ? `📌 已加入模板:${label}` : '⚠️ 模板已存在', added ? '#0f0' : '#fa0');
      updateTplDisplay();
    },

    quickSavePhase: () => {
      if (!state.lastBadgeCanvas) {
        log('⚠️ 沒有可標記的擷取', '#f33');
        return;
      }
      const label = document.getElementById('dQuickPhaseLabel').value;
      const added = TemplateDB.add('phase', label, state.lastBadgeCanvas);
      log(added ? `💾 階段模板 ${label} 已存入` : '⚠️ 此模板已存在', added ? '#0f0' : '#fa0');
      updateTplDisplay();
    },

    quickSaveCh: () => {
      if (!state.lastChCanvas) {
        log('⚠️ 沒有可標記的擷取', '#f33');
        return;
      }
      const label = document.getElementById('dQuickChLabel').value.trim();
      if (!label) {
        log('⚠️ 請輸入 CH 數字', '#f33');
        return;
      }
      const added = TemplateDB.add('ch', label, state.lastChCanvas);
      log(added ? `💾 分流模板 CH.${label} 已存入` : '⚠️ 此模板已存在', added ? '#0f0' : '#fa0');
      updateTplDisplay();
    },

    exportShadowData,
    runShadowDBSpike,
    getShadowDBStats,
    migrateLegacyShadowRecords,

    exportTpl: () => TemplateDB.export(),

    clearTpl: () => {
      if (confirm('確定清空所有模板?(此動作無法復原)')) {
        TemplateDB.data = { phase: {}, ch: {} };
        TemplateDB.save();
        updateTplDisplay();
        log('🗑 已清空模板', '#fa0');
      }
    },

    deleteTpl: (cat, label, idx) => {
      if (confirm(`刪除「${label} #${idx+1}」?`)) {
        TemplateDB.deleteAt(cat, label, idx);
        updateTplDisplay();
        log(`🗑 已刪除 ${label} #${idx+1}`, '#888');
      }
    },

    deleteTplFromInspect: (cat, label, idx) => {
      if (confirm(`刪除「${label} #${idx+1}」?`)) {
        TemplateDB.deleteAt(cat, label, idx);
        updateTplDisplay();
        log(`🗑 已刪除 ${label} #${idx+1}`, '#888');
        window.__detector.openInspect();
      }
    },

    openInspect: async () => {
      const modal = document.getElementById('dInspectModal');
      const body = document.getElementById('dInspectBody');
      if (!state.lastBadgeCanvas) {
        body.innerHTML = '<div style="color:#fa0;text-align:center;padding:20px">⚠️ 尚無偵測結果,請先「測試讀取」</div>';
        modal.classList.add('show');
        return;
      }

      body.innerHTML = '<div style="text-align:center;padding:20px">⏳ 計算比對結果中...</div>';
      modal.classList.add('show');

      // 重新比對一次以取得 allMatches 資料
      const phaseMatch = await TemplateDB.match('phase', state.lastBadgeCanvas);
      const chMatch = state.lastChCanvas ? await TemplateDB.match('ch', state.lastChCanvas) : null;

      const renderTable = (title, queryCanvas, match, cat) => {
        if (!match || !match.allMatches || match.allMatches.length === 0) {
          return `<div style="margin:10px 0;color:#888">${title}:無模板可比對</div>`;
        }
        const queryCanvasId = `dInspectQuery_${cat}`;
        const top1Label = match.label;
        let html = `
          <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
            <div style="font-weight:bold;color:#08f;margin-bottom:6px">${title}</div>
            <div class="inspect-query">
              <canvas id="${queryCanvasId}"></canvas>
              <div>
                <div>當前擷取(已標準化 32×32)</div>
                <div style="color:#0f0">最終判定:<b>${match.label}</b> @ ${(match.similarity*100).toFixed(1)}%</div>
                ${match.rejection ? `<div style="color:#f33;margin-top:4px">⛔ 拒答:${match.rejection.reason}<br><span style="font-size:10px">${match.rejection.detail}</span></div>` : ''}
              </div>
            </div>
            <table class="inspect-table">
              <tr>
                <th>排名</th><th>標籤</th><th>模板</th>
                <th title="像素 NCC">像素</th>
                <th title="Zone 密度 cosine">Zone</th>
                <th title="邊緣 NCC">邊緣</th>
                <th>綜合</th><th></th>
              </tr>
        `;
        match.allMatches.slice(0, 8).forEach((m, i) => {
          const isWinner = i === 0 && !match.rejection;
          const isSuspect = m.label !== top1Label && i < 3;
          const cls = isWinner ? 'winner' : (isSuspect ? 'suspect' : '');
          const tplURL = TemplateDB.data[cat]?.[m.label]?.[m.idx] || '';
          html += `
            <tr class="${cls}">
              <td>${i+1}</td>
              <td><b>${m.label}</b></td>
              <td><img class="tpl-thumb" src="${tplURL}"></td>
              <td>${(m.eucSim*100).toFixed(0)}%</td>
              <td>${(m.cosSim*100).toFixed(0)}%</td>
              <td>${(m.hashSim*100).toFixed(0)}%</td>
              <td><b style="color:${isWinner?'#0f0':'#aaa'}">${(m.combined*100).toFixed(1)}%</b>
                <span class="inspect-bar"><span style="display:block;height:100%;width:${m.combined*100}%;background:${isWinner?'#0f0':'#08f'}"></span></span>
              </td>
              <td><button class="del-tpl" onclick="window.__detector.deleteTplFromInspect('${cat}','${m.label}',${m.idx})">🗑</button></td>
            </tr>
          `;
        });
        html += '</table>';
        return html;
      };

      let html = renderTable('📷 階段比對(徽章模板)', state.lastBadgeCanvas, phaseMatch, 'phase');

      // v0.8.0: 公告 OCR 與融合決策區塊
      const fused = state.lastDecisionDetail;
      const ann = state.lastResult?.announcement;
      const annRaw = state.lastResult?.announcementRaw;
      if (state.regions.announcement || ann || annRaw) {
        html += `
          <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
            <div style="font-weight:bold;color:#08f;margin-bottom:6px">📢 公告 OCR(第二信號)</div>
        `;
        if (ann) {
          html += `
            <div style="background:#0a1a2a;border:1px solid #08f;border-radius:6px;padding:8px;margin:6px 0">
              <div>滑動視窗多數決:<b style="color:#0f0">${ann.phase}</b> @ ${(ann.confidence*100).toFixed(0)}% (${ann.voteCount}/${ann.windowSize} 票)</div>
              <div style="font-size:11px;color:#888;margin-top:2px">原文:${(ann.raw || '').slice(0, 40)}</div>
            </div>
          `;
        } else {
          html += `<div style="color:#888;padding:6px">尚未累積足夠樣本(需至少 ${ANNOUNCEMENT_VOTE_MIN} 次同 phase)</div>`;
        }
        if (state.announcementHistory.length > 0) {
          html += `<div style="font-size:11px;color:#888;margin-top:4px">最近歷史:`;
          html += state.announcementHistory.map(a =>
            `<span style="display:inline-block;margin:0 4px;padding:1px 5px;background:#222;border-radius:3px">${a.phase || '?'}@${(a.confidence*100).toFixed(0)}%</span>`
          ).join('');
          html += `</div>`;
        }
        html += `</div>`;
      }

      // 融合決策視覺化
      if (fused) {
        const reasonColor = fused.phase === 'UNKNOWN' ? '#f33' : '#0f0';
        html += `
          <div style="margin-top:14px;padding-top:10px;border-top:1px solid #333">
            <div style="font-weight:bold;color:#fa0;margin-bottom:6px">🎯 融合決策(最終)</div>
            <div style="background:#1a1a0a;border:1px solid #fa0;border-radius:6px;padding:8px">
              <div style="font-size:14px">最終判定:<b style="color:${reasonColor}">${fused.phase}</b> @ ${(fused.confidence*100).toFixed(1)}%</div>
              <div style="font-size:11px;color:#aaa;margin-top:4px">來源:${fused.source}</div>
              ${fused.detail ? `<div style="font-size:10px;color:#888;margin-top:4px;font-family:monospace">${JSON.stringify(fused.detail).replace(/"/g,'').slice(0,160)}</div>` : ''}
            </div>
          </div>
        `;
      }

      if (chMatch) html += renderTable('🔢 分流比對', state.lastChCanvas, chMatch, 'ch');
      body.innerHTML = html;

      const drawTo = (id, src) => {
        const c = document.getElementById(id);
        if (!c || !src) return;
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        const norm = TemplateDB.normalize(src);
        ctx.drawImage(norm, 0, 0, 64, 64);
      };
      drawTo('dInspectQuery_phase', state.lastBadgeCanvas);
      if (chMatch) drawTo('dInspectQuery_ch', state.lastChCanvas);
    },

    closeInspect: () => document.getElementById('dInspectModal').classList.remove('show'),

    // v0.9.0: 紅環校準 UI 已移除,但保留資料層相容性
    // 老用戶若有歷史校準資料,captureBadgeFromCalibration 仍會用它
    // 如需清除,呼叫此 API
    resetCalibration: () => {
      if (confirm('確定清除歷史校準資料?徽章將回到「狀態圈右上角」預設位置')) {
        clearCalibration();
        log('🗑 校準資料已清除', '#888');
        if (state.panelMode === 'full') renderBadgeEditor();
      }
    }
  };

  // ═══════════════════════════════════════════════
  // 啟動
  // ═══════════════════════════════════════════════
  loadTesseract(() => {
    waitForApp(() => {
      injectUI();
      console.log(DEBUG_PREFIX, 'v0.9.1 已就緒(文字主體中心化)');
    });
  });

  /* === TEST_HOOK BEGIN: do not remove. used by tosm-detector-eval harness === */
  window.__detectorInternal = { TemplateDB, detectPhase, detectCh, detectAnnouncement, ocrMultiPass, ocrBadgeFallback, parseAnnouncementText, pushAnnouncement, getStableAnnouncement, fuseDualSignals, isAllowedTransition, captureBadgeCanvas, captureChCanvas, getBadgeRect, analyzeStatusMetrics, matchMapName, state };
  /* === TEST_HOOK END === */

})();
