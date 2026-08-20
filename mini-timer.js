// TOSM 迷你計時窗 (依 Mini Timer Panel 設計稿實作)
// 顯示最緊急 3 張卡 + 快速輸入; 「彈出」= Document Picture-in-Picture, 真置頂於遊戲上方.
(function () {
    if (window.__miniTimerLoaded) return;
    window.__miniTimerLoaded = true;

    const LS_KEY = 'tosm_mini_timer_cfg';
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) {}
    let scale = Math.min(1.4, Math.max(0.6, cfg.scale || 1));
    let mode = cfg.mode || 0;
    let visible = !!cfg.visible;
    const locks = {};
    let pipWin = null;

    function saveCfg() {
        localStorage.setItem(LS_KEY, JSON.stringify({ scale, mode, visible }));
    }

    const css = document.createElement('style');
    css.textContent = `
@keyframes miniPulse {0%,100%{opacity:1}50%{opacity:.4}}
#miniTimerPanel{position:fixed;bottom:60px;right:12px;z-index:7400;width:300px;
 font-family:'JetBrains Mono',ui-monospace,monospace;transform-origin:bottom right;
 display:none;flex-direction:column;gap:4px;user-select:none;}
#miniTimerPanel.open{display:flex;}
#miniTimerPanel.inpip{position:static;transform-origin:top left;margin:6px;}
.mtCol{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.mtCard{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:4px 5px;
 background:rgba(8,10,8,.9);border:1px solid rgba(74,222,128,.32);border-radius:4px;
 box-shadow:0 4px 12px rgba(0,0,0,.5);}
.mtTop{display:flex;align-items:center;gap:3px;min-width:0;height:20px;}
.mtMap{font-size:18px;font-weight:700;color:#e9ece9;min-width:0;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap;line-height:20px;}
.mtTag{font-size:9px;color:#7f887f;white-space:nowrap;margin-left:auto;}
.mtVal{height:26px;display:flex;align-items:center;min-width:0;overflow:hidden;
 font-weight:700;line-height:26px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.mtSub{font-size:9px;line-height:11px;height:11px;color:#6d766e;white-space:nowrap;
 overflow:hidden;text-overflow:ellipsis;}
.mtAct{box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:19px;
 border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.04em;white-space:nowrap;
 overflow:hidden;background:rgba(0,0,0,.8);border:1px solid rgba(74,222,128,.26);
 color:#9fdfb4;cursor:pointer;}
.mtAct.lock{border-color:rgba(154,163,156,.2);color:#6d766e;cursor:not-allowed;}
.mtRow{display:flex;gap:4px;align-items:stretch;}
#mtInput{flex:1;min-width:0;box-sizing:border-box;height:26px;padding:0 7px;
 background:rgba(8,10,8,.9);border:1px solid rgba(74,222,128,.26);border-radius:3px;
 color:#e9ece9;font-family:inherit;font-size:10px;outline:none;}
#mtSend{box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:26px;
 width:64px;flex:none;border-radius:3px;background:rgba(0,0,0,.8);
 border:1px solid rgba(74,222,128,.34);color:#b7ecc9;font-size:10px;font-weight:700;cursor:pointer;}
#mtBar{display:flex;gap:6px;align-items:center;justify-content:flex-end;height:14px;}
#mtBar span{font-size:10px;color:#6d766e;cursor:pointer;line-height:14px;}
#mtBar span:hover{color:#b7ecc9;}
#miniTimerToggle{position:fixed;bottom:12px;z-index:7500;height:32px;padding:0 12px;
 border-radius:16px;background:#111;border:1px solid #333;color:#9fdfb4;font-size:13px;
 cursor:pointer;}
#miniTimerToggle:hover{border-color:#4ade80;}
`;
    document.head.appendChild(css);

    const panel = document.createElement('div');
    panel.id = 'miniTimerPanel';
    panel.innerHTML = `
<div id="mtBar"><span id="mtPip" title="彈出成置頂小窗 (蓋在遊戲上)">⧉ 彈出</span>
<span id="mtShrink" title="縮小">−</span><span id="mtGrow" title="放大">＋</span>
<span id="mtClose" title="收起">×</span></div>
<div class="mtRow" id="mtCards"></div>
<div class="mtRow"><input id="mtInput" placeholder="80 3 R1.5">
<div id="mtSend">送出</div></div>`;
    document.body.appendChild(panel);

    const toggle = document.createElement('button');
    toggle.id = 'miniTimerToggle';
    toggle.type = 'button';
    toggle.textContent = '⏱ 計時窗';
    const drawerBtn = document.getElementById('detectorDrawerToggle');
    toggle.style.right = drawerBtn ? '110px' : '12px';
    document.body.appendChild(toggle);

    function stageColor(dv) {
        if (/^ON/i.test(dv)) return '#ff00ff';
        const n = parseFloat(String(dv).replace(/[^\d.]/g, ''));
        if (n >= 4) return '#ff2fd0';
        if (n >= 3) return '#ff4d1a';
        if (n >= 2) return '#ff9500';
        return '#ffe600';
    }
    function fmt(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        const p = n => String(n).padStart(2, '0');
        return h > 0 ? h + ':' + p(m) + ':' + p(ss) : p(m) + ':' + p(ss);
    }
    function stageW(dv) {
        if (/^ON/i.test(dv)) return 9;
        const m = String(dv).match(/[\d.]+/);
        return m ? parseFloat(m[0]) : 0;
    }

    const MODES = ['⇄ 高進度', '⇄ 倒數短', '⇄ 超時久'];

    function pick() {
        const d = window.currentData || {};
        const now = Date.now();
        const rows = Object.entries(d).map(([id, b]) => ({ id, b }));
        const cds = rows.filter(r => r.b.targetTime > now)
            .sort((a, b) => a.b.targetTime - b.b.targetTime);
        const over = rows.filter(r => r.b.targetTime > 0 && r.b.targetTime <= now)
            .sort((a, b) => a.b.targetTime - b.b.targetTime);
        const stg = rows.filter(r => r.b.targetTime === 0 && /^(ON|階段)/.test(r.b.displayValue || ''))
            .sort((a, b) => stageW(b.b.displayValue) - stageW(a.b.displayValue));
        const base = cds.slice(0, 2);
        while (base.length < 2 && stg[base.length - cds.slice(0, 2).length]) {
            base.push(stg[base.length - cds.slice(0, 2).length]);
        }
        const used = new Set(base.map(r => r.id));
        let third = null;
        if (mode === 0) third = stg.find(r => !used.has(r.id)) || null;
        else if (mode === 1) third = cds.find(r => !used.has(r.id)) || null;
        else third = over.length ? over[0] : null;
        return { base, third, now };
    }

    function cardHtml(r, isThird, now) {
        if (!r) {
            return `<div class="mtCol"><div class="mtCard"><div class="mtTop"><span class="mtMap" style="color:#555;">—</span></div><div class="mtVal" style="color:#555;font-size:14px;">無資料</div><span class="mtSub"></span></div><div class="mtAct" data-cycle="1">${MODES[mode]}</div></div>`;
        }
        const b = r.b;
        const isCd = b.targetTime > now;
        const isOver = b.targetTime > 0 && b.targetTime <= now;
        const remain = b.targetTime - now;
        let valStyle, valTxt;
        if (isCd) {
            valTxt = fmt(remain);
            const red = remain < 300000;
            valStyle = 'color:' + (red ? '#ff3b30' : '#00e83c') + ';' +
                (red ? 'animation:miniPulse 1.1s ease-in-out infinite;' : '');
        } else if (isOver) {
            valTxt = '+' + fmt(now - b.targetTime);
            valStyle = 'color:#ff3b30;';
        } else {
            valTxt = b.displayValue || '?';
            valStyle = 'color:' + stageColor(valTxt) + ';letter-spacing:-.05em;';
        }
        const cjk = (valTxt.match(/[㐀-鿿]/g) || []).length;
        const fit = [24, 22, 20, 18, 16, 14, 13].find(sz => sz * (cjk * 0.98 + (valTxt.length - cjk) * 0.6) <= 86) || 13;
        const clock = b.targetTime > 0 ? new Date(b.targetTime).toTimeString().slice(0, 5) : '';
        const sub = [clock, b.updater || ''].filter(Boolean).join(' · ');
        const lockLeft = Math.max(0, (locks[r.id] || 0) - now);
        let act;
        if (isThird) {
            act = `<div class="mtAct" data-cycle="1" title="切換第三張卡片顯示條件">${MODES[mode]}</div>`;
        } else if (lockLeft > 0) {
            act = `<div class="mtAct lock">鎖定 ${(lockLeft / 1000).toFixed(1)}s</div>`;
        } else if (!isCd && !isOver) {
            const kill = /^ON/i.test(b.displayValue || '');
            act = `<div class="mtAct" data-next="${r.id}" title="推進到下一階段">${kill ? 'KILL ▸' : 'NEXT ▸'}</div>`;
        } else {
            act = `<div class="mtAct" data-on="${r.id}" title="BOSS 實際出現了 → 回報 ON">校時 ON</div>`;
        }
        const tag = (!isCd && !isOver) ? '' : `<span class="mtTag">${b.displayValue === 'ON' ? 'ON' : ''}</span>`;
        return `<div class="mtCol"><div class="mtCard">
<div class="mtTop"><span class="mtMap">${b.map} - ${b.ch}</span>${tag}</div>
<div class="mtVal" style="font-size:${fit}px;${valStyle}">${valTxt}</div>
<span class="mtSub">${sub}</span></div>${act}</div>`;
    }

    function render() {
        if (!visible && !pipWin) return;
        const { base, third, now } = pick();
        const doc = pipWin ? pipWin.document : document;
        const cardsEl = doc.getElementById('mtCards');
        if (!cardsEl) return;
        cardsEl.innerHTML = cardHtml(base[0], false, now) + cardHtml(base[1], false, now)
            + cardHtml(third, true, now);
        panel.style.transform = pipWin ? '' : 'scale(' + scale + ')';
    }

    function onPanelClick(e) {
        const t = e.target;
        if (t.dataset && t.dataset.cycle) { mode = (mode + 1) % 3; saveCfg(); render(); return; }
        const doAct = (id, fn) => {
            if ((locks[id] || 0) > Date.now()) return;
            locks[id] = Date.now() + 2000;
            const b = (window.currentData || {})[id];
            if (b) fn(b);
            render();
        };
        if (t.dataset && t.dataset.next) doAct(t.dataset.next, b => window.triggerNext && triggerNext(String(b.map), String(b.ch)));
        if (t.dataset && t.dataset.on) doAct(t.dataset.on, b => window.saveBoss && saveBoss(String(b.map), String(b.ch), 'ON'));
        if (t.id === 'mtSend') submitDraft();
        if (t.id === 'mtClose') { visible = false; panel.classList.remove('open'); saveCfg(); }
        if (t.id === 'mtShrink') { scale = Math.max(0.6, scale - 0.1); saveCfg(); render(); }
        if (t.id === 'mtGrow') { scale = Math.min(1.4, scale + 0.1); saveCfg(); render(); }
        if (t.id === 'mtPip') openPip();
    }

    function submitDraft() {
        const doc = pipWin ? pipWin.document : document;
        const inp = doc.getElementById('mtInput');
        const p = (inp.value || '').trim().split(/\s+/);
        if (p.length >= 3 && window.saveBoss) {
            saveBoss(p[0], p[1], p.slice(2).join(' '));
            inp.value = '';
        }
    }

    async function openPip() {
        if (!('documentPictureInPicture' in window)) {
            alert('此瀏覽器不支援置頂小窗 (需要 Chrome 116+)');
            return;
        }
        try {
            pipWin = await documentPictureInPicture.requestWindow({ width: 320, height: 200 });
        } catch (e) { return; }
        const pcss = pipWin.document.createElement('style');
        pcss.textContent = css.textContent + '\nbody{margin:0;background:#050605;}';
        pipWin.document.head.appendChild(pcss);
        panel.classList.add('inpip');
        pipWin.document.body.appendChild(panel);
        pipWin.document.body.addEventListener('click', onPanelClick);
        pipWin.document.getElementById('mtInput').addEventListener('keydown', e => {
            if (e.key === 'Enter') submitDraft();
        });
        pipWin.addEventListener('pagehide', () => {
            pipWin = null;
            panel.classList.remove('inpip');
            document.body.appendChild(panel);
            if (visible) panel.classList.add('open');
            render();
        });
        render();
    }

    panel.addEventListener('click', onPanelClick);
    panel.querySelector('#mtInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') submitDraft();
    });
    toggle.addEventListener('click', () => {
        visible = !visible;
        panel.classList.toggle('open', visible);
        saveCfg();
        render();
    });
    if (visible) panel.classList.add('open');
    setInterval(render, 1000);
})();
