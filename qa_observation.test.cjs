// Offline, real browser functions + room-local in-memory RTDB. No external traffic.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const {chromium}=require('playwright');
const O=require('./observation-core.js');
const catalogContext={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'map-catalog.js'),'utf8'),catalogContext);
const catalog=JSON.parse(JSON.stringify(catalogContext.window.TOSMMapCatalog));
const NOW=1800000000000;
const map175=catalog.find(m=>m.level===175),map181=catalog.find(m=>m.level===181);
const card=(extra={})=>({map:'175',ch:'1',lastInput:'R2',displayValue:'階段2',startTime:NOW-30000,targetTime:0,...extra});
const autoCard=(extra={})=>{const c=card(extra);c.autoGuard={signature:O.signature(c),notBefore:0};return c;};
const detector=(level=175,stage='R3',at=NOW,extra={})=>{
    const name=catalog.find(m=>m.level===level).name_zh_tw;
    return {room:'ROOM',map_level:level,map_name:name,ch:1,map_fresh:true,stage,updated_at:at,
        observation:{schema:1,map_level:level,map_name:name,ch:1,stage,observed_at:at,evidence:'same_frame_map_channel_stage'},...extra};
};
test('legacy/manual cards protected; explicit resume and old-client changes have distinct meaning',()=>{
    assert.equal(O.manualProtected(card()),true);
    assert.equal(O.manualProtected(autoCard()),false);
    assert.equal(O.manualProtected(autoCard({manualOverride:{active:true}})),true);
    const c=autoCard();c.lastInput='R4';assert.equal(O.manualProtected(c),true);
    const released=autoCard();released.autoGuard.notBefore=NOW;
    for(const at of [undefined,null,NOW-1,NOW])assert.equal(O.autoAllowed(released,at),false);
    assert.equal(O.autoAllowed(released,NOW+1),true);
});
test('catalog keeps level70 identities separate and refuses disabled/unknown maps',()=>{
    assert.equal(catalog.length,109);assert.equal(catalog.filter(m=>m.enabled_in_detector_dictionary).length,106);
    assert.equal(O.resolveMap(catalog,70),null);
    assert.notEqual(O.resolveMap(catalog,'70男',null,true).catalog_id,O.resolveMap(catalog,'70水',null,true).catalog_id);
    assert.equal(O.resolveMap(catalog,194,'歐勒夏內城'),null);
    assert.equal(O.resolveMap(catalog,175,'假地圖'),null);
});
test('observation contract rejects unsupported, foreign, future, stale and ambiguous evidence',()=>{
    assert.ok(O.normalizeObservation(detector(),'ROOM',catalog,NOW));
    const patches=[{room:'OTHER'},{map_fresh:false},{updated_at:NOW+1},{updated_at:NOW-120001},
        {map_name:'另一張圖'},{ch:null},{observation:null}];
    for(const patch of patches)assert.equal(O.normalizeObservation(detector(175,'R3',NOW,patch),'ROOM',catalog,NOW),null);
    for(const patch of [{schema:0},{ch:5},{ch:'1'},{stage:'UNKNOWN'},{observed_at:NOW+1},{observed_at:NOW-300001},
        {observed_at:NaN},{observed_at:'1800000000000'},{evidence:'sticky'}]){
        const d=detector();Object.assign(d.observation,patch);
        assert.equal(O.normalizeObservation(d,'ROOM',catalog,NOW),null,JSON.stringify(patch));
    }
});
test('source conflicts remain visible and observation age does not follow heartbeat age',()=>{
    const a=O.normalizeObservation(detector(),'ROOM',catalog,NOW),b={...a,stage:'R2',observed_at:NOW-1000};
    assert.equal(O.summarize({a,b},'ROOM',map175,1,NOW,300000).status,'conflict');
    assert.equal(O.summarize({a,b},'ROOM',map175,1,NOW+300001,300000).status,'stale');
    assert.equal(O.summarize({a},'OTHER',map175,1,NOW,300000).status,'never');
    assert.equal(O.summarize({a:{...a,observed_at:NOW+1}},'ROOM',map175,1,NOW,300000).status,'never');
});

const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const functions=section('function getBossStatus(','function enterInlineEdit(')
    +section('function renderList(','function toggleKilledSection(')
    +section('function saveBoss(','/* ════════ 紀錄');
const drawer=html.match(/<script id="detectorDrawerScript">([\s\S]*?)<\/script>/)[1];
const fixture=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function setup(t,initial=card(),observations={}) {
    const context=await browser.newContext({viewport:{width:1100,height:850}});t.after(()=>context.close());
    const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.route('**/*',r=>r.request().url()==='http://observation.test/'?r.fulfill({contentType:'text/html',body:fixture}):r.abort());
    await p.routeWebSocket('**/*',ws=>ws.close());await p.goto('http://observation.test/');
    await p.evaluate(({initial,now,observations})=>{
        const clone=x=>x==null?x:JSON.parse(JSON.stringify(x));
        window.qa={now,callbacks:{},intervals:[],queue:[],writes:[],defer:false,fail:false,
            tree:{rooms:{ROOM:{bosses:{'175_1':initial},observations}},shared:{nativeDetector:{ROOM:{},_unassigned:{}}}}};
        Date.now=()=>qa.now;window.setInterval=fn=>qa.intervals.push(fn);window.clearInterval=()=>{};window.setTimeout=()=>{};
        localStorage.setItem('nativeDetMine','["mine"]');localStorage.setItem('nativeDetAutoWrite','1');
        localStorage.setItem('nativeDetMultiCh','184,186,189');
        const get=p=>p.split('/').reduce((v,k)=>v?.[k],qa.tree)??null;
        const snapshot=v=>({val:()=>clone(v),numChildren:()=>Object.keys(v||{}).length,forEach:()=>{}});
        const put=(p,v)=>{const parts=p.split('/');let obj=qa.tree;for(const k of parts.slice(0,-1))obj=obj[k]||=( {} );obj[parts.at(-1)]=clone(v);
            for(const [watched,callbacks] of Object.entries(qa.callbacks))if(p===watched||p.startsWith(watched+'/'))
                for(const cb of callbacks)queueMicrotask(()=>cb(snapshot(get(watched))));
            const match=p.match(/^rooms\/([^/]+)\/bosses\/([^/]+)$/);
            if(match&&match[1]===currentRoom){window.currentData=clone(get(`rooms/${currentRoom}/bosses`));dispatchEvent(new Event('tosm-boss-data'));renderList();}
        };
        qa.get=p=>clone(get(p));qa.put=put;
        Object.assign(window,{currentRoom:'ROOM',myName:'QA',currentData:clone(qa.tree.rooms.ROOM.bosses),__tosmBossDataRoom:'ROOM',
            timers:{},currentSort:'map',localPinned:{},isBanned:false,globalNextLocked:false,protectedRooms:{},
            killedSectionCollapsed:false,lvPass:()=>true,hasAuth:()=>true,hasBanAuth:()=>false,
            canIUseCall:()=>false,isProtectedRoom:()=>false,getStatusColor:()=>'#e0a030',getCallSlots:()=>({}),
            t:k=>k,startTimer:(id,b)=>{const e=document.getElementById('t_'+id);if(e)e.textContent=b.displayValue;},
            db:{ref(p){return {
                on:(event,fn)=>{(qa.callbacks[p]||=[]).push(fn);queueMicrotask(()=>fn(snapshot(get(p))));},off:()=>{qa.callbacks[p]=[];},
                set:v=>{qa.writes.push({kind:'set',p,v});put(p,v);return Promise.resolve();},
                remove:()=>Promise.resolve(),push:v=>{qa.writes.push({kind:'log',p,v});return Promise.resolve();},
                once:(event,fn)=>{fn?.(snapshot(get(p)));return Promise.resolve(snapshot(get(p)));},
                update:v=>{qa.writes.push({kind:'manual',p,v});put(p,{...get(p),...v});return Promise.resolve();},
                transaction:(update,done,local)=>new Promise(resolve=>{
                    if(local!==false)throw Error('Transactions must wait for server confirmation');
                    const run=()=>{
                        if(qa.fail){done?.(Error('offline'),false,null);resolve({committed:false});return;}
                        const result=update(clone(get(p)));
                        if(result===undefined){done?.(null,false,snapshot(get(p)));resolve({committed:false});return;}
                        if(result.stored_at)result.stored_at=qa.now;
                        qa.writes.push({kind:'transaction',p,v:clone(result)});put(p,result);
                        done?.(null,true,snapshot(result));resolve({committed:true});
                    };qa.defer?qa.queue.push(run):queueMicrotask(run);
                })
            };}}});
        qa.tick=()=>qa.intervals.forEach(fn=>fn());
        document.getElementById('loginView').style.display='none';document.getElementById('mainView').style.display='block';
    },{initial,now:NOW,observations});
    for(const file of ['observation-core.js','map-catalog.js'])await p.addScriptTag({content:fs.readFileSync(path.join(__dirname,file),'utf8')});
    await p.addScriptTag({content:functions});await p.addScriptTag({content:drawer});
    await p.addScriptTag({content:fs.readFileSync(path.join(__dirname,'observation-ui.js'),'utf8')});
    await p.evaluate(()=>renderList());await p.locator('#observationBookButton').click();
    t.after(()=>assert.deepEqual(errors,[]));return p;
}
async function publish(p,data){await p.evaluate(d=>qa.put('shared/nativeDetector/'+currentRoom,d),data);}
const boss=p=>p.evaluate(()=>qa.get(`rooms/${currentRoom}/bosses/175_1`));

test('manual timer/stage/ON stay protected while observations are stored independently',async t=>{
    const p=await setup(t);
    for(const value of ['1:20','R1.5','ON','DE1']){
        await p.evaluate(value=>saveBoss('175','1',value),value);await publish(p,{mine:detector()});
        const c=await boss(p);assert.equal(c.lastInput,value);assert.equal(c.manualOverride.active,true);
    }
    assert.ok(await p.evaluate(key=>qa.get('rooms/ROOM/observations/'+key),`${map175.catalog_id}_1`));
    assert.equal(await p.evaluate(()=>qa.writes.filter(w=>w.kind==='transaction'&&w.p.includes('/bosses/')).length),0);
});
test('legacy records are protected and a resumed card waits for a NEW confirmed observation',async t=>{
    const p=await setup(t);await publish(p,{mine:detector()});assert.equal((await boss(p)).lastInput,'R2');
    await p.locator('#obsClose').click();await p.locator('.manual-guard').click();
    await publish(p,{mine:detector()});assert.equal((await boss(p)).lastInput,'R2');
    await p.evaluate(()=>{qa.now+=2000;});await publish(p,{mine:detector(175,'R3',NOW+2000)});
    assert.equal((await boss(p)).lastInput,'R3');assert.equal(O.manualProtected(await boss(p)),false);
});
test('in-flight stage/countdown cannot overwrite a simultaneous human edit',async t=>{
    for(const kind of ['stage','timer']){
        const p=await setup(t,autoCard());await p.evaluate(()=>{qa.defer=true;});
        const d=detector();if(kind==='timer')Object.assign(d,{stage:'UNKNOWN',observation:null,respawn:'1:20',respawn_seen_at:new Date(NOW).toISOString()});
        await publish(p,{mine:d});assert.ok(await p.evaluate(()=>qa.queue.length)>0);
        await p.evaluate(()=>saveBoss('175','1','R4'));
        await p.evaluate(()=>{qa.defer=false;const tasks=qa.queue.splice(0);tasks.forEach(fn=>fn());});
        assert.equal((await boss(p)).lastInput,'R4');assert.equal((await boss(p)).manualOverride.active,true);
        assert.equal(await p.evaluate(()=>qa.writes.filter(w=>w.kind==='log'&&w.v.source==='detector').length),0);
    }
});
test('manual ON is protected from confirmed cooldown',async t=>{
    const p=await setup(t);await p.evaluate(()=>saveBoss('175','1','ON'));
    await publish(p,{mine:detector(175,'WAITING',NOW,{cooldown_confirmed:true,respawn:'1:20',respawn_seen_at:new Date(NOW).toISOString()})});
    assert.equal((await boss(p)).lastInput,'ON');
});
test('old-client edits carrying stale automatic metadata are protected',async t=>{
    const p=await setup(t,autoCard());await p.evaluate(()=>{
        const c=qa.get('rooms/ROOM/bosses/175_1');c.lastInput='R4';c.startTime=qa.now;qa.put('rooms/ROOM/bosses/175_1',c);
    });await publish(p,{mine:detector()});assert.equal((await boss(p)).lastInput,'R4');
});
test('failed auto transaction stays retryable and does not log success',async t=>{
    const p=await setup(t,autoCard());await p.evaluate(()=>{qa.fail=true;});await publish(p,{mine:detector()});
    assert.equal((await boss(p)).lastInput,'R2');
    await p.evaluate(()=>{qa.fail=false;});await publish(p,{mine:detector()});assert.equal((await boss(p)).lastInput,'R3');
});
test('moving detector retains history; heartbeat cannot renew age; expiry occurs without a new snapshot',async t=>{
    const p=await setup(t);await publish(p,{mine:detector()});
    const row=p.locator(`[data-map-id="${map175.catalog_id}"][data-ch="1"]`);
    assert.match(await row.textContent(),/有人監看/);
    await p.evaluate(()=>{qa.now+=1000;});await publish(p,{mine:detector(181,'R1',NOW+1000)});
    assert.match(await row.textContent(),/目前無人監看/);assert.match(await row.textContent(),/R3/);
    await p.evaluate(()=>{qa.now+=301000;qa.tick();});assert.match(await row.textContent(),/已過期/);
});
test('duplicate/older observations do not overwrite stored data or cause repeated writes',async t=>{
    const p=await setup(t);await publish(p,{mine:detector()});
    await publish(p,{mine:detector(175,'R2',NOW-1000)});await publish(p,{mine:detector()});await p.evaluate(()=>qa.tick());
    const rows=await p.evaluate(()=>qa.writes.filter(w=>w.p.includes('/observations/')&&w.kind==='transaction'));
    assert.equal(rows.length,1);assert.equal(rows[0].v.stage,'R3');
});
test('a fresh browser restores shared observations and persistent human protection',async t=>{
    const first=await setup(t);await first.evaluate(()=>saveBoss('175','1','R4'));await publish(first,{mine:detector()});
    const saved=await first.evaluate(()=>qa.get('rooms/ROOM'));
    const second=await setup(t,saved.bosses['175_1'],saved.observations);await publish(second,{mine:detector()});
    assert.equal((await boss(second)).lastInput,'R4');assert.equal((await boss(second)).manualOverride.active,true);
    assert.match(await second.locator(`[data-map-id="${map175.catalog_id}"][data-ch="1"]`).textContent(),/R3/);
});
test('stored source names are literal text and cannot introduce markup',async t=>{
    const record={...O.normalizeObservation(detector(),'ROOM',catalog,NOW),collector_id:'<img src=x onerror=alert(1)>'};
    const p=await setup(t,card(),{[`${map175.catalog_id}_1`]:{source:record}});
    assert.match(await p.locator('#obsRows').textContent(),/<img src=x onerror=alert\(1\)>/);
    assert.equal(await p.locator('#obsRows img').count(),0);
});
test('current sources disagree visibly, without overwriting the human card',async t=>{
    const p=await setup(t);await p.evaluate(()=>{document.getElementById('nativeDetWriteOthers').checked=true;});
    await publish(p,{mine:detector(),other:detector(175,'R4')});
    const row=p.locator(`[data-map-id="${map175.catalog_id}"][data-ch="1"]`);
    assert.match(await row.textContent(),/來源有分歧/);assert.equal((await boss(p)).lastInput,'R2');
});
test('room switch aborts queued card/observation writes and rejects late snapshots',async t=>{
    const p=await setup(t,autoCard());await p.evaluate(()=>{qa.defer=true;});await publish(p,{mine:detector()});
    await p.evaluate(()=>{
        qa.old=qa.callbacks['rooms/ROOM/observations'][0];currentRoom='OTHER';__tosmBossDataRoom='OTHER';currentData={};
        dispatchEvent(new Event('tosm-boss-data'));qa.tick();qa.defer=false;qa.queue.splice(0).forEach(fn=>fn());
        qa.old({val:()=>({bogus:{a:{stage:'ON'}}})});
    });
    assert.equal(await p.evaluate(()=>qa.writes.filter(w=>w.kind==='transaction').length),0);
    assert.match(await p.locator('#obsRoom').textContent(),/OTHER/);
});
test('book handles two Lv70 maps, safe source text, search and desktop/mobile layouts',async t=>{
    const p=await setup(t);await publish(p,{mine:detector()});
    assert.equal(await p.locator('.obs-row').count(),106);
    await p.locator('#obsSearch').fill('70');assert.equal(await p.locator('.obs-row').count(),3); // includes Lv.170
    await p.locator('#obsSearch').fill('水路橋');assert.equal(await p.locator('.obs-row').count(),1);
    await p.locator('#obsSearch').fill('');
    for(const width of [1100,390,320])for(const light of [false,true]){
        await p.setViewportSize({width,height:850});await p.evaluate(light=>document.body.classList.toggle('light',light),light);
        assert.equal(await p.locator('#observationBook').evaluate(e=>e.scrollWidth>e.clientWidth+1),false);
        if(process.env.OBSERVATION_QA_ARTIFACTS){fs.mkdirSync(process.env.OBSERVATION_QA_ARTIFACTS,{recursive:true});
            await p.screenshot({path:path.join(process.env.OBSERVATION_QA_ARTIFACTS,`book-${width}-${light?'light':'dark'}.png`)});}
    }
    await p.locator('#obsClose').click();
    for(const width of [1100,390,320]) {
        await p.setViewportSize({width,height:850});
        assert.equal(await p.locator('.card').evaluate(e=>{
            const button=e.querySelector('.manual-guard').getBoundingClientRect(),timer=e.querySelector('.timer-container').getBoundingClientRect();
            return e.scrollWidth>e.clientWidth+1 || button.bottom>timer.top;
        }),false,'manual protection control fits outside the title and timer');
        if(process.env.OBSERVATION_QA_ARTIFACTS)await p.screenshot({path:path.join(process.env.OBSERVATION_QA_ARTIFACTS,`manual-card-${width}.png`)});
    }
});
