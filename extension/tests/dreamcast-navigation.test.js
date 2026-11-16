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
