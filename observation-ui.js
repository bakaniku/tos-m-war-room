/* Room-scoped observation book. This module never writes boss cards. */
(function() {
    'use strict';
    const O=window.TOSMObservation, catalog=window.TOSMMapCatalog;
    if (!O || !Array.isArray(catalog)) return;
    const anchor=document.getElementById('sortMapBtn');
    if (!anchor) return;
    const button=document.createElement('button');
    button.id='observationBookButton';button.className='btn-toggle';button.textContent='全圖觀測';
    anchor.parentElement.appendChild(button);
    const dialog=document.createElement('dialog');
    dialog.id='observationBook';
    dialog.innerHTML=`<div class="obs-header"><div><h2>全圖最近觀測</h2><div id="obsRoom"></div></div><button id="obsClose" aria-label="關閉全圖觀測">✕</button></div>
      <p>保留偵測器最後確認的階段；有人監看不代表階段已確認。人工卡片保持獨立。</p>
      <div class="obs-controls"><input id="obsSearch" type="search" placeholder="搜尋地圖等級或名稱" aria-label="搜尋地圖">
        <label>過期門檻 <select id="obsFreshness"><option value="1">1 分鐘</option><option value="2">2 分鐘</option><option value="5">5 分鐘</option><option value="10">10 分鐘</option><option value="30">30 分鐘</option></select></label>
        <label><input type="checkbox" id="obsSave"> 保存已認領偵測器的觀測</label></div>
      <div id="obsMessage" role="status"></div><div id="obsSummary"></div><div id="obsRows"></div>`;
    document.body.appendChild(dialog);
    const style=document.createElement('style');
    style.textContent=`#observationBook{box-sizing:border-box;width:min(980px,96vw);max-height:90vh;background:#111;color:#ddd;border:1px solid #555;border-radius:12px;padding:20px;overflow:auto}#observationBook::backdrop{background:#000a}.obs-header{display:flex;justify-content:space-between;gap:12px}.obs-header h2{margin:0 0 5px;font-size:19px}.obs-header button{align-self:flex-start}.obs-controls{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}.obs-controls input[type=search]{width:220px;max-width:100%;box-sizing:border-box}.obs-controls label{font-size:12px}.obs-controls input,.obs-controls select{color:inherit;background:transparent;border:1px solid #777;border-radius:5px;padding:5px}#obsRoom,#observationBook p{font-size:12px;color:#999}#obsMessage{color:#e8ad59;font-size:12px}#obsSummary{font-size:12px;margin:12px 0}.obs-row{display:grid;grid-template-columns:minmax(190px,2fr) minmax(120px,1fr) minmax(150px,1.5fr);gap:10px;padding:12px 0;border-top:1px solid #383838;font-size:13px}.obs-row small{display:block;font-size:11px;opacity:.7;margin-top:4px;overflow-wrap:anywhere}.obs-recent{color:#49ba7d}.obs-stale,.obs-conflict{color:#dc9e3b}.obs-never{color:#999}.obs-row [data-watch=yes]{color:#49ba7d}body.light #observationBook{background:#fafafa;color:#222}@media(max-width:550px){#observationBook{padding:14px}.obs-row{grid-template-columns:1fr 1fr}.obs-row>div:last-child{grid-column:1/-1}.obs-controls{display:block}.obs-controls>label{display:block;margin-top:10px}}`;
    document.head.appendChild(style);
    const el=id=>document.getElementById(id), pending=new Set(), retryAt=new Map();
    let room=null,ref=null,records={},loaded=false,errorText='';
    const save=el('obsSave'),freshness=el('obsFreshness');
    save.checked=localStorage.getItem('tosmSaveObservations')!=='0';
    freshness.value=['1','2','5','10','30'].includes(localStorage.getItem('tosmObservationFreshMinutes'))
        ?localStorage.getItem('tosmObservationFreshMinutes'):'5';
    const context=()=>window.getDetectorObservationContext?.()||{room:'',latest:{},owned:[]};
    const sourceKey=id=>'c_'+Array.from(new TextEncoder().encode(id),b=>b.toString(16).padStart(2,'0')).join('');
    const label=s=>({WAITING:'冷卻中',ON:'ON',R1:'R1',R2:'R2',R3:'R3',R4:'R4'}[s]||'未知');
    const age=t=>{const sec=Math.max(0,Math.floor((Date.now()-t)/1000));return sec<60?`${sec} 秒前`:`${Math.floor(sec/60)} 分前`;};
    function subscribe() {
        const next=context().room||'';
        if (next===room) return;
        if (ref) ref.off();
        room=next;records={};loaded=false;errorText='';ref=null;
        if (!room) {render();return;}
        const subscribed=room;
        ref=db.ref(`rooms/${room}/observations`);
        ref.on('value',snap=>{
            if (room!==subscribed || context().room!==subscribed) return;
            records=snap.val()||{};loaded=true;errorText='';render();persist();
        },error=>{
            if (room!==subscribed) return;
            loaded=false;errorText='觀測紀錄讀取失敗，請檢查連線或權限。';render();
            console.warn('觀測紀錄讀取失敗',error);
        });
        render();
    }
    function persist() {
        const c=context(), now=Date.now();
        if (!save.checked || !room || c.room!==room || !loaded || isBanned) return;
        for (const [id,d] of Object.entries(c.latest||{})) {
            if (!(c.owned.includes(id)||c.writeOthers) || id.length>100) continue;
            const o=O.normalizeObservation(d,room,catalog,now);
            if (!o) continue;
            const target=`${o.map_id}_${o.ch}`,source=sourceKey(id),job=`${room}/${target}/${source}`;
            const map=catalog.find(m=>m.catalog_id===o.map_id),old=records[target]?.[source];
            if (O.validStored(old,room,map,o.ch,now) && old.observed_at>=o.observed_at) continue;
            if (pending.has(job) || now<(retryAt.get(job)||0)) continue;
            const writeRoom=room;
            pending.add(job);
            db.ref(`rooms/${writeRoom}/observations/${target}/${source}`).transaction(cur=>{
                const current=context();
                if (room!==writeRoom || current.room!==writeRoom || !save.checked || isBanned
                    || !(current.owned.includes(id)||current.writeOthers)
                    || !O.normalizeObservation(d,writeRoom,catalog,Date.now())) return;
                if (O.validStored(cur,writeRoom,map,o.ch,Date.now()) && cur.observed_at>=o.observed_at) return;
                return {...o,collector_id:id,stored_at:{'.sv':'timestamp'}};
            },(error)=>{
                pending.delete(job);
                if (error) {
                    retryAt.set(job,Date.now()+5000);
                    if(room===writeRoom) {errorText='觀測保存失敗；稍後重試，人工卡片不受影響。';render();}
                } else retryAt.delete(job);
            },false).catch(()=>{});
        }
    }
    function watchers(map,ch,now) {
        return Object.entries(context().latest||{}).filter(([,d])=>d.room===room && d.map_fresh===true
            && Number.isFinite(d.updated_at) && d.updated_at<=now && now-d.updated_at<=120000
            && d.ch===ch && O.resolveMap(catalog,d.map_level,d.map_name)?.catalog_id===map.catalog_id)
            .map(([id])=>id);
    }
    function render() {
        if (!dialog.open) return;
        const now=Date.now(),freshMs=Number(freshness.value)*60000,search=el('obsSearch').value.trim().toLowerCase();
        el('obsRoom').textContent=room?`房間 ${room} · 請在同一房間觀測同一遊戲伺服器`:'請先進入房間';
        el('obsMessage').textContent=errorText||(!loaded?'等待本房間的觀測紀錄…':'');
        const body=el('obsRows');body.replaceChildren();
        const totals={recent:0,stale:0,conflict:0,never:0}, rows=[];
        for (const map of catalog.filter(m=>m.enabled_in_detector_dictionary)) {
            const channels=new Set();
            for (let ch=1;ch<=4;ch++) {
                const values=records[`${map.catalog_id}_${ch}`];
                if (Object.values(values||{}).some(o=>O.validStored(o,room,map,ch,now)))channels.add(ch);
            }
            if (window.__tosmBossDataRoom===room) for(const card of Object.values(window.currentData||{})) {
                if (O.resolveMap(catalog,card.map,null,true)?.catalog_id===map.catalog_id
                    && /^[1-4]$/.test(String(card.ch)))channels.add(Number(card.ch));
            }
            if (!channels.size) rows.push({map,ch:null});
            else for(const ch of [...channels].sort())rows.push({map,ch});
        }
        // Show useful reports first; low-level unverified candidates must not bury
        // the one map the user is currently watching beneath a hundred empty rows.
        const rank=row=>row.ch ? ({conflict:0,recent:1,stale:2,never:3}[O.summarize(
            records[`${row.map.catalog_id}_${row.ch}`],room,row.map,row.ch,now,freshMs).status]) : 4;
        rows.sort((a,b)=>rank(a)-rank(b)||a.map.level-b.map.level||(a.ch||0)-(b.ch||0));
        for(const {map,ch} of rows) {
            const summary=ch?O.summarize(records[`${map.catalog_id}_${ch}`],room,map,ch,now,freshMs):{status:'never',latest:null,sources:[]};
            totals[summary.status]++;
            if (search && !`${map.level} ${map.name_zh_tw}`.toLowerCase().includes(search))continue;
            const row=document.createElement('div');row.className='obs-row';row.dataset.mapId=map.catalog_id;row.dataset.ch=ch||'';
            const location=document.createElement('div');location.textContent=`Lv.${map.level} ${map.name_zh_tw}`;
            const detail=document.createElement('small');detail.textContent=ch?`CH.${ch} · 已列卡片或曾觀測的分流`:'分流待查核';location.appendChild(detail);
            const state=document.createElement('div');state.className=`obs-${summary.status}`;
            state.textContent=!loaded?'尚未載入':({never:'從未觀測',recent:label(summary.latest?.stage),stale:`已過期 · ${label(summary.latest?.stage)}`,conflict:'來源有分歧'}[summary.status]);
            if(summary.latest){const time=document.createElement('small');time.textContent=age(summary.latest.observed_at);time.title=new Date(summary.latest.observed_at).toLocaleString();state.appendChild(time);}
            const source=document.createElement('div'),watch=ch?watchers(map,ch,now):[];
            source.dataset.watch=watch.length?'yes':'no';source.textContent=watch.length?'👁 有人監看':'目前無人監看';
            const by=document.createElement('small');by.textContent=summary.sources.length
                ?summary.sources.map(o=>`${o.collector_id}: ${label(o.stage)}（${age(o.observed_at)}）`).join('；'):'尚無確認紀錄';source.appendChild(by);
            row.append(location,state,source);body.appendChild(row);
        }
        el('obsSummary').textContent=loaded?`候選地圖 106 張（另 3 張在字典停用）；分流總數尚未確認。列出的目標：最近 ${totals.recent} · 過期 ${totals.stale} · 分歧 ${totals.conflict} · 未觀測 ${totals.never}`:'尚未載入，暫不計算涵蓋率。';
    }
    button.addEventListener('click',()=>{dialog.showModal();subscribe();render();});
    el('obsClose').addEventListener('click',()=>dialog.close());
    el('obsSearch').addEventListener('input',render);
    freshness.addEventListener('change',()=>{localStorage.setItem('tosmObservationFreshMinutes',freshness.value);render();});
    save.addEventListener('change',()=>{localStorage.setItem('tosmSaveObservations',save.checked?'1':'0');persist();});
    window.addEventListener('tosm-detectors',()=>{subscribe();persist();render();});
    window.addEventListener('tosm-boss-data',()=>{subscribe();render();});
    setInterval(()=>{subscribe();persist();render();},1000);
    subscribe();
})();
