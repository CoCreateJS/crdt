const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const field = { array: 'notes', object: 'record', key: 'content', read: 'false', realtime: true };
function setup({ read, ids, frame = 'local', client = frame } = {}) {
    let counter = 0;
    const events = [], packets = [], requests = [], listeners = {};
    const crud = {
        socket: { clientId: client, frameId: frame,
            listen: (name, fn) => listeners[name] = fn,
            send: packet => packets.push(structuredClone(packet)) },
        getValueFromObject: (object, key) => object?.[key],
        send: async request => {
            requests.push(structuredClone(request));
            return read ? read(request) : { object: [] };
        }
    };
    const context = vm.createContext({ crud, uuid: () => 'uuid',
        ulid: () => ids?.shift() || String(++counter).padStart(26, '0'),
        ulidDecode: id => Number(id.slice(0,10)),
        localStorage: { getItem: () => 'user' }, console,
        crypto: require('node:crypto').webcrypto, TextEncoder,
        CustomEvent: class { constructor(name, options) { this.type=name; this.detail=options.detail; } },
        window: { dispatchEvent: event => events.push(event) }
    });
    const source = fs.readFileSync('src/index.js','utf8').replace(/\r\r\n/g,'\n')
        .replace(/^import .*;\n/gm,'').replace(/export default (.*);/, 'globalThis.api = $1; globalThis.internal = { objects, getName, viewVersion, createSnapshot };');
    const sequence = fs.readFileSync('src/sequence.js','utf8').replace(/^export /gm,'');
    const selection = fs.readFileSync('src/selection.js','utf8').replace(/^export /gm,'');
    const runs = fs.readFileSync('src/runs.js','utf8').replace(/^export /gm,'');
    vm.runInContext(sequence + '\n' + selection + '\n' + runs + '\n' + source,context);
    return { api: context.api, internal: context.internal, events, packets, requests, socket: crud.socket,
        remote: (data, socketId) => listeners.crdt({ data: structuredClone(data), socketId }) };
}

test('read=false initializes and preserves empty text after deleting all content', async () => {
    const s=setup(); assert.equal(await s.api.getText(field),'');
    await s.api.updateText({...field,start:0,value:'hello'});
    await s.api.updateText({...field,start:0,length:5,value:''});
    assert.equal(await s.api.getText(field),'');
    assert.equal(s.requests.filter(r=>r.method==='object.read').length,0);
});

test('IDs reach peers, duplicates apply once and remote packets are not rebroadcast', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'A'});
    const packet=s.packets[0].data;
    assert.ok(packet.id);
    const peer=setup();await peer.api.getText(field);
    packet.frameId='other';peer.remote(packet);peer.remote(packet);
    assert.equal(await peer.api.getText(field),'A');
    assert.equal(peer.packets.length,0);
    assert.equal(peer.internal.objects[peer.internal.getName(field)].changeLog.length,1);
});

test('out-of-order delivery converges to ordered replay without duplicate edits', async () => {
    const s=setup();await s.api.getText(field);
    const op=(id,start,value)=>({...field,id:String(id).padStart(26,'0'),frameId:'remote',start,value});
    s.remote(op(1,0,'A'));s.remote(op(3,2,'C'));s.remote(op(2,1,'B'));
    assert.equal(await s.api.getText(field),'ABC');
    assert.equal((await s.internal.viewVersion({...field})).value,'ABC');
});

test('whole replacements notify, broadcast, preserve history and await saving', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'old'});
    await s.api.replaceText({...field,value:'new'});
    assert.equal(await s.api.getText(field),'new');
    assert.equal(s.events.at(-1).detail.string,'new');
    assert.equal(s.packets.length,2);
    assert.equal(s.internal.objects[s.internal.getName(field)].changeLog.length,2);
});

test('undo and redo invert middle replacements and leave a dense operation log', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'abcdef'});
    await s.api.updateText({...field,start:2,length:2,value:'XY'});
    assert.equal(await s.api.getText(field),'abXYef');
    await s.api.undoText(field);assert.equal(await s.api.getText(field),'abcdef');
    await s.api.redoText(field);assert.equal(await s.api.getText(field),'abXYef');
    const log=s.internal.objects[s.internal.getName(field)].changeLog;
    assert.equal(log.length,4);assert.ok(log.every(Boolean));
    assert.equal((await s.internal.viewVersion({...field})).value,'abXYef');
});

test('parallel initial reads share one load and retain remote arrivals during loading', async () => {
    let release;const held=new Promise(resolve=>release=resolve);
    const s=setup({read:request=>request.array==='crdt' ? held : {object:[{content:''}]}});
    const data={...field,read:'true'};
    const a=s.api.getText(data),b=s.api.getText(data);
    s.remote({...data,frameId:'remote',id:'00000000000000000000000001',start:0,value:'R'});
    release({object:[]});
    assert.deepEqual(await Promise.all([a,b]),['R','R']);
    assert.equal(s.requests.filter(r=>r.array==='crdt').length,1);
});

test('loading a database seed does not overwrite the first caller edit', async () => {
    const s=setup({read:r=>({object:r.array==='crdt'?[]:[{content:'base'}]})});
    await s.api.updateText({...field,read:'true',start:4,value:'!'});
    assert.equal(await s.api.getText(field),'base!');
});

test('empty replay does not refetch deleted content and same-millisecond IDs stay ordered', async () => {
    const s=setup({ids:['00000000000000000000000009','00000000000000000000000001']});
    await s.api.updateText({...field,start:0,value:'A'});
    await s.api.updateText({...field,start:1,value:'B'});
    assert.equal(await s.api.getText(field),'AB');
    assert.ok(s.packets[1].data.id>s.packets[0].data.id);
});

test('invalid negative positions reject without writing or broadcasting', async () => {
    const s=setup();await assert.rejects(s.api.updateText({...field,start:-1,length:1}),{name:'RangeError'});
    assert.equal(s.packets.length,0);
});


test('undo follows its range after an earlier remote insertion', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'abc'});
    await s.api.updateText({...field,start:1,value:'X'});
    s.remote({...field,id:'00000000000000000000000003',frameId:'remote',start:0,value:'Y'});
    await s.api.undoText(field);
    assert.equal(await s.api.getText(field),'Yabc');
    await s.api.redoText(field);
    assert.equal(await s.api.getText(field),'YaXbc');
    await s.api.undoText(field);
    assert.equal(await s.api.getText(field),'Yabc');
});

test('undo deletes its own characters and preserves a remote insertion', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'abcd'});
    s.remote({...field,id:'00000000000000000000000002',frameId:'remote',start:2,value:'X'});
    await s.api.undoText(field);
    assert.equal(await s.api.getText(field),'X');
});

test('concurrent deletes of the same character preserve the other characters', async () => {
    const seed=setup();await seed.api.updateText({...field,start:0,value:'abc'});
    const first=setup({frame:'first',ids:['00000000010000000000000001']}),
        second=setup({frame:'second',ids:['00000000010000000000000002']});
    await first.api.getText(field);await second.api.getText(field);
    const baseline={...seed.packets[0].data,frameId:'seed'};
    first.remote(baseline);second.remote(baseline);
    await first.api.updateText({...field,start:0,length:1,value:''});
    await second.api.updateText({...field,start:0,length:1,value:''});
    assert.notEqual(first.packets[0].data.id,second.packets[0].data.id);
    assert.deepEqual(first.packets[0].data.targets,second.packets[0].data.targets);
    first.remote({...second.packets[0].data,frameId:'second'});
    second.remote({...first.packets[0].data,frameId:'first'});
    assert.equal(await first.api.getText(field),'bc');
    assert.equal(await second.api.getText(field),'bc');
});

function permutations(items) {
    if (!items.length) return [[]];
    return items.flatMap((item,index)=>permutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest]));
}
async function baseline(text='abc') {
    const seed=setup({frame:'seed'});await seed.api.updateText({...field,start:0,value:text});
    return seed.packets[0].data;
}
async function writer(frame, base, start, length, value) {
    const s=setup({frame,ids:[`0000000001${frame.padStart(16,'0')}`]});
    await s.api.getText(field);s.remote(base);
    await s.api.updateText({...field,start,length,value});
    return s;
}

test('concurrent insert and delete preserve unobserved inserted text in every delivery order', async () => {
    const base=await baseline();
    const deletion=await writer('A',base,0,1,'');
    const insertion=await writer('B',base,1,0,'X');
    for (const order of permutations([base,deletion.packets[0].data,insertion.packets[0].data])) {
        const peer=setup();await peer.api.getText(field);
        for (const op of order) peer.remote(op);
        assert.equal(await peer.api.getText(field),'Xbc');
    }
});

test('repeated characters have distinct identities and concurrent runs remain contiguous', async () => {
    const base=await baseline('aaa');
    const left=await writer('A',base,0,1,'');
    const right=await writer('B',base,1,1,'');
    const peer=setup();await peer.api.getText(field);peer.remote(base);
    peer.remote(left.packets[0].data);peer.remote(right.packets[0].data);
    assert.equal(await peer.api.getText(field),'a');
    const a=await writer('C',base,1,0,'XY'),b=await writer('D',base,1,0,'12');
    const results=[];
    for (const order of [[a,b],[b,a]]) {
        const p=setup();await p.api.getText(field);p.remote(base);
        for(const w of order)p.remote(w.packets[0].data);
        const text=await p.api.getText(field);
        assert.ok(text.includes('XY'));assert.ok(text.includes('12'));results.push(text);
    }
    assert.equal(results[0],results[1]);
});

test('selective undo of a concurrent deletion does not undo someone else deletion', async () => {
    const base=await baseline();
    const a=await writer('A',base,0,1,''),b=await writer('B',base,0,1,'');
    a.remote(b.packets[0].data);
    await a.api.undoText(field);
    assert.equal(await a.api.getText(field),'bc');
    await a.api.redoText(field);
    assert.equal(await a.api.getText(field),'bc');
});

test('identical database bootstrap has identical character identities across clients', async () => {
    const read=r=>({object:r.array==='crdt'?[]:[{content:'abc'}]});
    const a=setup({frame:'A',read}),b=setup({frame:'B',read});
    const data={...field,read:'true'};
    await Promise.all([a.api.getText(data),b.api.getText(data)]);
    assert.equal(a.packets[0].data.id,b.packets[0].data.id);
    a.remote(b.packets[0].data);b.remote(a.packets[0].data);
    assert.equal(await a.api.getText(field),'abc');
    assert.equal(await b.api.getText(field),'abc');
});

test('identity snapshots retain deleted anchors, accept delayed edits and reload correctly', async () => {
    const base=await baseline();
    const late=await writer('A',base,1,0,'X');
    const s=setup();await s.api.getText(field);s.remote(base);
    await s.api.updateText({...field,start:0,length:1,value:''});
    await s.api.updateText({...field,start:2,length:0,value:'!'});
    const compacted=await s.internal.createSnapshot({...field,save:'false'},2,0);
    assert.ok(compacted[0].sequence);
    s.remote(late.packets[0].data);
    assert.equal(await s.api.getText(field),'Xbc!');
    const log=s.internal.objects[s.internal.getName(field)].changeLog;
    const reloaded=setup({read:r=>({object:r.array==='crdt'?[{changeLog:structuredClone(log)}]:[]})});
    assert.equal(await reloaded.api.getText({...field,read:'true'}),'Xbc!');
    const count=reloaded.internal.objects[reloaded.internal.getName(field)].changeLog.length;
    reloaded.remote(late.packets[0].data);
    assert.equal(reloaded.internal.objects[reloaded.internal.getName(field)].changeLog.length,count);
});

test('concurrent replacements delete only observed characters and preserve both inserted runs', async () => {
    const base=await baseline('abcdef');
    const a=await writer('A',base,1,3,'XX'),b=await writer('B',base,2,3,'YY');
    const outputs=[];
    for(const order of permutations([base,a.packets[0].data,b.packets[0].data])) {
        const p=setup();await p.api.getText(field);
        for(const change of order)p.remote(change);
        const text=await p.api.getText(field);
        assert.ok(text.includes('XX'));assert.ok(text.includes('YY'));
        assert.ok(text.startsWith('a'));assert.ok(text.endsWith('f'));outputs.push(text);
    }
    assert.equal(new Set(outputs).size,1);
});

test('snapshot persistence appends identity state instead of overwriting concurrent log writes', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'abc'});
    await s.api.updateText({...field,start:1,length:1,value:''});
    await s.api.updateText({...field,start:2,value:'!'});
    await s.internal.createSnapshot(field,2,0);
    const request=s.requests.find(r=>r.metadata==='crdt-snapshot');
    assert.ok(request.object['$push.changeLog'].sequence);
    assert.equal(request.object.changeLog,undefined);
});

test('UTF-16 offsets delete one emoji without damaging following characters', async () => {
    const base=await baseline('😀bc');
    const a=await writer('A',base,0,2,''),b=await writer('B',base,0,2,'');
    a.remote(b.packets[0].data);b.remote(a.packets[0].data);
    assert.equal(await a.api.getText(field),'bc');assert.equal(await b.api.getText(field),'bc');
});

test('UI events use a current visible splice even when wire operations target old positions', async () => {
    const base=await baseline();
    const a=await writer('A',base,0,1,''),b=await writer('B',base,1,0,'X');
    const p=setup();await p.api.getText(field);p.remote(base);p.remote(b.packets[0].data);
    const before=await p.api.getText(field);p.remote(a.packets[0].data);
    const {start,length,value,string}=p.events.at(-1).detail;
    assert.equal(before.slice(0,start)+value+before.slice(start+length),string);
    assert.equal(string,'Xbc');
});

test('three writers converge after interleaved edits, duplicate packets and reversed delivery', async () => {
    const base=await baseline('repeated text repeated text');
    const writers=['A','B','C'].map(frame=>setup({frame,
        ids:Array.from({length:100},(_,i)=>String(i+1).padStart(10,'0')+frame.repeat(16))}));
    for(const writer of writers) { await writer.api.getText(field);writer.remote(base); }
    let random=123456;
    const next=max=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random%max;};
    const packets=[base];
    for(let step=0;step<60;step++) {
        const index=next(3),writer=writers[index];
        const text=await writer.api.getText(field),start=next(text.length+1);
        await writer.api.updateText({...field,start,length:Math.min(next(3),text.length-start),value:next(2)?String(step):''});
        const packet=writer.packets.at(-1).data;packets.push(packet);
        const receiver=writers[next(3)];receiver.remote(packet);
    }
    for(let i=0;i<writers.length;i++) {
        const delivery=i%2?packets:packets.slice().reverse();
        for(const packet of delivery) { writers[i].remote(packet);writers[i].remote(packet); }
    }
    const results=await Promise.all(writers.map(writer=>writer.api.getText(field)));
    assert.equal(new Set(results).size,1);
});

test('consecutive typing references the first operation without generating another run ID', async () => {
    const s=setup();
    await s.api.updateText({...field,start:0,value:'A'});
    await s.api.updateText({...field,start:1,value:'B'});
    await s.api.updateText({...field,start:2,value:'C'});
    const [a,b,c]=s.packets.map(packet=>packet.data);
    assert.equal(a.runId,a.id);assert.equal(b.runId,a.id);assert.equal(c.runId,a.id);
    assert.deepEqual([a.runIndex,b.runIndex,c.runIndex],[0,1,2]);
    assert.equal(b.runLeft,a.runLeft);assert.equal(b.runRight,a.runRight);
});

test('explicit run end, reposition, deletion and whole replacement establish boundaries', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'A'});
    const first=s.packets.at(-1).data.runId;
    s.api.endRun(field);await s.api.updateText({...field,start:1,value:'B'});
    assert.notEqual(s.packets.at(-1).data.runId,first);
    const second=s.packets.at(-1).data.runId;
    await s.api.updateText({...field,start:0,value:'C'});
    assert.notEqual(s.packets.at(-1).data.runId,second);
    await s.api.updateText({...field,start:0,length:1,value:''});
    assert.equal(s.packets.at(-1).data.runId,undefined);
    await s.api.replaceText({...field,value:'new'});
    const replacement=s.packets.at(-1).data;
    await s.api.updateText({...field,start:3,value:'!'});
    assert.notEqual(s.packets.at(-1).data.runId,replacement.runId);
});

test('four client typing runs stay grouped and ordered by client ID in reversed delivery', async () => {
    const base=await baseline();const packets=[base];
    for(const frame of ['D','B','A','C']) {
        const w=setup({frame,ids:Array.from({length:8},(_,i)=>String(i+1).padStart(10,'0')+frame.repeat(16))});
        await w.api.getText(field);w.remote(base);
        for(let i=0;i<3;i++)await w.api.updateText({...field,start:1+i,value:frame});
        packets.push(...w.packets.map(packet=>packet.data));
    }
    const orders=[packets,packets.slice().reverse(),packets.slice().sort((a,b)=>a.id.localeCompare(b.id))];
    for(const order of orders) {
        const p=setup();await p.api.getText(field);
        for(const op of order)p.remote(op);
        assert.equal(await p.api.getText(field),'aAAABBBCCCDDDbc');
        assert.equal((await p.internal.viewVersion(field)).value,'aAAABBBCCCDDDbc');
    }
});

test('two frames of the same browser use distinct runs with a stable run-ID tie-breaker', async () => {
    const base=await baseline();const packets=[base];
    for(const [frame,suffix,value] of [['tabB','B','Y'],['tabA','A','X']]) {
        const w=setup({frame,client:'browser',ids:Array.from({length:4},(_,i)=>String(i+1).padStart(10,'0')+suffix.repeat(16))});
        await w.api.getText(field);w.remote(base);
        for(let i=0;i<2;i++)await w.api.updateText({...field,start:1+i,value});
        packets.push(...w.packets.map(packet=>packet.data));
    }
    for(const order of [packets,packets.slice().reverse()]) {
        const p=setup();await p.api.getText(field);for(const op of order)p.remote(op);
        assert.equal(await p.api.getText(field),'aXXYYbc');
    }
});

test('observed insertion inside a run overrides client priority', async () => {
    const base=await baseline();const a=await writer('A',base,1,0,'XX');
    const z=setup({frame:'Z'});await z.api.getText(field);z.remote(base);z.remote(a.packets[0].data);
    await z.api.updateText({...field,start:2,value:'Y'});
    const p=setup();await p.api.getText(field);
    for(const op of [z.packets[0].data,a.packets[0].data,base])p.remote(op);
    assert.equal(await p.api.getText(field),'aXYXbc');
});

test('local edits read the live Socket Client identity instead of generating a browser ID', async () => {
    const s=setup();s.socket.clientId=undefined;
    await assert.rejects(s.api.updateText({...field,start:0,value:'A'}),/must initialize/);
    s.socket.clientId='initialized-browser';
    await s.api.updateText({...field,start:0,value:'A'});
    assert.equal(s.packets[0].data.clientId,'initialized-browser');
});

test('foreign paste into a run starts a fresh local run without an editor endRun call', async () => {
    const a=setup({frame:'A'});await a.api.updateText({...field,start:0,value:'AB'});
    const firstRun=a.packets[0].data.runId;
    const b=setup({frame:'B'});await b.api.getText(field);b.remote(a.packets[0].data);
    await b.api.updateText({...field,start:1,value:'PASTE'});
    a.remote(b.packets[0].data);
    assert.equal(await a.api.getText(field),'APASTEB');
    await a.api.updateText({...field,start:7,value:'C'});
    assert.notEqual(a.packets.at(-1).data.runId,firstRun);
    assert.equal(a.packets.at(-1).data.runIndex,0);
    assert.equal(await a.api.getText(field),'APASTEBC');
});

test('incoming insertion before a run breaks numeric sequential positioning', async () => {
    const a=setup({frame:'A'});await a.api.updateText({...field,start:0,value:'AB'});
    const first=a.packets[0].data.runId;
    const b=setup({frame:'B'});await b.api.getText(field);b.remote(a.packets[0].data);
    await b.api.updateText({...field,start:0,value:'X'});a.remote(b.packets[0].data);
    await a.api.updateText({...field,start:3,value:'C'});
    assert.notEqual(a.packets.at(-1).data.runId,first);
    assert.equal(await a.api.getText(field),'XABC');
});

test('an unrelated foreign edit after the run preserves its next-position contract', async () => {
    const base=await baseline('abc');
    const a=await writer('A',base,1,0,'X');
    const first=a.packets[0].data.runId;
    const b=setup({frame:'B'});await b.api.getText(field);b.remote(base);b.remote(a.packets[0].data);
    await b.api.updateText({...field,start:4,value:'Z'});a.remote(b.packets[0].data);
    await a.api.updateText({...field,start:2,value:'Y'});
    assert.equal(a.packets.at(-1).data.runId,first);
    assert.equal(await a.api.getText(field),'aXYbcZ');
});

test('edits carry the actual backward selection using identities in one packet', async () => {
    const s=setup();
    await s.api.updateText({...field,start:0,value:'abc', selection:{anchor:3,head:1}});
    assert.equal(s.packets.length,1);
    const data=s.packets[0].data;
    assert.equal(data.selection.anchor.left,`${data.id}:2`);
    assert.equal(data.selection.head.right,`${data.id}:1`);
    const event=s.events.filter(e=>e.type==='cocreate-crdt-selection').at(-1).detail;
    assert.deepEqual({...event.resolved},{anchor:3,head:1,start:1,end:3});
    assert.ok(s.requests.find(r=>r.metadata==='crdt-change').object['$push.changeLog'].selection);
});

test('selection-only movements and clearing do not save text or change undo history', async () => {
    const s=setup();await s.api.updateText({...field,start:0,value:'abc'});
    const writes=s.requests.length, object=s.internal.objects[s.internal.getName(field)];
    await s.api.updateSelection({...field,selection:{anchor:1,head:2}});
    await s.api.updateSelection({...field,selection:null});
    assert.equal(s.packets.at(-1).data.type,'selection');
    assert.equal(s.requests.length,writes);
    assert.equal(object.changeLog.length,1);assert.equal(object.undoStack.length,1);
    assert.equal(s.events.at(-1).detail.selection,null);
    assert.equal(await s.api.getText(field),'abc');
});

test('selection endpoints follow concurrent insertions and deleted neighbors', async () => {
    const a=setup({frame:'a'}),b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abcd'});
    await b.api.getText(field);b.remote(a.packets[0].data);
    await a.api.updateSelection({...field,selection:{anchor:3,head:1}});
    b.remote(a.packets.at(-1).data);
    await b.api.updateText({...field,start:0,value:'XX'});
    let event=b.events.filter(e=>e.type==='cocreate-crdt-selection'&&e.detail.frameId==='a').at(-1);
    assert.deepEqual({...event.detail.resolved},{anchor:5,head:3,start:3,end:5});
    await b.api.updateText({...field,start:2,length:3,value:''});
    event=b.events.filter(e=>e.type==='cocreate-crdt-selection'&&e.detail.frameId==='a').at(-1);
    assert.deepEqual({...event.detail.resolved},{anchor:2,head:2,start:2,end:2});
});

test('presence delivered before its characters waits and older presence cannot replace it', async () => {
    const a=setup({frame:'a'}),b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abc',selection:{anchor:1,head:1}});
    await a.api.updateSelection({...field,selection:{anchor:3,head:2}});
    await b.api.getText(field);
    b.remote(a.packets[1].data);
    assert.equal(b.events.filter(e=>e.type==='cocreate-crdt-selection').length,0);
    b.remote(a.packets[0].data);
    assert.deepEqual({...b.events.at(-1).detail.resolved},{anchor:3,head:2,start:2,end:3});
    assert.equal(b.packets.length,0);
});

test('captureSelection runs after the UI text event and is never serialized', async () => {
    const s=setup();
    await s.api.updateText({...field,start:0,value:'abc',captureSelection:()=>{
        assert.equal(s.events.at(-1).type,'cocreate-crdt-update');
        assert.equal(s.events.at(-1).detail.string,'abc');
        return {anchor:2,head:1};
    }});
    assert.equal(s.packets.length,1);
    assert.ok(s.packets[0].data.selection);
    assert.equal('captureSelection' in s.packets[0].data,false);
});

test('invalid explicit selection rejects without committing the text', async () => {
    const s=setup();
    await assert.rejects(s.api.updateText({...field,start:0,value:'a',selection:{anchor:2,head:0}}),/selection/);
    assert.equal(await s.api.getText(field),'');assert.equal(s.packets.length,0);
});

test('selection references survive snapshots and undo of deleted neighbors', async () => {
    const s=setup();
    await s.api.updateText({...field,start:0,value:'abcd'});
    await s.api.updateSelection({...field,selection:{anchor:3,head:1}});
    await s.api.updateText({...field,start:1,length:2,value:''});
    await s.api.updateText({...field,start:2,value:'!'});
    await s.internal.createSnapshot(field,2,0);
    await s.api.updateText({...field,start:0,value:'X'});
    let selection=s.events.filter(e=>e.type==='cocreate-crdt-selection').at(-1).detail;
    assert.deepEqual({...selection.resolved},{anchor:2,head:2,start:2,end:2});
    await s.api.undoText(field);
    selection=s.events.filter(e=>e.type==='cocreate-crdt-selection').at(-1).detail;
    assert.deepEqual({...selection.resolved},{anchor:1,head:1,start:1,end:1});
});

test('loaded selections anchor synchronously and resolve locally after a remote edit', async () => {
    const a=setup({frame:'a'}), b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abc'});
    await b.api.getText(field); b.remote(a.packets[0].data, 'socket-a');
    const sharing=b.api.updateSelection({...field,selection:{anchor:3,head:1}});
    assert.deepEqual({...b.api.getSelection(field)},{anchor:3,head:1,start:1,end:3});
    await a.api.updateText({...field,start:0,value:'X'});
    b.remote(a.packets[1].data, 'socket-a');
    await sharing;
    assert.deepEqual({...b.api.getSelection(field)},{anchor:4,head:2,start:2,end:4});
    await b.api.updateSelection({...field,selection:null});
    assert.equal(b.api.getSelection(field),null);
});

test('presence snapshots preserve identity, resolve late subscriptions and protect stored anchors', async () => {
    const a=setup({frame:'a'}), b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abc',selection:{anchor:1,head:2},presence:{userName:'Alice'}});
    await b.api.getText(field); b.remote(a.packets[0].data,'socket-a');
    const entry=b.api.getSelections(field)[0];
    assert.equal(entry.socketId,'socket-a');
    assert.equal(entry.presence.userName,'Alice');
    assert.deepEqual({...entry.resolved},{anchor:1,head:2,start:1,end:2});
    entry.selection.anchor.left='tampered'; entry.presence.userName='tampered';
    assert.equal(b.api.getSelections(field)[0].presence.userName,'Alice');
    assert.equal(b.api.getSelections(field)[0].resolved.anchor,1);
});

test('duplicate cursor reports do not send packets or split a typing run', async () => {
    const s=setup();
    const presence={userName:'Writer'};
    await s.api.updateText({...field,start:0,value:'a',selection:{anchor:1,head:1},presence});
    const count=s.packets.length;
    await s.api.updateSelection({...field,selection:{anchor:1,head:1},presence});
    assert.equal(s.packets.length,count);
    await s.api.updateSelection({...field,selection:{anchor:1,head:1},presence:{userName:'Renamed'}});
    assert.equal(s.packets.length,count+1);
    await s.api.updateText({...field,start:1,value:'b'});
    assert.equal(s.packets.at(-1).data.runId,s.packets[0].data.runId);
});

test('malformed presence clocks and references cannot overwrite known selections', async () => {
    const a=setup({frame:'a'}), b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abc',selection:{anchor:1,head:1}});
    await b.api.getText(field); b.remote(a.packets[0].data,'socket-a');
    const good=a.packets[0].data;
    for(const selectionClock of [undefined,0,-1,NaN,Infinity,'100'])
        b.remote({...good,type:'selection',selectionClock,selection:null},'socket-a');
    b.remote({...good,type:'selection',selectionClock:2,selection:{}},'socket-a');
    assert.equal(b.api.getSelections(field)[0].resolved.anchor,1);
    await a.api.updateSelection({...field,selection:{anchor:3,head:3}});
    b.remote(a.packets.at(-1).data,'socket-a');
    assert.equal(b.api.getSelections(field)[0].resolved.anchor,3);
});

test('invalid presence in a text packet never drops its valid text operation', async () => {
    const a=setup({frame:'a'}), b=setup({frame:'b'});
    await a.api.updateText({...field,start:0,value:'abc',selection:{anchor:1,head:1}});
    await b.api.getText(field);
    b.remote({...a.packets[0].data,selection:{},selectionClock:Infinity},'socket-a');
    assert.equal(await b.api.getText(field),'abc');
    assert.equal(b.api.getSelections(field).length,0);
});

test('private drafts retain CRDT history without notifying peers or storage', async () => {
    const s=setup({frame:null,client:null});
    const element={id:'editor-a'};
    const draft={...field,realtime:false,scope:'editor-a',initialValue:'abc',element};
    const other={...field,realtime:false,scope:'editor-b',initialValue:'abc'};
    assert.equal(await s.api.getText(draft),'abc');
    assert.equal(await s.api.getText(other),'abc');
    await s.api.updateText({...draft,start:1,value:'X'});
    assert.equal(await s.api.getText(draft),'aXbc');
    assert.equal(await s.api.getText(other),'abc');
    await s.api.undoText(draft);
    assert.equal(await s.api.getText(draft),'abc');
    await s.api.redoText(draft);
    assert.equal(await s.api.getText(draft),'aXbc');
    assert.deepEqual(s.events.map(event=>event.detail.string),['aXbc','abc','aXbc']);
    assert.ok(s.events.every(event=>event.detail.elements[0]===element));
    assert.equal(s.packets.length,0);
    assert.equal(s.requests.length,0);
});

test('realtime must be explicitly true before CRDT publishes a change', async () => {
    const s=setup();
    const local={array:'notes',object:'record',key:'content',read:'false',scope:'editor'};
    await s.api.updateText({...local,start:0,value:'draft'});
    assert.equal(await s.api.getText(local),'draft');
    assert.equal(s.packets.length,0);
    assert.equal(s.requests.length,0);
    assert.equal(s.events.length,0);
    await s.api.replaceText({...field,value:'published'});
    assert.equal(s.packets.length,1);
    assert.equal(s.events.at(-1).detail.string,'published');
});
