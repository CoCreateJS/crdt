const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('Text captures the resulting selection once and suppresses duplicate cursor packets',()=>{
    const source=fs.readFileSync('../CoCreate-text/src/index.js','utf8').replace(/\r\n/g,'\n');
    const adapter=source.slice(source.indexOf('let previousPosition'),source.indexOf('function updateElements'))
        .replace('export function','function');
    const listeners={}, edits=[],positions=[];
    const element={tagName:'TEXTAREA',start:2,end:2,hasAttribute:()=>true};
    const context=vm.createContext({
        window:{addEventListener:(name,fn)=>listeners[name]=fn},
        getAttributes:()=>({array:'notes',object:'record',key:'content'}),
        getSelection:target=>({start:target.start,end:target.end,anchor:target.end,head:target.start}),
        cursors:{getPresence:()=>({userName:'writer'})},
        crdt:{updateSelection:data=>positions.push(data),updateText:data=>{
            edits.push(data);
            element.start=1;element.end=3;
            listeners['cocreate-crdt-update']({detail:{}});
            const selection=data.captureSelection();
            assert.deepEqual({...selection},{anchor:3,head:1});
        }}
    });
    vm.runInContext(adapter+`\nfunction updateElements(){sendPosition(testElement);}\nglobalThis.api={updateText,sendPosition};\n_crdtUpdateListener();`,context);
    context.testElement=element;
    context.api.updateText({element,value:'abc',start:0});
    context.api.sendPosition(element); // selectionchange after rendering the same edit
    assert.equal(edits.length,1);assert.equal(positions.length,0);
    element.start=0;context.api.sendPosition(element);
    assert.equal(positions.length,1);
    assert.deepEqual({...positions[0].selection},{anchor:3,head:0});
});

test('Selection exposes direction for inputs and DOM ranges',()=>{
    const source=fs.readFileSync('../CoCreate-selection/src/index.js','utf8').replace(/\r\n/g,'\n');
    const fn=source.slice(source.indexOf('export function getSelection'),source.indexOf('function getNodePosition'))
        .replace('export function','function');
    const context=vm.createContext({console, captureSelection:()=>null});
    vm.runInContext(fn+'\nfunction getNodePosition(node,element,offset){return offset;}\nglobalThis.readSelection=getSelection;',context);
    const input={tagName:'TEXTAREA',selectionStart:1,selectionEnd:4,selectionDirection:'backward'};
    assert.deepEqual({...context.readSelection(input)},{start:1,end:4,anchor:4,head:1});
    const host={htmlString:'abcdef',textContent:'abcdef'};
    const node={nodeType:3,textContent:'abcdef',parentElement:{closest:()=>host}};
    const range={startContainer:node,endContainer:node,startOffset:1,endOffset:4};
    const selection={rangeCount:1,getRangeAt:()=>range,anchorNode:node,anchorOffset:4,isCollapsed:false,toString:()=> 'bcd'};
    host.ownerDocument={getSelection:()=>selection};
    const result=context.readSelection(host);
    assert.equal(result.anchor,4);assert.equal(result.head,1);
});

test('Cursors consumes resolved CRDT selection and blur from the same update path',()=>{
    const source=fs.readFileSync('../CoCreate-cursors/src/index.js','utf8').replace(/\r\n/g,'\n');
    const listener=source.slice(source.indexOf('window.addEventListener("cocreate-crdt-selection"'),source.indexOf('socket.listen("cursor"'));
    let receive;const drawn=[],removed=[];
    vm.runInNewContext(listener,{
        window:{addEventListener:(name,fn)=>receive=fn},socket:{frameId:'local'},
        drawCursors:selection=>drawn.push(selection),removeCursor:id=>removed.push(id),
        localStorage:{getItem:()=>null},cursorBackground:'gray'
    });
    receive({detail:{frameId:'remote',socketId:'peer',clientId:'browser',selection:{},
        resolved:{anchor:4,head:1,start:1,end:4},presence:{userName:'Alice'}}});
    assert.equal(drawn.length,1);assert.equal(drawn[0].start,1);assert.equal(drawn[0].end,4);
    assert.equal(drawn[0].userName,'Alice');
    receive({detail:{frameId:'remote',socketId:'peer',selection:null}});
    assert.deepEqual(removed,['peer']);
});

test('blur clears selection and allows the same position to be shared on refocus',()=>{
    const source=fs.readFileSync('../CoCreate-text/src/index.js','utf8').replace(/\r\n/g,'\n');
    const blur=source.slice(source.indexOf('function _blur('),source.indexOf('function _cut('));
    const packets=[];
    const context=vm.createContext({previousPosition:{start:1},
        getAttributes:()=>({array:'notes',object:'record',key:'content'}),
        crdt:{updateSelection:data=>packets.push(data)}});
    vm.runInContext(blur+'\nglobalThis.blur=_blur;',context);
    context.blur({currentTarget:{getAttribute:()=> 'true'}});
    assert.equal(packets[0].selection,null);
    assert.equal(Object.keys(context.previousPosition).length,0);
});
