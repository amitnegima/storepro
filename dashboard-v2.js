
// ════════════════════════════════════════════
// CONFIG / STATE
// ════════════════════════════════════════════
// Web Push relay (Cloudflare Worker). See push/README.md to deploy your own.
// Set both before deploying. Leave blank to disable Web Push (falls back to in-page only).
var PUSH_RELAY_URL="https://storepro-push.storepro.workers.dev";
var VAPID_PUBLIC_KEY="BKvrqqbCp4z0dei-Uh57yv-Pzh7zH2I0mOgqPFLZR3SQ5IH4jJXeTEHQoFiOxDtBTOChW7jsFB3AtvSOsl7FfD8";
var MASTER_SHEET_ID="1K6jYaOrnmMLw_0_N5EvrgE5jEOpbIsWZjyCM8Yf6OLg";
var SHEET_ID="",SCRIPT_URL="";
var STORE_META={}; // from master registry: ShopName, OwnerName, Plan, etc.
var configData=[],productData=[],allOrders=[];
var activeStatusFilter='all',activeDateFilter='today',activeCat='all';
var currentPage='home',pollInterval=null,prevNewCount=-1;
var _etaOrderId='';
var _broadcastQueue=[];

// ════════════════════════════════════════════
// NOTIFICATIONS — zero-infra: in-page only
// ════════════════════════════════════════════
var NPREF={sound:true,vibrate:true,browserNotif:true,wakeLock:true,repeat:true,
  speak:true,    // speech announcement
  flash:true,    // full-screen flash
  loud:true,     // extra-loud mode (saturation + noise burst)
  loop:false,    // keep alerting continuously until ack
  lang:''        // user override for language ('', 'en', 'hi'); '' = use Config.NotificationLanguage
};

// Default templates per language. Placeholders: {name} {total} {count}
var I18N={
  en:{
    title1:'🔔 New order received from {customerName}',
    titleN:'🔔 {count} new orders received',
    body1:'New order from {customerName} of ₹{rupee}',
    bodyN:'{count} new orders are waiting for your confirmation',
    speak1:'New order received from {customerName} of {rupee} rupees.',
    speakN:'{count} new orders have been received. Please check the dashboard.',
    bannerTitle1:'🔔 New order received!',
    bannerTitleN:'🔔 {count} new orders received',
    bannerInfo1:'From {customerName} of ₹{rupee} · tap to view',
    bannerInfoN:'Tap to review and confirm all orders',
    voiceLang:'en-IN'
  },
  hi:{
    title1:'🔔 {customerName} से नया ऑर्डर मिला है',
    titleN:'🔔 {count} नए ऑर्डर मिले हैं',
    body1:'{customerName} से ₹{rupee} का नया ऑर्डर मिला है',
    bodyN:'{count} नए ऑर्डर आपकी कन्फर्मेशन का इंतजार कर रहे हैं',
    speak1:'नया ऑर्डर मिला है {customerName} से, {rupee} रुपये का।',
    speakN:'{count} नए ऑर्डर मिले हैं। कृपया डैशबोर्ड देखें।',
    bannerTitle1:'🔔 नया ऑर्डर मिला है!',
    bannerTitleN:'🔔 {count} नए ऑर्डर मिले हैं',
    bannerInfo1:'{customerName} से ₹{rupee} · देखने के लिए टैप करें',
    bannerInfoN:'सभी ऑर्डर देखें और कन्फर्म करें',
    voiceLang:'hi-IN'
  }
};
function nLang(){
  if(NPREF.lang)return NPREF.lang;
  var c=(getCfg('NotificationLanguage','')||getCfg('NotificationLang','')||'').toLowerCase();
  if(c==='hi'||c==='hindi'||c==='हिन्दी'||c==='हिंदी')return 'hi';
  return 'en';
}
function nTpl(key){
  // Per-key Config override wins, e.g. Config.NotificationSpeak1, Config.NotificationBannerTitleN
  var ov=getCfg('Notification'+key.charAt(0).toUpperCase()+key.slice(1),'');
  if(ov)return ov;
  return I18N[nLang()][key]||I18N.en[key]||'';
}
// Placeholder aliases — both {name} and {customerName}, both {} and <> styles work
var PH_ALIAS={
  name:'name',customername:'name',customer:'name','customer_name':'name',cust:'name',
  total:'total',rupee:'total',rupees:'total',amount:'total',price:'total',rs:'total','order_total':'total',
  count:'count',n:'count',orders:'count','order_count':'count',num:'count',
  phone:'phone',mobile:'phone','phone_no':'phone',number:'phone',
  shop:'shop',shopname:'shop',store:'shop','shop_name':'shop','store_name':'shop'
};
function fillTpl(tpl,vars){
  return String(tpl||'').replace(/[{<](\w+)[}>]/g,function(m,k){
    var canonical=PH_ALIAS[k.toLowerCase()]||k;
    return vars[canonical]==null?'':String(vars[canonical]);
  });
}
try{var s=localStorage.getItem('sl_npref');if(s)NPREF=Object.assign(NPREF,JSON.parse(s))}catch(e){}
function saveNPref(){try{localStorage.setItem('sl_npref',JSON.stringify(NPREF))}catch(e){}}
var _audioCtx=null,_repeatTimer=null,_loopTimer=null,_titleFlashTimer=null,_origTitle=document.title;
var _seenOrderIds={};var _pendingNewIds=[];var _wakeLockObj=null;
var _installEvt=null; // captured beforeinstallprompt
var _vibraTimer=null; // recurring vibration during alert
var _shaperCurve=null; // cached saturation curve

function getAudio(){if(!_audioCtx){try{_audioCtx=new(window.AudioContext||window.webkitAudioContext)()}catch(e){}}return _audioCtx}

// Saturation curve — adds rich harmonics → much louder perceived volume without clipping
function getShaperCurve(){
  if(_shaperCurve)return _shaperCurve;
  var n=2048,curve=new Float32Array(n),k=12;
  for(var i=0;i<n;i++){var x=i*2/n-1;curve[i]=(1+k)*x/(1+k*Math.abs(x))*0.95}
  _shaperCurve=curve;return curve;
}

// One bell strike: fundamental + inharmonic partials → warm food-service "ting"
function strikeBell(ctx,startAt,fundamental,velocity,decay,bus){
  var partials=[
    {ratio:1.000,amp:1.00},
    {ratio:2.000,amp:0.60},
    {ratio:2.760,amp:0.50},
    {ratio:5.400,amp:0.25},
    {ratio:8.930,amp:0.12}
  ];
  partials.forEach(function(p){
    var o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.value=fundamental*p.ratio;
    var peak=velocity*p.amp;
    var dec=decay*(1-Math.min(0.6,(p.ratio-1)*0.08));
    g.gain.setValueAtTime(0,startAt);
    g.gain.linearRampToValueAtTime(peak,startAt+0.006);
    g.gain.exponentialRampToValueAtTime(0.0001,startAt+dec);
    o.connect(g);g.connect(bus);
    o.start(startAt);o.stop(startAt+dec+0.05);
  });
}

// Quick noise burst at attack → percussive "transient" makes bell feel much louder
function noiseBurst(ctx,startAt,bus,duration,gain){
  var sr=ctx.sampleRate,frames=Math.floor(sr*duration);
  var buf=ctx.createBuffer(1,frames,sr);
  var data=buf.getChannelData(0);
  for(var i=0;i<frames;i++)data[i]=(Math.random()*2-1)*Math.exp(-i/frames*8);
  var src=ctx.createBufferSource();src.buffer=buf;
  var hp=ctx.createBiquadFilter();hp.type='highpass';hp.frequency.value=3000;
  var g=ctx.createGain();g.gain.value=gain;
  src.connect(hp);hp.connect(g);g.connect(bus);
  src.start(startAt);
}

function playAlert(urgent){
  if(!NPREF.sound)return;
  var ctx=getAudio();if(!ctx)return;
  if(ctx.state==='suspended')ctx.resume().catch(function(){});
  var t=ctx.currentTime;

  // Master chain: Compressor → optional WaveShaper saturation → LowPass → MasterGain → out
  var comp=ctx.createDynamicsCompressor();
  comp.threshold.value=-12;comp.knee.value=20;comp.ratio.value=6;
  comp.attack.value=0.003;comp.release.value=0.2;

  var preMaster;
  if(NPREF.loud){
    var shaper=ctx.createWaveShaper();shaper.curve=getShaperCurve();shaper.oversample='4x';
    comp.connect(shaper);preMaster=shaper;
  }else preMaster=comp;

  var lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=NPREF.loud?6000:5200;lp.Q.value=0.7;
  preMaster.connect(lp);

  var master=ctx.createGain();
  master.gain.value=urgent?(NPREF.loud?1.4:0.95):0.55;
  lp.connect(master);master.connect(ctx.destination);

  // Restaurant chime: G5 → C6 → G5 doorbell pattern
  var notes=urgent
    ? [{f:783.99,d:1.0,v:0.95,t:0.00},
       {f:1046.50,d:1.4,v:1.0,t:0.28},
       {f:783.99,d:1.6,v:0.90,t:0.80}]
    : [{f:880.00,d:0.9,v:0.7,t:0}];
  notes.forEach(function(n){
    strikeBell(ctx,t+n.t,n.f,n.v,n.d,comp);
    if(NPREF.loud&&urgent)noiseBurst(ctx,t+n.t,comp,0.05,0.35);
  });
}

// ─── SPEECH ───
function speak(text,lang){
  if(!NPREF.speak)return;
  if(!('speechSynthesis' in window))return;
  if(!text)return;
  try{
    speechSynthesis.cancel();
    var u=new SpeechSynthesisUtterance(text);
    u.rate=lang==='hi'?0.95:1.05;u.pitch=1.05;u.volume=1.0;
    var targetLang=lang==='hi'?'hi-IN':'en-IN';
    var prefix=targetLang.split('-')[0];
    u.lang=targetLang;
    var voices=speechSynthesis.getVoices();
    var v=voices.find(function(x){return x.lang===targetLang})
        ||voices.find(function(x){return x.lang.indexOf(prefix)===0});
    if(v)u.voice=v;
    speechSynthesis.speak(u);
  }catch(e){}
}

// ─── VIBRATION ───
function vibrate(urgent){
  if(!NPREF.vibrate)return;
  if(!navigator.vibrate)return;
  try{
    navigator.vibrate(urgent
      ? [500,100,500,100,500,100,800,150,500,100,500,100,500]
      : [300,100,300]);
  }catch(e){}
}
function startRecurringVibrate(){
  if(!NPREF.vibrate||!navigator.vibrate)return;
  if(_vibraTimer)return;
  _vibraTimer=setInterval(function(){
    var pending=allOrders.filter(function(o){return o.status==='new'&&isToday(o.dateKey)});
    if(!pending.length){stopRecurringVibrate();return}
    if(document.visibilityState==='visible'&&document.hasFocus())return;
    try{navigator.vibrate([300,80,300])}catch(e){}
  },4000);
}
function stopRecurringVibrate(){if(_vibraTimer){clearInterval(_vibraTimer);_vibraTimer=null}}

// ─── SCREEN FLASH ───
function flashScreen(){
  if(!NPREF.flash)return;
  var f=document.getElementById('alertFlash');
  if(!f){
    f=document.createElement('div');f.id='alertFlash';
    f.style.cssText='position:fixed;inset:0;background:rgba(220,38,38,.55);z-index:150;pointer-events:none;opacity:0;transition:opacity .15s';
    document.body.appendChild(f);
  }
  var n=0;
  var doFlash=function(){
    if(n>=4){f.style.opacity='0';return}
    f.style.opacity=(n%2===0)?'1':'0';
    n++;
    setTimeout(doFlash,180);
  };
  doFlash();
}

// ─── CONTINUOUS LOOP MODE ───
function startContinuousLoop(){
  if(!NPREF.loop)return;
  if(_loopTimer)return;
  _loopTimer=setInterval(function(){
    var pending=allOrders.filter(function(o){return o.status==='new'&&isToday(o.dateKey)});
    if(!pending.length){stopContinuousLoop();return}
    playAlert(true);vibrate(true);flashScreen();
  },5000);
}
function stopContinuousLoop(){if(_loopTimer){clearInterval(_loopTimer);_loopTimer=null}}
function fireBrowserNotif(title,body,tag){
  if(!NPREF.browserNotif)return;
  if(!('Notification' in window))return;
  if(Notification.permission!=='granted')return;
  // Skip if tab is currently focused — sound + vibrate is enough
  if(document.visibilityState==='visible'&&document.hasFocus())return;
  try{
    var n=new Notification(title,{body:body,tag:tag||'order',icon:'/icon-192.png',badge:'/icon-192.png',renotify:true,requireInteraction:true});
    n.onclick=function(){window.focus();this.close()};
  }catch(e){}
}
function flashTitle(count){
  if(_titleFlashTimer){clearInterval(_titleFlashTimer);_titleFlashTimer=null}
  if(!count){document.title=_origTitle;return}
  var alt=true;
  document.title='🔔 ('+count+') New order — '+_origTitle;
  _titleFlashTimer=setInterval(function(){
    if(document.visibilityState==='visible'){
      clearInterval(_titleFlashTimer);_titleFlashTimer=null;document.title=_origTitle;return;
    }
    document.title=alt?'🔔 ('+count+') New order!':'('+count+') StorePro';
    alt=!alt;
  },1500);
}
function alertNewOrders(newOrders){
  var n=newOrders.length;if(!n)return;
  var first=newOrders[0];
  var vars={name:safeName(first.name||(nLang()==='hi'?'ग्राहक':'Customer')),total:Math.round(first.total||0),count:n,phone:first.phone||'',shop:getCfg('ShopName','')||(STORE_META.shopname||'')};
  var lang=nLang();
  var titleTpl=n===1?nTpl('title1'):nTpl('titleN');
  var bodyTpl =n===1?nTpl('body1') :nTpl('bodyN');
  var speakTpl=n===1?nTpl('speak1'):nTpl('speakN');
  var bTitleTpl=n===1?nTpl('bannerTitle1'):nTpl('bannerTitleN');
  var bInfoTpl =n===1?nTpl('bannerInfo1') :nTpl('bannerInfoN');
  // Layers 1-4: chime, vibrate, flash, title
  playAlert(true);vibrate(true);flashScreen();flashTitle(n);
  // Layer 5: voice
  setTimeout(function(){speak(fillTpl(speakTpl,vars),lang)},900);
  // Layer 6: system notification
  fireBrowserNotif(fillTpl(titleTpl,vars),fillTpl(bodyTpl,vars),'new-order');
  // Layer 7: in-page banner
  showInPageBannerLocalized(fillTpl(bTitleTpl,vars),fillTpl(bInfoTpl,vars));
  // Layers 8-10: re-alerting
  startRepeatNudge();startRecurringVibrate();startContinuousLoop();
}
function safeName(s){var r='';s=String(s||'');for(var i=0;i<s.length&&r.length<40;i++){var c=s.charCodeAt(i);if((c>=48&&c<=57)||(c>=65&&c<=90)||(c>=97&&c<=122)||c===32||(c>=0x0900&&c<=0x097F))r+=s.charAt(i);else if(r.length&&r.charAt(r.length-1)!==' ')r+=' '}return r.trim()}
function startRepeatNudge(){
  if(!NPREF.repeat)return;
  if(_repeatTimer)return;
  _repeatTimer=setInterval(function(){
    var pending=allOrders.filter(function(o){return o.status==='new'&&isToday(o.dateKey)});
    if(!pending.length){stopRepeatNudge();return}
    if(document.visibilityState==='visible'&&document.hasFocus())return;
    playAlert(false);vibrate(false);
  },30000);
}
function stopRepeatNudge(){
  if(_repeatTimer){clearInterval(_repeatTimer);_repeatTimer=null}
  stopRecurringVibrate();
  stopContinuousLoop();
  try{if('speechSynthesis' in window)speechSynthesis.cancel()}catch(e){}
  flashTitle(0);
  var b=$('newOrderBanner');if(b)b.classList.remove('show');
}
function showInPageBanner(n,first){
  // Legacy English-only entry kept for backward compat
  var vars={name:first.name||'Customer',total:Math.round(first.total||0),count:n};
  showInPageBannerLocalized(fillTpl(n===1?nTpl('bannerTitle1'):nTpl('bannerTitleN'),vars),fillTpl(n===1?nTpl('bannerInfo1'):nTpl('bannerInfoN'),vars));
}
function showInPageBannerLocalized(title,info){
  var b=$('newOrderBanner');if(!b)return;
  $('nobCount').textContent=title;
  $('nobInfo').textContent=info;
  b.classList.add('show');
}
function ackBanner(){
  stopRepeatNudge();
  goPage('orders');
  setStatusFilter('new');
}

// ─── Wake Lock ───
function requestWakeLock(){
  if(!NPREF.wakeLock)return;
  if(!('wakeLock' in navigator))return;
  navigator.wakeLock.request('screen').then(function(lock){
    _wakeLockObj=lock;
    lock.addEventListener('release',function(){_wakeLockObj=null});
  }).catch(function(){});
}
function releaseWakeLock(){if(_wakeLockObj){_wakeLockObj.release().catch(function(){});_wakeLockObj=null}}
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){
    requestWakeLock();
    flashTitle(0);
  }
});

// ─── Notification permission ───
function requestNotifPermission(){
  if(!('Notification' in window))return;
  if(Notification.permission==='granted'||Notification.permission==='denied')return;
  Notification.requestPermission().then(function(p){
    if(p==='granted')showToast('🔔 Notifications enabled','success');
  }).catch(function(){});
}

// ─── PWA install ───
window.addEventListener('beforeinstallprompt',function(e){
  e.preventDefault();_installEvt=e;
  if(localStorage.getItem('sl_install_dismissed_v2'))return;
  var b=$('installBanner');if(b)b.classList.add('show');
});
function isStandalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true}
function isIOS(){return /iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream}
function maybeShowIOSInstall(){
  if(isStandalone())return;
  if(!isIOS())return;
  if(localStorage.getItem('sl_install_dismissed_v2'))return;
  $('installBanner').classList.add('show','ios');
  $('installBtn').textContent='How?';
}
function showInstallBanner(){
  if(isStandalone())return;
  if(localStorage.getItem('sl_install_dismissed_v2'))return;
  var b=$('installBanner');if(!b)return;
  b.classList.add('show');
  var btn=$('installBtn');if(btn)btn.textContent=_installEvt?'Install':isIOS()?'How?':'How?';
}
function clickInstall(){
  if(isStandalone()){showToast('✓ Already installed','success');return}
  if(_installEvt){
    _installEvt.prompt();
    _installEvt.userChoice.then(function(c){
      if(c.outcome==='accepted')showToast('📱 Installing...','success');
      _installEvt=null;
      $('installBanner').classList.remove('show');
      updateInstallMenuState();
    });
  }else if(isIOS()){
    alert('To install on iPhone:\n\n1. Tap the Share button (square with arrow) at the bottom of Safari\n2. Scroll down and tap "Add to Home Screen"\n3. Tap "Add" in the top right\n\nThe dashboard will appear like an app on your home screen!');
  }else{
    // Desktop Chrome / Edge: show URL-bar install hint
    if(/Chrome|Edg/.test(navigator.userAgent)){
      alert('To install:\n\n• Look for the install icon (⊕) in the address bar at the top right\n• Or open the browser menu (⋮) → "Install Dashboard"\n\nIf neither is visible, your browser may have already installed it, or it may need a few more seconds to detect this as an installable app.');
    }else{
      showToast('Open in Chrome/Safari/Edge to install','error');
    }
  }
}
function updateInstallMenuState(){
  var row=$('installMenuRow'),sub=$('installSub');if(!row||!sub)return;
  if(isStandalone()){sub.textContent='✓ Running as installed app';row.style.opacity='.6'}
  else if(_installEvt){sub.textContent='Tap to install on this device'}
  else if(isIOS()){sub.textContent='Tap for iOS install instructions'}
  else{sub.textContent='Add to home screen for instant access'}
}
window.addEventListener('appinstalled',function(){showToast('✅ Installed','success');var b=$('installBanner');if(b)b.classList.remove('show');updateInstallMenuState()});
function dismissInstall(){
  $('installBanner').classList.remove('show');
  try{localStorage.setItem('sl_install_dismissed_v2','1')}catch(e){}
}

// ════════════════════════════════════════════
// WEB PUSH — locked-phone alerts via Cloudflare Worker
// ════════════════════════════════════════════
function pushRelayUrl(){return PUSH_RELAY_URL||getCfg('PushRelayURL','')||getCfg('PushURL','')}
function vapidPubKey(){return VAPID_PUBLIC_KEY||getCfg('VapidPublicKey','')}
function pushStoreId(){return STORE_META.slug||(new URLSearchParams(location.search)).get('store')||''}
function pushAvailable(){
  return !!(pushRelayUrl()&&vapidPubKey()&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window);
}
function urlBase64ToUint8Array(b64){
  var pad='='.repeat((4-b64.length%4)%4);
  var s=(b64+pad).replace(/-/g,'+').replace(/_/g,'/');
  var raw=atob(s);var arr=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);
  return arr;
}
function getPushSubscription(){return navigator.serviceWorker.ready.then(function(reg){return reg.pushManager.getSubscription()})}
function enablePush(){
  if(!pushAvailable()){showToast('Web push not configured (admin needs to set up relay)','error');return Promise.resolve(false)}
  if(Notification.permission==='denied'){showToast('Browser blocked notifications','error');return Promise.resolve(false)}
  var step1=Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission();
  return step1.then(function(p){
    if(p!=='granted'){showToast('Permission needed','error');return false}
    return navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(existing){
        if(existing)return existing;
        return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(vapidPubKey())});
      });
    }).then(function(sub){
      return fetch(pushRelayUrl().replace(/\/$/,'')+'/subscribe',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({store:pushStoreId(),sub:sub.toJSON()})
      });
    }).then(function(res){
      if(!res.ok)throw new Error('relay '+res.status);
      try{localStorage.setItem('sl_push_enabled_'+pushStoreId(),'1')}catch(e){}
      showToast('🔔 Push enabled — works even when phone is locked','success');
      return true;
    }).catch(function(e){console.error('[Push]',e);showToast('Could not enable push: '+e.message,'error');return false});
  });
}
function disablePush(){
  return getPushSubscription().then(function(sub){
    if(!sub)return true;
    var ep=sub.endpoint;
    return sub.unsubscribe().then(function(){
      return fetch(pushRelayUrl().replace(/\/$/,'')+'/unsubscribe',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({store:pushStoreId(),endpoint:ep})
      }).catch(function(){});
    });
  }).then(function(){
    try{localStorage.removeItem('sl_push_enabled_'+pushStoreId())}catch(e){}
    showToast('Push disabled','success');return true;
  }).catch(function(){return false});
}
function pushStatus(){
  if(!pushAvailable())return Promise.resolve({available:false});
  return getPushSubscription().then(function(sub){return{available:true,subscribed:!!sub}}).catch(function(){return{available:true,subscribed:false}});
}
function testPush(){
  if(!pushAvailable()){showToast('Push not configured','error');return}
  fetch(pushRelayUrl().replace(/\/$/,'')+'/send',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({store:pushStoreId(),secret:getCfg('PushSecret',''),title:'🔔 Test push',body:'If you see this on a locked phone, it works!',data:{store:pushStoreId(),tag:'test'}})
  }).then(function(r){return r.json()}).then(function(j){
    if(j.sent>0)showToast('✓ Push sent to '+j.sent+' device'+(j.sent>1?'s':''),'success');
    else showToast('No subscriptions yet — enable push first','error');
  }).catch(function(e){showToast('Test failed: '+e.message,'error')});
}
function togglePush(){
  pushStatus().then(function(s){
    if(!s.available){showToast('Configure VAPID + Relay URL first','error');return}
    if(s.subscribed)disablePush().then(renderNotifSettings);
    else enablePush().then(renderNotifSettings);
  });
}
if(navigator.serviceWorker){
  navigator.serviceWorker.addEventListener('message',function(e){
    if(e.data&&e.data.type==='pushsubscriptionchange')enablePush();
  });
}

function openNotifSettings(){renderNotifSettings();$('notifSheet').classList.add('open')}

// ─── Per-tenant manifest refinement (initial manifest set inline in HTML head;
// once we know the real ShopName from Config, we replace it for nicer install UX) ───
function injectTenantManifest(){
  try{
    var slug=STORE_META.slug||(new URLSearchParams(location.search)).get('store')||'';
    var shop=getCfg('ShopName','')||STORE_META.shopname||'';
    if(!shop)return; // nothing better than what HTML head already set
    var manifest={
      name:shop+' — Dashboard',
      short_name:(shop.split(' ')[0]||'StorePro').slice(0,12),
      description:'Manage orders, menu and customers for '+shop,
      start_url:location.pathname+(slug?'?store='+encodeURIComponent(slug):''),
      scope:'/',
      display:'standalone',
      background_color:'#0c831f',
      theme_color:'#0c831f',
      orientation:'portrait',
      icons:[
        {src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},
        {src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}
      ]
    };
    var blob=new Blob([JSON.stringify(manifest)],{type:'application/manifest+json'});
    var url=URL.createObjectURL(blob);
    var link=document.querySelector('link[rel=manifest]');
    if(!link){link=document.createElement('link');link.rel='manifest';document.head.appendChild(link)}
    // Revoke old blob URL to avoid memory leak
    var oldHref=link.href;
    link.href=url;
    if(oldHref&&oldHref.indexOf('blob:')===0){try{URL.revokeObjectURL(oldHref)}catch(e){}}
  }catch(e){console.warn('manifest refine failed',e)}
}

function $(i){return document.getElementById(i)}
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
// JS string escape — for embedding values inside inline onclick="fn('...')"
function jss(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'').replace(/</g,'\\u003c')}
function fmt(n){return '₹'+Number(n||0).toLocaleString('en-IN')}
function showToast(msg,type){var t=$('toast');t.textContent=msg;t.className='toast show '+(type||'');setTimeout(function(){t.className='toast '+(type||'')},2400)}
// Global error logger — surface any silent failures
window.addEventListener('error',function(e){console.error('[Dashboard2]',e.message,'at',e.filename+':'+e.lineno)});

// ════════════════════════════════════════════
// PIN LOCK
// ════════════════════════════════════════════
function pinNext(el,n){var v=el.value.replace(/\D/g,'');el.value=v;if(!v)return;if(n>0&&n<=4)$('p'+n).focus();else checkPin()}
function pinBack(e,i){if(e.key==='Backspace'&&!$('p'+(i+1)).value&&i>0)$('p'+i).focus()}
function checkPin(){
  var entered=$('p1').value+$('p2').value+$('p3').value+$('p4').value;
  if(entered.length<4){pinShake('Enter all 4 digits');return}
  // Always resolve the store first — SHEET_ID must be set before unlock,
  // otherwise loadOrdersSheet/loadProductsSheet skip with empty sheetId.
  var doCheck=function(){
    if(!SHEET_ID){pinShake('Store not found — check URL');return}
    var pin=getCfg('DashboardPIN','1234');
    var savedPin=localStorage.getItem('sl_pin_'+SHEET_ID);
    if(entered===pin||(savedPin&&savedPin===entered)){
      try{localStorage.setItem('sl_pin_'+SHEET_ID,entered)}catch(e){}
      unlock();
    }else{
      pinShake('Incorrect PIN');
    }
  };
  if(SHEET_ID&&configData.length){doCheck();return}
  initStore(doCheck);
}
function pinShake(msg){
  $('pinErr').textContent=msg;
  ['p1','p2','p3','p4'].forEach(function(id){$(id).classList.add('shake');$(id).value=''});
  setTimeout(function(){['p1','p2','p3','p4'].forEach(function(id){$(id).classList.remove('shake')});$('p1').focus()},400);
}
function unlock(){
  $('lockScr').classList.add('hidden');
  $('app').style.display='block';
  $('bnav').style.display='flex';
  $('pinErr').textContent='';
  bootstrap();
  // Prime audio + vibration synchronously while we still have the user-gesture token
  primeAudioVibrate();
  // Notification + wake-lock require user gesture (PIN tap counts)
  setTimeout(function(){
    requestNotifPermission();
    requestWakeLock();
    showInstallBanner();
    updateInstallMenuState();
  },1500);
}
function primeAudioVibrate(){
  try{
    var ctx=getAudio();
    if(ctx&&ctx.state==='suspended')ctx.resume().catch(function(){});
    if(ctx){
      var o=ctx.createOscillator(),g=ctx.createGain();
      g.gain.value=0.0001;o.connect(g);g.connect(ctx.destination);
      o.start();o.stop(ctx.currentTime+0.02);
    }
  }catch(e){}
  try{if(navigator.vibrate)navigator.vibrate(1)}catch(e){}
}
function lockNow(){
  try{localStorage.removeItem('sl_pin_'+SHEET_ID)}catch(e){}
  location.reload();
}

// ════════════════════════════════════════════
// JSONP LOADER (Google Sheets gviz)
// ════════════════════════════════════════════
function loadSheet(sheetId,name,cb){
  if(!sheetId){console.warn('[Dashboard2] loadSheet skipped: empty sheetId for',name);cb(null);return}
  if(!window.google)window.google={};
  if(!window.google.visualization)window.google.visualization={};
  if(!window.google.visualization.Query)window.google.visualization.Query={};
  var fired=false;
  window.google.visualization.Query.setResponse=function(r){if(fired)return;fired=true;cb(r)};
  var s=document.createElement('script');
  s.src='https://docs.google.com/spreadsheets/d/'+sheetId+'/gviz/tq?tqx=out:json&sheet='+encodeURIComponent(name)+'&_t='+Date.now();
  s.onerror=function(){if(fired)return;fired=true;cb(null)};
  document.body.appendChild(s);
  setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s);if(!fired){fired=true;cb(null)}},8000);
}
function parseSheetRows(r){
  if(!r||!r.table)return{headers:[],rows:[]};
  var cols=r.table.cols||[],allRows=r.table.rows||[];
  if(!allRows.length)return{headers:[],rows:[]};
  var headers=[],dataRows=allRows;
  var colLabels=cols.map(function(c){return(c.label||'').trim()});
  var firstRaw=colLabels[0]||'';
  var isMerged=(!firstRaw)||(firstRaw.split(/\s+/).length>3);
  if(!isMerged&&colLabels.filter(function(l){return l}).length>1){
    headers=colLabels;
  }else{
    var hRow=allRows[0];
    if(hRow&&hRow.c){
      for(var h=0;h<hRow.c.length;h++){
        var hc=hRow.c[h],hv='';
        if(hc){if(hc.v!=null)hv=String(hc.v).trim();else if(hc.f!=null)hv=String(hc.f).trim()}
        headers.push(hv);
      }
    }
    dataRows=allRows.slice(1);
  }
  var parsed=[];
  dataRows.forEach(function(row){
    var o={};
    headers.forEach(function(h,i){
      var c=row.c&&row.c[i],v='';
      if(c){if(c.f!=null)v=String(c.f).trim();else if(c.v!=null)v=String(c.v).trim()}
      var key=h.toLowerCase().replace(/\s+/g,'');
      if(key)o[key]=v;
    });
    parsed.push(o);
  });
  return{headers:headers,rows:parsed};
}
function sendCmd(params,cb){
  if(!SCRIPT_URL){if(cb)cb();return}
  var img=new Image(),done=false;
  img.onload=img.onerror=function(){if(!done){done=true;if(cb)cb()}};
  img.src=SCRIPT_URL+'?'+params;
  setTimeout(function(){if(!done){done=true;if(cb)cb()}},5500);
}

// ════════════════════════════════════════════
// STORE RESOLUTION (slug → SheetID via master)
// ════════════════════════════════════════════
function resolveStore(cb){
  var p=new URLSearchParams(location.search);
  if(p.get('shop')){
    SHEET_ID=p.get('shop');SCRIPT_URL=p.get('script')||'';
    cb();return;
  }
  var slug=(p.get('store')||'demo').toLowerCase();
  loadSheet(MASTER_SHEET_ID,'Stores',function(r){
    if(!r){cb();return}
    var parsed=parseSheetRows(r);
    var found=parsed.rows.find(function(o){return(o.slug||'').toLowerCase()===slug});
    if(found){
      STORE_META=found;
      SHEET_ID=found.sheetid||'';
      SCRIPT_URL=found.scripturl||found.script||'';
    }
    cb();
  });
}

// ════════════════════════════════════════════
// CONFIG HELPERS
// ════════════════════════════════════════════
function getCfg(key,def){
  if(!configData.length)return def||'';
  var k=key.toLowerCase().replace(/\s+/g,'');
  for(var i=0;i<configData.length;i++){
    if(configData[i].key.toLowerCase().replace(/\s+/g,'')===k)return configData[i].value;
  }
  return def||'';
}
function loadConfigSheet(cb){
  loadSheet(SHEET_ID,'Config',function(r){
    if(!r){if(cb)cb();return}
    var parsed=parseSheetRows(r);
    configData=parsed.rows.map(function(o){
      var keys=Object.keys(o);
      return{key:o[keys[0]]||'',value:o[keys[1]]||''};
    }).filter(function(c){return c.key});
    if(!SCRIPT_URL){
      var sc=getCfg('OrderScript','')||getCfg('ScriptURL','');
      if(sc)SCRIPT_URL=sc;
    }
    if(cb)cb();
  });
}
function initStore(cb){
  resolveStore(function(){
    if(!SHEET_ID){showToast('Store not found in registry','error');if(cb)cb();return}
    loadConfigSheet(cb);
  });
}

// ════════════════════════════════════════════
// BOOTSTRAP (after unlock)
// ════════════════════════════════════════════
function bootstrap(){
  // Theme
  try{var t=localStorage.getItem('sl_theme_v2');if(t==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}
  injectTenantManifest();
  paintHeader();
  paintProfile();
  buildDateFilters();
  buildStatusFilters();
  // Sequential — loadSheet uses a shared JSONP global callback, parallel calls clobber each other
  loadOrdersSheet(function(){
    paintHome();
    renderOrders();
    paintInsights();
    loadProductsSheet(function(){renderProducts();buildCatFilters()});
  });
  // Auto-refresh orders every 25s while on Home/Orders
  pollInterval=setInterval(function(){
    if(currentPage==='home'||currentPage==='orders'){silentRefreshOrders()}
  },25000);
}

function paintHeader(){
  var name=getCfg('ShopName','')||STORE_META.shopname||'My Store';
  var owner=STORE_META.ownername||'';
  var plan=(STORE_META.plan||'Free').toUpperCase();
  var open=isStoreOpen();
  // Cache shop name + type + brand color + logo for instant personalization next visit
  // (splash screen and PWA manifest both read from these)
  try{
    var slug=(STORE_META.slug||(new URLSearchParams(location.search)).get('store')||'').toLowerCase();
    if(slug){
      localStorage.setItem('sl_shopname_'+slug,name);
      var stype=STORE_META.shoptype||getCfg('ShopType','');
      if(stype)localStorage.setItem('sl_shoptype_'+slug,stype);
      var bc=getCfg('BrandColor','');
      if(/^#[0-9a-f]{6}$/i.test(bc))localStorage.setItem('sl_brand_'+slug,bc);
      var logoUrl=getCfg('LogoURL','')||getCfg('Logo','')||getCfg('AppIcon','');
      if(logoUrl)localStorage.setItem('sl_logo_'+slug,logoUrl);
    }
  }catch(e){}
  $('hShopName').textContent=name;
  $('hAvatar').textContent=name.charAt(0).toUpperCase()||'🏬';
  $('hPlanPill').textContent=plan;
  $('hStatusDot').className='dot '+(open?'dot-on':'dot-off');
  $('hStatusTxt').textContent=open?'Open now':'Closed';
  $('qaOpenIc').textContent=open?'⏸️':'▶️';
  $('qaOpenLb').textContent=open?'Pause Store':'Open Store';
  // Plan banner if expiring
  var exp=STORE_META.planexpiry||'';
  $('planBanner').innerHTML='';
  if(exp&&plan!=='FREE'){
    var d=new Date(exp);
    if(!isNaN(d)){
      var days=Math.ceil((d-Date.now())/86400000);
      if(days<0){$('planBanner').innerHTML='<div class="plan-banner expired"><div class="plan-banner-ic">⚠️</div><div class="plan-banner-info"><div class="plan-banner-title">Plan expired</div><div class="plan-banner-sub">Renew to unlock all features</div></div><button class="plan-banner-btn" onclick="contactSupport()">Renew</button></div>'}
      else if(days<=7){$('planBanner').innerHTML='<div class="plan-banner"><div class="plan-banner-ic">⏰</div><div class="plan-banner-info"><div class="plan-banner-title">Plan expires in '+days+' day'+(days===1?'':'s')+'</div><div class="plan-banner-sub">Renew now to avoid downtime</div></div><button class="plan-banner-btn" onclick="contactSupport()">Renew</button></div>'}
    }
  }
}
function isStoreOpen(){
  var s=getCfg('StoreOpen','yes').toLowerCase();
  return s==='yes'||s==='true'||s==='open'||s==='1';
}
function toggleStoreOpen(){
  var newVal=isStoreOpen()?'no':'yes';
  // Update locally first
  var found=false;
  configData.forEach(function(c){if(c.key.toLowerCase().replace(/\s+/g,'')==='storeopen'){c.value=newVal;found=true}});
  if(!found)configData.push({key:'StoreOpen',value:newVal});
  paintHeader();
  showToast(newVal==='yes'?'✅ Store reopened':'⏸️ Store paused','success');
  sendCmd('action=updateConfig&key=StoreOpen&value='+encodeURIComponent(newVal));
}

// ════════════════════════════════════════════
// PROFILE PAGE (data from MASTER REGISTRY)
// ════════════════════════════════════════════
function paintProfile(){
  var m=STORE_META;
  var shop=getCfg('ShopName','')||m.shopname||'My Store';
  var owner=m.ownername||'—';
  var phone=m.ownerphone||getCfg('Phone','')||'—';
  var plan=(m.plan||'Free');
  var expiry=m.planexpiry||'—';
  var city=m.city||getCfg('City','')||'—';
  var stype=m.shoptype||getCfg('ShopType','')||'Store';
  var slug=m.slug||'—';
  var url=m.url||'';
  var dashUrl=m.dashboardurl||location.href.split('?')[0]+'?store='+slug;
  var sheetUrl='https://docs.google.com/spreadsheets/d/'+SHEET_ID;
  var active=(m.active||'Yes').toLowerCase()==='yes';

  var html='';
  html+='<div class="profile-hero">';
  html+='<div class="profile-avatar">'+esc(shop.charAt(0).toUpperCase())+'</div>';
  html+='<div class="profile-name">'+esc(shop)+'</div>';
  html+='<div class="profile-tag">'+esc(stype)+(city!=='—'?' · '+esc(city):'')+' · '+esc(plan)+' Plan</div>';
  html+='</div>';

  html+='<div class="sec-title"><h2>Account</h2></div>';
  html+='<div class="card detail-list">';
  html+=detailRow('👤','Owner Name',owner);
  html+=detailRow('📞','Phone',phone, phone!=='—'?'<a class="detail-action" href="tel:'+esc(phone)+'">Call</a>':'');
  html+=detailRow('🏷️','Slug',slug);
  html+=detailRow('💎','Plan',plan+(expiry&&expiry!=='—'?' · expires '+expiry:''));
  html+=detailRow('🟢','Status',active?'Active':'Inactive');
  html+='</div>';

  html+='<div class="sec-title"><h2>Links</h2></div>';
  html+='<div class="card detail-list">';
  html+=detailRow('🛒','Customer Store URL',url||'—',url?'<button class="detail-action" onclick="copyText(\''+jss(url)+'\')">Copy</button>':'');
  html+=detailRow('🎛️','Dashboard URL',dashUrl,'<button class="detail-action" onclick="copyText(\''+jss(dashUrl)+'\')">Copy</button>');
  html+=detailRow('📋','Google Sheet','docs.google.com/...','<button class="detail-action" onclick="window.open(\''+jss(sheetUrl)+'\',\'_blank\')">Open</button>');
  html+='</div>';

  $('profileBlock').innerHTML=html;
}
function detailRow(ic,label,val,action){
  return '<div class="detail-row"><div class="detail-ic">'+ic+'</div><div class="detail-text"><div class="detail-label">'+esc(label)+'</div><div class="detail-value">'+esc(val)+'</div></div>'+(action||'')+'</div>';
}
function copyText(t){navigator.clipboard.writeText(t).then(function(){showToast('✓ Copied','success')}).catch(function(){showToast('Could not copy','error')})}
function openSheet(){window.open('https://docs.google.com/spreadsheets/d/'+SHEET_ID,'_blank')}
function openStorefront(){var u=STORE_META.url||(location.origin+'/?store='+(STORE_META.slug||''));window.open(u,'_blank')}
function openShareStore(){
  var u=STORE_META.url||(location.origin+'/?store='+(STORE_META.slug||''));
  var name=getCfg('ShopName','My Store');
  var msg=name+' is now online! 🎉\n\nOrder anytime at:\n'+u+'\n\nThanks for your support!';
  if(navigator.share){
    navigator.share({title:name,text:msg,url:u}).catch(function(){})
  }else{
    window.open('https://wa.me/?text='+encodeURIComponent(msg),'_blank');
  }
}
function contactSupport(){window.open('https://wa.me/919760684971?text='+encodeURIComponent('Hi, I want to renew my StorePro plan for '+(STORE_META.shopname||'my store')),'_blank')}

// ════════════════════════════════════════════
// ORDERS LOADING / RENDERING
// ════════════════════════════════════════════
function loadOrdersSheet(cb){
  $('rIcon').innerHTML='<span style="display:inline-block;animation:spin .6s linear infinite">↻</span>';
  loadSheet(SHEET_ID,'Orders',function(r){
    $('rIcon').textContent='↻';
    if(!r){if(cb)cb();return}
    var parsed=parseSheetRows(r);
    if(!parsed.rows.length&&r.table.rows.length>1){
      // Failsafe: first row as headers
      var rawH=[];var hRow=r.table.rows[0];
      if(hRow&&hRow.c){for(var h=0;h<hRow.c.length;h++){var hc=hRow.c[h],hv='';if(hc){if(hc.v!=null)hv=String(hc.v).trim();else if(hc.f!=null)hv=String(hc.f).trim()}rawH.push(hv)}}
      var rows=[];
      for(var ri=1;ri<r.table.rows.length;ri++){
        var row=r.table.rows[ri],o={};
        rawH.forEach(function(hd,i){var c=row.c&&row.c[i],v='';if(c){if(c.f!=null)v=String(c.f).trim();else if(c.v!=null)v=String(c.v).trim()}var key=hd.toLowerCase().replace(/\s+/g,'');if(key)o[key]=v});
        rows.push(o);
      }
      parsed={headers:rawH,rows:rows};
    }
    allOrders=parsed.rows.map(function(o){
      return{
        id:o.orderid||'',
        date:o['date&time']||o.datetime||o.date||'',
        dateKey:parseDateKey(o['date&time']||o.datetime||o.date||''),
        ts:parseTs(o['date&time']||o.datetime||o.date||''),
        mode:(o.mode||'').toLowerCase(),
        name:o.customername||o.name||'',
        phone:o.phone||'',
        email:o.email||'',
        address:o.address||'',
        items:o.items||'',
        total:parseFloat(o['total(₹)']||o.total||'0')||0,
        status:(o.status||'new').toLowerCase().trim(),
        comment:o.shopkeepercomment||o.comment||'',
        notes:o.ordernotes||o.notes||'',
        payment:o.payment||''
      };
    }).filter(function(o){return o.id});
    // Detect newly arrived NEW orders (today, status=new, not seen before)
    var todayNew=allOrders.filter(function(o){return o.status==='new'&&isToday(o.dateKey)});
    var freshlyArrived=[];
    todayNew.forEach(function(o){if(!_seenOrderIds[o.id]){_seenOrderIds[o.id]=1;if(prevNewCount>=0)freshlyArrived.push(o)}});
    if(freshlyArrived.length)alertNewOrders(freshlyArrived);
    // If no new orders left at all, stop the repeating nudge
    if(!todayNew.length)stopRepeatNudge();
    prevNewCount=todayNew.length;
    paintHome();
    renderOrders();
    updateBadges();
    if(cb)cb();
  });
}
function silentRefreshOrders(){loadOrdersSheet()}
function refreshAll(){loadConfigSheet(function(){paintHeader();paintProfile();loadOrdersSheet(function(){paintHome();paintInsights();renderOrders();loadProductsSheet(function(){renderProducts()})})})}

function parseDateKey(ds){
  if(!ds)return null;
  var p=ds.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(p)return p[3]+'-'+p[2].padStart(2,'0')+'-'+p[1].padStart(2,'0');
  var d=new Date(ds);
  if(!isNaN(d))return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  return null;
}
function parseTs(ds){
  if(!ds)return 0;
  var p=ds.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):?(\d{2})?\s*(am|pm)?/i);
  if(p){var h=parseInt(p[4]),m=parseInt(p[5]);if(p[7]){if(p[7].toLowerCase()==='pm'&&h!==12)h+=12;if(p[7].toLowerCase()==='am'&&h===12)h=0}return new Date(p[3],p[2]-1,p[1],h,m,p[6]?parseInt(p[6]):0).getTime()}
  var d=new Date(ds);return isNaN(d)?0:d.getTime();
}
function todayKey(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function isToday(k){return k===todayKey()}
function timeAgo(ts){if(!ts)return '';var diff=Math.floor((Date.now()-ts)/1000);if(diff<60)return 'now';if(diff<3600)return Math.floor(diff/60)+'m ago';if(diff<86400)return Math.floor(diff/3600)+'h ago';return Math.floor(diff/86400)+'d ago'}
function isDone(s){return s==='delivered'||s==='picked up'||s==='done'||s==='completed'}

function buildDateFilters(){
  var t=todayKey();
  var todayN=allOrders.filter(function(o){return o.dateKey===t}).length;
  var weekDates={};for(var i=0;i<7;i++){var d=new Date();d.setDate(d.getDate()-i);var ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');weekDates[ds]=true}
  var weekN=allOrders.filter(function(o){return weekDates[o.dateKey]}).length;
  var h='';
  h+='<button class="chip'+(activeDateFilter==='today'?' active':'')+'" onclick="setDateFilter(\'today\')">Today<b>'+todayN+'</b></button>';
  h+='<button class="chip'+(activeDateFilter==='week'?' active':'')+'" onclick="setDateFilter(\'week\')">7 Days<b>'+weekN+'</b></button>';
  h+='<button class="chip'+(activeDateFilter==='all'?' active':'')+'" onclick="setDateFilter(\'all\')">All<b>'+allOrders.length+'</b></button>';
  $('dateFilters').innerHTML=h;
}
function setDateFilter(f){activeDateFilter=f;buildDateFilters();renderOrders()}
function buildStatusFilters(){
  var stats=countByStatus();
  var h='';
  h+='<button class="chip'+(activeStatusFilter==='all'?' active':'')+'" onclick="setStatusFilter(\'all\')">All<b>'+stats.all+'</b></button>';
  h+='<button class="chip'+(activeStatusFilter==='new'?' active':'')+'" onclick="setStatusFilter(\'new\')">🟢 New<b>'+stats.new+'</b></button>';
  h+='<button class="chip'+(activeStatusFilter==='confirmed'?' active':'')+'" onclick="setStatusFilter(\'confirmed\')">🔵 Confirmed<b>'+stats.confirmed+'</b></button>';
  h+='<button class="chip'+(activeStatusFilter==='packed'?' active':'')+'" onclick="setStatusFilter(\'packed\')">🟠 Packed<b>'+stats.packed+'</b></button>';
  h+='<button class="chip'+(activeStatusFilter==='done'?' active':'')+'" onclick="setStatusFilter(\'done\')">⚪ Done<b>'+stats.done+'</b></button>';
  $('statusFilters').innerHTML=h;
}
function setStatusFilter(f){activeStatusFilter=f;buildStatusFilters();renderOrders()}
function countByStatus(){
  var s={all:0,new:0,confirmed:0,packed:0,done:0};
  filtered(true).forEach(function(o){s.all++;if(o.status==='new')s.new++;else if(o.status==='confirmed')s.confirmed++;else if(o.status==='packed'||o.status==='out for delivery'||o.status==='outfordelivery')s.packed++;else if(isDone(o.status))s.done++});
  return s;
}
function filtered(ignoreStatus){
  var t=todayKey(),list=allOrders;
  if(activeDateFilter==='today')list=list.filter(function(o){return o.dateKey===t});
  else if(activeDateFilter==='week'){var wd={};for(var i=0;i<7;i++){var d=new Date();d.setDate(d.getDate()-i);var ds=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');wd[ds]=true}list=list.filter(function(o){return wd[o.dateKey]})}
  if(!ignoreStatus&&activeStatusFilter!=='all'){
    if(activeStatusFilter==='new')list=list.filter(function(o){return o.status==='new'});
    else if(activeStatusFilter==='confirmed')list=list.filter(function(o){return o.status==='confirmed'});
    else if(activeStatusFilter==='packed')list=list.filter(function(o){return o.status==='packed'||o.status==='out for delivery'||o.status==='outfordelivery'});
    else if(activeStatusFilter==='done')list=list.filter(function(o){return isDone(o.status)});
  }
  var q=($('ordSearch').value||'').toLowerCase();
  if(q)list=list.filter(function(o){return(o.name+o.phone+o.id+o.items).toLowerCase().indexOf(q)>=0});
  list.sort(function(a,b){return b.ts-a.ts});
  return list;
}

function statusPill(s){
  if(s==='new')return '<span class="s-pill s-new">● New</span>';
  if(s==='confirmed')return '<span class="s-pill s-conf">● Confirmed</span>';
  if(s==='packed')return '<span class="s-pill s-pack">● Packed</span>';
  if(s==='out for delivery'||s==='outfordelivery')return '<span class="s-pill s-out">🛵 Out</span>';
  if(s==='cancelled')return '<span class="s-pill s-cancel">✕ Cancelled</span>';
  return '<span class="s-pill s-done">✓ Done</span>';
}
function modeIcon(m){return m==='delivery'?'<div class="o-mode o-mode-d">🛵</div>':'<div class="o-mode o-mode-p">🛍️</div>'}

function renderOrders(){
  var list=filtered(false);
  buildDateFilters();buildStatusFilters();
  if(!list.length){$('ordersList').innerHTML='<div class="empty"><div class="empty-emoji">📭</div>No orders found.</div>';return}
  $('ordersList').innerHTML=list.map(function(o){try{return orderHTML(o)}catch(e){console.error('[Dashboard2] orderHTML failed for',o.id,e);return ''}}).join('');
}

function orderHTML(o){
  var safeId=esc(o.id),safePhone=(o.phone||'').replace(/\D/g,'');
  var pulse=o.status==='new'&&isToday(o.dateKey)?' new-pulse new':'';
  var n=countItems(o.items);
  var itemTxt=n+' '+(n===1?'item':'items');
  var modeLbl=o.mode==='delivery'?'Delivery':'Pickup';
  var h='<div class="order'+pulse+'" id="ord_'+safeId+'">';
  h+='<div class="o-h" onclick="this.parentElement.classList.toggle(\'open\')">';
  h+='<div class="o-left">'+modeIcon(o.mode)+statusPill(o.status)+'</div>';
  h+='<div class="o-info">';
  h+='<div class="o-row1"><span class="o-name">'+esc(o.name||'Customer')+'</span><span class="o-amt-n">'+fmt(o.total)+'</span></div>';
  h+='<div class="o-row2"><span class="o-id">#'+safeId.slice(-6)+'</span><span class="o-dot">·</span><span>'+esc(modeLbl)+'</span><span class="o-dot">·</span><span>'+itemTxt+'</span><span class="o-ago">'+timeAgo(o.ts)+'</span></div>';
  h+='<div class="o-row3"><span>📞 '+esc(o.phone||'—')+'</span>'+(o.payment?'<span class="o-dot">·</span><span>💳 '+esc((o.payment+'').toUpperCase())+'</span>':'')+'</div>';
  h+='</div></div>';

  // Body
  h+='<div class="o-body">';
  if(o.items){h+='<div class="o-sec"><div class="o-sec-l">Items</div><div class="o-items">'+formatItems(o.items)+'</div></div>'}
  h+='<div class="o-sec"><div class="o-sec-l">Contact</div><div class="o-contact">';
  if(o.phone)h+='<span class="o-contact-chip">📞 '+esc(o.phone)+'</span>';
  if(o.email)h+='<span class="o-contact-chip">✉️ '+esc(o.email)+'</span>';
  if(!o.phone&&!o.email)h+='<span style="color:var(--ink4);font-size:11px">No contact info</span>';
  h+='</div></div>';
  if(o.address)h+='<div class="o-sec"><div class="o-sec-l">Delivery Address</div><div class="o-addr">📍 '+esc(o.address)+'</div></div>';
  if(o.notes)h+='<div class="bubble bubble-cust"><div class="bubble-l">📝 Customer Note</div>"'+esc(o.notes)+'"</div>';
  if(o.comment){o.comment.split(' | ').forEach(function(c){if(c.trim())h+='<div class="bubble bubble-shop"><div class="bubble-l">💬 You sent</div>'+esc(c.trim())+'</div>'})}

  // Actions
  h+='<div class="o-actions">';
  if(o.phone){
    h+='<button class="act act-wa" onclick="event.stopPropagation();waOpen(\''+safePhone+'\')">📱 WhatsApp</button>';
    h+='<button class="act act-call" onclick="event.stopPropagation();location.href=\'tel:+91'+safePhone+'\'">📞</button>';
  }
  h+='<button class="act act-eta" onclick="event.stopPropagation();openETA(\''+safeId+'\')">⏱ ETA</button>';
  h+='<button class="act act-msg" onclick="event.stopPropagation();openETA(\''+safeId+'\',true)">💬 Reply</button>';
  if(o.status==='new'){
    h+='<button class="act act-confirm" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Confirmed\')">✅ Confirm</button>';
    h+='<button class="act act-cancel" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Cancelled\')">✕ Cancel</button>';
  }else if(o.status==='confirmed'){
    h+='<button class="act act-pack" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Packed\')">📦 Packed</button>';
  }else if(o.status==='packed'){
    if(o.mode==='delivery')h+='<button class="act act-out" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Out for Delivery\')">🛵 Out for Delivery</button>';
    else h+='<button class="act act-done" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Picked Up\')">🏪 Picked Up</button>';
  }else if(o.status==='out for delivery'||o.status==='outfordelivery'){
    h+='<button class="act act-done" onclick="event.stopPropagation();updStatus(\''+safeId+'\',\'Delivered\')">✅ Delivered</button>';
  }
  h+='<button class="act act-print" onclick="event.stopPropagation();printReceipt(\''+safeId+'\')">🖨️</button>';
  h+='</div>';

  h+='</div></div>';
  return h;
}
function countItems(s){if(!s)return 0;return s.split(/\n|,(?=\s*\d+x\s)/).filter(function(x){return x.trim()}).length}
function formatItems(s){
  if(!s)return '<span style="color:var(--ink4)">No items</span>';
  var items=s.split(/\n|,(?=\s*\d+x\s)/).filter(function(x){return x.trim()});
  if(items.length<=1&&s.indexOf('=')<0)return '<div style="white-space:pre-wrap">'+esc(s)+'</div>';
  return items.map(function(item){
    item=item.trim();var p=item.split(/\s*=\s*/);
    return '<div class="o-item-row"><span class="o-item-name">'+esc(p[0]||item)+'</span>'+(p[1]?'<span class="o-item-price">'+esc(p[1])+'</span>':'')+'</div>';
  }).join('');
}
function waOpen(phone){if(phone.length===10)phone='91'+phone;window.open('https://wa.me/'+phone,'_blank')}
function updStatus(id,newStatus){
  if(newStatus==='Cancelled'&&!confirm('Cancel this order? Customer will be notified.'))return;
  var o=allOrders.find(function(x){return x.id===id});if(!o)return;
  o.status=newStatus.toLowerCase();
  renderOrders();updateBadges();
  showToast('✓ Status: '+newStatus,'success');
  sendCmd('action=updateStatus&orderId='+encodeURIComponent(id)+'&newStatus='+encodeURIComponent(newStatus));
  // Auto-prompt to send WhatsApp update
  if(o.phone&&newStatus!=='Cancelled'){
    setTimeout(function(){
      var msgs={'Confirmed':'Hi '+o.name+', your order *#'+id.slice(-6)+'* is *confirmed* ✅ Preparing it now!','Packed':'Hi '+o.name+', your order *#'+id.slice(-6)+'* is *packed* 📦 and ready!','Out for Delivery':'Hi '+o.name+', your order *#'+id.slice(-6)+'* is *out for delivery* 🛵','Delivered':'Hi '+o.name+', your order *#'+id.slice(-6)+'* has been *delivered* ✅ Thanks for choosing us!','Picked Up':'Thanks '+o.name+'! Your order *#'+id.slice(-6)+'* is picked up. Visit again! 🙏'};
      var msg=msgs[newStatus];
      if(msg&&confirm('Notify customer on WhatsApp?\n\n"'+msg+'"')){
        var p=o.phone.replace(/\D/g,'');if(p.length===10)p='91'+p;
        window.open('https://wa.me/'+p+'?text='+encodeURIComponent(msg),'_blank');
      }
    },300);
  }
  setTimeout(loadOrdersSheet,2500);
}

// ════════════════════════════════════════════
// ETA / QUICK REPLY SHEET
// ════════════════════════════════════════════
function openETA(orderId,messageMode){
  _etaOrderId=orderId;
  var o=allOrders.find(function(x){return x.id===orderId});
  if(!o){showToast('Order not found','error');return}
  $('etaSub').textContent=(messageMode?'Quick reply to ':'Send ETA to ')+(o.name||'Customer')+' · #'+orderId.slice(-6);
  $('etaText').value='';$('etaCustom').value='';
  $('etaSheet').classList.add('open');
}
function closeSheet(id){$(id).classList.remove('open')}
function quickETA(mins,customMsg){
  var o=allOrders.find(function(x){return x.id===_etaOrderId});if(!o)return;
  var msg;
  if(customMsg)msg=customMsg;
  else if(mins===0)msg='Your order is *ready now*! Please collect at the counter ✅';
  else{
    var when=new Date(Date.now()+mins*60000).toLocaleTimeString('en-IN',{hour:'numeric',minute:'2-digit',hour12:true});
    msg='Hi '+o.name+', your order *#'+_etaOrderId.slice(-6)+'* will be ready in *'+mins+' minutes* (around '+when+') ⏱';
  }
  $('etaText').value=msg;
  sendETA(true);
}
function customETA(){
  var v=parseInt($('etaCustom').value);
  if(!v||v<1){showToast('Enter minutes','error');return}
  quickETA(v);
}
function setReply(t){$('etaText').value=t;$('etaText').focus()}
function sendETA(sendWA){
  var msg=$('etaText').value.trim();
  if(!msg){showToast('Type a message','error');return}
  var o=allOrders.find(function(x){return x.id===_etaOrderId});if(!o)return;
  o.comment=(o.comment?o.comment+' | ':'')+msg;
  renderOrders();
  closeSheet('etaSheet');
  showToast('✓ Sent to customer','success');
  sendCmd('action=updateStatus&orderId='+encodeURIComponent(_etaOrderId)+'&comment='+encodeURIComponent(msg));
  if(sendWA&&o.phone){
    var p=o.phone.replace(/\D/g,'');if(p.length===10)p='91'+p;
    var shop=getCfg('ShopName','Our Store');
    var fullMsg=msg+'\n\n— '+shop;
    window.open('https://wa.me/'+p+'?text='+encodeURIComponent(fullMsg),'_blank');
  }
  setTimeout(loadOrdersSheet,2500);
}

// ════════════════════════════════════════════
// HOME PAINTING (today snapshot, recent orders)
// ════════════════════════════════════════════
function paintHome(){
  var t=todayKey(),y=new Date();y.setDate(y.getDate()-1);var yk=y.getFullYear()+'-'+String(y.getMonth()+1).padStart(2,'0')+'-'+String(y.getDate()).padStart(2,'0');
  var todayOrd=allOrders.filter(function(o){return o.dateKey===t&&o.status!=='cancelled'});
  var yesOrd=allOrders.filter(function(o){return o.dateKey===yk&&o.status!=='cancelled'});
  var todayRev=todayOrd.reduce(function(s,o){return s+o.total},0);
  var yesRev=yesOrd.reduce(function(s,o){return s+o.total},0);
  var newCt=todayOrd.filter(function(o){return o.status==='new'}).length;
  var pending=todayOrd.filter(function(o){return o.status==='new'||o.status==='confirmed'||o.status==='packed'}).length;
  var done=todayOrd.filter(function(o){return isDone(o.status)}).length;
  var custSet={};todayOrd.forEach(function(o){if(o.phone)custSet[o.phone]=1});
  var aov=todayOrd.length?todayRev/todayOrd.length:0;

  $('heroRev').textContent=fmt(todayRev);
  $('heroNew').textContent=newCt;
  $('heroOrders').textContent=todayOrd.length+' total today';

  if(yesRev>0){
    var pct=((todayRev-yesRev)/yesRev*100);
    $('heroDelta').innerHTML=(pct>=0?'<span class="delta-up">▲ ':'<span class="delta-down">▼ ')+Math.abs(Math.round(pct))+'% vs yest</span>';
  }else{
    $('heroDelta').textContent=todayRev>0?'First sales today!':'Awaiting first order';
  }
  $('kpiAov').textContent=fmt(Math.round(aov));
  $('kpiAovD').textContent=todayOrd.length+' orders';
  $('kpiPending').textContent=pending;
  $('kpiDone').textContent=done;
  $('kpiCust').textContent=Object.keys(custSet).length;

  // Recent orders preview (top 3 today, prioritise pending)
  var recent=todayOrd.slice().sort(function(a,b){
    var pri={new:0,confirmed:1,packed:2};
    var pa=pri[a.status]==null?9:pri[a.status];
    var pb=pri[b.status]==null?9:pri[b.status];
    if(pa!==pb)return pa-pb;
    return b.ts-a.ts;
  }).slice(0,3);
  if(recent.length){
    $('recentOrders').innerHTML=recent.map(orderHTML).join('');
  }else{
    $('recentOrders').innerHTML='<div class="empty"><div class="empty-emoji">☕</div>No orders today yet.<br>Share your store link to get started!</div>';
  }
  updateBadges();
}
function updateBadges(){
  var newCt=allOrders.filter(function(o){return o.status==='new'&&isToday(o.dateKey)}).length;
  var b=$('bnavOrdN');
  if(newCt>0){b.textContent=newCt>9?'9+':newCt;b.classList.add('show')}
  else b.classList.remove('show');
}

// ════════════════════════════════════════════
// INSIGHTS
// ════════════════════════════════════════════
function paintInsights(){
  var days=[];
  for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);days.push({key:d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'),lbl:['S','M','T','W','T','F','S'][d.getDay()],rev:0,ord:0})}
  var prev7=[];for(var i=13;i>=7;i--){var d=new Date();d.setDate(d.getDate()-i);prev7.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'))}
  var totalRev=0,totalOrd=0,prevRev=0,prevOrd=0;
  var prodMap={},custMap={},hourMap={};
  for(var h=0;h<24;h++)hourMap[h]=0;

  allOrders.forEach(function(o){
    if(o.status==='cancelled')return;
    var dayIdx=days.findIndex(function(d){return d.key===o.dateKey});
    if(dayIdx>=0){days[dayIdx].rev+=o.total;days[dayIdx].ord++;totalRev+=o.total;totalOrd++;
      // Hour
      if(o.ts){var hr=new Date(o.ts).getHours();hourMap[hr]=(hourMap[hr]||0)+1}
      // Products
      if(o.items)o.items.split(/\n|,(?=\s*\d+x\s)/).forEach(function(it){var name=it.split('=')[0].replace(/^\s*\d+x\s*/i,'').trim();if(name){prodMap[name]=(prodMap[name]||0)+1}});
      // Customers
      if(o.phone){if(!custMap[o.phone])custMap[o.phone]={name:o.name,phone:o.phone,orders:0,spent:0};custMap[o.phone].orders++;custMap[o.phone].spent+=o.total}
    }
    if(prev7.indexOf(o.dateKey)>=0){prevRev+=o.total;prevOrd++}
  });

  $('ins7Rev').textContent=fmt(totalRev);
  $('ins7Ord').textContent=totalOrd;
  if(prevRev){var pct=Math.round((totalRev-prevRev)/prevRev*100);$('ins7Delta').innerHTML=(pct>=0?'<span class="up">▲ ':'<span class="down">▼ ')+Math.abs(pct)+'% vs prev week</span>'}else $('ins7Delta').textContent='—';
  if(prevOrd){var pct=Math.round((totalOrd-prevOrd)/prevOrd*100);$('ins7OrdD').innerHTML=(pct>=0?'<span class="up">▲ ':'<span class="down">▼ ')+Math.abs(pct)+'% vs prev week</span>'}else $('ins7OrdD').textContent='—';
  $('insAov').textContent=fmt(totalOrd?Math.round(totalRev/totalOrd):0);
  // Repeat rate
  var multi=0,uniq=Object.keys(custMap).length;
  Object.values(custMap).forEach(function(c){if(c.orders>1)multi++});
  $('insRepeat').textContent=uniq?Math.round(multi/uniq*100)+'%':'0%';

  // Bar chart 7 days — chart area is 124px tall (160px container - 18px top - 22px bottom for label/baseline)
  var CHART_H=124;
  var maxR=Math.max.apply(null,days.map(function(d){return d.rev}))||1;
  $('barChart').innerHTML=days.map(function(d){
    var px=d.rev?Math.max(20,Math.round(d.rev/maxR*CHART_H)):0;
    var bar=d.rev
      ? '<div class="bar" style="height:'+px+'px"><div class="bar-val">₹'+(d.rev>=1000?(d.rev/1000).toFixed(d.rev>=10000?0:1).replace(/\.0$/,'')+'k':d.rev)+'</div></div>'
      : '<div class="bar empty"></div>';
    return '<div class="bar-col">'+bar+'<div class="bar-lbl">'+d.lbl+'</div></div>';
  }).join('');

  // Hour chart — same height system, purple gradient
  var maxH=Math.max.apply(null,Object.values(hourMap))||1;
  var hourHTML='';
  for(var hr=8;hr<=22;hr++){
    var c=hourMap[hr]||0;
    var px=c?Math.max(20,Math.round(c/maxH*CHART_H)):0;
    var bar=c
      ? '<div class="bar" style="height:'+px+'px;background:linear-gradient(180deg,var(--purple),#8b5cf6)"><div class="bar-val">'+c+'</div></div>'
      : '<div class="bar empty"></div>';
    hourHTML+='<div class="bar-col">'+bar+'<div class="bar-lbl">'+(hr%12||12)+(hr<12?'a':'p')+'</div></div>';
  }
  $('hourChart').innerHTML=hourHTML;

  // Top products
  var topProd=Object.keys(prodMap).map(function(k){return{name:k,n:prodMap[k]}}).sort(function(a,b){return b.n-a.n}).slice(0,5);
  if(topProd.length){
    $('topProductsList').innerHTML=topProd.map(function(p,i){
      return '<div class="top-row"><div class="top-rank '+(i<3?'r'+(i+1):'')+'">'+(i+1)+'</div><div class="top-info"><div class="top-name">'+esc(p.name)+'</div><div class="top-meta">'+p.n+' order'+(p.n!==1?'s':'')+'</div></div></div>';
    }).join('');
  }

  // Top customers
  var topCust=Object.values(custMap).sort(function(a,b){return b.spent-a.spent}).slice(0,5);
  if(topCust.length){
    $('topCustomersList').innerHTML=topCust.map(function(c,i){
      return '<div class="top-row"><div class="top-rank '+(i<3?'r'+(i+1):'')+'">'+(i+1)+'</div><div class="top-info"><div class="top-name">'+esc(c.name||'Customer')+'</div><div class="top-meta">'+c.orders+' order'+(c.orders!==1?'s':'')+' · '+esc(c.phone)+'</div></div><div class="top-amt">'+fmt(c.spent)+'</div></div>';
    }).join('');
  }
}

// ════════════════════════════════════════════
// CUSTOMERS (derived from orders)
// ════════════════════════════════════════════
function buildCustomers(){
  var map={};
  allOrders.forEach(function(o){
    if(!o.phone||o.status==='cancelled')return;
    var k=o.phone.replace(/\D/g,'');
    if(!map[k])map[k]={name:o.name||'Customer',phone:o.phone,orders:0,spent:0,lastDate:'',firstDate:''};
    map[k].orders++;map[k].spent+=o.total;
    if(!map[k].lastDate||(o.dateKey>map[k].lastDate))map[k].lastDate=o.dateKey;
    if(!map[k].firstDate||(o.dateKey<map[k].firstDate))map[k].firstDate=o.dateKey;
  });
  return Object.values(map).sort(function(a,b){return b.spent-a.spent});
}
function openCustomers(){
  var custs=buildCustomers();
  $('custSheetSub').textContent=custs.length+' unique customers from '+allOrders.length+' orders';
  $('custCountSub').textContent=custs.length+' unique customers';
  renderCustomers();
  $('custSheet').classList.add('open');
}
function renderCustomers(){
  var custs=buildCustomers();
  var q=($('custSearch').value||'').toLowerCase();
  if(q)custs=custs.filter(function(c){return(c.name+c.phone).toLowerCase().indexOf(q)>=0});
  if(!custs.length){$('custList').innerHTML='<div class="empty"><div class="empty-emoji">👥</div>No customers yet.</div>';return}
  $('custList').innerHTML=custs.map(function(c){
    var p=c.phone.replace(/\D/g,'');if(p.length===10)p='91'+p;
    var initial=(c.name||'C').charAt(0).toUpperCase();
    return '<div class="cust-row"><div class="cust-avatar">'+esc(initial)+'</div><div class="cust-info"><div class="cust-name">'+esc(c.name)+'</div><div class="cust-meta">'+c.orders+' order'+(c.orders!==1?'s':'')+' · last '+(c.lastDate||'—')+'</div></div><div class="cust-stat"><div class="cust-spent">'+fmt(c.spent)+'</div><div class="cust-orders">'+esc(c.phone)+'</div></div><div class="cust-act"><button class="cust-ic-btn wa" onclick="window.open(\'https://wa.me/'+p+'\',\'_blank\')">📱</button></div></div>';
  }).join('');
}

// ════════════════════════════════════════════
// MARKETING / BROADCAST
// ════════════════════════════════════════════
function openMarketing(){
  var custs=buildCustomers();
  $('bcastCount').textContent=custs.length;
  var templates=[
    {label:'Weekend Offer',msg:'🎉 Special Weekend Offer! Get 10% off on all orders this Saturday & Sunday. Order now: '+(STORE_META.url||'')},
    {label:'Festival',msg:'🪔 Wishing you a very happy festival! Special menu live now: '+(STORE_META.url||'')},
    {label:'Restock',msg:'✨ Good news — your favourites are back in stock! Order at: '+(STORE_META.url||'')},
    {label:'Closed Today',msg:'Hi! We are closed today and will reopen tomorrow. Sorry for the inconvenience 🙏'},
    {label:'Thank You',msg:'Thank you for being a loyal customer! Use code LOYAL10 for 10% off your next order ❤️'}
  ];
  $('bcastTemplates').innerHTML=templates.map(function(t){
    return '<button class="q-reply" onclick="document.getElementById(\'bcastText\').value=\''+jss(t.msg)+'\'">'+esc(t.label)+'</button>';
  }).join('');
  $('bcastSheet').classList.add('open');
}
function startBroadcast(){
  var msg=$('bcastText').value.trim();
  if(!msg){showToast('Type a message first','error');return}
  var custs=buildCustomers();
  if(!custs.length){showToast('No customers yet','error');return}
  if(!confirm('Send this message to '+custs.length+' customers?\n\n"'+msg.slice(0,80)+(msg.length>80?'...':'')+'"\n\nWhatsApp will open one chat at a time. You\'ll need to tap Send for each.'))return;
  _broadcastQueue=custs.slice();
  closeSheet('bcastSheet');
  showToast('📱 Opening WhatsApp for each customer...','success');
  broadcastNext(msg);
}
function broadcastNext(msg){
  if(!_broadcastQueue.length){showToast('✓ Broadcast complete','success');return}
  var c=_broadcastQueue.shift();
  var p=c.phone.replace(/\D/g,'');if(p.length===10)p='91'+p;
  window.open('https://wa.me/'+p+'?text='+encodeURIComponent(msg),'_blank');
  if(_broadcastQueue.length){
    setTimeout(function(){
      if(confirm('Sent to '+c.name+'. Continue with next of '+_broadcastQueue.length+' customers?'))broadcastNext(msg);
      else{_broadcastQueue=[];showToast('Stopped','error')}
    },800);
  }
}

// ════════════════════════════════════════════
// PRODUCTS
// ════════════════════════════════════════════
function loadProductsSheet(cb){
  loadSheet(SHEET_ID,'Products',function(r){
    if(!r){loadSheet(SHEET_ID,'Menu',function(r2){_parseProducts(r2);if(cb)cb()});return}
    _parseProducts(r);if(cb)cb();
  });
}
function _parseProducts(r){
  if(!r){productData=[];return}
  var parsed=parseSheetRows(r);
  productData=parsed.rows.filter(function(p){return p.name||p['name']});
}
function buildCatFilters(){
  var cats={};
  productData.forEach(function(p){var c=p.category||'Other';cats[c]=(cats[c]||0)+1});
  var h='<button class="chip'+(activeCat==='all'?' active':'')+'" onclick="setCat(\'all\')">All<b>'+productData.length+'</b></button>';
  Object.keys(cats).forEach(function(c){h+='<button class="chip'+(activeCat===c?' active':'')+'" onclick="setCat(\''+jss(c)+'\')">'+esc(c)+'<b>'+cats[c]+'</b></button>'});
  $('catFilters').innerHTML=h;
}
function setCat(c){activeCat=c;buildCatFilters();renderProducts()}
function renderProducts(){
  var list=productData.slice();
  if(activeCat!=='all')list=list.filter(function(p){return(p.category||'Other')===activeCat});
  var q=($('prodSearch').value||'').toLowerCase();
  if(q)list=list.filter(function(p){return((p.name||'')+(p.category||'')+(p.hindiname||'')).toLowerCase().indexOf(q)>=0});
  if(!list.length){$('productsList').innerHTML='<div class="empty"><div class="empty-emoji">📦</div>No products yet.</div>';return}
  $('productsList').innerHTML=list.map(function(p){
    var oos=(p.stock||'').toLowerCase().indexOf('out')>=0;
    var veg=(p.veg||'').toLowerCase()==='yes'?'<span class="veg-d veg"></span>':(p.veg||'').toLowerCase()==='no'?'<span class="veg-d nonveg"></span>':'';
    return '<div class="prod-card'+(oos?' oos':'')+'"><div class="prod-h"><div class="prod-img">'+(p.image?'<img src="'+esc(p.image)+'" onerror="this.style.display=\'none\'">':'🍽️')+'</div><div class="prod-info"><div class="prod-n">'+esc(p.name)+'</div><div class="prod-m">'+veg+(p.category?'<span>'+esc(p.category)+'</span>':'')+'<span class="stk '+(oos?'stk-no':'stk-ok')+'">'+(oos?'Out of stock':'In stock')+'</span></div></div><div class="prod-p">'+fmt(p.price)+'</div></div></div>';
  }).join('');
}

// ════════════════════════════════════════════
// CONFIG SHEET (settings)
// ════════════════════════════════════════════
function openSection(sec){
  if(sec==='config'||sec==='inventory'){
    $('cfgSheet').classList.add('open');
    renderConfig();
  }else if(sec==='help'){
    $('helpSheet').classList.add('open');
  }
}
function renderConfig(){
  var q=($('cfgSearch').value||'').toLowerCase();
  var list=configData.filter(function(c){return!q||(c.key+' '+c.value).toLowerCase().indexOf(q)>=0});
  if(!list.length){$('cfgList').innerHTML='<div class="empty">No matching settings</div>';return}
  $('cfgList').innerHTML=list.map(function(c,i){
    var k=esc(c.key),v=esc(c.value),id='cfg_'+i;
    var isLong=(c.value||'').length>50;
    return '<div class="cfg-item"><div class="cfg-k">'+k+'</div><div class="cfg-row">'+(isLong?'<textarea class="cfg-input" id="'+id+'" rows="2" style="height:auto;padding:8px 12px">'+v+'</textarea>':'<input class="cfg-input" id="'+id+'" value="'+v+'">')+'<button class="cfg-save" onclick="saveCfg(\''+jss(c.key)+'\',\''+id+'\',this)">Save</button></div></div>';
  }).join('');
}
function saveCfg(key,inputId,btn){
  var val=$(inputId).value;
  // Update local
  configData.forEach(function(c){if(c.key===key)c.value=val});
  btn.textContent='✓ Saved';btn.classList.add('saved');
  setTimeout(function(){btn.textContent='Save';btn.classList.remove('saved')},1500);
  paintHeader();
  sendCmd('action=updateConfig&key='+encodeURIComponent(key)+'&value='+encodeURIComponent(val));
}

// ════════════════════════════════════════════
// PRINT RECEIPT
// ════════════════════════════════════════════
function printReceipt(id){
  var o=allOrders.find(function(x){return x.id===id});if(!o)return;
  var shop=getCfg('ShopName','My Store');
  var addr=getCfg('Address','');
  var phone=getCfg('Phone','')||getCfg('WhatsApp','');
  var rows=(o.items||'').split(/\n|,(?=\s*\d+x\s)/).filter(function(x){return x.trim()}).map(function(it){
    var pp=it.split('=');
    return '<tr><td>'+esc(pp[0]||it)+'</td><td class="r">'+esc(pp[1]||'')+'</td></tr>';
  }).join('');
  var css='body{font-family:monospace;font-size:12px;padding:14px;max-width:300px;margin:0 auto}h1{font-size:16px;text-align:center;margin-bottom:4px}.c{text-align:center}hr{border:none;border-top:1px dashed #000;margin:8px 0}table{width:100%}td{padding:2px 0}.r{text-align:right}.tot{font-size:14px;font-weight:bold}';
  var parts=[
    '<html><head><title>Receipt ',id,'</title><style>',css,'</style></head><body>',
    '<h1>',esc(shop),'</h1>',
    '<div class="c">',esc(addr),'<br>',esc(phone),'</div><hr>',
    '<div>Order: ',esc(id),'<br>Date: ',esc(o.date),'<br>Customer: ',esc(o.name),'<br>Phone: ',esc(o.phone),'<br>Mode: ',esc(o.mode.toUpperCase()),'</div><hr>',
    '<table>',rows,'</table><hr>',
    '<table><tr class="tot"><td>TOTAL</td><td class="r">₹',o.total,'</td></tr></table><hr>',
    '<div class="c">Thank you!<br>Powered by StorePro</div></body></html>'
  ];
  var w=window.open('','_blank','width=380,height=600');
  if(!w){showToast('Popup blocked — allow popups to print','error');return}
  w.document.write(parts.join(''));
  w.document.close();
  setTimeout(function(){try{w.focus();w.print()}catch(e){}},250);
}

// ════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════
function goPage(p){
  currentPage=p;
  document.querySelectorAll('.page').forEach(function(el){el.classList.remove('active')});
  $('pg'+p.charAt(0).toUpperCase()+p.slice(1)).classList.add('active');
  document.querySelectorAll('.bnav-btn').forEach(function(el){el.classList.toggle('active',el.dataset.page===p)});
  // Hero stats only visible on home
  $('heroRow').style.display=p==='home'?'flex':'none';
  $('fabBtn').style.display=p==='orders'?'flex':'none';
  if(p==='insights')paintInsights();
  if(p==='more')paintProfile();
  window.scrollTo({top:0,behavior:'smooth'});
}

// ════════════════════════════════════════════
// THEME, BEEP
// ════════════════════════════════════════════
function toggleTheme(){
  var cur=document.documentElement.getAttribute('data-theme');
  var n=cur==='dark'?'':'dark';
  if(n)document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.removeAttribute('data-theme');
  try{localStorage.setItem('sl_theme_v2',n||'light')}catch(e){}
  showToast(n==='dark'?'🌙 Dark mode':'☀️ Light mode');
}
// playBeep() kept as alias for any legacy callers
function playBeep(){playAlert(true);vibrate(true)}
function testNotif(){
  // Simulate a new order alert with all layers
  alertNewOrders([{name:'Test Customer',total:299,phone:'9999999999'}]);
  showToast('Test alert sent — confirm to stop','success');
}
function toggleNPref(key){NPREF[key]=!NPREF[key];saveNPref();renderNotifSettings();showToast(NPREF[key]?'✓ Enabled':'✕ Disabled');if(key==='wakeLock'){if(NPREF[key])requestWakeLock();else releaseWakeLock()}if(key==='loop'&&!NPREF.loop)stopContinuousLoop()}
function setNotifLang(lang){NPREF.lang=lang;saveNPref();renderNotifSettings();showToast(lang===''?'Using Config / Auto':lang==='hi'?'हिन्दी सेट किया':'English set','success')}
function renderNotifSettings(){
  var el=$('notifSettings');if(!el)return;
  var rows=[
    {k:'sound',ic:'🔊',t:'Sound alerts',s:'Bell chime when new orders arrive'},
    {k:'loud',ic:'📢',t:'Extra loud mode',s:'Saturated chime + transient burst — best for noisy kitchens'},
    {k:'speak',ic:'🗣',t:'Voice announcement',s:'"New order! [Customer], [Total] rupees" — cuts through noise'},
    {k:'vibrate',ic:'📳',t:'Vibration',s:'Aggressive 5s buzz + recurring pulses while pending'},
    {k:'flash',ic:'⚡',t:'Screen flash',s:'Red full-screen flash on new orders'},
    {k:'browserNotif',ic:'🔔',t:'Browser notifications',s:'System notification when tab is in background'},
    {k:'repeat',ic:'🔁',t:'Repeat reminder (30s)',s:'Gentle re-alert until you confirm or cancel'},
    {k:'loop',ic:'🚨',t:'CONTINUOUS ALARM (5s)',s:'⚠️ Plays full alarm every 5s until you tap. Use only in noisy shops.'},
    {k:'wakeLock',ic:'💡',t:'Keep screen on',s:'Stop screen auto-lock while dashboard is open'}
  ];
  var notifPerm=('Notification' in window)?Notification.permission:'unsupported';
  var permLine=notifPerm==='granted'?'<div style="background:var(--brand-bg);color:var(--brand);padding:10px 12px;border-radius:10px;font-size:12px;font-weight:700;margin-bottom:12px">✓ Browser permission granted</div>':notifPerm==='denied'?'<div style="background:var(--red-bg);color:var(--red);padding:10px 12px;border-radius:10px;font-size:12px;font-weight:700;margin-bottom:12px">✕ Browser blocked notifications — change in browser site settings</div>':'<button class="btn btn-primary" style="height:38px;font-size:12px;margin-bottom:12px;width:100%" onclick="requestNotifPermission()">Enable Browser Notifications</button>';
  var hasVibrate=!!navigator.vibrate;
  var hasSpeech=('speechSynthesis' in window);
  var supportLine='<div style="background:var(--bg);padding:10px 12px;border-radius:10px;font-size:11px;color:var(--ink3);margin-bottom:12px;line-height:1.5">📱 This device supports: '+(hasVibrate?'✓ Vibration · ':'✕ No vibration · ')+(hasSpeech?'✓ Voice · ':'✕ No voice · ')+'✓ Sound</div>';
  // Language picker
  var curLang=nLang();
  var configuredLang=(getCfg('NotificationLanguage','')||getCfg('NotificationLang','')||'').toLowerCase();
  var langLine='<div style="margin-bottom:12px"><div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">🌐 Notification Language</div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">'
    +'<button class="btn '+(NPREF.lang===''?'btn-primary':'btn-ghost')+'" style="height:42px;font-size:12px" onclick="setNotifLang(\'\')">Auto</button>'
    +'<button class="btn '+(NPREF.lang==='en'?'btn-primary':'btn-ghost')+'" style="height:42px;font-size:12px" onclick="setNotifLang(\'en\')">English</button>'
    +'<button class="btn '+(NPREF.lang==='hi'?'btn-primary':'btn-ghost')+'" style="height:42px;font-size:12px" onclick="setNotifLang(\'hi\')">हिन्दी</button>'
    +'</div>'
    +'<div style="font-size:10px;color:var(--ink3);margin-top:6px;line-height:1.5">'
    +(NPREF.lang===''?('Auto: using <b>'+(curLang==='hi'?'हिन्दी':'English')+'</b>'+(configuredLang?' (set in Config sheet → <code>NotificationLanguage</code>)':' (no Config setting found — defaulting to English)')):'Override active. Set <b>NotificationLanguage</b> in your Config sheet to change the default.')
    +'</div></div>';
  // Push (locked-phone) section
  var pushLine='<div style="margin-bottom:12px;padding:12px;background:var(--bg);border-radius:12px;border:1px dashed var(--line)"><div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">🌐 Locked-phone alerts (Web Push)</div><div id="pushBlock" style="font-size:12px;color:var(--ink3)">Loading...</div></div>';
  el.innerHTML=permLine+supportLine+langLine+pushLine+rows.map(function(r){
    var on=NPREF[r.k];
    return '<div class="detail-row" style="cursor:pointer" onclick="toggleNPref(\''+r.k+'\')"><div class="detail-ic">'+r.ic+'</div><div class="detail-text"><div class="detail-label">'+esc(r.t)+'</div><div class="detail-value" style="font-size:11px;color:var(--ink3);font-weight:500">'+esc(r.s)+'</div></div><div class="toggle '+(on?'on':'')+'"><div class="toggle-knob"></div></div></div>';
  }).join('')+'<div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-primary" onclick="testNotif()" style="height:46px;flex:1">🔔 Test Full Alert</button><button class="btn btn-ghost" onclick="stopRepeatNudge();showToast(\'Stopped\',\'success\')" style="height:46px;flex:1">✕ Stop</button></div><div style="font-size:10px;color:var(--ink4);text-align:center;margin-top:10px;line-height:1.5">⚠️ Volume is also limited by your phone\'s system volume. Keep media volume up for best results.</div>';
  // Populate push block asynchronously
  pushStatus().then(function(s){
    var b=$('pushBlock');if(!b)return;
    if(!s.available){
      b.innerHTML='<div style="line-height:1.6">Web Push not configured.<br>Admin must set <code>VAPID_PUBLIC_KEY</code> + <code>PUSH_RELAY_URL</code> in dashboard-v2.js (or via <code>VapidPublicKey</code> + <code>PushRelayURL</code> Config keys). See <code>push/README.md</code>.</div>';
      return;
    }
    var on=s.subscribed;
    b.innerHTML='<div style="display:flex;align-items:center;gap:10px"><div style="flex:1"><b style="color:var(--ink);font-size:13px">'+(on?'✓ Push enabled':'Off')+'</b><div style="font-size:11px;margin-top:2px">'+(on?'You will get alerts even when phone is locked or app is closed':'Tap to enable — works in pocket, locked phones, and when dashboard is closed')+'</div></div><div class="toggle '+(on?'on':'')+'" onclick="togglePush()"><div class="toggle-knob"></div></div></div>'+(on?'<button class="btn btn-ghost" style="height:36px;font-size:11px;width:100%;margin-top:8px" onclick="testPush()">Send Test Push</button>':'');
  });
}

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════
// Clean up bad PIN cache from earlier flow where SHEET_ID was empty at save time
try{localStorage.removeItem('sl_pin_')}catch(e){}
// Dismiss splash once page is interactive (after the CSS animation has had ~1.6s to play)
setTimeout(function(){var s=$('splash');if(s)s.classList.add('gone')},1700);
$('p1').focus();
// Pre-resolve store + load config so PIN check is instant and SHEET_ID is ready
initStore(function(){if(!SHEET_ID)console.warn('[Dashboard2] Store not resolved — check ?store= param against master registry')});
