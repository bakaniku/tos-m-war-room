// Offline execution of the actual detector drawer, with an in-memory RTDB transaction.
// No Firebase SDK, browser, sockets, or production writes are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const O = require('./observation-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script id="detectorDrawerScript">([\s\S]*?)<\/script>/)[1];
const NOW = 1800000000000;
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
function setup({card = {}, detector = {}, storage = {}, loaded = true, deferred = false} = {}) {
    const elements = {}, events = {}, queued = [], writes = [], logs = [], callbacks = {};
    const state = { now: NOW, fail: false };
    const saved = {nativeDetAutoWrite: '1', nativeDetMine: '["mine"]', ...storage};
    const cards = {'153_2': {map:'153', ch:'2', lastInput:'ON', displayValue:'ON', startTime:NOW-30000,
        memberCount:9, isMax:true, callPriority:1, custom:'keep', ...card}};
    cards['153_2'].autoGuard ||= {signature:O.signature(cards['153_2']),notBefore:0};
    const node = id => elements[id] ||= {checked:false, value:'', style:{}, innerHTML:'',
        classList:{toggle(){}, contains(){return false;}}, setAttribute(){},
        addEventListener(name, fn){ (this.events ||= {})[name] = fn; }};
    const server = clone(cards);
    const ctx = vm.createContext({console, Set, Map, Number, String, Object, JSON, Date:class extends Date {static now(){return state.now;}},
        Event:class {constructor(type){this.type=type;}},
        localStorage:{getItem:k=>saved[k]??null, setItem:(k,v)=>{saved[k]=String(v);}},
        document:{getElementById:node, querySelectorAll:()=>[]},
        window:{TOSMObservation:O,currentData:cards, __tosmBossDataRoom:loaded?'ROOM':null,
            addEventListener:(name,fn)=>{const previous=events[name];events[name]=()=>{previous?.();fn();};},
            dispatchEvent:e=>events[e.type]?.()},
        currentRoom:'ROOM', myName:'Tester', isBanned:false,
        setInterval(){}, setTimeout(){},
        getBossStatus:()=>({isGrey:false}),
        saveBoss:(map,ch,val,focus,options)=>{writes.push({map,ch,val});options?.onCommitted?.();options?.onFinished?.(true);},
        db:{ref(p){return {
            on:(ev,fn)=>{callbacks[p]=fn;}, off(){}, set(){return Promise.resolve();}, remove(){},
            push(v){logs.push({p,v}); return Promise.resolve();},
            transaction(update,complete,applyLocally){
                assert.equal(applyLocally,false);
                const run = () => {
                    if(state.fail){complete(new Error('offline failure'),false,null);return;}
                    const key=p.split('/').at(-1), result=update(clone(server[key]));
                    if(result===undefined){complete(null,false,{val:()=>clone(server[key])});return;}
                    server[key]=clone(result); cards[key]=clone(result);
                    complete(null,true,{val:()=>clone(result)});
                };
                queued.push(run); if(!deferred)run();
                return Promise.resolve();
            }
        };}}
    });
    const exposed = script.replace(/\}\)\(\);\s*$/, `window.test = {run: autoWrite,
        set: value => {latest = value;}, subscribeRoom, mergeBuckets};})();`);
    vm.runInContext(exposed, ctx);
    const d = {room:'ROOM', stage:'WAITING', map_level:153, ch:2, map_fresh:true,
        cooldown_confirmed:true, updated_at:NOW-1000, respawn:'1:14',
        respawn_seen_at:new Date(NOW-1000).toISOString(), ...detector};
    const set = value => ctx.window.test.set(value);
    set({mine:d});
    return {ctx,d,cards,server,state,saved,elements,writes,logs,queued,events,callbacks,set,
        run:()=>ctx.window.test.run(), change:(id,checked)=>{node(id).checked=checked;node(id).events.change();}};
}

test('confirmed ON becomes DE1 once, preserves unrelated fields, resets kill metadata',()=>{
    const h=setup();h.run();h.run();
    assert.equal(h.server['153_2'].lastInput,'DE1');
    assert.equal(h.server['153_2'].custom,'keep');
    assert.equal(h.server['153_2'].memberCount,0);
    assert.equal(h.server['153_2'].isMax,false);
    assert.equal(h.server['153_2'].callPriority,0);
    assert.equal(h.server['153_2'].targetTime,0);
    assert.equal(h.server['153_2'].isFlash,false);
    assert.equal(h.logs.length,1);assert.deepEqual(h.writes,[]);
});
test('cooldown setting defaults enabled and persists disabled choice',()=>{
    const h=setup();assert.equal(h.elements.nativeDetCooldownKilled.checked,true);
    h.change('nativeDetCooldownKilled',false);h.run();
    assert.equal(h.saved.nativeDetCooldownKilled,'0');assert.equal(h.server['153_2'].lastInput,'ON');
    assert.equal(setup({storage:h.saved}).elements.nativeDetCooldownKilled.checked,false);
});
for(const [name,patch] of Object.entries({missingFlag:{cooldown_confirmed:undefined}, falseFlag:{cooldown_confirmed:false},
    stringFlag:{cooldown_confirmed:'true'}, unknownMap:{map_fresh:false}, legacyMap:{map_fresh:undefined},
    noCH:{ch:null}, badCH:{ch:5}, stringCH:{ch:'2'}, noMap:{map_level:null},
    wrongRoom:{room:'OTHER'}, unassigned:{room:''}, stale:{updated_at:NOW-120001},
    future:{updated_at:NOW+1}, missingTimestamp:{updated_at:undefined}, onConflict:{stage:'ON'}, rConflict:{stage:'R3'}})) {
    test(`does not kill: ${name}`,()=>{const h=setup({detector:patch});h.run();assert.equal(h.logs.length,0);});
}
test('unclaimed collector and disabled auto-write cannot kill',()=>{
    for(const storage of [{nativeDetMine:'[]'},{nativeDetAutoWrite:'0'}]){
        const h=setup({storage});h.run();assert.equal(h.logs.length,0);
    }
});
test('write-others permits only explicitly same-room collector',()=>{
    const h=setup({storage:{nativeDetMine:'[]',nativeDetWriteOthers:'1'}});h.run();assert.equal(h.logs.length,1);
});
test('banned user cannot kill',()=>{const h=setup();h.ctx.isBanned=true;h.run();assert.equal(h.logs.length,0);});
test('non-ON and absent cards are never converted or created',()=>{
    for(const value of ['R1','R4','DE1','1:14']){
        const h=setup({card:{lastInput:value}});h.run();assert.equal(h.logs.length,0);
    }
    const h=setup();delete h.cards['153_2'];delete h.server['153_2'];h.run();assert.equal(h.logs.length,0);
});
test('waits for first room card snapshot and retries on its event',()=>{
    const h=setup({loaded:false});h.run();assert.equal(h.logs.length,0);
    assert.deepEqual(h.writes,[]);
    h.ctx.window.__tosmBossDataRoom='ROOM';h.events['tosm-boss-data']();assert.equal(h.logs.length,1);
});
test('mismatched server identity never writes',()=>{
    const h=setup();h.server['153_2'].ch='1';h.run();assert.equal(h.logs.length,0);
});
test('server race to newer ON or other state aborts',()=>{
    for(const patch of [{startTime:NOW+1},{lastInput:'R2'},{lastInput:'DE1'}]){
        const h=setup({deferred:true});h.run();Object.assign(h.server['153_2'],patch);
        h.queued[0]();assert.equal(h.logs.length,0);assert.deepEqual(h.writes,[]);
    }
});
test('room change, setting disable, confirmation withdrawal abort an in-flight transaction',()=>{
    for(const mutate of [h=>{h.ctx.currentRoom='OTHER';},h=>{h.elements.nativeDetCooldownKilled.checked=false;},
        h=>h.set({mine:{...h.d,cooldown_confirmed:false,updated_at:NOW}})]){
        const h=setup({deferred:true});h.run();mutate(h);h.queued[0]();assert.equal(h.logs.length,0);
    }
});
test('in-flight conversion suppresses countdown and duplicate transaction',()=>{
    const h=setup({deferred:true});h.run();h.run();
    assert.equal(h.queued.length,1);assert.deepEqual(h.writes,[]);
});
test('failed transaction remains retryable and does not log success',()=>{
    const h=setup();h.state.fail=true;h.run();assert.equal(h.logs.length,0);
    h.state.fail=false;h.run();assert.equal(h.logs.length,1);
});
test('newer or simultaneous active detector vetoes cooldown; older one cannot overwrite kill',()=>{
    for(const offset of [0,1]){
        const h=setup({storage:{nativeDetWriteOthers:'1'}});
        h.set({mine:h.d,other:{...h.d,stage:'ON',cooldown_confirmed:false,updated_at:h.d.updated_at+offset}});
        h.run();assert.equal(h.logs.length,0);
    }
    const h=setup({storage:{nativeDetWriteOthers:'1'}});
    h.set({mine:h.d,other:{...h.d,stage:'ON',cooldown_confirmed:false,updated_at:h.d.updated_at-1}});
    h.run();assert.equal(h.logs.length,1);assert.deepEqual(h.writes,[]);
});
test('same cooldown heartbeats cannot erase a later manual ON, including after reload',()=>{
    const h=setup();h.run();
    const manual={...h.server['153_2'],lastInput:'ON',startTime:NOW+1000};
    h.cards['153_2']=clone(manual);h.server['153_2']=clone(manual);h.state.now+=5000;
    h.set({mine:{...h.d,updated_at:NOW+4000}});h.run();assert.equal(h.logs.length,1);
    const reloaded=setup({card:manual,storage:h.saved,detector:{updated_at:NOW+4000}});
    reloaded.state.now+=5000;reloaded.run();assert.equal(reloaded.logs.length,0);
});
test('confirmed active evidence ends episode so next cooldown can kill next ON',()=>{
    const h=setup();h.run();h.state.now+=5000;
    h.set({mine:{...h.d,stage:'ON',cooldown_confirmed:false,updated_at:NOW+1000,respawn:null}});h.run();
    const card={...h.cards['153_2'],lastInput:'ON',startTime:NOW+1000};
    card.autoGuard={signature:O.signature(card),notBefore:0}; // Explicitly automated next episode.
    h.cards['153_2']=clone(card);h.server['153_2']=clone(card);
    h.set({mine:{...h.d,updated_at:NOW+4000}});h.run();assert.equal(h.logs.length,2);
});
test('detected KILLED survives later unconfirmed countdown and page reload',()=>{
    const h=setup();h.run();h.set({mine:{...h.d,cooldown_confirmed:false,updated_at:NOW}});h.run();
    assert.deepEqual(h.writes,[]);
    const reload=setup({card:h.cards['153_2'],storage:h.saved,detector:{cooldown_confirmed:false}});
    reload.run();assert.deepEqual(reload.writes,[]);
});
test('manual timer edit is preserved from the same cooldown episode',()=>{
    const h=setup();h.run();h.cards['153_2']={...h.cards['153_2'],lastInput:'2:00',startTime:NOW+1};
    h.set({mine:{...h.d,cooldown_confirmed:false,updated_at:NOW}});h.run();assert.equal(h.writes.length,0);
});
test('normal stage and countdown behavior remains when feature is disabled',()=>{
    const h=setup({storage:{nativeDetCooldownKilled:'0'},detector:{stage:'R2',cooldown_confirmed:false,respawn:null}});
    h.run();assert.equal(h.writes[0].val,'R2');
    const timer=setup({storage:{nativeDetCooldownKilled:'0'}});timer.run();assert.equal(timer.writes[0].val,'1:14');
});
test('late old-room subscription snapshot is ignored',()=>{
    const h=setup();const callback=h.callbacks['shared/nativeDetector/ROOM'];
    h.ctx.currentRoom='OTHER';callback({val:()=>({mine:h.d})});h.run();assert.equal(h.logs.length,0);
});
test('unconfirmed heartbeat with old timer cannot overwrite later manual ON, including reload',()=>{
    const h=setup();h.run();
    const manual={...h.cards['153_2'],lastInput:'ON',startTime:NOW+1000};
    h.cards['153_2']=clone(manual);h.server['153_2']=clone(manual);h.state.now+=5000;
    h.set({mine:{...h.d,cooldown_confirmed:false,updated_at:NOW+4000}});h.run();
    assert.deepEqual(h.writes,[]);assert.equal(h.logs.length,1);
    const reload=setup({card:manual,storage:h.saved,detector:{cooldown_confirmed:false,updated_at:NOW+4000}});
    reload.state.now+=5000;reload.run();assert.deepEqual(reload.writes,[]);assert.equal(reload.logs.length,0);
});
test('cached room bucket cannot be relabelled by unassigned callback during room switch',()=>{
    const h=setup({storage:{nativeDetAutoWrite:'0'}});
    h.callbacks['shared/nativeDetector/ROOM']({val:()=>({mine:h.d})});
    h.ctx.currentRoom='OTHER';h.ctx.window.__tosmBossDataRoom='OTHER';
    h.elements.nativeDetAutoWrite.checked=true;
    h.callbacks['shared/nativeDetector/_unassigned']({val:()=>({})});
    assert.equal(h.logs.length,0);assert.deepEqual(h.writes,[]);
});
test('new room card snapshot cannot apply old-room stage or timer from cached latest',()=>{
    for(const stage of ['ON','WAITING']){
        const h=setup({detector:{stage,cooldown_confirmed:false}});
        h.ctx.currentRoom='OTHER';h.ctx.window.__tosmBossDataRoom='OTHER';
        h.events['tosm-boss-data']();assert.equal(h.logs.length,0);assert.deepEqual(h.writes,[]);
    }
});
