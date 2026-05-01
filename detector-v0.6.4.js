/*
 * TOS M FB TIME - Window Capture Boss Detector
 * File: detector-v0.7.2.js
 *
 * 載入方式：
 * <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
 * <script src="detector-v0.7.2.js"></script>
 *
 * 重要：
 * - 本檔不直接寫 Firebase，只呼叫原本主程式 window.saveBoss(map, ch, value, false)。
 * - 準確性優先：右上狀態圖示模板比對 + 中央公告 OCR + 地圖/分流辨識。
 * - 第一次使用請先 ROI 校正，再建立 R1/R2/R3/R4/ON/WAITING 與 CH 模板。
 */

(function () {
  "use strict";

  const VERSION = "0.7.2";
  const STORE_KEY = "tosm_detector_v072_store";

  const CONFIG = {
    scanIntervalMs: 350,
    mapOcrIntervalMs: 2200,
    announcementOcrIntervalMs: 900,
    submitCooldownMs: 6000,
    stableNeed: 3,
    autoSubmit: false,
    confirmBeforeSubmit: true,
    autoSubmitWaiting: false,
    debug: false,
    previewScale: 0.32,
    template: {
      stageThreshold: 0.78,
      stageStrongThreshold: 0.86,
      channelThreshold: 0.74,
      maxTemplatesPerLabel: 8,
      imageSize: 48
    },
    roi: {
      mapName: { x: 0.755, y: 0.315, w: 0.190, h: 0.060 },
      channel: { x: 0.930, y: 0.315, w: 0.065, h: 0.060 },
      stageIcon: { x: 0.765, y: 0.145, w: 0.075, h: 0.105 },
      announcement: { x: 0.280, y: 0.245, w: 0.460, h: 0.145 }
    }
  };

  const STAGE_LABELS = ["WAITING", "R1", "R2", "R3", "R4", "ON"];
  const CHANNEL_LABELS = ["CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7", "CH8", "CH9", "CH10"];

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

  const state = {
    running: false,
    video: null,
    stream: null,
    canvas: null,
    ctx: null,
    timer: null,
    store: loadStore(),
    lastMapOcrAt: 0,
    lastAnnouncementOcrAt: 0,
    cachedMapName: "",
    cachedMapLevel: "",
    cachedChannel: "",
    lastAnnouncement: null,
    lastDecisionKey: "",
    stableCount: 0,
    lastSubmitKey: "",
    lastSubmitAt: 0,
    pendingConfirm: null,
    lastSubmittedStateByBoss: {},
    calibration: { active: false, target: null, dragging: false, start: null, current: null },
    lastFrameInfo: null
  };

  window.TOSMDetector = {
    version: VERSION,
    start,
    stop,
    mount,
    unmount,
    scanOnce,
    setConfig,
    exportData,
    importData,
    clearTemplates,
    getState: () => JSON.parse(JSON.stringify({
      running: state.running,
      store: state.store,
      cachedMapName: state.cachedMapName,
      cachedMapLevel: state.cachedMapLevel,
      cachedChannel: state.cachedChannel,
      lastAnnouncement: state.lastAnnouncement,
      lastFrameInfo: state.lastFrameInfo
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
        <button id="tdCompactBtn" class="td-icon-btn" title="收合/展開">−</button>
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
          <label><input id="tdWaiting" type="checkbox"> 自動送出 WAITING/XX</label>
          <label><input id="tdDebug" type="checkbox"> Debug</label>
        </div>

        <div class="td-grid">
          <div>地圖</div><div id="tdMap">?</div>
          <div>分流</div><div id="tdChannel">?</div>
          <div>狀態圖示</div><div id="tdStageTemplate">?</div>
          <div>公告</div><div id="tdAnnouncement">?</div>
          <div>決策</div><div id="tdDecision">?</div>
          <div>穩定</div><div id="tdStable">0</div>
        </div>

        <details id="tdAdvanced">
          <summary>進階 / 校正 / 模板</summary>

          <div class="td-section">
            <div class="td-section-title">ROI 校正</div>
            <div class="td-small">開啟 Debug 後，在預覽圖拖曳框選。框選完成會自動儲存。</div>
            <div class="td-row compact">
              <button class="td-btn small" data-roi="mapName">地圖名</button>
              <button class="td-btn small" data-roi="channel">分流</button>
              <button class="td-btn small" data-roi="stageIcon">狀態圖示</button>
              <button class="td-btn small" data-roi="announcement">中央公告</button>
              <button id="tdResetRoi" class="td-btn small danger">重置 ROI</button>
            </div>
          </div>

          <div class="td-section">
            <div class="td-section-title">狀態圖示模板</div>
            <div class="td-small">在對應狀態畫面按下按鈕，會擷取目前「狀態圖示 ROI」作為模板。</div>
            <div id="tdStageTemplateButtons" class="td-template-buttons"></div>
          </div>

          <div class="td-section">
            <div class="td-section-title">分流模板</div>
            <div class="td-small">在對應 CH 畫面按下按鈕，會擷取目前「分流 ROI」作為模板。</div>
            <div id="tdChannelTemplateButtons" class="td-template-buttons"></div>
          </div>

          <div class="td-section">
            <div class="td-section-title">模板管理</div>
            <div class="td-row compact">
              <button id="tdExport" class="td-btn small">匯出設定</button>
              <button id="tdImport" class="td-btn small">匯入設定</button>
              <button id="tdClearTemplates" class="td-btn small danger">清除模板</button>
            </div>
            <textarea id="tdImportBox" class="td-textarea" placeholder="匯入/匯出 JSON 會顯示在這裡"></textarea>
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

    $("tdStartBtn").onclick = start;
    $("tdStopBtn").onclick = stop;
    $("tdCompactBtn").onclick = toggleCompact;
    $("tdResetRoi").onclick = resetRoi;
    $("tdExport").onclick = () => { $("tdImportBox").value = exportData(); };
    $("tdImport").onclick = () => importData($("tdImportBox").value);
    $("tdClearTemplates").onclick = () => {
      if (confirm("確定清除所有模板？ROI 與設定不會被清除。")) clearTemplates();
    };

    $("tdAutoSubmit").onchange = e => { CONFIG.autoSubmit = e.target.checked; };
    $("tdConfirm").onchange = e => { CONFIG.confirmBeforeSubmit = e.target.checked; };
    $("tdWaiting").onchange = e => { CONFIG.autoSubmitWaiting = e.target.checked; };
    $("tdDebug").onchange = e => { CONFIG.debug = e.target.checked; updatePreviewVisibility(); };

    $("tdConfirmSend").onclick = () => {
      const item = state.pendingConfirm;
      state.pendingConfirm = null;
      hideConfirm();
      if (item) submitDecision(item, true);
    };
    $("tdConfirmIgnore").onclick = () => {
      state.pendingConfirm = null;
      hideConfirm();
      setStatus("已忽略本次候選", "muted");
    };

    panel.querySelectorAll("[data-roi]").forEach(btn => {
      btn.onclick = () => beginCalibration(btn.dataset.roi);
    });

    renderTemplateButtons();
    setupPreviewEvents();
    updateTemplateCounts();
    updatePreviewVisibility();
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
        alert("找不到 window.saveBoss()。請確認 detector-v0.7.2.js 載入在主程式之後。");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("瀏覽器不支援視窗擷取，請使用新版 Chrome 或 Edge。");
        return;
      }

      state.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 12, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      });

      state.video = document.createElement("video");
      state.video.srcObject = state.stream;
      state.video.muted = true;
      state.video.playsInline = true;
      await state.video.play();

      state.canvas = document.createElement("canvas");
      state.ctx = state.canvas.getContext("2d", { willReadFrequently: true });
      state.running = true;
      state.lastMapOcrAt = 0;
      state.lastAnnouncementOcrAt = 0;
      state.stream.getVideoTracks().forEach(track => track.addEventListener("ended", stop));

      setStatus("擷取中，請確認選的是 TOSM 遊戲視窗", "ok");
      state.timer = setInterval(scanOnce, CONFIG.scanIntervalMs);
      await scanOnce();
    } catch (err) {
      console.error("[TOSMDetector] start failed", err);
      setStatus("擷取啟動失敗或使用者取消授權", "bad");
      stop();
    }
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
    state.video = null;
    state.canvas = null;
    state.ctx = null;
    state.running = false;
    setStatus("已停止", "muted");
  }

  async function scanOnce() {
    if (!state.video || state.video.readyState < 2 || !state.ctx) return;

    const w = state.video.videoWidth;
    const h = state.video.videoHeight;
    if (!w || !h) return;

    state.canvas.width = w;
    state.canvas.height = h;
    state.ctx.drawImage(state.video, 0, 0, w, h);

    const now = Date.now();
    const stageResult = recognizeStageIcon(w, h);
    const channelTemplate = recognizeChannelTemplate(w, h);

    if (now - state.lastMapOcrAt >= CONFIG.mapOcrIntervalMs) {
      state.lastMapOcrAt = now;
      await updateMapAndChannelByOcr(w, h, channelTemplate);
    } else if (channelTemplate.label && channelTemplate.score >= CONFIG.template.channelThreshold) {
      state.cachedChannel = channelTemplate.label.replace("CH", "");
    }

    if (now - state.lastAnnouncementOcrAt >= CONFIG.announcementOcrIntervalMs) {
      state.lastAnnouncementOcrAt = now;
      const ann = await recognizeAnnouncement(w, h);
      if (ann && ann.stage) state.lastAnnouncement = ann;
    }

    const decision = makeDecision(stageResult, channelTemplate);
    state.lastFrameInfo = {
      mapName: state.cachedMapName,
      mapLevel: state.cachedMapLevel,
      channel: state.cachedChannel,
      stageResult,
      channelTemplate,
      announcement: state.lastAnnouncement,
      decision,
      time: now
    };

    updatePanel(state.lastFrameInfo);
    if (CONFIG.debug) drawPreview(w, h);
    if (decision && decision.value) handleDecision(decision);
  }

  async function updateMapAndChannelByOcr(w, h, channelTemplate) {
    if (!window.Tesseract) {
      setStatus("Tesseract.js 未載入：地圖/分流 OCR 不可用", "warn");
      return;
    }

    try {
      const mapText = await ocrRoi("mapName", "chi_tra+eng", "map", w, h);
      const mapMatch = resolveMap(normalizeMapText(mapText));
      if (mapMatch.level && mapMatch.score >= 0.45) {
        state.cachedMapName = mapMatch.name;
        state.cachedMapLevel = mapMatch.level;
      }

      let ch = "";
      if (channelTemplate.label && channelTemplate.score >= CONFIG.template.channelThreshold) {
        ch = channelTemplate.label.replace("CH", "");
      }
      if (!ch) {
        const chText = await ocrRoi("channel", "eng", "channel", w, h);
        ch = parseChannel(chText);
      }
      if (ch) state.cachedChannel = ch;
    } catch (err) {
      console.warn("[TOSMDetector] map/channel OCR failed", err);
    }
  }

  async function recognizeAnnouncement(w, h) {
    if (!window.Tesseract) return null;

    try {
      const text = await ocrRoi("announcement", "chi_tra+eng", "announcement", w, h);
      const raw = String(text || "").replace(/\s+/g, "");
      let m = raw.match(/(?:警戒|憤怒|慎怒|提升|升)[^1-4]{0,8}([1-4])[^階段]{0,3}階段/);
      if (!m) m = raw.match(/([1-4])階段/);

      if (m) return { stage: `R${m[1]}`, value: `R${m[1]}`, raw, score: 0.92, time: Date.now() };
      if (/ON|On|on|復活|出現/.test(raw)) return { stage: "ON", value: "ON", raw, score: 0.78, time: Date.now() };
      return { stage: "", value: "", raw, score: 0, time: Date.now() };
    } catch (err) {
      console.warn("[TOSMDetector] announcement OCR failed", err);
      return null;
    }
  }

  function recognizeStageIcon(w, h) {
    const crop = cropRoiToTemplateVector("stageIcon", w, h, CONFIG.template.imageSize);
    if (!crop) return { label: "", score: 0, scores: {} };
    return matchTemplates(crop.vector, "stage", STAGE_LABELS);
  }

  function recognizeChannelTemplate(w, h) {
    const crop = cropRoiToTemplateVector("channel", w, h, CONFIG.template.imageSize);
    if (!crop) return { label: "", score: 0, scores: {} };
    return matchTemplates(crop.vector, "channel", CHANNEL_LABELS);
  }

  function makeDecision(stageResult, channelTemplate) {
    const mapLevel = state.cachedMapLevel;
    const channel = state.cachedChannel || (channelTemplate.label ? channelTemplate.label.replace("CH", "") : "");
    const ann = getFreshAnnouncement();
    const templateStage = stageResult && stageResult.score >= CONFIG.template.stageThreshold ? stageResult.label : "";
    const strongTemplate = stageResult && stageResult.score >= CONFIG.template.stageStrongThreshold;

    let value = "";
    let confidence = 0;
    let reason = "";

    if (ann && ann.value) {
      if (!templateStage || templateStage === ann.value || !isStageConflict(templateStage, ann.value)) {
        value = ann.value;
        confidence = Math.max(ann.score, strongTemplate ? 0.96 : 0.90);
        reason = templateStage ? `公告+圖示一致/不衝突：${ann.raw}` : `公告：${ann.raw}`;
      } else return null;
    } else if (templateStage && strongTemplate) {
      value = templateStage;
      confidence = stageResult.score;
      reason = `狀態圖示模板 ${templateStage} ${(stageResult.score * 100).toFixed(1)}%`;
    } else if (templateStage && stageResult.score >= CONFIG.template.stageThreshold) {
      value = templateStage;
      confidence = stageResult.score;
      reason = `狀態圖示候選 ${templateStage} ${(stageResult.score * 100).toFixed(1)}%`;
    }

    if (!value || !mapLevel || !channel) return null;
    if (value === "WAITING") value = "XX";

    if (value === "XX" && !CONFIG.autoSubmitWaiting) {
      return { mapLevel, channel, value, confidence, reason: `${reason}；WAITING/XX 未開啟自動送出`, blocked: true };
    }

    if (!isAllowedTransition(mapLevel, channel, value)) return null;
    return { mapLevel, channel, value, confidence, reason, blocked: false };
  }

  function getFreshAnnouncement() {
    const ann = state.lastAnnouncement;
    if (!ann || !ann.value) return null;
    if (Date.now() - ann.time > 4500) return null;
    return ann;
  }

  function isStageConflict(a, b) {
    if (!a || !b || a === b) return false;
    if (a === "WAITING" && b === "XX") return false;
    if (a === "ON" || b === "ON") return true;
    if (/^R[1-4]$/.test(a) && /^R[1-4]$/.test(b)) return true;
    return false;
  }

  function isAllowedTransition(mapLevel, channel, value) {
    const id = `${mapLevel}_${channel}`;
    const last = state.lastSubmittedStateByBoss[id] || readCurrentBossState(mapLevel, channel);
    if (!last || last === value) return true;

    const rank = { XX: 0, R1: 1, R2: 2, R3: 3, R4: 4, ON: 5 };
    const a = rank[last];
    const b = rank[value];
    if (value === "XX") return true;
    if (last === "ON" && value !== "XX") return false;
    if (a == null || b == null) return true;
    return b >= a;
  }

  function readCurrentBossState(mapLevel, channel) {
    const id = `${mapLevel}_${channel}`;
    const b = window.currentData && window.currentData[id];
    if (!b) return "";

    const input = String(b.lastInput || "").toUpperCase();
    if (input === "ON") return "ON";
    if (input.startsWith("XX") || input.startsWith("DE")) return "XX";
    const r = input.match(/^R([1-4])/);
    if (r) return `R${r[1]}`;

    const dv = String(b.displayValue || "").toUpperCase();
    if (dv === "ON") return "ON";
    const dvr = dv.match(/階段\s*([1-4])|段階\s*([1-4])/);
    if (dvr) return `R${dvr[1] || dvr[2]}`;
    return "";
  }

  function handleDecision(decision) {
    const key = `${decision.mapLevel}_${decision.channel}_${decision.value}`;
    if (key === state.lastDecisionKey) state.stableCount++;
    else { state.lastDecisionKey = key; state.stableCount = 1; }

    if (decision.blocked) {
      setStatus(`候選：${key}，但未啟用自動送出 XX`, "muted");
      return;
    }
    if (state.stableCount < CONFIG.stableNeed) {
      setStatus(`候選：${key} / ${state.stableCount}/${CONFIG.stableNeed}`, "muted");
      return;
    }
    if (!CONFIG.autoSubmit) {
      setStatus(`已穩定但自動送出關閉：${key}`, "warn");
      return;
    }
    if (CONFIG.confirmBeforeSubmit) {
      showConfirm(decision);
      return;
    }
    submitDecision(decision, false);
  }

  function submitDecision(decision, forced) {
    const key = `${decision.mapLevel}_${decision.channel}_${decision.value}`;
    const now = Date.now();
    if (!forced && key === state.lastSubmitKey && now - state.lastSubmitAt < CONFIG.submitCooldownMs) return;

    try {
      window.saveBoss(decision.mapLevel, decision.channel, decision.value, false);
      state.lastSubmitKey = key;
      state.lastSubmitAt = now;
      state.lastSubmittedStateByBoss[`${decision.mapLevel}_${decision.channel}`] = decision.value;
      setStatus(`已送出：${decision.mapLevel}-${decision.channel} ${decision.value}`, "ok");
    } catch (err) {
      console.error("[TOSMDetector] saveBoss failed", err);
      setStatus("saveBoss 送出失敗，請看 console", "bad");
    }
  }

  async function ocrRoi(roiName, lang, mode, w, h) {
    const roi = getRoiPx(roiName, w, h);
    const c = document.createElement("canvas");
    const scale = mode === "channel" ? 4 : 3;
    c.width = Math.max(1, Math.round(roi.w * scale));
    c.height = Math.max(1, Math.round(roi.h * scale));
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    cx.drawImage(state.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, c.width, c.height);
    preprocessOcrCanvas(cx, c.width, c.height, mode);

    const opts = { logger: () => {} };
    if (mode === "channel") opts.tessedit_char_whitelist = "CHch.:：0123456789 ";
    const res = await window.Tesseract.recognize(c, lang, opts);
    return res && res.data ? res.data.text || "" : "";
  }

  function preprocessOcrCanvas(ctx, w, h, mode) {
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
        const red = r > 120 && g < 90 && b < 90;
        const white = gray > 125;
        v = red || white ? 255 : 0;
      } else v = gray > 95 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function cropRoiToTemplateVector(roiName, w, h, size) {
    if (!state.canvas) return null;
    const roi = getRoiPx(roiName, w, h);
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.drawImage(state.canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, size, size);
    return canvasToVector(c, size, size);
  }

  function canvasToVector(canvas, w, h) {
    const cx = canvas.getContext("2d", { willReadFrequently: true });
    const img = cx.getImageData(0, 0, w, h);
    const d = img.data;
    const vector = new Float32Array(w * h);
    let sum = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const gray = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      vector[j] = gray;
      sum += gray;
    }
    const mean = sum / vector.length;
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      vector[i] -= mean;
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return { vector: Array.from(vector), width: w, height: h };
  }

  function matchTemplates(vector, group, labels) {
    const templates = state.store.templates[group] || {};
    const scores = {};
    let bestLabel = "";
    let bestScore = -1;
    labels.forEach(label => {
      const list = templates[label] || [];
      let labelBest = -1;
      for (const tpl of list) {
        const score = vectorCorrelation(vector, tpl.vector);
        if (score > labelBest) labelBest = score;
      }
      scores[label] = labelBest < 0 ? 0 : labelBest;
      if (scores[label] > bestScore) {
        bestScore = scores[label];
        bestLabel = label;
      }
    });
    if (bestScore < 0) bestScore = 0;
    return { label: bestLabel, score: bestScore, scores };
  }

  function vectorCorrelation(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return clamp01((dot + 1) / 2);
  }

  function captureTemplate(group, label) {
    if (!state.canvas || !state.video) {
      alert("請先開始擷取遊戲視窗。");
      return;
    }
    const w = state.video.videoWidth;
    const h = state.video.videoHeight;
    const roiName = group === "stage" ? "stageIcon" : "channel";
    const cropped = cropRoiToTemplateVector(roiName, w, h, CONFIG.template.imageSize);
    if (!cropped) return;
    const templates = state.store.templates[group];
    if (!templates[label]) templates[label] = [];
    templates[label].push({ vector: cropped.vector, time: Date.now() });
    while (templates[label].length > CONFIG.template.maxTemplatesPerLabel) templates[label].shift();
    saveStore();
    updateTemplateCounts();
    setStatus(`已新增模板：${group} ${label}，共 ${templates[label].length} 張`, "ok");
  }

  function renderTemplateButtons() {
    const stageBox = $("tdStageTemplateButtons");
    const channelBox = $("tdChannelTemplateButtons");
    if (!stageBox || !channelBox) return;

    stageBox.innerHTML = "";
    STAGE_LABELS.forEach(label => {
      const btn = document.createElement("button");
      btn.className = "td-btn small template";
      btn.innerHTML = `${label}<span class="td-count" id="tdCount-stage-${label}">0</span>`;
      btn.onclick = () => captureTemplate("stage", label);
      stageBox.appendChild(btn);
    });

    channelBox.innerHTML = "";
    CHANNEL_LABELS.forEach(label => {
      const btn = document.createElement("button");
      btn.className = "td-btn small template";
      btn.innerHTML = `${label}<span class="td-count" id="tdCount-channel-${label}">0</span>`;
      btn.onclick = () => captureTemplate("channel", label);
      channelBox.appendChild(btn);
    });
  }

  function updateTemplateCounts() {
    STAGE_LABELS.forEach(label => setText(`tdCount-stage-${label}`, String((state.store.templates.stage[label] || []).length)));
    CHANNEL_LABELS.forEach(label => setText(`tdCount-channel-${label}`, String((state.store.templates.channel[label] || []).length)));
  }

  function clearTemplates() {
    state.store.templates = { stage: {}, channel: {} };
    saveStore();
    updateTemplateCounts();
    setStatus("已清除所有模板", "muted");
  }

  function beginCalibration(roiName) {
    if (!state.canvas) {
      alert("請先開始擷取並開啟 Debug。");
      return;
    }
    CONFIG.debug = true;
    const dbg = $("tdDebug");
    if (dbg) dbg.checked = true;
    updatePreviewVisibility();
    state.calibration.active = true;
    state.calibration.target = roiName;
    state.calibration.dragging = false;
    state.calibration.start = null;
    state.calibration.current = null;
    setStatus(`ROI 校正：請在預覽圖拖曳框選「${roiName}」`, "warn");
  }

  function setupPreviewEvents() {
    const c = $("tdPreview");
    if (!c) return;

    c.addEventListener("mousedown", e => {
      if (!state.calibration.active || !state.video) return;
      const p = getPreviewPoint(e, c);
      state.calibration.dragging = true;
      state.calibration.start = p;
      state.calibration.current = p;
    });
    c.addEventListener("mousemove", e => {
      if (!state.calibration.active || !state.calibration.dragging) return;
      state.calibration.current = getPreviewPoint(e, c);
    });
    window.addEventListener("mouseup", () => {
      if (!state.calibration.active || !state.calibration.dragging || !state.video) return;
      const start = state.calibration.start;
      const end = state.calibration.current;
      state.calibration.dragging = false;
      if (!start || !end) return;

      const x1 = Math.min(start.x, end.x);
      const y1 = Math.min(start.y, end.y);
      const x2 = Math.max(start.x, end.x);
      const y2 = Math.max(start.y, end.y);
      if (x2 - x1 < 5 || y2 - y1 < 5) return;

      const vw = state.video.videoWidth;
      const vh = state.video.videoHeight;
      const sx = vw / c.width;
      const sy = vh / c.height;
      state.store.roi[state.calibration.target] = {
        x: clamp01((x1 * sx) / vw),
        y: clamp01((y1 * sy) / vh),
        w: clamp01(((x2 - x1) * sx) / vw),
        h: clamp01(((y2 - y1) * sy) / vh)
      };
      saveStore();
      setStatus(`ROI 已儲存：${state.calibration.target}`, "ok");
      state.calibration.active = false;
      state.calibration.target = null;
    });
  }

  function getPreviewPoint(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function resetRoi() {
    if (!confirm("確定重置 ROI？模板不會被刪除。")) return;
    state.store.roi = JSON.parse(JSON.stringify(CONFIG.roi));
    saveStore();
    setStatus("ROI 已重置", "muted");
  }

  function getRoiNormalized(name) {
    return state.store.roi[name] || CONFIG.roi[name];
  }

  function getRoiPx(name, w, h) {
    const r = getRoiNormalized(name);
    return {
      x: Math.round(r.x * w),
      y: Math.round(r.y * h),
      w: Math.max(1, Math.round(r.w * w)),
      h: Math.max(1, Math.round(r.h * h))
    };
  }

  function drawPreview(w, h) {
    const p = $("tdPreview");
    if (!p || !state.canvas) return;
    const scale = CONFIG.previewScale;
    p.width = Math.max(1, Math.round(w * scale));
    p.height = Math.max(1, Math.round(h * scale));
    p.style.width = p.width + "px";
    p.style.height = p.height + "px";
    const px = p.getContext("2d");
    px.drawImage(state.canvas, 0, 0, p.width, p.height);
    drawRoi(px, "mapName", w, h, scale, "#00ff00");
    drawRoi(px, "channel", w, h, scale, "#00aaff");
    drawRoi(px, "stageIcon", w, h, scale, "#ff3333");
    drawRoi(px, "announcement", w, h, scale, "#ffcc00");

    if (state.calibration.active && state.calibration.dragging && state.calibration.start && state.calibration.current) {
      const a = state.calibration.start;
      const b = state.calibration.current;
      px.strokeStyle = "#fff";
      px.lineWidth = 2;
      px.setLineDash([4, 4]);
      px.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      px.setLineDash([]);
    }
  }

  function drawRoi(ctx, name, w, h, scale, color) {
    const r = getRoiPx(name, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    ctx.fillStyle = color;
    ctx.font = "12px monospace";
    ctx.fillText(name, r.x * scale + 3, r.y * scale + 13);
  }

  function updatePreviewVisibility() {
    const p = $("tdPreview");
    if (p) p.style.display = CONFIG.debug ? "block" : "none";
  }

  function updatePanel(info) {
    setText("tdMap", info.mapLevel ? `${info.mapLevel} (${info.mapName || ""})` : (info.mapName || "?"));
    setText("tdChannel", info.channel || "?");
    if (info.stageResult) setText("tdStageTemplate", `${info.stageResult.label || "?"} ${(info.stageResult.score * 100).toFixed(1)}%`);
    const ann = getFreshAnnouncement();
    setText("tdAnnouncement", ann ? `${ann.value} ${(ann.score * 100).toFixed(0)}%` : "-");
    setText("tdDecision", info.decision ? `${info.decision.value}${info.decision.blocked ? " (blocked)" : ""}` : "-");
    setText("tdStable", String(state.stableCount || 0));
  }

  function showConfirm(decision) {
    const key = `${decision.mapLevel}-${decision.channel} ${decision.value}`;
    if (state.pendingConfirm && state.pendingConfirm.mapLevel === decision.mapLevel && state.pendingConfirm.channel === decision.channel && state.pendingConfirm.value === decision.value) return;
    state.pendingConfirm = decision;
    setText("tdConfirmText", `確認送出：${key}\n${decision.reason || ""}`);
    const box = $("tdConfirmBox");
    if (box) box.style.display = "block";
    setStatus(`等待確認：${key}`, "warn");
  }

  function hideConfirm() {
    const box = $("tdConfirmBox");
    if (box) box.style.display = "none";
  }

  function setStatus(text, type) {
    const el = $("tdStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `td-status ${type || "muted"}`;
  }

  function toggleCompact() {
    const body = $("tdBody");
    const btn = $("tdCompactBtn");
    if (!body || !btn) return;
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "block" : "none";
    btn.textContent = hidden ? "−" : "+";
  }

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
    let bestName = "";
    let bestScore = 0;
    for (const name of Object.keys(MAP_NAME_TO_LEVEL)) {
      const score = mapSimilarity(q, normalizeMapText(name));
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    return { name: bestName, level: bestName ? MAP_NAME_TO_LEVEL[bestName] : "", score: bestScore };
  }

  function mapSimilarity(a, b) {
    if (!a || !b) return 0;
    const setA = [...a];
    const used = new Array(b.length).fill(false);
    let hit = 0;
    for (const ch of setA) {
      for (let i = 0; i < b.length; i++) {
        if (!used[i] && b[i] === ch) {
          used[i] = true;
          hit++;
          break;
        }
      }
    }
    const charScore = hit / Math.max(a.length, b.length);
    const includeBonus = b.includes(a) || a.includes(b) ? 0.18 : 0;
    return clamp01(charScore + includeBonus);
  }

  function normalizeMapText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .replace(/[|｜]/g, "")
      .replace(/[\[\]{}()（）【】「」『』]/g, "")
      .replace(/[臺]/g, "台")
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")
      .trim();
  }

  function normalizeAscii(text) {
    return String(text || "")
      .replace(/[ＯOｏ]/g, "0")
      .replace(/[ＩIlｌ]/g, "1")
      .replace(/[ＳS]/g, "5")
      .replace(/[^A-Za-z0-9.:：\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return sanitizeStore(JSON.parse(raw));
    } catch (err) {
      console.warn("[TOSMDetector] store load failed", err);
    }
    return sanitizeStore({});
  }

  function sanitizeStore(s) {
    s = s || {};
    if (!s.roi) s.roi = JSON.parse(JSON.stringify(CONFIG.roi));
    if (!s.templates) s.templates = {};
    if (!s.templates.stage) s.templates.stage = {};
    if (!s.templates.channel) s.templates.channel = {};
    return s;
  }

  function saveStore() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.store));
  }

  function exportData() {
    return JSON.stringify(state.store, null, 2);
  }

  function importData(json) {
    try {
      state.store = sanitizeStore(JSON.parse(json));
      saveStore();
      updateTemplateCounts();
      setStatus("設定已匯入", "ok");
    } catch (err) {
      alert("匯入失敗：JSON 格式錯誤");
    }
  }

  function setConfig(partial) {
    Object.assign(CONFIG, partial || {});
  }

  function injectStyle() {
    if ($("tosmDetectorStyle")) return;
    const s = document.createElement("style");
    s.id = "tosmDetectorStyle";
    s.textContent = `
      #tosmDetectorPanel { position: fixed; right: 12px; bottom: 12px; width: 280px; max-height: 92vh; overflow: auto; z-index: 99999; background: rgba(0,0,0,.92); border: 1px solid #333; border-radius: 12px; color: #aaa; font: 12px/1.45 monospace; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
      #tosmDetectorPanel .td-head { display:flex; justify-content:space-between; align-items:center; padding:9px 10px; border-bottom:1px solid #222; background:#0b0b0b; position: sticky; top: 0; z-index: 2; }
      #tosmDetectorPanel .td-title { color:#0f0; font-weight:bold; }
      #tosmDetectorPanel .td-ver { color:#555; font-size:10px; }
      #tosmDetectorPanel #tdBody { padding:10px; }
      #tosmDetectorPanel .td-icon-btn, #tosmDetectorPanel .td-btn { border:1px solid #444; color:#aaa; background:#111; border-radius:6px; padding:5px 8px; cursor:pointer; font:inherit; }
      #tosmDetectorPanel .td-btn.primary { border-color:#0f0; color:#0f0; background:#001800; }
      #tosmDetectorPanel .td-btn.danger { border-color:#733; color:#f66; }
      #tosmDetectorPanel .td-btn.small { padding:4px 6px; font-size:11px; }
      #tosmDetectorPanel .td-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
      #tosmDetectorPanel .td-row.compact { gap:5px; margin-bottom:4px; }
      #tosmDetectorPanel .td-status { min-height:18px; padding:6px 8px; border:1px solid #222; background:#101010; border-radius:7px; margin-bottom:8px; white-space:pre-wrap; word-break:break-all; }
      #tosmDetectorPanel .td-status.ok { color:#0f0; border-color:#064; }
      #tosmDetectorPanel .td-status.warn { color:#ffca28; border-color:#665000; }
      #tosmDetectorPanel .td-status.bad { color:#f66; border-color:#733; }
      #tosmDetectorPanel .td-status.muted { color:#888; }
      #tosmDetectorPanel .td-switches { display:grid; grid-template-columns:1fr 1fr; gap:4px 6px; margin-bottom:8px; color:#888; font-size:11px; }
      #tosmDetectorPanel .td-switches input { vertical-align:-2px; margin-right:3px; }
      #tosmDetectorPanel .td-grid { display:grid; grid-template-columns:64px 1fr; gap:3px 8px; border:1px solid #222; background:#080808; border-radius:8px; padding:8px; margin-bottom:8px; }
      #tosmDetectorPanel .td-grid div:nth-child(odd) { color:#555; }
      #tosmDetectorPanel .td-grid div:nth-child(even) { color:#ddd; word-break:break-all; }
      #tosmDetectorPanel details { border-top:1px solid #222; padding-top:8px; }
      #tosmDetectorPanel summary { cursor:pointer; color:#0f0; margin-bottom:8px; }
      #tosmDetectorPanel .td-section { border:1px solid #222; border-radius:8px; padding:8px; margin-bottom:8px; background:#080808; }
      #tosmDetectorPanel .td-section-title { color:#ffca28; margin-bottom:4px; font-weight:bold; }
      #tosmDetectorPanel .td-small { color:#666; font-size:11px; margin-bottom:6px; }
      #tosmDetectorPanel .td-template-buttons { display:grid; grid-template-columns:repeat(3, 1fr); gap:5px; }
      #tosmDetectorPanel .td-btn.template { position:relative; min-height:32px; }
      #tosmDetectorPanel .td-count { display:block; color:#0f0; font-size:10px; margin-top:2px; }
      #tosmDetectorPanel .td-textarea { width:100%; min-height:58px; box-sizing:border-box; background:#050505; color:#aaa; border:1px solid #333; border-radius:6px; font:10px monospace; padding:6px; }
      #tosmDetectorPanel .td-preview { display:none; max-width:100%; border:1px solid #333; border-radius:8px; background:#000; cursor:crosshair; }
      #tosmDetectorPanel .td-confirm { border:1px solid #665000; background:#171303; color:#ffca28; border-radius:8px; padding:8px; margin-top:8px; white-space:pre-wrap; }
    `;
    document.head.appendChild(s);
  }

  function $(id) { return document.getElementById(id); }
  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
  function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }
})();
