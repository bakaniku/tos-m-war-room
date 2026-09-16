/* Pure contracts shared by the room UI and offline tests. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.TOSMObservation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const STAGES = new Set(['R1','R2','R3','R4','ON','WAITING']);
    const finite = n => typeof n === 'number' && Number.isFinite(n);
    const signature = c => c ? JSON.stringify([String(c.map),String(c.ch),c.lastInput,c.startTime,c.targetTime]) : null;
    // Legacy records have no reliable writer identity. Preserve them until a person
    // explicitly resumes automation. Also detect writes by old clients that leave
    // our metadata behind but change the actual card value/time.
    const manualProtected = c => !!c && (c.manualOverride?.active === true
        || !c.autoGuard || c.autoGuard.signature !== signature(c));
    const autoAllowed = (c, observedAt) => !manualProtected(c) && (!c?.autoGuard?.notBefore
        || (finite(observedAt) && observedAt > c.autoGuard.notBefore));
    function resolveMap(catalog, level, name, cardAlias=false) {
        const maps = catalog.filter(m => m.enabled_in_detector_dictionary);
        if (cardAlias && level === '70男') return maps.find(m=>m.level===70 && m.name_zh_tw==='阿雷魯諾男爵嶺') || null;
        if (cardAlias && level === '70水') return maps.find(m=>m.level===70 && m.name_zh_tw==='水路橋地區') || null;
        if (!(typeof level==='number' || (typeof level==='string' && /^[1-9]\d*$/.test(level)))) return null;
        const candidates=maps.filter(m=>m.level===Number(level));
        if (name) return candidates.find(m=>m.name_zh_tw===name) || null;
        return candidates.length===1 ? candidates[0] : null;
    }
    function normalizeObservation(d, room, catalog, now) {
        const o=d?.observation;
        if (!room || d?.room!==room || o?.schema!==1 || d.map_fresh!==true
            || !finite(d.updated_at) || d.updated_at>now || now-d.updated_at>120000
            || !finite(o.observed_at) || o.observed_at>now || o.observed_at>d.updated_at
            || now-o.observed_at>300000 || o.observed_at<=0 || !STAGES.has(o.stage)
            || o.evidence!=='same_frame_map_channel_stage'
            || !Number.isInteger(o.ch) || o.ch<1 || o.ch>4
            || d.map_level!==o.map_level || d.map_name!==o.map_name || d.ch!==o.ch) return null;
        const map=resolveMap(catalog,o.map_level,o.map_name);
        if (!map) return null;
        return {schema:1, room, map_id:map.catalog_id, map_level:map.level,
            map_name:map.name_zh_tw,ch:o.ch,stage:o.stage,observed_at:o.observed_at,
            detector_received_at:d.updated_at,evidence:o.evidence};
    }
    function validStored(o, room, map, ch, now) {
        return o?.schema===1 && o.room===room && o.map_id===map.catalog_id
            && o.map_level===map.level && o.map_name===map.name_zh_tw && o.ch===ch
            && STAGES.has(o.stage) && o.evidence==='same_frame_map_channel_stage'
            && finite(o.observed_at) && o.observed_at>0 && o.observed_at<=now
            && finite(o.detector_received_at) && o.observed_at<=o.detector_received_at
            && o.detector_received_at<=now;
    }
    function summarize(sources, room, map, ch, now, freshMs) {
        const all=Object.entries(sources||{}).filter(([,o])=>validStored(o,room,map,ch,now))
            .map(([id,o])=>({...o,collector_id:o.collector_id||id})).sort((a,b)=>b.observed_at-a.observed_at);
        if (!all.length) return {status:'never',latest:null,sources:[]};
        const latest=all[0], fresh=all.filter(o=>now-o.observed_at<=freshMs);
        const conflict=new Set(fresh.map(o=>o.stage)).size>1;
        return {status:conflict?'conflict':now-latest.observed_at>freshMs?'stale':'recent',latest,sources:all};
    }
    return {signature,manualProtected,autoAllowed,resolveMap,normalizeObservation,validStored,summarize};
});
