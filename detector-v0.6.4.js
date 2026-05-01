(function () {
  "use strict";

  const VERSION = "0.6.4";

  const CONFIG = {
    scanIntervalMs: 800,
    stableNeed: 3,
    submitCooldownMs: 8000,

    // 以 1648x900 截圖比例估算，可之後做校正功能
    roi: {
      mapName: { x: 0.78, y: 0.32, w: 0.17, h: 0.06 },
      channel: { x: 0.93, y: 0.32, w: 0.06, h: 0.06 },
      bossCircle: { x: 0.77, y: 0.08, w: 0.12, h: 0.18 }
    }
  };

  const MAP_NAME_TO_LEVEL = {
    "那魯巴斯寺院別館": "160",
    "那魯巴斯寺院": "160"
  };

  let video = null;
  let canvas = null;
  let ctx = null;
  let stream = null;
  let timer = null;

  let lastCandidateKey = "";
  let stableCount = 0;
  let lastSubmitKey = "";
  let lastSubmitAt = 0;

  function createPanel() {
    if (document.getElementById("tosmDetectorPanel")) return;

    const panel = document.createElement("div");
    panel.id = "tosmDetectorPanel";
    panel.style.cssText = `
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 99999;
      background: rgba(0,0,0,.88);
      border: 1px solid #333;
      border-radius: 10px;
      padding: 10px;
      color: #aaa;
      font-size: 12px;
      font-family: monospace;
      min-width: 220px;
      box-shadow: 0 0 12px rgba(0,0,0,.5);
    `;

    panel.innerHTML = `
      <div style="color:#0f0;font-weight:bold;margin-bottom:6px;">
        TOSM Detector v${VERSION}
      </div>
      <div id="tosmDetectorStatus" style="margin-bottom:8px;">尚未啟動</div>
      <button id="tosmDetectorStart" style="padding:5px 10px;border-radius:6px;border:1px solid #0f0;background:#000;color:#0f0;cursor:pointer;">開始偵測</button>
      <button id="tosmDetectorStop" style="padding:5px 10px;border-radius:6px;border:1px solid #555;background:#111;color:#888;cursor:pointer;">停止</button>
    `;

    document.body.appendChild(panel);

    document.getElementById("tosmDetectorStart").onclick = start;
    document.getElementById("tosmDetectorStop").onclick = stop;
  }

  function setStatus(text, color) {
    const el = document.getElementById("tosmDetectorStatus");
    if (!el) return;
    el.textContent = text;
    el.style.color = color || "#aaa";
  }

  async function start() {
    try {
      if (!window.saveBoss) {
        alert("偵測器找不到 saveBoss()，請確認 detector-v0.6.4.js 載入在主程式之後。");
        return;
      }

      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: 10
        },
        audio: false
      });

      video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });

      timer = setInterval(scanFrame, CONFIG.scanIntervalMs);
      setStatus("偵測中…", "#0f0");
    } catch (err) {
      console.error("[TOSMDetector] start failed:", err);
      setStatus("啟動失敗或未授權", "#f66");
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }

    stream = null;
    video = null;
    setStatus("已停止", "#888");
  }

  async function scanFrame() {
    if (!video || video.readyState < 2) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;

    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);

    try {
      const channel = await detectChannel(w, h);
      const mapName = await detectMapName(w, h);
      const mapLevel = resolveMapLevel(mapName);
      const state = detectBossState(w, h);

      if (!channel || !mapLevel || !state) {
        setStatus(`辨識不足 map=${mapName || "?"} ch=${channel || "?"} state=${state || "?"}`, "#ff0");
        return;
      }

      const result = {
        mapLevel,
        channel,
        state,
        rawMapName: mapName
      };

      handleStableResult(result);
    } catch (err) {
      console.warn("[TOSMDetector] scan error:", err);
      setStatus("偵測錯誤，請查看 console", "#f66");
    }
  }

  function handleStableResult(result) {
    const key = `${result.mapLevel}_${result.channel}_${result.state}`;

    if (key === lastCandidateKey) {
      stableCount++;
    } else {
      lastCandidateKey = key;
      stableCount = 1;
    }

    setStatus(
      `候選：${result.mapLevel}-${result.channel} ${result.state} / ${stableCount}`,
      stableCount >= CONFIG.stableNeed ? "#0f0" : "#aaa"
    );

    if (stableCount < CONFIG.stableNeed) return;

    const now = Date.now();
    if (key === lastSubmitKey && now - lastSubmitAt < CONFIG.submitCooldownMs) return;

    lastSubmitKey = key;
    lastSubmitAt = now;

    window.saveBoss(result.mapLevel, result.channel, result.state, false);

    setStatus(`已送出：${result.mapLevel}-${result.channel} ${result.state}`, "#0af");
  }

  async function detectChannel(w, h) {
    const roi = getRoi("channel", w, h);
    const text = await ocrRoi(roi, "eng");

    const match = text.match(/CH\.?\s*[:：]?\s*(\d+)/i) || text.match(/\b(\d{1,2})\b/);
    return match ? match[1] : "";
  }

  async function detectMapName(w, h) {
    const roi = getRoi("mapName", w, h);
    const text = await ocrRoi(roi, "chi_tra+eng");

    return normalizeText(text);
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

    return bestScore >= 0.55 ? MAP_NAME_TO_LEVEL[bestName] : "";
  }

  function detectBossState(w, h) {
    const roi = getRoi("bossCircle", w, h);
    const img = ctx.getImageData(roi.x, roi.y, roi.w, roi.h);

    const redRatio = estimateRedProgressRatio(img);

    // 這裡先用簡化規則，實際要依多張樣本調整
    if (redRatio >= 0.92) return "ON";
    if (redRatio >= 0.68) return "R4";
    if (redRatio >= 0.45) return "R3";
    if (redRatio >= 0.22) return "R2";
    if (redRatio >= 0.05) return "R1";

    return "XX";
  }

  function estimateRedProgressRatio(imageData) {
    const data = imageData.data;
    let red = 0;
    let valid = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 80) continue;

      const isRed = r > 130 && g < 90 && b < 90 && r > g * 1.4 && r > b * 1.4;
      const isDarkOrColored = r + g + b > 80;

      if (isDarkOrColored) valid++;
      if (isRed) red++;
    }

    if (!valid) return 0;
    return red / valid;
  }

  async function ocrRoi(roi, lang) {
    const tmp = document.createElement("canvas");
    tmp.width = roi.w;
    tmp.height = roi.h;

    const tctx = tmp.getContext("2d", { willReadFrequently: true });
    tctx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);

    preprocessForOcr(tctx, roi.w, roi.h);

    const result = await Tesseract.recognize(tmp, lang, {
      logger: () => {}
    });

    return result.data.text || "";
  }

  function preprocessForOcr(tctx, w, h) {
    const img = tctx.getImageData(0, 0, w, h);
    const d = img.data;

    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const v = gray > 120 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }

    tctx.putImageData(img, 0, 0);
  }

  function getRoi(name, w, h) {
    const r = CONFIG.roi[name];
    return {
      x: Math.floor(r.x * w),
      y: Math.floor(r.y * h),
      w: Math.floor(r.w * w),
      h: Math.floor(r.h * h)
    };
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, "")
      .replace(/[|｜]/g, "")
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    let hit = 0;
    for (const ch of a) {
      if (b.includes(ch)) hit++;
    }
    return hit / Math.max(a.length, b.length);
  }

  window.TOSMDetector = {
    version: VERSION,
    start,
    stop,
    mount: createPanel,
    config: CONFIG
  };

  window.addEventListener("DOMContentLoaded", createPanel);
})();
