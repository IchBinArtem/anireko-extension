'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.join(__dirname, '..');
const base = 'https://dreamerscast.com/home/release/621-test';

function sensor(hasNavigation = true) {
  const listeners = new Map(), navigation = new Map(), windowListeners = new Map(), sent = [];
  let label = 'Серия 1';
  const video = {tagName:'VIDEO', isConnected:true, src:'blob:one', currentSrc:'blob:one', readyState:4,
    currentTime:20, duration:1000, paused:false, ended:false, seeking:false, muted:false, volume:1,
    playbackRate:1, hidden:false, closest:() => ({}), getBoundingClientRect:() => ({width:800,height:450}), addEventListener() {}};
  const document = {documentElement:{}, title:'', readyState:'complete',
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type,list); },
    querySelectorAll(selector) { if (selector === '#player video' || selector === 'video') return [video];
      if (selector === '#player .pjs-player-active-pl') return [{textContent:label}]; return []; },
    querySelector(selector) { return selector === '#player video' || selector === 'video' ? video : null; }};
  const window = {addEventListener(type, fn) { windowListeners.set(type, fn); }};
  if (hasNavigation) window.navigation={addEventListener(type, fn) { navigation.set(type,fn); }};
  window.top = window;
  const context = vm.createContext({document,window,location:new URL(base),
    chrome:{runtime:{id:'extension',onMessage:{addListener() {}},sendMessage(message) { sent.push(message); return Promise.resolve(); }}},
    getComputedStyle:() => ({display:'block',visibility:'visible',opacity:'1'}),
    MutationObserver:class {observe() {} disconnect() {}}, Element:class {}, Node:{ELEMENT_NODE:1},
    setTimeout() {}, setInterval() {return 1;}, clearInterval() {}, queueMicrotask(fn) {fn();}, URL});
  for (const file of ['lib/recognition.js','lib/progress.js','content/media-detector.js'])
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  return {sent, video, setLabel(value) {label=value;},
    episode(value) { for (const fn of listeners.get('anireko-dreamcast-prototype') || []) fn({detail:JSON.stringify({episode:value})}); },
    navigate(url) {context.location=new URL(url); if (hasNavigation) navigation.get('currententrychange')({isTrusted:true});
      else windowListeners.get('popstate')();},
    last() {return sent.filter(m => m.type === 'player-progress').at(-1);}};
}

test('isolated detector preserves valid proof only across fragment navigation', () => {
  const f=sensor(); f.episode(1); assert.equal(f.last().episode,1);
  f.navigate(`${base}#chapter`);
  assert.equal(f.last().episode,1); assert.equal(f.last().documentUrl,`${base}#chapter`);
  assert.equal(f.last().frameUrl,`${base}#chapter`);
  f.setLabel('Серия 2'); f.navigate(`${base}#next`);
  assert.equal(f.last().episode,null, 'changed selected episode cannot reuse the old proof');
});

for (const target of [`${base}?other=1`, 'https://dreamerscast.com/home/release/622-other', 'https://dreamerscast.com/other']) {
  test(`isolated detector latches departure and return: ${target}`, () => {
    const f=sensor(); f.episode(1); f.navigate(target); f.episode(1);
    assert.equal(f.last().episode,null); f.navigate(base);
    f.video.src=f.video.currentSrc='blob:two'; f.setLabel('Серия 2'); f.episode(2);
    assert.equal(f.last().episode,null);
  });
}

function mainObserver(hasNavigation = true) {
  const docEvents=new Map(), nav=new Map(), dashEvents=new Map(), episodes=[];
  const video={tagName:'VIDEO',isConnected:true,readyState:0,src:'',currentSrc:''};
  const label={textContent:''}; let info, manifest, id, notify;
  const active={getIsActive:()=>true,getStreamInfo:()=>info};
  const dash={on:(name,fn)=>dashEvents.set(name,fn),getVideoElement:()=>video,
    getActiveStream:()=>active,getDashAdapter:()=>({getMpd:()=>({manifest})})};
  const window={pjs:{api:name=>({dash,playlist_id:id,playlist_title:label.textContent})[name]},
    addEventListener:(name,fn)=>nav.set(name,fn)};
  if (hasNavigation) window.navigation={addEventListener:(name,fn)=>nav.set(name,fn)};
  const document={documentElement:{},querySelectorAll:selector=>selector==='#player video'?[video]:[label],
    addEventListener:(name,fn)=>docEvents.set(name,fn),dispatchEvent:event=>episodes.push(JSON.parse(event.detail).episode)};
  const context=vm.createContext({URL,window,document,location:new URL(base),
    CustomEvent:class {constructor(type,{detail}) {this.type=type;this.detail=detail;}},
    MutationObserver:class {constructor(fn) {notify=fn;} observe() {}}});
  vm.runInContext(fs.readFileSync(path.join(root,'content/dreamcast-main.js'),'utf8'),context); notify([]);
  const event=type=>docEvents.get(type)({type,isTrusted:true,target:video});
  return {episodes, navigate(url) {context.location=new URL(url);nav.get(hasNavigation ? 'currententrychange' : 'popstate')();},
    activate(episode, ready=true) {
      event('loadstart'); const key=episode===1?'447e7ded-abcd-4173-a2f4-f234567890ab':'cf82a881-7359-43c2-a091-d0f639df926a';
      const loadedTime=new Date(episode); info={manifestInfo:{loadedTime}};
      manifest={loadedTime,url:`https://fixture.invalid/${key}/manifest.mpd`}; id=`playlist_${key}`;
      label.textContent=`Серия ${episode}`; video.src=video.currentSrc=`blob:${key}`;
      dashEvents.get('streamActivated')({streamInfo:info});
      if (ready) {video.readyState=2;event('loadeddata');}
    }, last() {return episodes.at(-1);}};
}

test('MAIN keeps the media proof on fragment and requires a new activation for another episode', () => {
  const f=mainObserver(); f.activate(1); assert.equal(f.last(),1);
  f.navigate(`${base}#chapter`); assert.equal(f.last(),1);
  f.activate(2,false); assert.equal(f.last(),null);
  f.activate(2,true); assert.equal(f.last(),2);
});
for (const target of [`${base}?other=1`, 'https://dreamerscast.com/home/release/622-other']) {
  test(`MAIN latches departure and late activations: ${target}`, () => {
    const f=mainObserver(); f.activate(1); f.navigate(target); assert.equal(f.last(),null);
    f.activate(2); assert.equal(f.last(),null); f.navigate(base); f.activate(2); assert.equal(f.last(),null);
  });
}

test('without Navigation API the original full-URL guard and detector reset remain in effect', () => {
  const main=mainObserver(false), isolated=sensor(false);
  main.activate(1); isolated.episode(1);
  assert.equal(main.last(),1); assert.equal(isolated.last().episode,1);
  main.navigate(`${base}#chapter`); isolated.navigate(`${base}#chapter`);
  assert.equal(main.last(),null); assert.equal(isolated.last().episode,null);
  main.navigate(`${base}?other=1`); isolated.navigate(`${base}?other=1`);
  main.activate(2); assert.equal(main.last(),null); assert.equal(isolated.last().episode,null);
  main.navigate('https://dreamerscast.com/home/release/622-other');
  isolated.navigate('https://dreamerscast.com/home/release/622-other');
  main.activate(2); assert.equal(main.last(),null); assert.equal(isolated.last().episode,null);
  main.navigate(base); isolated.navigate(base);
  main.activate(2); isolated.video.src=isolated.video.currentSrc='blob:two';
  isolated.setLabel('Серия 2'); isolated.episode(2);
  assert.equal(main.last(),2); assert.equal(isolated.last().episode,2);
});

function receiptFixture() {
  const listeners=new Map(), sent=[]; let selected='Серия 1', playerVideos=[];
  function video(src, inside) {
    const handlers=new Map();
    return {tagName:'VIDEO',isConnected:true,src,currentSrc:src,readyState:4,currentTime:100,duration:1000,
      paused:false,ended:false,seeking:false,muted:false,volume:1,playbackRate:1,hidden:false,inside,
      closest(selector) {return selector==='#player' && this.isConnected && this.inside ? {} : null;},
      getBoundingClientRect() {return {width:800,height:450};},
      addEventListener(type,fn) {handlers.set(type,fn);}, emit(type) {assert.ok(handlers.has(type));handlers.get(type)();}};
  }
  const old=video('blob:old',true), next=video('blob:new',false), other=video('blob:other',false); playerVideos=[old];
  const document={documentElement:{},title:'',readyState:'complete',
    addEventListener(type,fn) {const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},
    querySelectorAll(selector) {if(selector==='#player video') return playerVideos;
      if(selector==='video') return [old,next,other];
      if(selector==='#player .pjs-player-active-pl') return [{textContent:selected}];return [];},
    querySelector(selector) {return selector==='#player video' ? playerVideos[0] || null : selector==='video' ? old : null;}};
  const window={addEventListener(){},navigation:{addEventListener(){}}};window.top=window;
  const context=vm.createContext({document,window,location:new URL(base),
    chrome:{runtime:{id:'extension',onMessage:{addListener(){}},sendMessage(m){sent.push(m);return Promise.resolve();}}},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    MutationObserver:class {observe(){} disconnect(){}},Element:class{},Node:{ELEMENT_NODE:1},
    setTimeout(){},setInterval(){return 1;},clearInterval(){},queueMicrotask(){},URL});
  for(const file of ['lib/recognition.js','lib/progress.js','content/media-detector.js'])
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  const source=fs.readFileSync(path.join(root,'service-worker.js'),'utf8');
  const start=source.indexOf('function captureDreamCastReceipt('), end=source.indexOf('chrome.runtime.onMessage.addListener(',start);
  assert.ok(start>=0 && end>start);
  const worker=vm.createContext({URL});
  vm.runInContext("const latestDreamCastReceiptByTab=new Map(),latestTopDocumentByTab=new Map(),stateByTab={}; function isDreamCastReleaseUrl(v){try {const u=new URL(v);return u.hostname==='dreamerscast.com' && /^\\/home\\/release\\/\\d+-[^/]+\\/?$/u.test(u.pathname);}catch{return false;}}\n"+source.slice(start,end),worker);
  const sender={tab:{id:7}}, scope={topFrame:true,documentId:'top',documentToken:null,documentUrl:base};
  let consumed=0;
  return {old,next,other,sent,
    player(videos, label) {playerVideos=videos;selected=label;},
    proof(episode) {for(const fn of listeners.get('anireko-dreamcast-prototype')||[])fn({detail:JSON.stringify({episode})});},
    messages() {return sent.filter(m=>m.type==='player-progress');},
    accept() {const messages=this.messages();for(;consumed<messages.length;consumed++) {const m=messages[consumed];scope.documentToken=m.documentToken;assert.equal(worker.captureDreamCastReceipt(m,sender,scope),true);}return messages.at(-1);},
    current(message) {return worker.dreamCastMessageReceiptCurrent(message,sender,scope);}};
}

test('detached and unrelated video events cannot supersede a valid current receipt', () => {
  const f=receiptFixture();f.proof(1);f.accept();f.old.isConnected=false;f.next.inside=true;
  f.player([f.next],'Серия 2');f.proof(2);const valid=f.accept();assert.equal(valid.episode,2);
  const count=f.messages().length;f.old.emit('pause');f.other.emit('pause');f.accept();
  assert.equal(f.messages().length,count);assert.equal(f.current(valid),true);
  f.next.paused=true;f.next.emit('pause');const paused=f.accept();
  assert.equal(paused.episode,2);assert.equal(paused.paused,true);assert.equal(f.current(valid),false);assert.equal(f.current(paused),true);
});

for(const mode of ['missing','ambiguous','replacement']) {
  test(`lost proof invalidates the previous worker receipt once: ${mode}`, () => {
    const f=receiptFixture();f.proof(1);const valid=f.accept();assert.equal(valid.episode,1);
    if(mode==='missing') {f.old.isConnected=false;f.player([],'Серия 1');}
    if(mode==='ambiguous') {f.next.inside=true;f.player([f.old,f.next],'Серия 1');}
    if(mode==='replacement') {f.old.isConnected=false;f.next.inside=true;f.player([f.next],'Серия 2');}
    f.proof(null);const invalid=f.accept();assert.equal(invalid.episode,null);assert.equal(f.current(valid),false);assert.equal(f.current(invalid),true);
    const count=f.messages().length;f.old.emit('pause');f.accept();assert.equal(f.messages().length,count);
  });
}
