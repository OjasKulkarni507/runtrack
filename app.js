'use strict';
/* ===== Config: tune GPS filtering here ===== */
const CFG={maxAcc:25,      // reject fixes worse than ±25 m
  minStep:3,               // ignore movement under 3 m (or half the accuracy radius)
  maxSpeed:11,             // m/s (~40 km/h) – faster hops are treated as GPS jumps
  gapSec:15,lostSec:10,    // gap = break in route line; lost = show "signal lost"
  winSec:15};              // window for current pace/speed

/* ===== State ===== */
const $=id=>document.getElementById(id);
const T={READY:['GPS_ACQUIRING'],GPS_ACQUIRING:['RUNNING','READY'],RUNNING:['PAUSED','COMPLETED'],PAUSED:['RUNNING','COMPLETED','READY'],COMPLETED:['READY']};
const fresh=()=>({state:'READY',id:'',name:'',start:0,end:0,t0:0,acc:0,dist:0,segs:[[]],last:null,win:[],kmDone:0,splits:[],goal:{kind:'none',value:0},goalHit:false,fix:0});
let S=fresh(),watchId=null,timerId=null,wake=null,audioCtx=null,beeping=false,saveN=0,voices=[],msgT=0;
let map,poly,cur,startM,finM,follow=true,sumMap;
const SP='speechSynthesis' in window;
let prefs={};try{prefs=JSON.parse(localStorage.getItem('rt_prefs'))||{}}catch{}

function go(s){if(!T[S.state].includes(s))return false;S.state=s;ui();return true}

/* ===== Formatting ===== */
const pad=n=>String(n).padStart(2,'0');
const fmtT=s=>{s=Math.floor(s);const h=Math.floor(s/3600);return(h?h+':':'')+pad(Math.floor(s%3600/60))+':'+pad(s%60)};
const fmtP=s=>{if(!isFinite(s)||s<=0||s>5999)return'--:--';const r=Math.round(s);return Math.floor(r/60)+':'+pad(r%60)};
const plural=(n,w)=>n+' '+w+(n===1?'':'s');
const say=s=>{s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return[h&&plural(h,'hour'),m&&plural(m,'minute'),(x||!(h||m))&&plural(x,'second')].filter(Boolean).join(' ')};
const esc=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');

/* ===== Distance (Haversine, metres) ===== */
const hav=(a,b)=>{const R=6371000,r=Math.PI/180,dl=(b[0]-a[0])*r,dn=(b[1]-a[1])*r,x=Math.sin(dl/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(x))};

/* ===== Timer: timestamp based, so no setInterval drift ===== */
const elapsed=()=>S.acc+(S.state==='RUNNING'?(Date.now()-S.t0)/1000:0);
const startTimer=()=>{if(!timerId)timerId=setInterval(()=>{render();if(++saveN%20===0)save()},250)};
const stopTimer=()=>{clearInterval(timerId);timerId=null};

function metrics(){
  const t=elapsed(),d=S.dist/1000,w=S.win;let sp=0;
  if(w.length>1&&Date.now()-w[w.length-1][0]<CFG.lostSec*1000){const dt=(w[w.length-1][0]-w[0][0])/1000;if(dt>=3)sp=(w[w.length-1][1]-w[0][1])/dt*3.6}
  return{t,d,sp,pace:sp>.5?3600/sp:NaN,avgP:d>.01?t/d:NaN,avgS:t>0&&d>0?d/(t/3600):0};
}

/* ===== UI ===== */
function msg(t,k='info'){const e=$('msg');clearTimeout(msgT);e.hidden=!t;e.textContent=t;e.className=k;if(t&&k==='ok')msgT=setTimeout(()=>e.hidden=true,5000)}
function setGps(ac,lost){const e=$('gps');
  if(lost){e.textContent='GPS: signal lost';e.className='pill bad';return}
  if(ac==null){e.textContent='GPS: off';e.className='pill';$('accv').textContent='--';return}
  e.textContent='GPS ±'+Math.round(ac)+' m';e.className='pill '+(ac<=10?'good':ac<=CFG.maxAcc?'ok':'bad');$('accv').textContent=Math.round(ac)+' m'}
function setWl(note){$('wl').textContent='Screen: '+(!('wakeLock' in navigator)?'may sleep (unsupported)':wake?'kept awake':note||'normal');$('wl').className='pill '+(wake?'good':'')}
function render(){
  const m=metrics(),g=S.goal;
  $('dist').textContent=m.d.toFixed(2);$('time').textContent=fmtT(m.t);
  $('pace').textContent=fmtP(m.pace);$('apace').textContent=fmtP(m.avgP);
  $('spd').textContent=m.sp?m.sp.toFixed(1):'--';$('aspd').textContent=m.avgS?m.avgS.toFixed(1):'--';$('km').textContent=S.kmDone;
  const gt=$('goalTxt');gt.hidden=g.kind==='none'||S.state==='READY';
  if(!gt.hidden)gt.textContent=S.goalHit?'🏆 Goal reached':g.kind==='distance'?`Goal: ${m.d.toFixed(2)} / ${g.value} km`:`Goal: ${fmtT(m.t)} / ${fmtT(g.value*60)}`;
  if(S.state==='RUNNING'){checkGoal(m);if(Date.now()-S.fix>CFG.lostSec*1000)setGps(null,true)}
}
function ui(){
  const s=S.state;$('setup').hidden=s!=='READY';
  $('bMain').textContent={READY:'Start',GPS_ACQUIRING:'Finding GPS…',RUNNING:'Pause',PAUSED:'Resume',COMPLETED:'Done'}[s];
  $('bMain').disabled=s==='GPS_ACQUIRING'||s==='COMPLETED';
  $('bFinish').hidden=!(s==='RUNNING'||s==='PAUSED');$('bReset').hidden=!(s==='PAUSED'||s==='GPS_ACQUIRING');
  $('vs').textContent='Voice: '+(!SP?'unsupported':$('voice').checked?'on':'off');
  if(s==='READY')setGps(null);
  setWl();render();
}

/* ===== Audio: beep + speech ===== */
function initAudio(){try{audioCtx=audioCtx||new(window.AudioContext||window.webkitAudioContext)();audioCtx.resume()}catch{}}
function beep(freqs){
  if(!$('sound').checked||!audioCtx||beeping)return;beeping=true;
  try{const t0=audioCtx.currentTime;freqs.forEach((f,i)=>{const o=audioCtx.createOscillator(),g=audioCtx.createGain(),s=t0+i*.18;o.frequency.value=f;o.connect(g);g.connect(audioCtx.destination);g.gain.setValueAtTime(.0001,s);g.gain.exponentialRampToValueAtTime(.3,s+.02);g.gain.exponentialRampToValueAtTime(.0001,s+.15);o.start(s);o.stop(s+.16)})}catch{}
  setTimeout(()=>beeping=false,freqs.length*180+50);
}
function loadVoices(){
  voices=speechSynthesis.getVoices();const langs=[...new Set(voices.map(v=>v.lang))].sort(),sel=$('lang');
  sel.innerHTML='<option value="">Auto</option>'+langs.map(l=>`<option>${l}</option>`).join('');
  sel.value=langs.includes(prefs.lang)?prefs.lang:'';
}
function speak(text,delay=0){ // speechSynthesis has its own queue, so announcements never overlap
  if(!SP||!$('voice').checked)return;
  setTimeout(()=>{try{const u=new SpeechSynthesisUtterance(text),l=$('lang').value;
    u.rate=+$('rate').value;u.volume=+$('vol').value;
    if(l){u.lang=l;const v=voices.find(v=>v.lang===l);if(v)u.voice=v}
    u.onerror=e=>{if(e.error!=='canceled'&&e.error!=='interrupted')msg('Voice announcement failed: '+e.error,'warn')};
    speechSynthesis.speak(u)}catch{msg('Voice announcement failed.','warn')}},delay);
}

/* ===== Wake lock ===== */
async function lock(){
  if(!('wakeLock' in navigator)){setWl();return}
  try{wake=await navigator.wakeLock.request('screen');wake.addEventListener('release',()=>{wake=null;setWl('released')});setWl()}
  catch(e){wake=null;setWl('request failed');msg('Could not keep the screen awake. Change your phone\'s screen timeout to a longer time.','warn')}
}
const unlock=()=>{if(wake){wake.release().catch(()=>{});wake=null}setWl()};

/* ===== Map ===== */
const tiles=m=>L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).on('tileerror',()=>msg('Some map tiles failed to load. Tracking is unaffected.','warn')).addTo(m);
const mk=(m,ll,c)=>L.circleMarker(ll,{radius:9,color:'#fff',weight:3,fillColor:c,fillOpacity:1}).addTo(m);
function initMap(){
  if(typeof L==='undefined'){msg('Map library could not load (offline?). Tracking still works.','warn');return}
  map=L.map('map',{preferCanvas:true}).setView([20,0],2);tiles(map);
  poly=L.polyline([],{color:'#d4ff3a',weight:6,renderer:L.canvas()}).addTo(map);
  map.on('dragstart',()=>{follow=false;$('recenter').hidden=false});
}
function showPos(la,lo){
  if(!map)return;const ll=[la,lo];
  cur?cur.setLatLng(ll):cur=mk(map,ll,'#2d8cff');
  if(follow)map.setView(ll,Math.max(map.getZoom(),17),{animate:false});
}
const drawRoute=()=>poly&&poly.setLatLngs(S.segs.map(s=>s.map(p=>[p[0],p[1]])));
function clearMap(){if(!map)return;poly.setLatLngs([]);[cur,startM,finM].forEach(x=>x&&x.remove());cur=startM=finM=null;follow=true;$('recenter').hidden=true}

/* ===== GPS ===== */
const GEO={enableHighAccuracy:true,maximumAge:0,timeout:15000};
const startWatch=()=>{if(watchId===null)watchId=navigator.geolocation.watchPosition(onPos,onErr,GEO)};
const stopWatch=()=>{if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null}};
function onErr(e){
  if(e.code===1){stopWatch();msg('Location permission denied. Allow location for this site in browser settings, then tap Start again.','err');
    if(S.state==='GPS_ACQUIRING')go('READY');else if(S.state==='RUNNING')pause();setGps(null);return}
  msg(e.code===3?'Waiting for GPS signal…':'GPS unavailable. Turn on Location and move to open sky.','warn');
}
function onPos(p){
  const{latitude:la,longitude:lo,accuracy:ac}=p.coords,ts=p.timestamp;
  if(!Number.isFinite(la)||!Number.isFinite(lo)||Math.abs(la)>90||Math.abs(lo)>180)return;
  S.fix=Date.now();setGps(ac);showPos(la,lo);
  if(S.state==='GPS_ACQUIRING'){
    if(ac>CFG.maxAcc){msg(`Waiting for a better GPS fix (now ±${Math.round(ac)} m)…`,'warn');return}
    S.start=S.t0=Date.now();go('RUNNING');startTimer();msg('GPS locked. Go!','ok');
  }
  if(S.state!=='RUNNING'||ac>CFG.maxAcc)return;
  const pt=[la,lo,ts],seg=S.segs[S.segs.length-1],l=S.last;
  if(l){
    const dt=(ts-l[2])/1000;if(dt<=0)return;               // out-of-order / duplicate timestamp
    const d=hav(l,pt);
    if(dt>CFG.gapSec){if(d/dt>CFG.maxSpeed)return;S.dist+=d;S.segs.push([pt])}   // signal gap: new line segment, no line drawn across it
    else{if(d<Math.max(CFG.minStep,ac*.5)||d/dt>CFG.maxSpeed)return;S.dist+=d;seg.push(pt)} // drift / jump rejected
  }else seg.push(pt);
  S.last=pt;if(!startM&&map)startM=mk(map,[la,lo],'#4be39b');
  const w=S.win,n=Date.now();w.push([n,S.dist]);while(w.length>2&&w[0][0]<n-CFG.winSec*1000)w.shift();
  drawRoute();checkKm();render();
}

/* ===== Km announcements & goals ===== */
function checkKm(){
  while(S.dist>=(S.kmDone+1)*1000){ // while-loop + counter = no duplicates, no skips
    const k=++S.kmDone,t=elapsed();S.splits.push(t);beep([880]);
    speak(`You have completed ${plural(k,'kilometre')}. Your time is ${say(t)}. Your average pace is ${say(t/(S.dist/1000))} per kilometre.`,350);
  }
}
function checkGoal(m){
  const g=S.goal;if(S.goalHit||g.kind==='none')return;
  if((g.kind==='distance'&&S.dist>=g.value*1000)||(g.kind==='time'&&m.t>=g.value*60)){
    S.goalHit=true;beep([660,880,1100]);
    speak(`Goal achieved! You covered ${m.d.toFixed(2)} kilometres in ${say(m.t)}.`,600);
    $('gdBody').innerHTML=`<p><b>${m.d.toFixed(2)} km</b> in <b>${fmtT(m.t)}</b><br>Average pace ${fmtP(m.avgP)} /km · ${m.avgS.toFixed(1)} km/h</p>`;
    if(!$('goalDlg').open)$('goalDlg').showModal();
  }
}
function readGoal(){
  const kind=$('gk').value;if(kind==='none')return{kind,value:0};
  const v=parseFloat($('gv').value),min=kind==='distance'?.1:1,max=kind==='distance'?100:600;
  if(!(v>=min&&v<=max)){msg(`Enter a ${kind==='distance'?'distance between 0.1 and 100 km':'duration between 1 and 600 minutes'}.`,'err');$('gv').focus();return null}
  return{kind,value:v};
}

/* ===== Session controls ===== */
function start(){
  if(!navigator.geolocation){msg('This browser does not support location (Geolocation API).','err');return}
  const g=readGoal();if(!g)return;
  if(!go('GPS_ACQUIRING'))return;
  S.goal=g;S.name=$('name').value.trim();S.id=Date.now()+'-'+Math.random().toString(36).slice(2,7);
  initAudio();speak('Run started. Finding GPS.');lock();msg('Finding GPS… stand in the open for a few seconds.');startWatch();
}
function pause(){
  if(S.state!=='RUNNING')return;
  S.acc=elapsed();go('PAUSED');stopWatch();stopTimer();unlock();S.last=null;S.win=[];save();setGps(null);
}
function resume(){
  if(S.state!=='PAUSED')return;
  initAudio();S.t0=Date.now();S.segs.push([]);S.last=null;S.win=[];S.fix=Date.now();
  go('RUNNING');startWatch();startTimer();lock();
}
async function finish(){
  if(S.state!=='RUNNING'&&S.state!=='PAUSED')return;
  if(!confirm('Finish and save this run?'))return;
  $('goalDlg').open&&$('goalDlg').close();
  const t=elapsed();S.acc=t;S.end=Date.now();const m=metrics();
  go('COMPLETED');stopWatch();stopTimer();unlock();localStorage.removeItem('rt_active');
  const rec={id:S.id,name:S.name||'Run',start:S.start,end:S.end,dist:S.dist,dur:t,avgPace:isFinite(m.avgP)?m.avgP:null,avgSpeed:m.avgS,goal:S.goal,goalHit:S.goalHit,splits:S.splits,route:S.segs.filter(s=>s.length)};
  const last=S.last;if(last&&map)finM=mk(map,[last[0],last[1]],'#ff6464');
  beep([660,880]);speak(`Run complete. ${m.d.toFixed(2)} kilometres in ${say(t)}.`,400);
  try{await tx('readwrite',s=>s.put(rec));msg('Run saved to this device.','ok')}catch{msg('Could not save the run (storage unavailable). Screenshot your summary.','err')}
  showSummary(rec);
}
function reset(){
  if(!T[S.state].includes('READY'))return;
  if(S.state==='PAUSED'&&S.dist>0&&!confirm('Discard this run? Its data will be lost.'))return;
  stopWatch();stopTimer();unlock();localStorage.removeItem('rt_active');clearMap();S=fresh();msg('');ui();
}

/* ===== Persistence: IndexedDB for runs, localStorage snapshot for refresh recovery ===== */
const db=()=>new Promise((res,rej)=>{const r=indexedDB.open('runtrack',1);r.onupgradeneeded=()=>r.result.createObjectStore('sessions',{keyPath:'id'});r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const tx=async(mode,fn)=>{const d=await db();return new Promise((res,rej)=>{const t=d.transaction('sessions',mode),q=fn(t.objectStore('sessions'));t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error)})};
function save(){if(S.state==='RUNNING'||S.state==='PAUSED')try{localStorage.setItem('rt_active',JSON.stringify({...S,acc:elapsed(),win:[],last:null,t0:0,state:'PAUSED'}))}catch{}}
function recoverCheck(){
  let o;try{o=JSON.parse(localStorage.getItem('rt_active'))}catch{}
  if(!o||!o.segs)return;
  $('recovTxt').textContent=`Unfinished run found: ${(o.dist/1000).toFixed(2)} km, ${fmtT(o.acc)}. It was paused when the page closed.`;$('recov').hidden=false;
  $('bRecov').onclick=()=>{S={...fresh(),...o,state:'PAUSED'};$('recov').hidden=true;drawRoute();const p=S.segs.flat().pop();if(p&&map){showPos(p[0],p[1]);startM=mk(map,[S.segs[0][0][0],S.segs[0][0][1]],'#4be39b')}ui();msg('Run restored. Tap Resume when ready.','ok')};
  $('bDisc').onclick=()=>{localStorage.removeItem('rt_active');$('recov').hidden=true};
}

/* ===== Summary & history ===== */
function showSummary(r){
  $('sTitle').textContent=`${r.name} · ${new Date(r.start).toLocaleString()}`;
  const c=(v,l)=>`<div><b>${v}</b><small>${l}</small></div>`;
  $('sBody').innerHTML=c((r.dist/1000).toFixed(2)+' km','distance')+c(fmtT(r.dur),'time')+c(fmtP(r.avgPace)+' /km','avg pace')+c(r.avgSpeed.toFixed(1)+' km/h','avg speed')+
    c(r.goal.kind==='none'?'No goal':r.goalHit?'🏆 Reached':'Not reached','goal'+(r.goal.kind==='none'?'':` (${r.goal.value} ${r.goal.kind==='distance'?'km':'min'})`))+c(r.splits.length,'km completed');
  $('sumDlg').showModal();
  setTimeout(()=>{ // wait for dialog layout so Leaflet measures the right size
    if(typeof L==='undefined')return;sumMap&&sumMap.remove();
    sumMap=L.map('sumMap');tiles(sumMap);
    const segs=r.route.map(s=>s.map(p=>[p[0],p[1]]));
    if(segs.flat().length){const l=L.polyline(segs,{color:'#d4ff3a',weight:5}).addTo(sumMap),a=segs[0][0],z=segs[segs.length-1].slice(-1)[0];
      mk(sumMap,a,'#4be39b');mk(sumMap,z,'#ff6464');sumMap.fitBounds(l.getBounds(),{padding:[20,20]})}else sumMap.setView([0,0],2);
  },80);
}
async function openHist(){
  let list=[];try{list=((await tx('readonly',s=>s.getAll()))||[]).sort((a,b)=>b.start-a.start)}catch{msg('History unavailable (storage blocked).','err')}
  $('hList').innerHTML=list.length?list.map(r=>`<li data-id="${esc(r.id)}"><button class="row" data-act="view">${esc(r.name)}<br><small>${new Date(r.start).toLocaleDateString()} · ${(r.dist/1000).toFixed(2)} km · ${fmtT(r.dur)} · ${fmtP(r.avgPace)}/km ${r.goalHit?'🏆':''}</small></button><button class="danger" data-act="del" aria-label="Delete run">🗑</button></li>`).join(''):'<li>No runs yet. Your saved runs appear here.</li>';
  if(!$('histDlg').open)$('histDlg').showModal();
}

/* ===== Events ===== */
$('bMain').onclick=()=>({READY:start,RUNNING:pause,PAUSED:resume})[S.state]?.();
$('bFinish').onclick=finish;$('bReset').onclick=reset;$('bGoalFin').onclick=finish;$('bKeep').onclick=()=>$('goalDlg').close();
$('bHist').onclick=openHist;
$('recenter').onclick=()=>{follow=true;$('recenter').hidden=true;const p=S.segs.flat().pop();if(p)showPos(p[0],p[1])};
$('bTest').onclick=()=>{initAudio();beep([880]);speak('This is a test. You have completed 1 kilometre. Your time is 6 minutes 20 seconds. Your average pace is 6 minutes 20 seconds per kilometre.',350);if(!SP)msg('Speech is not supported in this browser.','warn')};
$('hList').onclick=async e=>{
  const b=e.target.closest('button[data-act]');if(!b)return;const id=b.closest('li').dataset.id;
  try{if(b.dataset.act==='view'){const r=await tx('readonly',s=>s.get(id));if(r){$('histDlg').close();showSummary(r)}}
  else if(confirm('Delete this run?')){await tx('readwrite',s=>s.delete(id));openHist()}}catch{msg('Storage error.','err')}
};
$('bClear').onclick=async()=>{if(confirm('Delete ALL saved runs? This cannot be undone.')){try{await tx('readwrite',s=>s.clear());openHist()}catch{msg('Storage error.','err')}}};
$('sumDlg').onclose=()=>{sumMap&&sumMap.remove();sumMap=null;if(S.state==='COMPLETED'){clearMap();S=fresh();ui()}};
function applyGoalUi(){const k=$('gk').value;$('gvRow').hidden=k==='none';$('gl').textContent=k==='time'?'Duration (minutes)':'Distance (km)';$('gv').setAttribute('list','dl-'+k)}
$('gk').addEventListener('change',()=>{$('gv').value='';prefs.gv='';applyGoalUi()});
document.addEventListener('change',e=>{const t=e.target;if(t.classList.contains('pref')){prefs[t.id]=t.type==='checkbox'?t.checked:t.value;try{localStorage.setItem('rt_prefs',JSON.stringify(prefs))}catch{}ui()}});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){save();return}
  if(S.state==='RUNNING'){if(!wake)lock();render();if(SP)speechSynthesis.resume()}
});
addEventListener('pagehide',save);

/* ===== Init ===== */
document.querySelectorAll('.pref').forEach(e=>{if(e.id in prefs&&e.id!=='lang'){e.type==='checkbox'?e.checked=prefs[e.id]:e.value=prefs[e.id]}});
applyGoalUi();initMap();
if(SP){loadVoices();speechSynthesis.onvoiceschanged=loadVoices}else{$('voice').checked=false;$('voice').disabled=true}
recoverCheck();ui();
if('serviceWorker' in navigator)addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));
