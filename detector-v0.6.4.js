/*
 * TOS M FB TIME - Boss Detector v0.8.0
 * ------------------------------------------------------------
 * 合併版重點：
 * 1) Claude 方案 A：三特徵模板比對 + ±3px 錨點對齊 + 三規則拒答
 * 2) GPT 方案 B：中央公告 OCR + 狀態轉移約束 + currentData 現況防呆 + export/import
 * 3) 準確性優先：看不準就 UNKNOWN，不寫入 Firebase
 *
 * 載入方式：放在主程式 saveBoss() 已載入完成之後
 * <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
 * <script src="detector-v0.8.0.js"></script>
 *
 * 主程式需求：window.saveBoss(map, ch, value, false)、window.currentData
 */

(function () {
  "use strict";

  const VERSION = "0.8.0";
  const STORE_KEY = "tosm_detector_v080_store";

  const LABELS = {
    phase: ["WAITING", "R1", "R2", "R3", "R4", "ON"],
    channel: ["CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7", "CH8", "CH9", "CH10"]
  };

  const CONFIG = {
    scanIntervalMs: 320,
    mapOcrIntervalMs: 2200,
    announcementOcrIntervalMs: 800,
    announcementFreshMs: 4500,
    submitCooldownMs: 6000,

    // 視覺模板採信門檻
    template: {
      size: 32,
      alignRadius: 3,
      top1Min: 0.92,
      rivalDiffMin: 0.05,
      labelAvgMin: 0.88,
      weakMin: 0.88,
      maxTemplatesPerLabel: 10,
      weights: { edge: 0.50, zone: 0.35, pixel: 0.15 }
    },

    // 決策穩定條件
    stability: {
      veryHighTicks: 2,
      normalTicks: 3,
      weakTicks: 4
    },

    // 安全設定
    autoSubmit: false,
    confirmBeforeSubmit: true,
    autoSubmitWaiting: false,
    debug: false,
    previewScale: 0.30,

    // 預設 ROI；實機請先校正
    roi: {
      mapName: { x: 0.755, y: 0.315, w: 0.190, h: 0.060 },
      channel: { x: 0.930, y: 0.315, w: 0.065, h: 0.060 },
      phaseIcon: { x: 0.765, y: 0.145, w: 0.075, h: 0.105 },
      announcement: { x: 0.280, y: 0.245, w: 0.460, h: 0.145 },
      // 紅環搜尋區，只用於自動校正 phaseIcon ROI，不用來直接判斷階段
      ringSearch: { x: 0.720, y: 0.100, w: 0.190, h: 0.220 }
    },

    ring: {
      enabled: false,
      minRedPixels: 70,
      ransacIterations: 70,
      tolerance: 3.5,
      minInliers: 35
    }
  };

  const MAP_NAME_TO_LEVEL = {
    "夏奧雷伊西邊森林": "1",
    "夏奧雷伊東邊森林": "3",
    "蓮帕拉沙池塘": "5",
    "夏奧雷伊礦山村莊": "7",
    "水晶礦山": "9",
    "斯拉屋塔斯峽谷": "10",
    "凱利高原": "11",
    "奈普里塔斯懸崖": "12",
    "泰內花園": "13",
    "泰內聖堂地下1層": "15",
    "泰內聖堂地上1層": "17",
    "泰內聖堂地上2層": "19",
    "庫魯森林": "20",
    "克尼多斯森林": "21",
    "達旦森林": "22",
    "諾巴哈公會所": "24",
    "諾巴哈別館": "26",
    "諾巴哈本館": "28",
    "貝雅山谷": "30",
    "比爾塔溪谷": "31",
    "科博爾特森林": "32",
    "賽堤尼山溝": "34",
    "塔爾克神殿": "36",
    "安森塔水源地": "38",
    "卡羅利斯泉水": "40",
    "萊塔斯小溪": "42",
    "德幕爾佃農村": "44",
    "德幕爾莊園": "46",
    "德幕爾外城": "48",
    "達伊納養蜂地": "50",
    "比爾那森林": "51",
    "烏奇斯耕作地": "52",
    "春光森林": "53",
    "關口路": "55",
    "史爾特凱拉森林": "57",
    "克巴伊拉斯森林": "59",
    "魯卡斯高原": "60",
    "王之高原": "61",
    "札卡里耶爾交叉路": "62",
    "王陵1層": "64",
    "王陵2層": "66",
    "王陵3層": "68",
    "阿雷魯諾男爵嶺": "70",
    "水路橋地區": "70",
    "魔族收監所第1區": "71",
    "魔族收監所第3區": "72",
    "魔族收監所第4區": "73",
    "魔族收監所第5區": "74",
    "女神的古院": "75",
    "佩迪米安外城": "76",
    "魔法師之塔1層": "77",
    "魔法師之塔2層": "78",
    "魔法師之塔3層": "79",
    "大教堂懺悔路": "80",
    "大教堂正殿": "81",
    "大教堂大迴廊": "82",
    "大教堂至聖所": "83",
    "拉烏基美溼地": "85",
    "堤拉修道院": "86",
    "貝拉伊森林": "87",
    "潔拉哈": "88",
    "世伊魯森林": "89",
    "沿岸要塞": "90",
    "丁格巴希地區": "91",
    "大地要塞貯藏區域": "92",
    "大地要塞決戰地": "93",
    "阿勒篾森林": "95",
    "巴勒哈森林": "98",
    "卡雷伊瑪斯接見所": "101",
    "卡雷伊瑪斯拷問所": "103",
    "娜圖森林": "105",
    "史巴賓嘉斯森林": "107",
    "娜塔勒森林": "109",
    "泰芙林鐘乳洞1區域": "111",
    "泰芙林鐘乳洞 1區域": "111",
    "泰芙林鐘乳洞2區域": "113",
    "泰芙林鐘乳洞 2區域": "113",
    "杰洛梅爾廣場": "115",
    "尤那耶爾紀念區": "118",
    "坦尼爾1世紀念區": "120",
    "緹玫勒斯寺院": "123",
    "捷泰奧海岸": "125",
    "艾泰奧海岸": "128",
    "埃佩羅塔奧海岸": "130",
    "蘭庫22海域": "133",
    "泰萊希森林": "135",
    "沙烏席斯10館": "138",
    "巴蘭迪斯3館": "140",
    "巴蘭迪斯91館": "143",
    "諾貝禮爾森林": "145",
    "尤德伊安森林": "148",
    "那魯巴斯寺院": "150",
    "那魯巴斯寺院別館": "153"
  };

  const app = {
    store: loadStore(),
    running: false,
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    timer: null,

    featureCacheDirty: true,
    featureDB: { phase: {}, channel: {} },

    lastMapOcrAt: 0,
    lastAnnOcrAt: 0,
    cachedMapName: "",
    cachedMapLevel: "",
    cachedChannel: "",
    lastAnnouncement: null,
    lastRing: null,
    lastFrame: null,

    stableKey: "",
    stableCount: 0,
    lastSubmitKey: "",
    lastSubmitAt: 0,
    lastSubmittedByBoss: {},
    pendingConfirm: null,

    calibration: { active: false, target: null, dragging: false, start: null, current: null }
  };

  window.TOSMDetector = {
    version: VERSION,
    start,
    stop,
    mount,
    unmount,
    scanOnce,
    captureTemplate,
    exportData,
    importData,
    clearTemplates,
    setConfig,
    getState: () => JSON.parse(JSON.stringify({
      running: app.running,
      store: app.store,
      cachedMapName: app.cachedMapName,
      cachedMapLevel: app.cachedMapLevel,
      cachedChannel: app.cachedChannel,
      lastAnnouncement: app.lastAnnouncement,
      lastRing: app.lastRing,
      lastFrame: app.lastFrame
    }))
  };

  window.addEventListener("DOMContentLoaded", mount);

  function mount() {
    if ($("tosmDetectorPanel")) return;
    injectStyle();

    const panel = document.createElement("div");
    panel.id = "tosmDetectorPanel";
    panel.innerHTML = `
      <div class="td-head">
        <div>
          <div class="td-title">TOSM Detector</div>
          <div class="td-ver">v${VERSION}</div>
        </div>
        <button id="tdCompactBtn" class="td-icon-btn">−</button>
      </div>

      <div id="tdBody">
        <div id="tdStatus" class="td-status muted">尚未啟動</div>
        <div class="td-row">
          <button id="tdStartBtn" class="td-btn primary">▶ 開始擷取</button>
          <button id="tdStopBtn" class="td-btn">■ 停止</button>
        </div>

        <div class="td-switches">
          <label><input id="tdAutoSubmit" type="checkbox"> 自動送出</label>
          <label><input id="tdConfirm" type="checkbox" checked> 送出前確認</label>
          <label><input id="tdWaiting" type="checkbox"> 自動送出 XX</label>
          <label><input id="tdDebug" type="checkbox"> Debug</label>
          <label><input id="tdRing" type="checkbox"> 紅環自動校準</label>
        </div>

        <div class="td-grid">
          <div>地圖</div><div id="tdMap">?</div>
          <div>分流</div><div id="tdChannel">?</div>
          <div>徽章</div><div id="tdPhaseMatch">?</div>
          <div>公告</div><div id="tdAnnouncement">-</div>
          <div>決策</div><div id="tdDecision">-</div>
          <div>穩定</div><div id="tdStable">0</div>
        </div>

        <details id="tdAdvanced">
          <summary>進階 / ROI / 模板</summary>

          <div class="td-section">
            <div class="td-section-title">ROI 校正</div>
            <div class="td-small">開啟 Debug，點選目標後在預覽圖拖曳框選。</div>
            <div class="td-row compact">
              <button class="td-btn small" data-roi="mapName">地圖</button>
              <button class="td-btn small" data-roi="channel">分流</button>
              <button class="td-btn small" data-roi="phaseIcon">徽章</button>
              <button class="td-btn small" data-roi="announcement">公告</button>
              <button class="td-btn small" data-roi="ringSearch">紅環搜尋</button>
              <button id="tdResetRoi" class="td-btn small danger">重置</button>
            </div>
          </div>

          <div class="td-section">
            <div class="td-section-title">階段模板</div>
            <div class="td-small">畫面正確時按對應按鈕。每個標籤建議 3~5 張。</div>
            <div id="tdPhaseTplButtons" class="td-template-buttons"></div>
          </div>

          <div class="td-section">
            <div class="td-section-title">分流模板</div>
            <div id="tdChTplButtons" class="td-template-buttons"></div>
          </div>

          <div class="td-section">
            <div class="td-section-title">設定共享</div>
            <div class="td-row compact">
              <button id="tdExport" class="td-btn small">匯出</button>
              <button id="tdImport" class="td-btn small">匯入</button>
              <button id="tdClearTpl" class="td-btn small danger">清除模板</button>
            </div>
            <textarea id="tdDataBox" class="td-textarea" placeholder="匯出/匯入 JSON"></textarea>
          </div>

          <canvas id="tdPreview" class="td-preview"></canvas>
        </details>

        <div id="tdConfirmBox" class="td-confirm" style="display:none;">
          <div id="tdConfirmText"></div>
          <div class="td-row compact">
            <button id="tdConfirmSend" class="td-btn primary small">送出</button>
            <button id="tdConfirmIgnore" class="td-btn small">忽略</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindUi();
    renderTemplateButtons();
    updateTemplateCounts();
    updatePreviewVisibility();
  }

  function bindUi() {
    $("tdStartBtn").onclick = start;
    $("tdStopBtn").onclick = stop;
    $("tdCompactBtn").onclick = toggleCompact;
    $("tdResetRoi").onclick = resetRoi;
    $("tdExport").onclick = () => { $("tdDataBox").value = exportData(); };
    $("tdImport").onclick = () => importData($("tdDataBox").value);
    $("tdClearTpl").onclick = () => {
      if (confirm("確定清除全部模板？ROI 不會刪除。")) clearTemplates();
    };

    $("tdAutoSubmit").onchange = e => { CONFIG.autoSubmit = !!e.target.checked; };
    $("tdConfirm").onchange = e => { CONFIG.confirmBeforeSubmit = !!e.target.checked; };
    $("tdWaiting").onchange = e => { CONFIG.autoSubmitWaiting = !!e.target.checked; };
    $("tdDebug").onchange = e => { CONFIG.debug = !!e.target.checked; updatePreviewVisibility(); };
    $("tdRing").onchange = e => { CONFIG.ring.enabled = !!e.target.checked; };

    $("tdConfirmSend").onclick = () => {
      const d = app.pendingConfirm;
      app.pendingConfirm = null;
      hideConfirm();
      if (d) submitDecision(d, true);
    };
    $("tdConfirmIgnore").onclick = () => {
      app.pendingConfirm = null;
      hideConfirm();
      setStatus("已忽略候選", "muted");
    };

    document.querySelectorAll("#tosmDetectorPanel [data-roi]").forEach(btn => {
      btn.onclick = () => beginCalibration(btn.dataset.roi);
    });

    setupPreviewEvents();
  }

  function unmount() {
    stop();
    const p = $("tosmDetectorPanel");
    if (p) p.remove();
    const s = $("tosmDetectorStyle");
    if (s) s.remove();
  }

  async function start() {
    try {
      if (!window.saveBoss || typeof window.saveBoss !== "function") {
        alert("找不到 window.saveBoss()，請把 detector-v0.8.0.js 放在主程式之後載入。");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("瀏覽器不支援視窗擷取，請使用新版 Chrome / Edge。");
        return;
      }

      rebuildFeatureCache();
      app.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 12, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });
      app.video = document.createElement("video");
      app.video.srcObject = app.stream;
      app.video.muted = true;
      app.video.playsInline = true;
      await app.video.play();

      app.canvas = document.createElement("canvas");
      app.ctx = app.canvas.getContext("2d", { willReadFrequently: true });
      app.running = true;
      app.lastMapOcrAt = 0;
      app.lastAnnOcrAt = 0;
      app.stream.getVideoTracks().forEach(t => t.addEventListener("ended", stop));

      setStatus("擷取中，請確認選的是遊戲視窗", "ok");
      app.timer = setInterval(scanOnce, CONFIG.scanIntervalMs);
      await scanOnce();
    } catch (err) {
      console.error("[TOSMDetector] start failed", err);
      setStatus("擷取失敗或取消授權", "bad");
      stop();
    }
  }

  function stop() {
    if (app.timer) clearInterval(app.timer);
    app.timer = null;
    if (app.stream) app.stream.getTracks().forEach(t => t.stop());
    app.stream = null;
    app.video = null;
    app.canvas = null;
    app.ctx = null;
    app.running = false;
    setStatus("已停止", "muted");
  }

  async function scanOnce() {
    if (!app.video || app.video.readyState < 2 || !app.ctx) return;

    const w = app.video.videoWidth;
    const h = app.video.videoHeight;
    if (!w || !h) return;

    app.canvas.width = w;
    app.canvas.height = h;
    app.ctx.drawImage(app.video, 0, 0, w, h);

    if (CONFIG.ring.enabled) autoCalibratePhaseByRing(w, h);

    const now = Date.now();
    const phaseMatch = matchRoi("phase", "phaseIcon", w, h);
    const chMatch = matchRoi("channel", "channel", w, h);

    if (now - app.lastMapOcrAt >= CONFIG.mapOcrIntervalMs) {
      app.lastMapOcrAt = now;
      await updateMapAndChannel(w, h, chMatch);
    } else if (chMatch.label && !chMatch.rejected && chMatch.label.startsWith("CH")) {
      app.cachedChannel = chMatch.label.replace("CH", "");
    }

    if (now - app.lastAnnOcrAt >= CONFIG.announcementOcrIntervalMs) {
      app.lastAnnOcrAt = now;
      const ann = await recognizeAnnouncement(w, h);
      if (ann && ann.value) app.lastAnnouncement = ann;
    }

    const decision = makeDecision(phaseMatch, chMatch);

    app.lastFrame = {
      mapName: app.cachedMapName,
      mapLevel: app.cachedMapLevel,
      channel: app.cachedChannel,
      phaseMatch,
      chMatch,
      announcement: getFreshAnnouncement(),
      decision,
      time: now
    };

    updatePanel(app.lastFrame);
    if (CONFIG.debug) drawPreview(w, h);
    if (decision && decision.value) handleDecision(decision);
  }

  async function updateMapAndChannel(w, h, chMatch) {
    if (!window.Tesseract) {
      setStatus("Tesseract.js 未載入，OCR 不可用", "warn");
      return;
    }
    try {
      const mapText = await ocrRoi("mapName", "chi_tra+eng", "map", w, h);
      const map = resolveMap(normalizeMapText(mapText));
      if (map.level && map.score >= 0.45) {
        app.cachedMapName = map.name;
        app.cachedMapLevel = map.level;
      }

      let ch = "";
      if (chMatch.label && !chMatch.rejected && chMatch.score >= CONFIG.template.weakMin) {
        ch = chMatch.label.replace("CH", "");
      }
      if (!ch) {
        const chText = await ocrRoi("channel", "eng", "channel", w, h);
        ch = parseChannel(chText);
      }
      if (ch) app.cachedChannel = ch;
    } catch (err) {
      console.warn("[TOSMDetector] OCR failed", err);
    }
  }

  async function recognizeAnnouncement(w, h) {
    if (!window.Tesseract) return null;
    try {
      const text = await ocrRoi("announcement", "chi_tra+eng", "announcement", w, h);
      const raw = String(text || "").replace(/\s+/g, "");
      let m = raw.match(/(?:警戒|憤怒|慎怒|提升|升|提高)[^1-4]{0,10}([1-4])[^階段]{0,4}階段/);
      if (!m) m = raw.match(/([1-4])階段/);
      if (m) return { value: `R${m[1]}`, raw, score: 0.92, time: Date.now() };
      if (/ON|On|on|復活|出現/.test(raw)) return { value: "ON", raw, score: 0.78, time: Date.now() };
      return { value: "", raw, score: 0, time: Date.now() };
    } catch (err) {
      console.warn("[TOSMDetector] announcement OCR failed", err);
      return null;
    }
  }

  function makeDecision(phaseMatch, chMatch) {
    const mapLevel = app.cachedMapLevel;
    const channel = app.cachedChannel || (chMatch.label ? chMatch.label.replace("CH", "") : "");
    if (!mapLevel || !channel) return null;

    const ann = getFreshAnnouncement();
    const tplOk = phaseMatch && phaseMatch.label && !phaseMatch.rejected;
    const tplWeak = phaseMatch && phaseMatch.label && phaseMatch.score >= CONFIG.template.weakMin && !phaseMatch.hardRejected;
    const tplValue = tplOk || tplWeak ? labelToValue(phaseMatch.label) : "";
    const annValue = ann && ann.value ? ann.value : "";

    let value = "";
    let confidence = "rejected";
    let score = 0;
    let reason = "";

    if (tplOk && annValue && sameStage(tplValue, annValue)) {
      value = tplValue;
      confidence = "very_high";
      score = Math.max(phaseMatch.score, ann.score, 0.96);
      reason = `徽章+公告一致；${ann.raw}`;
    } else if (tplOk && annValue && isStageConflict(tplValue, annValue)) {
      return unknown("徽章與公告衝突", phaseMatch, ann);
    } else if (tplOk && !annValue) {
      value = tplValue;
      confidence = phaseMatch.score >= CONFIG.template.top1Min ? "high" : "medium";
      score = phaseMatch.score;
      reason = `徽章通過：${phaseMatch.label} ${pct(phaseMatch.score)}`;
    } else if (!tplOk && annValue) {
      // 公告單獨通過，作為低信心，需要較高穩定或人工確認
      value = annValue;
      confidence = "low";
      score = ann.score * 0.85;
      reason = `僅公告：${ann.raw}`;
    } else if (tplWeak && annValue && sameStage(tplValue, annValue)) {
      value = tplValue;
      confidence = "medium";
      score = Math.max(phaseMatch.score, ann.score * 0.90);
      reason = `弱徽章+公告一致；${ann.raw}`;
    } else {
      return unknown(phaseMatch ? phaseMatch.rejectReason || "無可信訊號" : "無可信訊號", phaseMatch, ann);
    }

    if (value === "WAITING") value = "XX";
    if (value === "XX" && !CONFIG.autoSubmitWaiting) {
      return { mapLevel, channel, value, score, confidence, reason: `${reason}；XX 自動送出關閉`, blocked: true };
    }

    if (!isAllowedTransition(mapLevel, channel, value)) return null;
    if (isSameAsCurrent(mapLevel, channel, value)) return null;

    return { mapLevel, channel, value, score, confidence, reason, blocked: false };
  }

  function unknown(reason, phaseMatch, ann) {
    const text = reason || "UNKNOWN";
    setText("tdDecision", `UNKNOWN: ${text}`);
    return null;
  }

  function handleDecision(d) {
    const key = `${d.mapLevel}_${d.channel}_${d.value}_${d.confidence}`;
    if (key === app.stableKey) app.stableCount++;
    else {
      app.stableKey = key;
      app.stableCount = 1;
    }

    const need = stableNeedFor(d.confidence);

    if (d.blocked) {
      setStatus(`候選：${d.mapLevel}-${d.channel} ${d.value}，但未啟用 XX 自動送出`, "muted");
      return;
    }
    if (app.stableCount < need) {
      setStatus(`候選：${d.mapLevel}-${d.channel} ${d.value} ${d.confidence} / ${app.stableCount}/${need}`, "muted");
      return;
    }
    if (!CONFIG.autoSubmit) {
      setStatus(`已穩定但自動送出關閉：${d.mapLevel}-${d.channel} ${d.value}`, "warn");
      return;
    }
    if (CONFIG.confirmBeforeSubmit || d.confidence === "low") {
      showConfirm(d);
      return;
    }
    submitDecision(d, false);
  }

  function stableNeedFor(confidence) {
    if (confidence === "very_high") return CONFIG.stability.veryHighTicks;
    if (confidence === "low") return CONFIG.stability.weakTicks;
    return CONFIG.stability.normalTicks;
  }

  function submitDecision(d, forced) {
    const key = `${d.mapLevel}_${d.channel}_${d.value}`;
    const now = Date.now();
    if (!forced && key === app.lastSubmitKey && now - app.lastSubmitAt < CONFIG.submitCooldownMs) return;

    try {
      window.saveBoss(d.mapLevel, d.channel, d.value, false);
      app.lastSubmitKey = key;
      app.lastSubmitAt = now;
      app.lastSubmittedByBoss[`${d.mapLevel}_${d.channel}`] = d.value;
      setStatus(`已送出：${d.mapLevel}-${d.channel} ${d.value}`, "ok");
    } catch (err) {
      console.error("[TOSMDetector] saveBoss failed", err);
      setStatus("saveBoss 送出失敗，請查看 console", "bad");
    }
  }

  /* ---------------- TemplateDB: 三特徵 + 對齊 + 拒答 ---------------- */

  function matchRoi(group, roiName, w, h) {
    rebuildFeatureCache();
    const crop = cropRoiToCanvas(roiName, w, h, CONFIG.template.size, CONFIG.template.size);
    if (!crop) return rejectedResult("no_crop");
    const q = TemplateDB.extractFeatures(crop);
    return TemplateDB.match(group, q);
  }

  const TemplateDB = {
    extractFeatures(canvas) {
      const size = CONFIG.template.size;
      const gray = this._gray(canvas, size, size);
      const binary = this._otsuBinarize(gray);
      const edge = this._sobelEdge(gray, size, size);
      const zone = this._zoneFeatures(binary, size, size);
      const pixel = this._normalizeVector(gray);
      return { w: size, h: size, gray, binary, edge, zone, pixel };
    },

    match(group, queryFeat) {
      const labels = LABELS[group] || [];
      const db = app.featureDB[group] || {};
      const all = [];
      const byLabel = {};

      labels.forEach(label => {
        const list = db[label] || [];
        byLabel[label] = [];
        for (const tplFeat of list) {
          const s = this._alignAndScore(queryFeat, tplFeat);
          const item = { label, score: s.score, dx: s.dx, dy: s.dy };
          all.push(item);
          byLabel[label].push(item);
        }
      });

      if (!all.length) return rejectedResult("no_templates");
      all.sort((a, b) => b.score - a.score);
      const top1 = all[0];
      const rival = all.find(x => x.label !== top1.label) || { score: 0, label: "" };
      const sameLabelTop = byLabel[top1.label].slice().sort((a, b) => b.score - a.score).slice(0, 3);
      const sameAvg = sameLabelTop.reduce((s, x) => s + x.score, 0) / Math.max(1, sameLabelTop.length);

      let rejected = false;
      let hardRejected = false;
      let rejectReason = "";

      if (top1.score < CONFIG.template.top1Min) {
        rejected = true;
        rejectReason = `low_confidence ${pct(top1.score)}`;
      }
      if (top1.score - rival.score < CONFIG.template.rivalDiffMin) {
        rejected = true;
        hardRejected = true;
        rejectReason = `ambiguous ${top1.label}/${rival.label} diff=${pct(top1.score - rival.score)}`;
      }
      if (sameAvg < CONFIG.template.labelAvgMin) {
        rejected = true;
        rejectReason = `inconsistent_within_label avg=${pct(sameAvg)}`;
      }

      return {
        label: top1.label,
        score: top1.score,
        rivalLabel: rival.label,
        rivalScore: rival.score,
        diff: top1.score - rival.score,
        sameAvg,
        dx: top1.dx,
        dy: top1.dy,
        rejected,
        hardRejected,
        rejectReason,
        top: all.slice(0, 5)
      };
    },

    _alignAndScore(q, t) {
      const r = CONFIG.template.alignRadius;
      let best = { score: -Infinity, dx: 0, dy: 0 };
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const edgeScore = this._shiftedNcc(q.edge, t.edge, q.w, q.h, dx, dy);
          const pixelScore = this._shiftedNcc(q.pixel, t.pixel, q.w, q.h, dx, dy);
          const zoneScore = this._ncc(q.zone, t.zone);
          const total = CONFIG.template.weights.edge * edgeScore + CONFIG.template.weights.zone * zoneScore + CONFIG.template.weights.pixel * pixelScore;
          if (total > best.score) best = { score: total, dx, dy };
        }
      }
      best.score = clamp01((best.score + 1) / 2);
      return best;
    },

    _gray(canvas, w, h) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0, j = 0; i < img.length; i += 4, j++) out[j] = (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) / 255;
      return out;
    },

    _otsuBinarize(gray) {
      const hist = new Array(256).fill(0);
      for (const v of gray) hist[Math.max(0, Math.min(255, Math.round(v * 255)))]++;
      const total = gray.length;
      let sum = 0;
      for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, maxVar = -1, threshold = 128;
      for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB;
        const mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > maxVar) { maxVar = between; threshold = t; }
      }
      const out = new Float32Array(gray.length);
      for (let i = 0; i < gray.length; i++) out[i] = gray[i] * 255 >= threshold ? 1 : 0;
      return out;
    },

    _sobelEdge(gray, w, h) {
      const out = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
          const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
          out[i] = Math.sqrt(gx * gx + gy * gy);
        }
      }
      return this._normalizeVector(out);
    },

    _zoneFeatures(binary, w, h) {
      const zones = 4;
      const out = [];
      const zw = Math.floor(w / zones);
      const zh = Math.floor(h / zones);
      for (let zy = 0; zy < zones; zy++) {
        for (let zx = 0; zx < zones; zx++) {
          let sum = 0, count = 0;
          for (let y = zy * zh; y < (zy === zones - 1 ? h : (zy + 1) * zh); y++) {
            for (let x = zx * zw; x < (zx === zones - 1 ? w : (zx + 1) * zw); x++) {
              sum += binary[y * w + x];
              count++;
            }
          }
          out.push(count ? sum / count : 0);
        }
      }
      return this._normalizeVector(out);
    },

    _ncc(a, b) {
      if (!a || !b || a.length !== b.length) return -1;
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot;
    },

    _shiftedNcc(a, b, w, h, dx, dy) {
      let dot = 0, count = 0;
      for (let y = 0; y < h; y++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let x = 0; x < w; x++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          dot += a[y * w + x] * b[yy * w + xx];
          count++;
        }
      }
      return count ? dot : -1;
    },

    _normalizeVector(arr) {
      const out = new Float32Array(arr.length);
      let mean = 0;
      for (let i = 0; i < arr.length; i++) mean += arr[i];
      mean /= Math.max(1, arr.length);
      let norm = 0;
      for (let i = 0; i < arr.length; i++) {
        out[i] = arr[i] - mean;
        norm += out[i] * out[i];
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < out.length; i++) out[i] /= norm;
      return out;
    }
  };

  function rejectedResult(reason) {
    return { label: "", score: 0, rejected: true, hardRejected: true, rejectReason: reason || "rejected", top: [] };
  }

  function rebuildFeatureCache() {
    if (!app.featureCacheDirty) return;
    app.featureDB = { phase: {}, channel: {} };
    for (const group of ["phase", "channel"]) {
      const source = app.store.templates[group] || {};
      for (const label of Object.keys(source)) {
        app.featureDB[group][label] = [];
        for (const tpl of source[label]) {
          if (tpl.canvas) app.featureDB[group][label].push(TemplateDB.extractFeatures(tpl.canvas));
        }
      }
    }
    app.featureCacheDirty = false;
  }

  /* ---------------- 紅環 RANSAC：只用於自動推導徽章 ROI ---------------- */

  function autoCalibratePhaseByRing(w, h) {
    const search = getRoiPx("ringSearch", w, h);
    const img = app.ctx.getImageData(search.x, search.y, search.w, search.h);
    const ring = detectRedRing(img, search);
    app.lastRing = ring;
    if (!ring) return;

    const roi = deriveBadgeFromRing(ring, w, h);
    if (!roi) return;
    app.store.runtimePhaseRoi = roi;
  }

  function detectRedRing(imageData, offset) {
    const points = [];
    const d = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a > 80 && r > 130 && g < 95 && b < 95 && r > g * 1.35 && r > b * 1.35) {
          points.push({ x: offset.x + x, y: offset.y + y });
        }
      }
    }
    if (points.length < CONFIG.ring.minRedPixels) return null;
    return ransacCircle(points, CONFIG.ring);
  }

  function ransacCircle(points, opt) {
    let best = null;
    for (let i = 0; i < opt.ransacIterations; i++) {
      const a = points[Math.floor(Math.random() * points.length)];
      const b = points[Math.floor(Math.random() * points.length)];
      const c = points[Math.floor(Math.random() * points.length)];
      const circle = circleFrom3(a, b, c);
      if (!circle || circle.r < 8 || circle.r > 120) continue;
      let inliers = 0;
      for (const p of points) {
        const dist = Math.hypot(p.x - circle.x, p.y - circle.y);
        if (Math.abs(dist - circle.r) <= opt.tolerance) inliers++;
      }
      if (!best || inliers > best.inliers) best = { ...circle, inliers };
    }
    if (!best || best.inliers < opt.minInliers) return null;
    return best;
  }

  function circleFrom3(a, b, c) {
    const A = b.x - a.x, B = b.y - a.y;
    const C = c.x - a.x, D = c.y - a.y;
    const E = A * (a.x + b.x) + B * (a.y + b.y);
    const F = C * (a.x + c.x) + D * (a.y + c.y);
    const G = 2 * (A * (c.y - b.y) - B * (c.x - b.x));
    if (Math.abs(G) < 0.0001) return null;
    const x = (D * E - B * F) / G;
    const y = (A * F - C * E) / G;
    return { x, y, r: Math.hypot(x - a.x, y - a.y) };
  }

  function deriveBadgeFromRing(ring, w, h) {
    // 以紅環中心為基準取正方形；若實機偏移，可改此處比例
    const size = ring.r * 2.35;
    return {
      x: clamp01((ring.x - size / 2) / w),
      y: clamp01((ring.y - size / 2) / h),
      w: clamp01(size / w),
      h: clamp01(size / h)
    };
  }

  /* ---------------- OCR / ROI / Canvas ---------------- */

  async function ocrRoi(roiName, lang, mode, w, h) {
    if (!window.Tesseract) return "";
    const roi = getRoiPx(roiName, w, h);
    const c = document.createElement("canvas");
    const scale = mode === "channel" ? 4 : 3;
    c.width = Math.max(1, Math.round(roi.w * scale));
    c.height = Math.max(1, Math.round(roi.h * scale));
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    cx.drawImage(app.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, c.width, c.height);
    preprocessOcr(cx, c.width, c.height, mode);

    const opts = { logger: () => {} };
    if (mode === "channel") opts.tessedit_char_whitelist = "CHch.:：0123456789 ";
    const res = await window.Tesseract.recognize(c, lang, opts);
    return res && res.data ? res.data.text || "" : "";
  }

  function preprocessOcr(ctx, w, h, mode) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const gray = r * 0.299 + g * 0.587 + b * 0.114;
      let v;
      if (mode === "channel") {
        const cyan = g > 100 && b > 100 && r < 150;
        v = gray > 125 || cyan ? 255 : 0;
      } else if (mode === "announcement") {
        const red = r > 120 && g < 95 && b < 95;
        v = red || gray > 125 ? 255 : 0;
      } else {
        v = gray > 95 ? 255 : 0;
      }
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function cropRoiToCanvas(roiName, w, h, outW, outH) {
    if (!app.canvas) return null;
    const roi = getRoiPx(roiName, w, h);
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.drawImage(app.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, outW, outH);
    return c;
  }

  function getRoiNormalized(name) {
    if (name === "phaseIcon" && app.store.runtimePhaseRoi) return app.store.runtimePhaseRoi;
    return app.store.roi[name] || CONFIG.roi[name];
  }

  function getRoiPx(name, w, h) {
    const r = getRoiNormalized(name);
    return { x: Math.round(r.x * w), y: Math.round(r.y * h), w: Math.max(1, Math.round(r.w * w)), h: Math.max(1, Math.round(r.h * h)) };
  }

  /* ---------------- 模板儲存：PNG dataURL，執行時轉 feature ---------------- */

  function captureTemplate(group, label) {
    if (!app.canvas || !app.video) {
      alert("請先開始擷取遊戲視窗。");
      return;
    }
    const w = app.video.videoWidth;
    const h = app.video.videoHeight;
    const roiName = group === "phase" ? "phaseIcon" : "channel";
    const c = cropRoiToCanvas(roiName, w, h, CONFIG.template.size, CONFIG.template.size);
    if (!c) return;

    const img = c.toDataURL("image/png");
    const bucket = app.store.templates[group][label] || (app.store.templates[group][label] = []);
    bucket.push({ img, createdAt: Date.now() });
    while (bucket.length > CONFIG.template.maxTemplatesPerLabel) bucket.shift();
    saveStore();
    app.featureCacheDirty = true;
    rebuildFeatureCacheAsync();
    updateTemplateCounts();
    setStatus(`已新增模板：${group} ${label}，共 ${bucket.length} 張`, "ok");
  }

  function rebuildFeatureCacheAsync() {
    // dataURL 載入是非同步，先標記；下個 tick 可用
    app.featureDB = { phase: {}, channel: {} };
    const jobs = [];
    for (const group of ["phase", "channel"]) {
      app.featureDB[group] = {};
      for (const label of Object.keys(app.store.templates[group] || {})) {
        app.featureDB[group][label] = [];
        for (const tpl of app.store.templates[group][label]) {
          jobs.push(loadImageToCanvas(tpl.img, CONFIG.template.size, CONFIG.template.size).then(c => {
            app.featureDB[group][label].push(TemplateDB.extractFeatures(c));
          }));
        }
      }
    }
    Promise.all(jobs).then(() => { app.featureCacheDirty = false; }).catch(err => console.warn("template rebuild failed", err));
  }

  function rebuildFeatureCache() {
    if (!app.featureCacheDirty) return;
    rebuildFeatureCacheAsync();
  }

  function loadImageToCanvas(src, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0, w, h);
        resolve(c);
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  function renderTemplateButtons() {
    const phaseBox = $("tdPhaseTplButtons");
    const chBox = $("tdChTplButtons");
    if (!phaseBox || !chBox) return;
    phaseBox.innerHTML = "";
    LABELS.phase.forEach(label => phaseBox.appendChild(makeTplButton("phase", label)));
    chBox.innerHTML = "";
    LABELS.channel.forEach(label => chBox.appendChild(makeTplButton("channel", label)));
  }

  function makeTplButton(group, label) {
    const btn = document.createElement("button");
    btn.className = "td-btn small template";
    btn.innerHTML = `${label}<span class="td-count" id="tdCount-${group}-${label}">0</span>`;
    btn.onclick = () => captureTemplate(group, label);
    return btn;
  }

  function updateTemplateCounts() {
    for (const group of ["phase", "channel"]) {
      for (const label of LABELS[group]) {
        setText(`tdCount-${group}-${label}`, String((app.store.templates[group][label] || []).length));
      }
    }
  }

  function clearTemplates() {
    app.store.templates = { phase: {}, channel: {} };
    saveStore();
    app.featureCacheDirty = true;
    app.featureDB = { phase: {}, channel: {} };
    updateTemplateCounts();
    setStatus("模板已清除", "muted");
  }

  /* ---------------- 狀態安全 ---------------- */

  function getFreshAnnouncement() {
    if (!app.lastAnnouncement || !app.lastAnnouncement.value) return null;
    return Date.now() - app.lastAnnouncement.time <= CONFIG.announcementFreshMs ? app.lastAnnouncement : null;
  }

  function labelToValue(label) {
    return label === "WAITING" ? "XX" : label;
  }

  function sameStage(a, b) {
    return labelToValue(a) === labelToValue(b);
  }

  function isStageConflict(a, b) {
    a = labelToValue(a);
    b = labelToValue(b);
    if (!a || !b || a === b) return false;
    if (a === "ON" || b === "ON") return true;
    if (/^R[1-4]$/.test(a) && /^R[1-4]$/.test(b)) return true;
    if (a === "XX" || b === "XX") return true;
    return false;
  }

  function isAllowedTransition(map, ch, val) {
    const current = app.lastSubmittedByBoss[`${map}_${ch}`] || readCurrentBossState(map, ch);
    if (!current || current === val) return true;
    const rank = { XX: 0, R1: 1, R2: 2, R3: 3, R4: 4, ON: 5 };
    const a = rank[current], b = rank[val];
    if (val === "XX") return current === "ON" || CONFIG.autoSubmitWaiting;
    if (current === "ON" && val !== "XX") return false;
    if (a == null || b == null) return true;
    return b >= a;
  }

  function readCurrentBossState(map, ch) {
    const id = `${map}_${ch}`;
    const b = window.currentData && window.currentData[id];
    if (!b) return "";
    const input = String(b.lastInput || "").toUpperCase();
    if (input === "ON") return "ON";
    if (input.startsWith("XX") || input.startsWith("DE")) return "XX";
    const r = input.match(/^R([1-4])/);
    if (r) return `R${r[1]}`;
    const dv = String(b.displayValue || "").toUpperCase();
    if (dv === "ON") return "ON";
    const m = dv.match(/階段\s*([1-4])|段階\s*([1-4])/);
    if (m) return `R${m[1] || m[2]}`;
    return "";
  }

  function isSameAsCurrent(map, ch, val) {
    return readCurrentBossState(map, ch) === val;
  }

  /* ---------------- UI / ROI 校正 ---------------- */

  function beginCalibration(name) {
    if (!app.canvas) {
      alert("請先開始擷取並開啟 Debug。");
      return;
    }
    CONFIG.debug = true;
    const dbg = $("tdDebug");
    if (dbg) dbg.checked = true;
    updatePreviewVisibility();
    app.calibration = { active: true, target: name, dragging: false, start: null, current: null };
    setStatus(`ROI 校正：請在預覽圖拖曳框選 ${name}`, "warn");
  }

  function setupPreviewEvents() {
    const c = $("tdPreview");
    if (!c) return;
    c.addEventListener("mousedown", e => {
      if (!app.calibration.active || !app.video) return;
      const p = previewPoint(e, c);
      app.calibration.dragging = true;
      app.calibration.start = p;
      app.calibration.current = p;
    });
    c.addEventListener("mousemove", e => {
      if (!app.calibration.active || !app.calibration.dragging) return;
      app.calibration.current = previewPoint(e, c);
    });
    window.addEventListener("mouseup", () => {
      if (!app.calibration.active || !app.calibration.dragging || !app.video) return;
      const a = app.calibration.start;
      const b = app.calibration.current;
      app.calibration.dragging = false;
      if (!a || !b) return;
      const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y);
      if (x2 - x1 < 5 || y2 - y1 < 5) return;
      const vw = app.video.videoWidth, vh = app.video.videoHeight;
      const sx = vw / c.width, sy = vh / c.height;
      app.store.roi[app.calibration.target] = {
        x: clamp01((x1 * sx) / vw),
        y: clamp01((y1 * sy) / vh),
        w: clamp01(((x2 - x1) * sx) / vw),
        h: clamp01(((y2 - y1) * sy) / vh)
      };
      app.store.runtimePhaseRoi = null;
      saveStore();
      setStatus(`ROI 已儲存：${app.calibration.target}`, "ok");
      app.calibration.active = false;
      app.calibration.target = null;
    });
  }

  function previewPoint(e, canvas) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }

  function resetRoi() {
    if (!confirm("確定重置 ROI？模板不會刪除。")) return;
    app.store.roi = JSON.parse(JSON.stringify(CONFIG.roi));
    app.store.runtimePhaseRoi = null;
    saveStore();
    setStatus("ROI 已重置", "muted");
  }

  function drawPreview(w, h) {
    const p = $("tdPreview");
    if (!p || !app.canvas) return;
    const s = CONFIG.previewScale;
    p.width = Math.round(w * s);
    p.height = Math.round(h * s);
    p.style.width = p.width + "px";
    p.style.height = p.height + "px";
    const ctx = p.getContext("2d");
    ctx.drawImage(app.canvas, 0, 0, p.width, p.height);
    drawRoi(ctx, "mapName", w, h, s, "#00ff00");
    drawRoi(ctx, "channel", w, h, s, "#00aaff");
    drawRoi(ctx, "phaseIcon", w, h, s, "#ff3333");
    drawRoi(ctx, "announcement", w, h, s, "#ffcc00");
    drawRoi(ctx, "ringSearch", w, h, s, "#ff66ff");

    if (app.lastRing) {
      ctx.strokeStyle = "#ff0000";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(app.lastRing.x * s, app.lastRing.y * s, app.lastRing.r * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (app.calibration.active && app.calibration.dragging && app.calibration.start && app.calibration.current) {
      const a = app.calibration.start, b = app.calibration.current;
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    }
  }

  function drawRoi(ctx, name, w, h, s, color) {
    const r = getRoiPx(name, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
    ctx.fillStyle = color;
    ctx.font = "12px monospace";
    ctx.fillText(name, r.x * s + 3, r.y * s + 13);
  }

  function updatePreviewVisibility() {
    const p = $("tdPreview");
    if (p) p.style.display = CONFIG.debug ? "block" : "none";
  }

  function updatePanel(f) {
    setText("tdMap", f.mapLevel ? `${f.mapLevel} (${f.mapName || ""})` : (f.mapName || "?"));
    setText("tdChannel", f.channel || "?");
    const pm = f.phaseMatch;
    setText("tdPhaseMatch", pm && pm.label ? `${pm.label} ${pct(pm.score)}${pm.rejected ? " REJ" : ""}` : "?");
    const ann = f.announcement;
    setText("tdAnnouncement", ann ? `${ann.value} ${pct(ann.score)}` : "-");
    setText("tdDecision", f.decision ? `${f.decision.value} ${f.decision.confidence}` : "-");
    setText("tdStable", String(app.stableCount || 0));
  }

  function showConfirm(d) {
    if (app.pendingConfirm && app.pendingConfirm.mapLevel === d.mapLevel && app.pendingConfirm.channel === d.channel && app.pendingConfirm.value === d.value) return;
    app.pendingConfirm = d;
    setText("tdConfirmText", `確認送出：${d.mapLevel}-${d.channel} ${d.value}\n${d.reason || ""}`);
    const box = $("tdConfirmBox");
    if (box) box.style.display = "block";
    setStatus(`等待確認：${d.mapLevel}-${d.channel} ${d.value}`, "warn");
  }

  function hideConfirm() {
    const box = $("tdConfirmBox");
    if (box) box.style.display = "none";
  }

  function toggleCompact() {
    const body = $("tdBody"), btn = $("tdCompactBtn");
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "block" : "none";
    btn.textContent = hidden ? "−" : "+";
  }

  function setStatus(text, type) {
    const el = $("tdStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `td-status ${type || "muted"}`;
  }

  /* ---------------- 地圖 / 分流 / 儲存 ---------------- */

  function parseChannel(text) {
    const s = normalizeAscii(text);
    const m = s.match(/CH\.?\s*[:：]?\s*(\d{1,2})/i) || s.match(/\b(\d{1,2})\b/);
    if (!m) return "";
    const n = parseInt(m[1], 10);
    return n > 0 && n <= 20 ? String(n) : "";
  }

  function resolveMap(text) {
    const q = normalizeMapText(text);
    if (!q) return { name: "", level: "", score: 0 };
    if (MAP_NAME_TO_LEVEL[q]) return { name: q, level: MAP_NAME_TO_LEVEL[q], score: 1 };
    let bestName = "", bestScore = 0;
    for (const name of Object.keys(MAP_NAME_TO_LEVEL)) {
      const score = mapSimilarity(q, normalizeMapText(name));
      if (score > bestScore) { bestScore = score; bestName = name; }
    }
    return { name: bestName, level: bestName ? MAP_NAME_TO_LEVEL[bestName] : "", score: bestScore };
  }

  function mapSimilarity(a, b) {
    if (!a || !b) return 0;
    const used = new Array(b.length).fill(false);
    let hit = 0;
    for (const ch of a) {
      for (let i = 0; i < b.length; i++) {
        if (!used[i] && b[i] === ch) { used[i] = true; hit++; break; }
      }
    }
    return clamp01(hit / Math.max(a.length, b.length) + (a.includes(b) || b.includes(a) ? 0.18 : 0));
  }

  function normalizeMapText(text) {
    return String(text || "").replace(/\s+/g, "").replace(/[|｜]/g, "").replace(/[\[\]{}()（）【】「」『』]/g, "").replace(/[臺]/g, "台").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").trim();
  }

  function normalizeAscii(text) {
    return String(text || "").replace(/[ＯOｏ]/g, "0").replace(/[ＩIlｌ]/g, "1").replace(/[ＳS]/g, "5").replace(/[^A-Za-z0-9.:：\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return sanitizeStore(JSON.parse(raw));
    } catch (e) { console.warn("[TOSMDetector] loadStore failed", e); }
    return sanitizeStore({});
  }

  function sanitizeStore(s) {
    s = s || {};
    if (!s.roi) s.roi = JSON.parse(JSON.stringify(CONFIG.roi));
    if (!s.templates) s.templates = {};
    if (!s.templates.phase) s.templates.phase = {};
    if (!s.templates.channel) s.templates.channel = {};
    return s;
  }

  function saveStore() {
    localStorage.setItem(STORE_KEY, JSON.stringify(app.store));
  }

  function exportData() {
    return JSON.stringify(app.store, null, 2);
  }

  function importData(json) {
    try {
      app.store = sanitizeStore(JSON.parse(json));
      saveStore();
      app.featureCacheDirty = true;
      rebuildFeatureCacheAsync();
      updateTemplateCounts();
      setStatus("設定已匯入", "ok");
    } catch (e) {
      alert("匯入失敗：JSON 格式錯誤");
    }
  }

  function setConfig(partial) {
    Object.assign(CONFIG, partial || {});
  }

  /* ---------------- CSS / 小工具 ---------------- */

  function injectStyle() {
    if ($("tosmDetectorStyle")) return;
    const s = document.createElement("style");
    s.id = "tosmDetectorStyle";
    s.textContent = `
      #tosmDetectorPanel{position:fixed;right:12px;bottom:12px;width:292px;max-height:92vh;overflow:auto;z-index:99999;background:rgba(0,0,0,.92);border:1px solid #333;border-radius:12px;color:#aaa;font:12px/1.45 monospace;box-shadow:0 8px 30px rgba(0,0,0,.5)}
      #tosmDetectorPanel .td-head{display:flex;justify-content:space-between;align-items:center;padding:9px 10px;border-bottom:1px solid #222;background:#0b0b0b;position:sticky;top:0;z-index:2}.td-title{color:#0f0;font-weight:bold}.td-ver{color:#555;font-size:10px}#tdBody{padding:10px}.td-icon-btn,.td-btn{border:1px solid #444;color:#aaa;background:#111;border-radius:6px;padding:5px 8px;cursor:pointer;font:inherit}.td-btn.primary{border-color:#0f0;color:#0f0;background:#001800}.td-btn.danger{border-color:#733;color:#f66}.td-btn.small{padding:4px 6px;font-size:11px}.td-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.td-row.compact{gap:5px;margin-bottom:4px}.td-status{min-height:18px;padding:6px 8px;border:1px solid #222;background:#101010;border-radius:7px;margin-bottom:8px;white-space:pre-wrap;word-break:break-all}.td-status.ok{color:#0f0;border-color:#064}.td-status.warn{color:#ffca28;border-color:#665000}.td-status.bad{color:#f66;border-color:#733}.td-status.muted{color:#888}.td-switches{display:grid;grid-template-columns:1fr 1fr;gap:4px 6px;margin-bottom:8px;color:#888;font-size:11px}.td-switches input{vertical-align:-2px;margin-right:3px}.td-grid{display:grid;grid-template-columns:64px 1fr;gap:3px 8px;border:1px solid #222;background:#080808;border-radius:8px;padding:8px;margin-bottom:8px}.td-grid div:nth-child(odd){color:#555}.td-grid div:nth-child(even){color:#ddd;word-break:break-all}details{border-top:1px solid #222;padding-top:8px}summary{cursor:pointer;color:#0f0;margin-bottom:8px}.td-section{border:1px solid #222;border-radius:8px;padding:8px;margin-bottom:8px;background:#080808}.td-section-title{color:#ffca28;margin-bottom:4px;font-weight:bold}.td-small{color:#666;font-size:11px;margin-bottom:6px}.td-template-buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}.td-btn.template{position:relative;min-height:32px}.td-count{display:block;color:#0f0;font-size:10px;margin-top:2px}.td-textarea{width:100%;min-height:58px;box-sizing:border-box;background:#050505;color:#aaa;border:1px solid #333;border-radius:6px;font:10px monospace;padding:6px}.td-preview{display:none;max-width:100%;border:1px solid #333;border-radius:8px;background:#000;cursor:crosshair}.td-confirm{border:1px solid #665000;background:#171303;color:#ffca28;border-radius:8px;padding:8px;margin-top:8px;white-space:pre-wrap}
    `;
    document.head.appendChild(s);
  }

  function $(id) { return document.getElementById(id); }
  function setText(id, v) { const el = $(id); if (el) el.textContent = v; }
  function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
  function pct(n) { return `${(Number(n || 0) * 100).toFixed(1)}%`; }
})();
