/*
 * TOS M FB TIME - Window Capture Boss Detector
 * File: detector-v0.6.4.js
 *
 * 使用方式：
 * 1. 將本檔案放在主 HTML 同層或可讀取的位置。
 * 2. 在原本主程式載入完成後加入：
 *    <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
 *    <script src="detector-v0.6.4.js"></script>
 *
 * 3. 進入房間後，右下角會出現「TOSM Detector」面板。
 * 4. 點「開始擷取」，選擇 TOSM 遊戲視窗。
 *
 * 重要說明：
 * - 本檔案不直接寫 Firebase。
 * - 本檔案只會在判斷穩定後呼叫原主程式的 window.saveBoss(map, ch, value, false)。
 * - value 會輸出 XX / R1 / R2 / R3 / R4 / ON。
 * - 階段判斷使用狀態機，不以紅條比例直接代表階段。
 * - 若第一次開始偵測時已在紅條階段，無法只靠單張畫面知道目前是 R1~R4，
 *   會優先讀取 window.currentData[map_ch].lastInput；若沒有資料，會要求手動校正。
 */

(function () {
  "use strict";

  const VERSION = "0.6.4";

  const DEFAULT_CONFIG = {
    scanIntervalMs: 700,
    ocrIntervalMs: 1800,
    stableNeed: 3,
    submitCooldownMs: 6500,
    autoSubmit: true,
    confirmBeforeSubmit: false,
    debug: false,

    // 以使用者提供的 1648x900 範例畫面為基準的比例 ROI。
    // 不同解析度會依比例自動換算。
    // 若你的模擬器 UI 比例不同，可在面板開啟 debug 觀察後調整。
    roi: {
      // 右上小地圖下方的地圖名稱區。
      mapName: { x: 0.775, y: 0.310, w: 0.160, h: 0.065 },

      // 右上 CH.4 分流區。
      channel: { x: 0.930, y: 0.315, w: 0.065, h: 0.060 },

      // 右上圓形 BOSS / 進度圖示區。
      // 你提供的截圖中在小地圖左下附近。
      bossCircle: { x: 0.805, y: 0.170, w: 0.075, h: 0.115 }
    },

    // 圓環進度判斷。
    ring: {
      sampleCount: 96,
      radiusRatio: 0.42,
      thicknessRatio: 0.13,
      whiteThreshold: 0.30,
      redThreshold: 0.18,
      resetFrom: 0.82,
      resetTo: 0.24,
      minForwardDelta: 0.015
    }
  };

  // 地圖名稱 → 地圖等級。
  // 請依遊戲實際野外 BOSS 地圖持續補齊。
  const MAP_NAME_TO_LEVEL = {
    "那魯巴斯寺院別館": "160",
    "那魯巴斯寺院": "160",
    "那魯巴斯": "160"
  };

  const detector = {
    version: VERSION,
    config: deepMerge({}, DEFAULT_CONFIG),
    running: false,
    video: null,
    stream: null,
    canvas: null,
    ctx: null,
    loopTimer: null,
    lastOcrAt: 0,
    cachedMapName: "",
    cachedMapLevel: "",
    cachedChannel: "",
    lastCandidateKey: "",
    stableCount: 0,
    lastSubmitKey: "",
    lastSubmitAt: 0,
    trackers: {},
    lastScan: null,
    tesseractWorker: null,
    workerReady: false,
    manualPhaseTarget: null
  };

  window.TOSMDetector = {
    version: VERSION,
    start,
    stop,
    mount,
    unmount,
    scanOnce,
    setConfig,
    setMapDict,
    getState: () => ({
      running: detector.running,
      config: detector.config,
      cachedMapName: detector.cachedMapName,
      cachedMapLevel: detector.cachedMapLevel,
      cachedChannel: detector.cachedChannel,
      trackers: detector.trackers,
      lastScan: detector.lastScan
    })
  };

  window.addEventListener("DOMContentLoaded", mount);

  function mount() {
    if (document.getElementById("tosmDetectorPanel")) return;

    injectStyle();

    const panel = document.createElement("div");
    panel.id = "tosmDetectorPanel";
    panel.innerHTML = `
      <div class="td-head">
        <div>
          <div class="td-title">TOSM Detector</div>
          <div class="td-ver">v${VERSION}</div>
        </div>
        <button class="td-mini-btn" id="tdCollapseBtn" title="收合/展開">−</button>
      </div>

      <div id="tdBody">
        <div id="tdStatus" class="td-status">尚未啟動</div>

        <div class="td-row">
          <button id="tdStartBtn" class="td-btn td-primary">開始擷取</button>
          <button id="tdStopBtn" class="td-btn">停止</button>
        </div>

        <div class="td-row td-row-compact">
          <label class="td-check"><input id="tdAutoSubmit" type="checkbox" checked> 自動送出</label>
          <label class="td-check"><input id="tdConfirm" type="checkbox"> 送出前確認</label>
          <label class="td-check"><input id="tdDebug" type="checkbox"> Debug</label>
        </div>

        <div class="td-grid">
          <div>地圖</div><div id="tdMap">?</div>
          <div>分流</div><div id="tdCh">?</div>
          <div>條色</div><div id="tdBar">?</div>
          <div>進度</div><div id="tdProgress">?</div>
          <div>階段</div><div id="tdPhase">?</div>
          <div>穩定</div><div id="tdStable">0</div>
        </div>

        <div id="tdManualBox" class="td-manual" style="display:none;">
          <div class="td-warn">目前只看到紅條，無法判斷是第幾階段。請手動校正一次：</div>
          <div class="td-row">
            <button class="td-phase" data-phase="1">R1</button>
            <button class="td-phase" data-phase="2">R2</button>
            <button class="td-phase" data-phase="3">R3</button>
            <button class="td-phase" data-phase="4">R4</button>
          </div>
        </div>

        <div id="tdConfirmBox" class="td-confirm" style="display:none;">
          <div id="tdConfirmText" class="td-confirm-text"></div>
          <div class="td-row">
            <button id="tdConfirmSend" class="td-btn td-primary">送出</button>
            <button id="tdConfirmIgnore" class="td-btn">忽略</button>
          </div>
        </div>

        <canvas id="tdDebugCanvas" style="display:none;"></canvas>
      </div>
    `;

    document.body.appendChild(panel);

    $("tdStartBtn").onclick = start;
    $("tdStopBtn").onclick = stop;
    $("tdCollapseBtn").onclick = toggleCollapse;

    $("tdAutoSubmit").onchange = e => {
      detector.config.autoSubmit = !!e.target.checked;
    };
    $("tdConfirm").onchange = e => {
      detector.config.confirmBeforeSubmit = !!e.target.checked;
    };
    $("tdDebug").onchange = e => {
      detector.config.debug = !!e.target.checked;
      const c = $("tdDebugCanvas");
      if (c) c.style.display = detector.config.debug ? "block" : "none";
    };

    panel.querySelectorAll(".td-phase").forEach(btn => {
      btn.onclick = () => {
        const phase = parseInt(btn.dataset.phase, 10);
        applyManualPhase(phase);
      };
    });

    $("tdConfirmSend").onclick = () => {
      const pending = detector.pendingConfirm;
      detector.pendingConfirm = null;
      hideConfirmBox();
      if (pending) submitResult(pending, true);
    };

    $("tdConfirmIgnore").onclick = () => {
      detector.pendingConfirm = null;
      hideConfirmBox();
      setStatus("已忽略本次結果", "muted");
    };
  }

  function unmount() {
    stop();
    const panel = document.getElementById("tosmDetectorPanel");
    if (panel) panel.remove();
    const style = document.getElementById("tosmDetectorStyle");
    if (style) style.remove();
  }

  async function start() {
    try {
      if (!window.saveBoss || typeof window.saveBoss !== "function") {
        alert("偵測器找不到 saveBoss()。請把 detector-v0.6.4.js 放在主程式 <script> 後面載入。");
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("此瀏覽器不支援螢幕/視窗擷取。請使用新版 Chrome / Edge。");
        return;
      }

      detector.stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 10,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });

      detector.video = document.createElement("video");
      detector.video.srcObject = detector.stream;
      detector.video.muted = true;
      detector.video.playsInline = true;
      await detector.video.play();

      detector.canvas = document.createElement("canvas");
      detector.ctx = detector.canvas.getContext("2d", { willReadFrequently: true });

      detector.stream.getVideoTracks().forEach(track => {
        track.addEventListener("ended", () => stop());
      });

      detector.running = true;
      detector.lastOcrAt = 0;
      detector.cachedMapName = "";
      detector.cachedMapLevel = "";
      detector.cachedChannel = "";

      setStatus("擷取中，等待畫面穩定…", "ok");
      updatePanelFields({});

      detector.loopTimer = setInterval(scanOnce, detector.config.scanIntervalMs);
      await scanOnce();
    } catch (err) {
      console.error("[TOSMDetector] start failed", err);
      setStatus("啟動失敗或未授權擷取", "bad");
      stop();
    }
  }

  function stop() {
    if (detector.loopTimer) clearInterval(detector.loopTimer);
    detector.loopTimer = null;

    if (detector.stream) {
      detector.stream.getTracks().forEach(t => t.stop());
    }

    detector.running = false;
    detector.stream = null;
    detector.video = null;
    detector.canvas = null;
    detector.ctx = null;
    hideManualBox();
    hideConfirmBox();
    setStatus("已停止", "muted");
  }

  async function scanOnce() {
    if (!detector.video || !detector.ctx) return;
    if (detector.video.readyState < 2) return;

    const w = detector.video.videoWidth;
    const h = detector.video.videoHeight;
    if (!w || !h) return;

    detector.canvas.width = w;
    detector.canvas.height = h;
    detector.ctx.drawImage(detector.video, 0, 0, w, h);

    const now = Date.now();
    let mapName = detector.cachedMapName;
    let mapLevel = detector.cachedMapLevel;
    let channel = detector.cachedChannel;

    if (now - detector.lastOcrAt >= detector.config.ocrIntervalMs) {
      detector.lastOcrAt = now;

      const ocrResult = await readMapAndChannel(w, h);
      if (ocrResult.mapName) {
        mapName = ocrResult.mapName;
        detector.cachedMapName = mapName;
      }
      if (ocrResult.mapLevel) {
        mapLevel = ocrResult.mapLevel;
        detector.cachedMapLevel = mapLevel;
      }
      if (ocrResult.channel) {
        channel = ocrResult.channel;
        detector.cachedChannel = channel;
      }
    }

    const progress = detectBossProgress(w, h);

    detector.lastScan = {
      mapName,
      mapLevel,
      channel,
      progress,
      time: now
    };

    if (detector.config.debug) drawDebug(w, h, progress);

    updatePanelFields({ mapName, mapLevel, channel, progress });

    if (!mapLevel || !channel) {
      setStatus(`辨識中：地圖=${mapName || "?"} 分流=${channel || "?"}`, "warn");
      return;
    }

    const state = updateBossPhase(mapLevel, channel, progress);
    updatePanelFields({ mapName, mapLevel, channel, progress, state });

    if (!state) {
      const p = Number.isFinite(progress.progress) ? Math.round(progress.progress * 100) : 0;
      setStatus(`觀察中：${mapLevel}-${channel} ${progress.barType} ${p}%`, "muted");
      return;
    }

    handleStableResult({
      mapLevel,
      channel,
      state,
      rawMapName: mapName,
      barType: progress.barType,
      progress: progress.progress
    });
  }

  async function readMapAndChannel(w, h) {
    const out = { mapName: "", mapLevel: "", channel: "" };

    try {
      const mapRoi = getRoi("mapName", w, h);
      const chRoi = getRoi("channel", w, h);

      const mapText = await ocrRoi(mapRoi, "chi_tra+eng", "map");
      const chText = await ocrRoi(chRoi, "eng", "channel");

      out.mapName = normalizeMapText(mapText);
      out.mapLevel = resolveMapLevel(out.mapName);
      out.channel = parseChannel(chText);

      // 有些 OCR 會把 CH 與數字讀壞，從原始 channel ROI 的亮字再跑一次簡易解析。
      if (!out.channel) out.channel = parseChannel(normalizeAscii(chText));
    } catch (err) {
      console.warn("[TOSMDetector] OCR failed", err);
    }

    return out;
  }

  async function ocrRoi(roi, lang, mode) {
    if (!window.Tesseract) {
      console.warn("[TOSMDetector] Tesseract.js 未載入，無法 OCR 地圖與分流。", { mode });
      return "";
    }

    const tmp = document.createElement("canvas");
    const scale = mode === "channel" ? 4 : 3;
    tmp.width = Math.max(1, roi.w * scale);
    tmp.height = Math.max(1, roi.h * scale);

    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(detector.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, tmp.width, tmp.height);

    preprocessForOcr(tctx, tmp.width, tmp.height, mode);

    const options = {
      logger: () => {}
    };

    if (mode === "channel") {
      options.tessedit_char_whitelist = "CHch.：:0123456789 ";
    }

    const result = await window.Tesseract.recognize(tmp, lang, options);
    return (result && result.data && result.data.text) ? result.data.text : "";
  }

  function preprocessForOcr(tctx, w, h, mode) {
    const img = tctx.getImageData(0, 0, w, h);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const gray = r * 0.299 + g * 0.587 + b * 0.114;

      let v;
      if (mode === "channel") {
        // CH 文字偏青藍色，保留亮色與青色。
        const cyan = g > 110 && b > 110 && r < 130;
        v = (gray > 135 || cyan || max - min > 70) ? 255 : 0;
      } else {
        // 地圖名稱白字，有陰影，使用較寬鬆門檻。
        v = gray > 100 ? 255 : 0;
      }

      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }

    tctx.putImageData(img, 0, 0);
  }

  function detectBossProgress(w, h) {
    const roi = getRoi("bossCircle", w, h);
    const img = detector.ctx.getImageData(roi.x, roi.y, roi.w, roi.h);

    const white = estimateRingProgress(img, "white");
    const red = estimateRingProgress(img, "red");
    const on = detectOnVisual(img);

    let barType = "none";
    let progress = 0;
    let confidence = 0;

    if (on.confidence >= 0.50) {
      barType = "on";
      progress = 1;
      confidence = on.confidence;
    } else if (white.confidence >= detector.config.ring.whiteThreshold && white.confidence >= red.confidence * 1.12) {
      barType = "white";
      progress = white.progress;
      confidence = white.confidence;
    } else if (red.confidence >= detector.config.ring.redThreshold) {
      barType = "red";
      progress = red.progress;
      confidence = red.confidence;
    }

    return {
      barType,
      progress: clamp01(progress),
      confidence,
      white,
      red,
      on,
      roi
    };
  }

  function estimateRingProgress(imageData, colorType) {
    const { width, height, data } = imageData;
    const cx = width / 2;
    const cy = height / 2;
    const baseR = Math.min(width, height) * detector.config.ring.radiusRatio;
    const thickness = Math.max(2, Math.min(width, height) * detector.config.ring.thicknessRatio);
    const sampleCount = detector.config.ring.sampleCount;

    const hitByAngle = [];
    let hitAngles = 0;

    for (let i = 0; i < sampleCount; i++) {
      // 從 12 點鐘方向開始，順時針。
      const angle = -Math.PI / 2 + (Math.PI * 2 * i / sampleCount);
      let angleHit = false;

      for (let rr = -thickness; rr <= thickness; rr += 2) {
        const r = baseR + rr;
        const x = Math.round(cx + Math.cos(angle) * r);
        const y = Math.round(cy + Math.sin(angle) * r);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;

        const idx = (y * width + x) * 4;
        const px = {
          r: data[idx],
          g: data[idx + 1],
          b: data[idx + 2],
          a: data[idx + 3]
        };

        if (isColorHit(px, colorType)) {
          angleHit = true;
          break;
        }
      }

      hitByAngle.push(angleHit);
      if (angleHit) hitAngles++;
    }

    const confidence = hitAngles / sampleCount;
    const progress = contiguousProgressFromTop(hitByAngle);

    return {
      progress,
      confidence,
      hitAngles,
      sampleCount
    };
  }

  function contiguousProgressFromTop(hits) {
    if (!hits.length) return 0;

    // 容許少量斷裂：例如光效或壓縮造成中間斷點。
    let count = 0;
    let missRun = 0;
    const maxMissRun = 3;

    for (let i = 0; i < hits.length; i++) {
      if (hits[i]) {
        count = i + 1;
        missRun = 0;
      } else {
        missRun++;
        if (missRun > maxMissRun) break;
      }
    }

    return clamp01(count / hits.length);
  }

  function isColorHit(px, type) {
    const { r, g, b, a } = px;
    if (a < 60) return false;

    if (type === "red") {
      return r >= 135 && g <= 105 && b <= 105 && r > g * 1.28 && r > b * 1.28;
    }

    if (type === "white") {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      return max >= 155 && max - min <= 65;
    }

    return false;
  }

  function detectOnVisual(imageData) {
    // ON 狀態實際畫面未提供完整樣本，因此這裡做保守判斷：
    // 1. 紅色環接近滿圈；或
    // 2. 圖示中心高亮/金紅大量出現。
    // 建議實際取得 ON 截圖後再微調。
    const red = estimateRingProgress(imageData, "red");

    const { data } = imageData;
    let goldOrRed = 0;
    let valid = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 60) continue;

      const bright = r + g + b > 220;
      if (bright) valid++;

      const gold = r > 150 && g > 95 && g < 190 && b < 100;
      const redish = r > 150 && g < 95 && b < 95;
      if (gold || redish) goldOrRed++;
    }

    const colorRatio = valid ? goldOrRed / valid : 0;
    const confidence = Math.max(
      red.progress >= 0.94 && red.confidence >= 0.32 ? 0.60 : 0,
      colorRatio >= 0.23 ? 0.52 : 0
    );

    return { confidence, colorRatio, red };
  }

  function updateBossPhase(mapLevel, channel, detected) {
    const id = `${mapLevel}_${channel}`;
    const tracker = getTracker(id, mapLevel, channel, detected);

    const barType = detected.barType;
    const progress = detected.progress;

    // ON 後看到白條，視為 BOSS 已被擊殺並回等待。
    if (tracker.phase === 5 && (barType === "white" || barType === "none")) {
      tracker.phase = 0;
      tracker.lastProgress = progress;
      tracker.lastBarType = barType;
      tracker.initialized = true;
      return "XX";
    }

    if (barType === "on") {
      tracker.phase = 5;
      tracker.lastProgress = progress;
      tracker.lastBarType = barType;
      tracker.initialized = true;
      return "ON";
    }

    if (barType === "white") {
      hideManualBox();

      if (!tracker.initialized) {
        tracker.phase = 0;
        tracker.initialized = true;
      }

      // 白條跑滿一圈並重置，進入階段 1。
      if (isProgressReset(tracker, "white", progress)) {
        tracker.phase = 1;
      }

      // 如果已經有共享資料是 R1~R4，但畫面仍是白條，不急著倒退，避免 OCR/色彩誤判。
      if (tracker.phase <= 0) {
        tracker.lastProgress = progress;
        tracker.lastBarType = barType;
        return "XX";
      }

      tracker.lastProgress = progress;
      tracker.lastBarType = barType;
      return phaseToValue(tracker.phase);
    }

    if (barType === "red") {
      if (!tracker.initialized) {
        const initPhase = inferInitialPhaseFromCurrentData(id, detected);
        if (initPhase == null) {
          showManualBox(id);
          tracker.lastProgress = progress;
          tracker.lastBarType = barType;
          return null;
        }
        tracker.phase = initPhase;
        tracker.initialized = true;
      }

      // 剛從白條進紅條，代表至少階段 1。
      if (tracker.lastBarType === "white" && tracker.phase === 0) {
        tracker.phase = 1;
      }

      // 紅條跑滿並回起點，階段 +1。
      if (isProgressReset(tracker, "red", progress)) {
        tracker.phase += 1;
      }

      if (tracker.phase >= 5) {
        tracker.phase = 5;
        tracker.lastProgress = progress;
        tracker.lastBarType = barType;
        return "ON";
      }

      if (tracker.phase <= 0) tracker.phase = 1;

      tracker.lastProgress = progress;
      tracker.lastBarType = barType;
      hideManualBox();
      return phaseToValue(tracker.phase);
    }

    // 無法辨識時不更新狀態，避免誤送。
    return null;
  }

  function getTracker(id, mapLevel, channel, detected) {
    if (!detector.trackers[id]) {
      const initPhase = inferInitialPhaseFromCurrentData(id, detected);
      detector.trackers[id] = {
        id,
        mapLevel,
        channel,
        phase: initPhase == null ? 0 : initPhase,
        initialized: initPhase != null,
        lastProgress: 0,
        lastBarType: "none",
        lastSubmittedValue: "",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }
    return detector.trackers[id];
  }

  function inferInitialPhaseFromCurrentData(id, detected) {
    const existing = window.currentData && window.currentData[id];
    if (existing && existing.lastInput != null) {
      const uv = String(existing.lastInput).toUpperCase();

      if (uv === "ON") return 5;
      if (uv.startsWith("XX") || uv.startsWith("DE")) return 0;

      const r = uv.match(/^R(\d+(?:\.\d+)?)/);
      if (r) {
        const phase = Math.floor(parseFloat(r[1]));
        if (phase >= 1 && phase <= 4) return phase;
      }

      // 相容 001 / 0015 / 004 等輸入格式。
      if (uv.startsWith("00")) {
        const raw = uv.replace(/^00/, "");
        const phase = Math.floor(parseFloat(raw[0] || "0"));
        if (phase >= 1 && phase <= 4) return phase;
      }
    }

    if (detected && detected.barType === "white") return 0;
    if (detected && detected.barType === "on") return 5;

    return null;
  }

  function isProgressReset(tracker, expectedBarType, currentProgress) {
    if (tracker.lastBarType !== expectedBarType) return false;

    const from = detector.config.ring.resetFrom;
    const to = detector.config.ring.resetTo;

    return tracker.lastProgress >= from && currentProgress <= to;
  }

  function phaseToValue(phase) {
    if (phase >= 5) return "ON";
    if (phase <= 0) return "XX";
    return `R${phase}`;
  }

  function handleStableResult(result) {
    const key = `${result.mapLevel}_${result.channel}_${result.state}`;

    if (key === detector.lastCandidateKey) {
      detector.stableCount++;
    } else {
      detector.lastCandidateKey = key;
      detector.stableCount = 1;
    }

    updatePanelFields({ state: result.state });
    const p = Number.isFinite(result.progress) ? Math.round(result.progress * 100) : "?";
    setStatus(`候選：${result.mapLevel}-${result.channel} ${result.state} ${result.barType} ${p}% / ${detector.stableCount}`, detector.stableCount >= detector.config.stableNeed ? "ok" : "muted");

    if (detector.stableCount < detector.config.stableNeed) return;
    if (!detector.config.autoSubmit) return;

    const now = Date.now();
    if (key === detector.lastSubmitKey && now - detector.lastSubmitAt < detector.config.submitCooldownMs) return;

    if (detector.config.confirmBeforeSubmit) {
      showConfirmBox(result);
      return;
    }

    submitResult(result, false);
  }

  function submitResult(result, forced) {
    const key = `${result.mapLevel}_${result.channel}_${result.state}`;
    const now = Date.now();

    if (!forced && key === detector.lastSubmitKey && now - detector.lastSubmitAt < detector.config.submitCooldownMs) return;

    detector.lastSubmitKey = key;
    detector.lastSubmitAt = now;

    try {
      window.saveBoss(result.mapLevel, result.channel, result.state, false);
      setStatus(`已送出：${result.mapLevel}-${result.channel} ${result.state}`, "ok");
    } catch (err) {
      console.error("[TOSMDetector] saveBoss failed", err);
      setStatus("送出失敗，請查看 console", "bad");
    }
  }

  function showConfirmBox(result) {
    detector.pendingConfirm = result;
    const box = $("tdConfirmBox");
    const text = $("tdConfirmText");
    if (!box || !text) return;
    text.textContent = `確認送出：${result.mapLevel}-${result.channel} ${result.state}`;
    box.style.display = "block";
  }

  function hideConfirmBox() {
    const box = $("tdConfirmBox");
    if (box) box.style.display = "none";
  }

  function showManualBox(id) {
    detector.manualPhaseTarget = id;
    const box = $("tdManualBox");
    if (box) box.style.display = "block";
  }

  function hideManualBox() {
    detector.manualPhaseTarget = null;
    const box = $("tdManualBox");
    if (box) box.style.display = "none";
  }

  function applyManualPhase(phase) {
    const id = detector.manualPhaseTarget;
    if (!id) return;

    if (!detector.trackers[id]) {
      const parts = id.split("_");
      detector.trackers[id] = {
        id,
        mapLevel: parts[0],
        channel: parts[1],
        phase,
        initialized: true,
        lastProgress: 0,
        lastBarType: "red",
        lastSubmittedValue: "",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    } else {
      detector.trackers[id].phase = phase;
      detector.trackers[id].initialized = true;
    }

    hideManualBox();
    setStatus(`已手動校正：${id.replace("_", "-")} R${phase}`, "ok");
  }

  function getRoi(name, w, h) {
    const r = detector.config.roi[name];
    return {
      x: Math.max(0, Math.floor(r.x * w)),
      y: Math.max(0, Math.floor(r.y * h)),
      w: Math.max(1, Math.floor(r.w * w)),
      h: Math.max(1, Math.floor(r.h * h))
    };
  }

  function resolveMapLevel(mapName) {
    if (!mapName) return "";

    if (MAP_NAME_TO_LEVEL[mapName]) return MAP_NAME_TO_LEVEL[mapName];

    let bestName = "";
    let bestScore = 0;

    Object.keys(MAP_NAME_TO_LEVEL).forEach(name => {
      const score = similarity(mapName, name);
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    });

    return bestScore >= 0.52 ? MAP_NAME_TO_LEVEL[bestName] : "";
  }

  function parseChannel(text) {
    const s = normalizeAscii(text);
    const m = s.match(/CH\.?\s*[:：]?\s*(\d{1,2})/i) || s.match(/\b(\d{1,2})\b/);
    return m ? String(parseInt(m[1], 10)) : "";
  }

  function normalizeMapText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .replace(/[|｜]/g, "")
      .replace(/[\[\]{}()（）【】]/g, "")
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
      .trim();
  }

  function normalizeAscii(text) {
    return String(text || "")
      .replace(/[ＯO]/g, "0")
      .replace(/[ｌlI]/g, "1")
      .replace(/[ＳS]/g, "5")
      .replace(/[^A-Za-z0-9:.：\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function similarity(a, b) {
    a = normalizeMapText(a);
    b = normalizeMapText(b);
    if (!a || !b) return 0;

    // 字元重疊分數。
    let hit = 0;
    const used = new Array(b.length).fill(false);
    for (const ch of a) {
      const idx = b.split("").findIndex((c, i) => !used[i] && c === ch);
      if (idx >= 0) {
        used[idx] = true;
        hit++;
      }
    }

    return hit / Math.max(a.length, b.length);
  }

  function drawDebug(w, h, progress) {
    const debug = $("tdDebugCanvas");
    if (!debug || !detector.canvas) return;

    const scale = 0.28;
    debug.width = Math.floor(w * scale);
    debug.height = Math.floor(h * scale);
    debug.style.width = debug.width + "px";
    debug.style.height = debug.height + "px";

    const dctx = debug.getContext("2d");
    dctx.drawImage(detector.canvas, 0, 0, debug.width, debug.height);

    dctx.lineWidth = 2;
    drawRoiBox(dctx, "mapName", w, h, scale, "#00ff00");
    drawRoiBox(dctx, "channel", w, h, scale, "#00aaff");
    drawRoiBox(dctx, "bossCircle", w, h, scale, "#ff3333");

    dctx.fillStyle = "rgba(0,0,0,.75)";
    dctx.fillRect(4, 4, 240, 44);
    dctx.fillStyle = "#fff";
    dctx.font = "12px monospace";
    dctx.fillText(`bar=${progress.barType} p=${Math.round(progress.progress * 100)}%`, 10, 22);
    dctx.fillText(`red=${Math.round(progress.red.confidence * 100)} white=${Math.round(progress.white.confidence * 100)}`, 10, 40);
  }

  function drawRoiBox(dctx, name, w, h, scale, color) {
    const r = getRoi(name, w, h);
    dctx.strokeStyle = color;
    dctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  }

  function updatePanelFields(data) {
    if (data.mapLevel || data.mapName) {
      setText("tdMap", data.mapLevel ? `${data.mapLevel} (${data.mapName || ""})` : (data.mapName || "?"));
    }
    if (data.channel) setText("tdCh", data.channel);
    if (data.progress) {
      setText("tdBar", `${data.progress.barType} ${Math.round(data.progress.confidence * 100)}%`);
      setText("tdProgress", `${Math.round(data.progress.progress * 100)}%`);
    }
    if (data.state) setText("tdPhase", data.state);
    setText("tdStable", String(detector.stableCount || 0));
  }

  function setStatus(text, type) {
    const el = $("tdStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `td-status ${type || ""}`;
  }

  function toggleCollapse() {
    const body = $("tdBody");
    const btn = $("tdCollapseBtn");
    if (!body || !btn) return;

    const closed = body.style.display === "none";
    body.style.display = closed ? "block" : "none";
    btn.textContent = closed ? "−" : "+";
  }

  function setConfig(partialConfig) {
    deepMerge(detector.config, partialConfig || {});
    const auto = $("tdAutoSubmit");
    const confirm = $("tdConfirm");
    const debug = $("tdDebug");
    if (auto) auto.checked = !!detector.config.autoSubmit;
    if (confirm) confirm.checked = !!detector.config.confirmBeforeSubmit;
    if (debug) debug.checked = !!detector.config.debug;
  }

  function setMapDict(dict) {
    Object.assign(MAP_NAME_TO_LEVEL, dict || {});
  }

  function injectStyle() {
    if (document.getElementById("tosmDetectorStyle")) return;
    const style = document.createElement("style");
    style.id = "tosmDetectorStyle";
    style.textContent = `
      #tosmDetectorPanel {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 99999;
        width: 260px;
        color: #aaa;
        background: rgba(0, 0, 0, .90);
        border: 1px solid #333;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.45);
        font: 12px/1.45 monospace;
        overflow: hidden;
      }
      #tosmDetectorPanel .td-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 9px 10px;
        border-bottom: 1px solid #222;
        background: rgba(15,15,15,.95);
      }
      #tosmDetectorPanel .td-title { color:#0f0; font-weight:bold; font-size:13px; }
      #tosmDetectorPanel .td-ver { color:#555; font-size:10px; }
      #tosmDetectorPanel #tdBody { padding: 10px; }
      #tosmDetectorPanel .td-status {
        min-height: 18px;
        padding: 6px 8px;
        margin-bottom: 8px;
        border-radius: 6px;
        background: #101010;
        border: 1px solid #222;
        color: #aaa;
        word-break: break-all;
      }
      #tosmDetectorPanel .td-status.ok { color:#0f0; border-color:#064; }
      #tosmDetectorPanel .td-status.warn { color:#ff0; border-color:#660; }
      #tosmDetectorPanel .td-status.bad { color:#f66; border-color:#733; }
      #tosmDetectorPanel .td-status.muted { color:#888; }
      #tosmDetectorPanel .td-row {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      #tosmDetectorPanel .td-row-compact { gap: 8px; }
      #tosmDetectorPanel .td-btn,
      #tosmDetectorPanel .td-mini-btn,
      #tosmDetectorPanel .td-phase {
        border: 1px solid #444;
        background: #111;
        color: #aaa;
        border-radius: 6px;
        padding: 5px 9px;
        cursor: pointer;
        font: inherit;
      }
      #tosmDetectorPanel .td-mini-btn {
        padding: 1px 7px;
        font-size: 14px;
        line-height: 1.2;
      }
      #tosmDetectorPanel .td-primary {
        border-color: #0f0;
        color: #0f0;
        background: #001800;
      }
      #tosmDetectorPanel .td-phase {
        border-color: #0a6;
        color: #0f0;
        min-width: 43px;
      }
      #tosmDetectorPanel .td-check {
        color: #888;
        font-size: 11px;
        white-space: nowrap;
      }
      #tosmDetectorPanel .td-check input {
        vertical-align: -2px;
        margin-right: 3px;
      }
      #tosmDetectorPanel .td-grid {
        display: grid;
        grid-template-columns: 48px 1fr;
        gap: 3px 8px;
        padding: 8px;
        border: 1px solid #222;
        border-radius: 8px;
        background: #080808;
        margin-bottom: 8px;
      }
      #tosmDetectorPanel .td-grid div:nth-child(odd) { color:#555; }
      #tosmDetectorPanel .td-grid div:nth-child(even) { color:#bbb; word-break: break-all; }
      #tosmDetectorPanel .td-manual,
      #tosmDetectorPanel .td-confirm {
        border: 1px solid #553;
        border-radius: 8px;
        padding: 8px;
        background: #151205;
        margin-bottom: 8px;
      }
      #tosmDetectorPanel .td-warn { color:#ffca28; margin-bottom: 7px; }
      #tosmDetectorPanel .td-confirm-text { color:#ffca28; margin-bottom: 7px; }
      #tosmDetectorPanel #tdDebugCanvas {
        display: block;
        max-width: 100%;
        border: 1px solid #333;
        border-radius: 6px;
        background: #000;
      }
    `;
    document.head.appendChild(style);
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function deepMerge(target, source) {
    for (const key of Object.keys(source || {})) {
      const val = source[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (!target[key] || typeof target[key] !== "object") target[key] = {};
        deepMerge(target[key], val);
      } else {
        target[key] = val;
      }
    }
    return target;
  }
})();
