// Offline browser tests of the real card renderer and detector drawer.
// Requires playwright (NODE_PATH may point at the bundled runtime) and installed Chrome.
// All HTTP/WebSocket traffic is intercepted; Firebase is an in-memory stub.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');
const O = require('./observation-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const section = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
const drawer = html.match(/<script id="detectorDrawerScript">([\s\S]*?)<\/script>/)[1]
    .replace(/\}\)\(\);\s*$/, 'window.coverageQA={calculateCoverage,refreshCoverage,render,subscribeRoom,autoWrite,setLatest:d=>{latest=d;}};})();');
const functions = section('function getBossStatus(', 'function enterInlineEdit(')
    + section('function enterInlineEdit(', 'function editMemberCount(')
    + section('function renderList(', 'function toggleKilledSection(');
const fixture = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const NOW = 1800000000000;
const card = (map, ch, extra={}) => {
    const c={map:String(map),ch:String(ch),lastInput:'R2',displayValue:'階段2',startTime:NOW-30000,targetTime:0,...extra};
    c.autoGuard={signature:O.signature(c),notBefore:0};return c;
};
const cards = {'175_1':card(175,1),'181_1':card(181,1),'184_1':card(184,1),'184_2':card(184,2)};
const det = (map, ch, extra={}) => ({room:'ROOM',map_level:map,ch,map_fresh:true,updated_at:NOW,
    stage:'R2',...extra});
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});

async function setup(t, data=cards) {
    const context = await browser.newContext({viewport:{width:1100,height:820}});
    t.after(()=>context.close());
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url()==='http://coverage.test/'
        ? r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}) : r.abort());
    await page.routeWebSocket('**/*',ws=>ws.close());
    await page.goto('http://coverage.test/');
    await page.evaluate(({data,now})=>{
        window.qa={now,callbacks:{},subscriptions:[],writes:[],intervals:[]};
        Date.now=()=>qa.now;
        window.setInterval=(fn,ms)=>{qa.intervals.push({fn,ms});return qa.intervals.length;};
        window.clearInterval=()=>{};
        localStorage.setItem('nativeDetAutoWrite','0');
        localStorage.setItem('nativeDetMine','[]');
        localStorage.setItem('nativeDetMultiCh','184');
        Object.assign(window,{currentRoom:'ROOM',myName:'QA',currentData:data,__tosmBossDataRoom:'ROOM',
            timers:{},currentSort:'map',localPinned:{},isBanned:false,globalNextLocked:false,
            killedSectionCollapsed:false,lvPass:()=>true,hasAuth:()=>true,hasBanAuth:()=>false,
            canIUseCall:()=>false,isProtectedRoom:()=>false,getStatusColor:()=> '#e0a030',
            t:k=>({secMapAll:'全部地圖',secPinned:'置頂'}[k]||k),
            startTimer:(id,b)=>{document.getElementById('t_'+id).textContent=b.displayValue;},
            saveBoss:(map,ch,val,focus,options)=>{qa.writes.push({kind:'saveBoss',map,ch,val});options?.onCommitted?.();options?.onFinished?.(true);},
            db:{ref(p){return {
                on:(ev,fn)=>{qa.callbacks[p]=fn;qa.subscriptions.push(p);},off:()=>{},
                set:v=>{qa.writes.push({kind:'set',p,v});return Promise.resolve();},
                remove:()=>{qa.writes.push({kind:'remove',p});return Promise.resolve();},
                push:v=>{qa.writes.push({kind:'push',p,v});return Promise.resolve();},
                transaction:()=>{throw new Error('Coverage must never transact');}
            };}}});
        document.getElementById('loginView').style.display='none';
        document.getElementById('mainView').style.display='block';
        document.getElementById('displayID').textContent='QA（離線測試）';
        document.getElementById('chatPanel').className='chat-hidden';
    },{data,now:NOW});
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'observation-core.js'),'utf8')});
    await page.addScriptTag({content:functions});
    await page.addScriptTag({content:drawer});
    await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}'});
    await page.evaluate(()=>{renderList();document.getElementById('detectorDrawerToggle').click();});
    t.after(()=>assert.deepEqual(errors,[],'no browser script errors'));
    return page;
}
async function publish(page,detectors,bucket='ROOM'){
    await page.evaluate(({d,b})=>qa.callbacks['shared/nativeDetector/'+b]({val:()=>d}),{d:detectors,b:bucket});
}
async function state(page){return page.evaluate(()=>({
    badges:Object.fromEntries([...document.querySelectorAll('.det-coverage')].map(e=>[e.dataset.cardId,
        {hidden:e.hidden,state:e.dataset.state,title:e.title}])),
    summary:document.getElementById('detectorCoverageSummary').textContent,
    hidden:document.getElementById('detectorCoverageSummary').hidden,
    writes:qa.writes,subscriptions:qa.subscriptions
}));}

test('basic coverage: unclaimed same-room collectors count; remaining cards sorted',async t=>{
    const p=await setup(t);await publish(p,{qa_a:det(175,1),qa_b:det(181,1)});
    const s=await state(p);assert.equal(s.badges['175_1'].state,'confirmed');
    assert.equal(s.badges['181_1'].state,'confirmed');assert.equal(s.badges['184_1'].hidden,true);
    assert.equal(s.summary,'未覆蓋：184-1、184-2');assert.deepEqual(s.writes,[]);
    assert.deepEqual(s.subscriptions,['shared/nativeDetector/ROOM','shared/nativeDetector/_unassigned']);
});
test('unconfirmed map is yellow and remains uncovered',async t=>{
    const p=await setup(t);await publish(p,{c:det(184,2,{map_fresh:false})});
    const s=await state(p);assert.equal(s.badges['184_2'].state,'pending');
    assert.match(s.summary,/184-2/);assert.match(s.badges['184_2'].title,/地圖待確認/);
});
test('unknown channel on protected map marks every existing channel yellow',async t=>{
    const p=await setup(t);await publish(p,{c:det(184,null)});const s=await state(p);
    for(const k of ['184_1','184_2']){assert.equal(s.badges[k].state,'pending');assert.match(s.badges[k].title,/分流未知/);}
    assert.equal(s.summary,'未覆蓋：175-1、181-1、184-1、184-2');
});
test('exact 120 second boundary and expiration use existing timer, no new snapshot',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});
    await p.evaluate(()=>{qa.now+=120000;qa.intervals.find(x=>x.fn.name==='render').fn();});
    assert.equal((await state(p)).badges['175_1'].state,'confirmed');
    await p.evaluate(()=>{qa.now++;qa.intervals.find(x=>x.fn.name==='render').fn();});
    const s=await state(p);assert.equal(s.badges['175_1'].hidden,true);assert.match(s.summary,/175-1/);
});
test('confirmed source wins over pending; all source IDs remain in tooltip',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1,{map_fresh:false}),b:det(175,1),c:det(175,1)});
    const s=await state(p);assert.equal(s.badges['175_1'].state,'confirmed');
    for(const id of ['a','b','c'])assert.match(s.badges['175_1'].title,new RegExp(id+'：'));
    assert.equal(s.summary,'未覆蓋：181-1、184-1、184-2');
});
test('all cards covered, no detectors, no cards each have the intended summary',async t=>{
    const p=await setup(t,{'175_1':card(175,1)});
    assert.equal((await state(p)).summary,'未覆蓋：175-1');
    await publish(p,{a:det(175,1)});assert.equal((await state(p)).summary,'全部卡片都有偵測器在看');
    await publish(p,{});assert.match(await p.locator('#nativeDetList').textContent(),/沒有偵測器/);
    assert.equal((await state(p)).summary,'未覆蓋：175-1');
    await p.evaluate(()=>{currentData={};dispatchEvent(new Event('tosm-boss-data'));renderList();});
    assert.equal((await state(p)).hidden,true);assert.deepEqual((await state(p)).badges,{});
});
test('unassigned collectors cannot cover; foreign and missing-room data rejected by pure function',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)},'_unassigned');
    assert.equal((await state(p)).badges['175_1'].hidden,true);
    const s=await p.evaluate(()=>coverageQA.calculateCoverage(currentData,
        {other:{room:'OTHER',map_level:175,ch:1,updated_at:qa.now},missing:{map_level:181,ch:1,updated_at:qa.now}},
        currentRoom,__tosmBossDataRoom,new Set(['184']),qa.now));
    assert.equal(s.uncovered.length,4);
});
test('changing room clears badges immediately; delayed old callback cannot restore them',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});
    await p.evaluate(()=>{qa.old=qa.callbacks['shared/nativeDetector/ROOM'];currentRoom='OTHER';refreshDetectorCoverage();});
    let s=await state(p);assert.equal(s.badges['175_1'].hidden,true);assert.equal(s.hidden,true);
    await p.evaluate(()=>{coverageQA.subscribeRoom();__tosmBossDataRoom='OTHER';dispatchEvent(new Event('tosm-boss-data'));
        qa.old({val:()=>({old:{map_level:175,ch:1,updated_at:qa.now}})});});
    s=await state(p);assert.equal(s.badges['175_1'].hidden,true);
    await publish(p,{new:det(175,1)},'OTHER');assert.equal((await state(p)).badges['175_1'].state,'confirmed');
});
test('unassigned callback during room switch cannot relabel cached room data',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});
    await p.evaluate(()=>{currentRoom='OTHER';__tosmBossDataRoom='OTHER';});
    await publish(p,{},'_unassigned');assert.equal((await state(p)).badges['175_1'].hidden,true);
});
test('detector before card snapshot waits; card event then exposes coverage',async t=>{
    const p=await setup(t);await p.evaluate(()=>{__tosmBossDataRoom=null;});await publish(p,{a:det(175,1)});
    assert.equal((await state(p)).hidden,true);
    await p.evaluate(()=>{__tosmBossDataRoom='ROOM';dispatchEvent(new Event('tosm-boss-data'));});
    assert.equal((await state(p)).badges['175_1'].state,'confirmed');
});
test('missing, future, stale, nonnumeric timestamps and malformed identities never confirm',async t=>{
    const p=await setup(t);
    const invalid=[{updated_at:null},{updated_at:undefined},{updated_at:String(NOW)},{updated_at:NOW+1},
        {updated_at:NOW-120001},{map_level:null},{map_level:0},{map_level:'175x'},{map_level:true},
        {ch:0},{ch:-1},{ch:5},{ch:1.5},{ch:'oops'},{ch:''},{ch:true}];
    for(const patch of invalid){await publish(p,{a:det(175,1,patch)});assert.equal((await state(p)).badges['175_1'].hidden,true,JSON.stringify(patch));}
});
test('channel resolver preserves legacy defaults, valid string data and dynamic settings',async t=>{
    const p=await setup(t);await publish(p,{a:det('175','1'),b:det(181,4),c:det(184,null)});
    let s=await state(p);assert.equal(s.badges['175_1'].state,'confirmed');assert.equal(s.badges['181_1'].state,'confirmed');
    assert.match(s.badges['181_1'].title,/推定 CH.1/);
    await p.locator('#detectorSettingsToggle').click();
    await p.locator('#nativeDetMultiCh').fill('181');await p.locator('#nativeDetMultiCh').dispatchEvent('input');
    s=await state(p);assert.equal(s.badges['181_1'].hidden,true);assert.equal(s.badges['184_1'].state,'confirmed');
    assert.match(s.badges['184_1'].title,/推定 CH.1/);
});
test('legacy missing map_fresh is compatible; unknown stage still means location coverage only',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1,{map_fresh:undefined,stage:'UNKNOWN'})});
    const b=(await state(p)).badges['175_1'];assert.equal(b.state,'confirmed');assert.match(b.title,/不代表階段/);
});
test('detector movement and card additions/deletions cannot leave old coverage behind',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});await publish(p,{a:det(181,1)});
    let s=await state(p);assert.equal(s.badges['175_1'].hidden,true);assert.equal(s.badges['181_1'].state,'confirmed');
    await publish(p,{a:det(189,2)});assert.equal(Object.keys((await state(p)).badges).length,4);
    await p.evaluate(c=>{delete currentData['175_1'];currentData['189_2']=c;dispatchEvent(new Event('tosm-boss-data'));renderList();},card(189,2));
    s=await state(p);assert.equal(s.badges['175_1'],undefined);assert.equal(s.badges['189_2'].state,'confirmed');
});
test('numeric summary order and level filtering still count all room cards',async t=>{
    const p=await setup(t,{'181_2':card(181,2),'9_1':card(9,1),'181_1':card(181,1)});
    await p.evaluate(()=>{lvPass=m=>Number(m)>100;renderList();});const s=await state(p);
    assert.equal(s.summary,'未覆蓋：9-1、181-1、181-2');assert.equal(s.badges['9_1'],undefined);
});
test('custom map labels remain uncovered and cannot be mistaken for numeric detector maps',async t=>{
    const p=await setup(t,{'70水_1':card('70水',1),'70男_1':card('70男',1),'175_1':card(175,1)});
    await publish(p,{a:det(70,1),b:det(175,1)});const s=await state(p);
    assert.equal(s.badges['70水_1'].hidden,true);assert.equal(s.badges['70男_1'].hidden,true);
    assert.match(s.summary,/70水-1/);assert.match(s.summary,/70男-1/);assert.doesNotMatch(s.summary,/175-1/);
});
test('timer updates preserve real inline editor, selection, card nodes and typed value',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});
    await p.evaluate(()=>{enterInlineEdit('175_1');qa.editor=document.activeElement;qa.card=qa.editor.closest('.card');
        qa.editor.value='175 1 R1.3';qa.editor.setSelectionRange(8,10);qa.now+=120001;
        qa.intervals.find(x=>x.fn.name==='render').fn();});
    const s=await p.evaluate(()=>({same:document.activeElement===qa.editor,card:qa.editor.closest('.card')===qa.card,
        value:qa.editor.value,selection:[qa.editor.selectionStart,qa.editor.selectionEnd]}));
    assert.deepEqual(s,{same:true,card:true,value:'175 1 R1.3',selection:[8,10]});
});
test('special collector IDs remain literal tooltip text and cannot inject badge HTML',async t=>{
    const p=await setup(t);const id='<img src=x onerror="window.badInjection=true">';
    await p.evaluate(({id,d})=>{coverageQA.setLatest({[id]:d});refreshDetectorCoverage();},{id,d:det(175,1)});
    const s=await state(p);assert.ok(s.badges['175_1'].title.includes(id));
    assert.equal(await p.locator('.det-coverage img').count(),0);assert.equal(await p.evaluate(()=>!!window.badInjection),false);
});
test('coverage refresh itself makes no writes, including when auto-write checkbox is enabled',async t=>{
    const p=await setup(t);await publish(p,{a:det(175,1)});
    await p.evaluate(()=>{document.getElementById('nativeDetAutoWrite').checked=true;
        for(let i=0;i<10;i++){refreshDetectorCoverage();coverageQA.render();}renderList();});
    const s=await state(p);assert.deepEqual(s.writes,[]);assert.equal(s.subscriptions.length,2);
});

test('original qa_autowrite nine cases replay offline using actual autoWrite and getBossStatus',async t=>{
    const p=await setup(t,{
        '115_1':card(115,1,{lastInput:'R1.3',displayValue:'階段1.3',startTime:NOW-60000}),
        '117_1':card(117,1,{lastInput:'R1.3',displayValue:'階段1.3',startTime:NOW-10800000})});
    await p.evaluate(()=>{document.getElementById('nativeDetAutoWrite').checked=true;
        document.getElementById('nativeDetWriteOthers').checked=true;});
    await publish(p,{noch:det(157,null,{stage:'R2'}),multi:det(184,null,{stage:'R3'}),
        ch2:det(181,2,{stage:'R4'}),notfresh:det(163,1,{map_fresh:false,stage:'R1'}),
        subfresh:det(115,1,{stage:'R1'}),subidle:det(117,1,{stage:'R1'}),
        ch4:det(155,4,{stage:'R3'}),ch3multi:det(184,3,{stage:'R2'}),ch2other:det(173,2,{stage:'R1'})});
    const writes=(await state(p)).writes;
    assert.deepEqual(writes.map(({map,ch,val})=>[`${map}_${ch}`,val]),
        [['157_1','R2'],['181_2','R4'],['117_1','R1'],['155_1','R3'],['184_3','R2'],['173_2','R1']]);
});

test('desktop/mobile light and dark badges follow the channel and stay clear of MAX, count and delete',async t=>{
    const p=await setup(t,{'175_1':card(175,1,{memberCount:12}),'181_1':card(181,1,{isMax:true}),
        '184_1':card(184,1),'184_2':card(184,2)});
    await publish(p,{a:det(175,1),b:det(181,1),c:det(184,2,{map_fresh:false})});
    for(const width of [1100,390,320])for(const light of [false,true]){
        await p.setViewportSize({width,height:820});
        await p.evaluate(light=>document.body.classList.toggle('light',light),light);
        const overlaps=await p.evaluate(()=>{
            const hits=[];for(const e of document.querySelectorAll('.det-coverage:not([hidden])')){
                const r=e.getBoundingClientRect();
                const location=e.previousElementSibling;
                const label=location?.getBoundingClientRect();
                if(!location?.matches('.card-location') || label.right>r.left
                    || Math.min(label.bottom,r.bottom)<=Math.max(label.top,r.top))hits.push(`${e.dataset.cardId}:not after channel`);
                for(const other of e.closest('.card').querySelectorAll('.card-location,.max-badge,.member-top-display,.del')){
                    const s=other.getBoundingClientRect();
                    if(Math.min(r.right,s.right)>Math.max(r.left,s.left)&&Math.min(r.bottom,s.bottom)>Math.max(r.top,s.top))
                        hits.push(`${e.dataset.cardId}:${other.className||other.tagName}`);
                }
            }return hits;
        });
        assert.deepEqual(overlaps,[],`width=${width} light=${light}`);
        if(process.env.COVERAGE_QA_ARTIFACTS){fs.mkdirSync(process.env.COVERAGE_QA_ARTIFACTS,{recursive:true});
            await p.screenshot({path:path.join(process.env.COVERAGE_QA_ARTIFACTS,`coverage-${width}-${light?'light':'dark'}.png`),fullPage:true});
            await p.locator('#detectorDrawerClose').click();
            await p.screenshot({path:path.join(process.env.COVERAGE_QA_ARTIFACTS,`cards-${width}-${light?'light':'dark'}.png`),fullPage:true});
            await p.locator('#detectorDrawerToggle').click();}
    }
});
