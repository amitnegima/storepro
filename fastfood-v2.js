// ════════════════════════════════════════════
// FASTFOOD V2 — Modern mobile-first food ordering
// ════════════════════════════════════════════
var MASTER_SHEET_ID="1U1T-OS6xx3xRRn2O7KoTw8NE6C-IwrQs6r88sACpejo";
var SHEET_ID="",SCRIPT_URL="";
var STORE_META={};
var configData=[],products=[],cart=[],lastOrder=null;
var activeCat='all',vegOnly=false,bestOnly=false;
var _custCtx=null,_installEvt=null;
// Order-analysis state (powers Trending, Live counter, Stars, Order-Again)
var allOrdersList=[],trendingItems=[],itemRatings={};
var _todayOrderCount=0,_liveOrderCount=0;
var customerHistoryItems=[]; // item names this device has ordered before, freq-sorted

function $(i){return document.getElementById(i)}
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML.replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function jss(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'').replace(/</g,'\\u003c')}
function fmt(n){var c=getCfg('Currency','₹');return c+Math.round(Number(n||0)).toLocaleString('en-IN')}
function showToast(msg,type){var t=$('toast');t.textContent=msg;t.className='toast show '+(type||'');clearTimeout(t._h);t._h=setTimeout(function(){t.className='toast '+(type||'')},2400)}
window.addEventListener('error',function(e){console.error('[Fastfood2]',e.message,'at',e.filename+':'+e.lineno)});

// ─── Theme ───
try{if(localStorage.getItem('ff_theme_v2')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}
function toggleTheme(){
  var cur=document.documentElement.getAttribute('data-theme');
  var n=cur==='dark'?'':'dark';
  if(n)document.documentElement.setAttribute('data-theme','dark');
  else document.documentElement.removeAttribute('data-theme');
  try{localStorage.setItem('ff_theme_v2',n||'light')}catch(e){}
}

// ════════════════════════════════════════════
// JSONP LOAD
// ════════════════════════════════════════════
function loadSheet(sheetId,name,cb){
  if(!sheetId){cb(null);return}
  if(!window.google)window.google={};
  if(!window.google.visualization)window.google.visualization={};
  if(!window.google.visualization.Query)window.google.visualization.Query={};
  var fired=false;
  window.google.visualization.Query.setResponse=function(r){if(fired)return;fired=true;cb(r)};
  var s=document.createElement('script');
  s.src='https://docs.google.com/spreadsheets/d/'+sheetId+'/gviz/tq?tqx=out:json&sheet='+encodeURIComponent(name)+'&headers=1&_t='+Date.now();
  s.onerror=function(){if(fired)return;fired=true;cb(null)};
  document.body.appendChild(s);
  setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s);if(!fired){fired=true;cb(null)}},9000);
}
function parseSheetRows(r){
  if(!r||!r.table)return{rows:[]};
  var cols=r.table.cols||[],allRows=r.table.rows||[];
  if(!allRows.length)return{rows:[]};
  var headers=[],dataRows=allRows;
  var colLabels=cols.map(function(c){return(c.label||'').trim()});
  var firstRaw=colLabels[0]||'';
  var isMerged=(!firstRaw)||(firstRaw.split(/\s+/).length>3);
  if(!isMerged&&colLabels.filter(function(l){return l}).length>1){
    headers=colLabels;
  }else{
    var hRow=allRows[0];
    if(hRow&&hRow.c){for(var h=0;h<hRow.c.length;h++){var hc=hRow.c[h],hv='';if(hc){if(hc.v!=null)hv=String(hc.v).trim();else if(hc.f!=null)hv=String(hc.f).trim()}headers.push(hv)}}
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
  return{rows:parsed};
}
function sendCmd(params,cb){
  if(!SCRIPT_URL){if(cb)cb(false);return}
  var img=new Image(),done=false;
  img.onload=img.onerror=function(){if(!done){done=true;if(cb)cb(true)}};
  img.src=SCRIPT_URL+'?'+params;
  setTimeout(function(){if(!done){done=true;if(cb)cb(false)}},6000);
}

// ════════════════════════════════════════════
// STORE RESOLUTION
// ════════════════════════════════════════════
function resolveStore(cb){
  var p=new URLSearchParams(location.search);
  if(p.get('shop')){SHEET_ID=p.get('shop');SCRIPT_URL=p.get('script')||'';cb();return}
  var slug=(p.get('store')||'').toLowerCase();
  if(!slug){showStoreNotFound('No store specified');return}
  loadSheet(MASTER_SHEET_ID,'Stores',function(r){
    if(!r){showStoreNotFound('Could not connect to store registry');return}
    var parsed=parseSheetRows(r);
    var found=parsed.rows.find(function(o){return(o.slug||'').toLowerCase()===slug});
    if(!found){showStoreNotFound('Store "'+slug+'" not found');return}
    STORE_META=found;
    SHEET_ID=found.sheetid||'';
    SCRIPT_URL=found.scripturl||found.script||'';
    cb();
  });
}
function showStoreNotFound(why){
  $('menu').innerHTML='<div class="empty-msg"><div class="empty-em">🏬</div><h3>Store not found</h3><p>'+esc(why)+'</p><button class="btn btn-primary" onclick="location.href=\'/\'" style="margin-top:14px">Browse stores</button></div>';
}

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════
function getCfg(key,def){
  if(!configData.length)return def||'';
  var k=key.toLowerCase().replace(/\s+/g,'');
  for(var i=0;i<configData.length;i++){
    if(configData[i].key.toLowerCase().replace(/\s+/g,'')===k)return configData[i].value;
  }
  return def||'';
}
function loadConfig(cb){
  loadSheet(SHEET_ID,'Config',function(r){
    if(!r){if(cb)cb();return}
    var parsed=parseSheetRows(r);
    configData=parsed.rows.map(function(o){var keys=Object.keys(o);return{key:o[keys[0]]||'',value:o[keys[1]]||''}}).filter(function(c){return c.key});
    if(!SCRIPT_URL){var sc=getCfg('OrderScript','')||getCfg('ScriptURL','');if(sc)SCRIPT_URL=sc}
    if(cb)cb();
  });
}

// ════════════════════════════════════════════
// PRODUCTS
// ════════════════════════════════════════════
// ════════════════════════════════════════════
// ORDER ANALYTICS — Trending, Stars, Live activity (read-only of Orders sheet)
// ════════════════════════════════════════════
function loadOrders(cb){
  loadSheet(SHEET_ID,'Orders',function(r){
    if(!r){if(cb)cb();return}
    var parsed=parseSheetRows(r);
    allOrdersList=parsed.rows.filter(function(o){return o.orderid});
    analyzeOrders();
    if(cb)cb();
  });
}
function parseTs(ds){
  if(!ds)return 0;
  var p=ds.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):?(\d{2})?\s*(am|pm)?/i);
  if(p){var h=parseInt(p[4]),m=parseInt(p[5]);if(p[7]){if(p[7].toLowerCase()==='pm'&&h!==12)h+=12;if(p[7].toLowerCase()==='am'&&h===12)h=0}return new Date(p[3],p[2]-1,p[1],h,m,p[6]?parseInt(p[6]):0).getTime()}
  var d=new Date(ds);return isNaN(d)?0:d.getTime();
}
// Pull canonical product names out of an items string
// Format: "2x Chicken Curry [size: Half | spice: Mild] = ₹260\n1x Mutton Boneless = ₹950"
function parseOrderItems(s){
  if(!s)return[];
  var lines=String(s).split(/\n|,(?=\s*\d+x\s)/);
  var names=[];
  lines.forEach(function(line){
    line=String(line||'').trim();if(!line)return;
    line=line.replace(/^\d+x\s+/i,''); // strip "2x "
    line=line.replace(/\s*=.*$/,''); // strip "= ₹450"
    line=line.replace(/\s*\[[^\]]*\]\s*/g,' '); // strip "[customizations]"
    line=line.replace(/\s+/g,' ').trim();
    if(!line)return;
    // Canonicalize against products (case-insensitive)
    var hit=products.find(function(p){return (p.name||'').trim().toLowerCase()===line.toLowerCase()});
    names.push(hit?hit.name:line);
  });
  return names;
}
function analyzeOrders(){
  var now=Date.now();
  var dayAgo=now-86400000;
  var halfHourAgo=now-30*60*1000;
  var todayKey=new Date().toISOString().slice(0,10);
  var trendCounts={},allCounts={};
  var ratingSum={},ratingCount={};
  var todayN=0,liveN=0;
  allOrdersList.forEach(function(o){
    var cancelled=/cancel/i.test(o.status||'');
    var ts=parseTs(o['date&time']||o.datetime||o.date||'');
    var items=parseOrderItems(o.items||'');
    if(!cancelled){
      items.forEach(function(name){
        allCounts[name]=(allCounts[name]||0)+1;
        if(ts>=dayAgo)trendCounts[name]=(trendCounts[name]||0)+1;
      });
      // Today + last 30min
      if(ts){
        var d=new Date(ts);
        if(d.toISOString().slice(0,10)===todayKey)todayN++;
        if(ts>=halfHourAgo)liveN++;
      }
    }
    // Reviews
    var stars=parseInt(o.reviewstars||0)||0;
    if(stars>0){
      items.forEach(function(name){
        ratingSum[name]=(ratingSum[name]||0)+stars;
        ratingCount[name]=(ratingCount[name]||0)+1;
      });
    }
  });
  // Trending: prefer last-24h, fall back to all-time if too few
  var src=Object.keys(trendCounts).length>=3?trendCounts:allCounts;
  trendingItems=Object.keys(src).map(function(n){return{name:n,count:src[n]}}).sort(function(a,b){return b.count-a.count}).slice(0,6);
  // Ratings
  itemRatings={};
  Object.keys(ratingCount).forEach(function(n){
    itemRatings[n]={avg:ratingSum[n]/ratingCount[n],count:ratingCount[n]};
  });
  _todayOrderCount=todayN;
  _liveOrderCount=liveN;
  // Customer's own history — read from localStorage (stored on each successful checkout)
  try{
    var hist=JSON.parse(localStorage.getItem('ff_history_items_v2')||'{}')||{};
    customerHistoryItems=Object.keys(hist).map(function(n){return{name:n,count:hist[n]}}).sort(function(a,b){return b.count-a.count}).slice(0,8);
  }catch(e){}
}

function loadProducts(cb){
  loadSheet(SHEET_ID,'Products',function(r){
    if(r&&r.table&&r.table.rows&&r.table.rows.length){_parseProducts(r);if(cb)cb();return}
    loadSheet(SHEET_ID,'Menu',function(r2){_parseProducts(r2);if(cb)cb()});
  });
}
function _parseProducts(r){
  if(!r){products=[];return}
  var parsed=parseSheetRows(r);
  products=parsed.rows.filter(function(p){return p.name});
}

// ════════════════════════════════════════════
// PAINT HEADER
// ════════════════════════════════════════════
function paintHeader(){
  var name=getCfg('ShopName','')||(STORE_META.shopname)||'Order Online';
  document.title=name+' · Order';
  $('hShop').textContent=name;
  $('tbName').textContent=name;
  // Cache name/type/brand/logo for next-visit PWA manifest personalization
  try{
    var slug=(STORE_META.slug||(new URLSearchParams(location.search)).get('store')||'').toLowerCase();
    if(slug){
      localStorage.setItem('ff_shopname_'+slug,name);
      var stype=STORE_META.shoptype||getCfg('ShopType','');
      if(stype)localStorage.setItem('ff_shoptype_'+slug,stype);
      var bc=getCfg('BrandColor','');
      if(/^#[0-9a-f]{6}$/i.test(bc))localStorage.setItem('ff_brand_'+slug,bc);
      var logoUrl=getCfg('LogoURL','')||getCfg('Logo','')||getCfg('AppIcon','');
      if(logoUrl)localStorage.setItem('ff_logo_'+slug,logoUrl);
    }
  }catch(e){}
  // Hero tag — supports HeroTitle2 (Hindi blessing) + tagline
  var t1=getCfg('HeroTagline','')||getCfg('Tagline','');
  var t2=getCfg('HeroTitle2','')||getCfg('Blessing','')||getCfg('Subtitle','');
  var tagHTML='';
  if(t2)tagHTML+='<span class="hi">'+esc(t2)+'</span>';
  if(t1&&t2)tagHTML+=' · ';
  if(t1)tagHTML+=esc(t1);
  if(!t1&&!t2)tagHTML='Hot, fresh & delivered fast';
  $('hTag').innerHTML=tagHTML;
  $('hRating').textContent=getCfg('Rating','4.5');
  $('hEta').textContent=getCfg('EstimatedDeliveryTime','30-45 min');
  var minOrd=parseFloat(getCfg('MinOrder','0'))||0;
  if(minOrd>0)$('hMin').textContent=fmt(minOrd);
  else $('hMinChip').style.display='none';
  // Determine brand color: explicit BrandColor wins, else green for veg-only, else red default
  var vegOnlyShop=/^(yes|true|1)$/i.test(getCfg('VegOnly','')||getCfg('PureVegetarian','')||getCfg('Pureveg',''));
  var brand=getCfg('BrandColor','');
  if(!brand)brand=vegOnlyShop?'#0c831f':'#d4321f';
  if(/^#[0-9a-f]{6}$/i.test(brand)){
    document.documentElement.style.setProperty('--brand',brand);
    document.documentElement.style.setProperty('--brand-dk',shadeColor(brand,-25));
    document.documentElement.style.setProperty('--brand2',shadeColor(brand,15));
    document.documentElement.style.setProperty('--brand-bg',hexToRgba(brand,.1));
    document.querySelector('meta[name=theme-color]').setAttribute('content',brand);
  }
  var heroImg=getCfg('HeroImage','');
  if(heroImg)$('heroImg').style.backgroundImage='url('+heroImg+')';
  if(vegOnlyShop){$('hVegChip').style.display='inline-flex';$('vegToggleBtn').style.display='none'}
  else $('vegToggleBtn').style.display='inline-flex';
  // Status (open/closed)
  var open=isStoreOpen();
  var openLabel=getCfg('Timing','9:00-22:00');
  $('tbStatus').classList.toggle('closed',!open);
  $('tbStatusTxt').textContent=open?'Open now · '+openLabel:'Closed · '+openLabel;
  paintContactBar();
}
function shadeColor(hex,pct){
  var n=parseInt(hex.slice(1),16),r=(n>>16)&255,g=(n>>8)&255,b=n&255;
  var f=pct/100;
  r=Math.max(0,Math.min(255,Math.round(r+(pct>0?(255-r)*f:r*f))));
  g=Math.max(0,Math.min(255,Math.round(g+(pct>0?(255-g)*f:g*f))));
  b=Math.max(0,Math.min(255,Math.round(b+(pct>0?(255-b)*f:b*f))));
  return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}
function hexToRgba(hex,a){var n=parseInt(hex.slice(1),16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')'}

function paintContactBar(){
  // Builds the contact sheet (opened via 📞 icon in topbar).
  // Renders as a vertical list of large tappable buttons.
  var p1=(getCfg('Phone','')||'').replace(/\D/g,'').slice(-10);
  var p2=(getCfg('Phone2','')||getCfg('SecondaryPhone','')||'').replace(/\D/g,'').slice(-10);
  var wa=(getCfg('WhatsApp','')||getCfg('Phone','')).replace(/\D/g,'');
  if(wa.length===10)wa='91'+wa;
  var html='';
  if(p1)html+='<a class="contact-btn-lg" href="tel:+91'+p1+'"><span class="ic">📞</span><span class="lb"><b>Call</b><small>+91 '+p1+'</small></span></a>';
  if(p2&&p2!==p1)html+='<a class="contact-btn-lg" href="tel:+91'+p2+'"><span class="ic">📞</span><span class="lb"><b>Call (secondary)</b><small>+91 '+p2+'</small></span></a>';
  if(wa){
    var shop=getCfg('ShopName','Store');
    var msg='Hi! I want to place an order at '+shop;
    html+='<a class="contact-btn-lg wa" href="https://wa.me/'+wa+'?text='+encodeURIComponent(msg)+'" target="_blank"><span class="ic">💬</span><span class="lb"><b>WhatsApp the shop</b><small>Pre-filled message ready</small></span></a>';
  }
  var btns=$('contactBtns');if(btns)btns.innerHTML=html||'<div style="text-align:center;padding:20px;color:var(--ink3);font-size:13px">No contact details set</div>';
}
function openContact(){$('contactSheet').classList.add('open')}
function isStoreOpen(){
  var s=(getCfg('StoreOpen','')||'').toLowerCase();
  if(s==='no'||s==='false'||s==='closed'||s==='0')return false;
  var timing=getCfg('Timing','9:00-22:00');
  var m=timing.match(/(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?/);
  if(!m)return true;
  var now=new Date();var nm=now.getHours()*60+now.getMinutes();
  var sm=parseInt(m[1])*60+parseInt(m[2]||'0');
  var em=parseInt(m[3])*60+parseInt(m[4]||'0');
  if(em<=sm)em+=24*60; // overnight
  return nm>=sm&&nm<=em;
}

// ════════════════════════════════════════════
// FILTERS
// ════════════════════════════════════════════
function paintFilters(){
  var cats={};products.forEach(function(p){var c=(p.category||'Other').trim();if(!c)c='Other';cats[c]=(cats[c]||0)+1});
  var keys=Object.keys(cats).sort();
  var h='';
  // Always-on All tab
  h+='<button class="f-tab'+(activeCat==='all'&&!bestOnly?' active':'')+'" onclick="setCat(\'all\')">All<b>'+products.length+'</b></button>';
  // 🔁 Reorder tab — only if customer has past history matching products
  var reorderCount=customerHistoryItems.filter(function(h){return products.find(function(p){return p.name===h.name})}).length;
  if(reorderCount>0){
    h+='<button class="f-tab reorder'+(activeCat==='__reorder'?' active':'')+'" onclick="setCat(\'__reorder\')">🔁 Reorder<b>'+reorderCount+'</b></button>';
  }
  // 🔥 Trending tab — only if Orders sheet has trending data
  var trendCount=trendingItems.filter(function(t){return products.find(function(p){return p.name===t.name})}).length;
  if(trendCount>0){
    h+='<button class="f-tab trending'+(activeCat==='__trending'?' active':'')+'" onclick="setCat(\'__trending\')">🔥 Trending<b>'+trendCount+'</b></button>';
  }
  // ⭐ Bestsellers — based on Products.bestseller flag
  if(products.some(function(p){return/^(yes|true|1)$/i.test(p.bestseller||'')})){
    h+='<button class="f-tab best'+(bestOnly?' active':'')+'" onclick="toggleBest()">⭐ Best</button>';
  }
  // Real categories last
  keys.forEach(function(k){
    h+='<button class="f-tab'+(activeCat===k?' active':'')+'" onclick="setCat(\''+jss(k)+'\')">'+esc(k)+'<b>'+cats[k]+'</b></button>';
  });
  $('filters').innerHTML=h;
  var vt=$('vegToggleBtn');if(vt)vt.classList.toggle('active',vegOnly);
}
function setCat(c){activeCat=c;bestOnly=false;paintFilters();renderMenu();var fl=$('filters');var pos=fl?fl.getBoundingClientRect().bottom:200;window.scrollTo({top:Math.max(0,window.scrollY+pos-60),behavior:'smooth'})}
function toggleVeg(){vegOnly=!vegOnly;paintFilters();renderMenu()}
function toggleBest(){bestOnly=!bestOnly;activeCat='all';paintFilters();renderMenu()}
function catEmoji(c){
  c=(c||'').toLowerCase();
  if(/burger/.test(c))return '🍔';if(/pizza/.test(c))return '🍕';
  if(/biryani|rice/.test(c))return '🍛';if(/roll|wrap/.test(c))return '🌯';
  if(/momo|dimsum|dumpling/.test(c))return '🥟';if(/noodle|chow|hakka/.test(c))return '🍜';
  if(/dessert|sweet|cake|ice/.test(c))return '🍰';if(/drink|beverage|juice|shake|tea|coffee/.test(c))return '🥤';
  if(/chicken|tandoor|kebab/.test(c))return '🍗';if(/sandwich|toast/.test(c))return '🥪';
  if(/breakfast/.test(c))return '🥞';if(/snack|chaat|samosa/.test(c))return '🥨';
  if(/paratha|bread|naan|roti/.test(c))return '🫓';if(/thali|combo/.test(c))return '🍱';
  if(/dosa|idli|south/.test(c))return '🥞';if(/salad/.test(c))return '🥗';
  if(/special/.test(c))return '✨';if(/starter|appet/.test(c))return '🍢';
  return '🍽';
}

// ════════════════════════════════════════════
// MENU RENDER
// ════════════════════════════════════════════
function renderMenu(){
  var q=($('qInput').value||'').toLowerCase().trim();
  $('qClear').style.display=q?'block':'none';
  var list=products.slice();
  if(vegOnly)list=list.filter(function(p){return/^(yes|veg|true|1)$/i.test(p.veg||'')});
  if(bestOnly)list=list.filter(function(p){return/^(yes|true|1)$/i.test(p.bestseller||'')});
  // Virtual categories — Reorder and Trending filter against products list
  if(activeCat==='__reorder'){
    var hist=customerHistoryItems.map(function(h){return h.name});
    list=list.filter(function(p){return hist.indexOf(p.name)>=0});
  }else if(activeCat==='__trending'){
    var trend=trendingItems.map(function(t){return t.name});
    list=list.filter(function(p){return trend.indexOf(p.name)>=0});
  }else if(activeCat!=='all'){
    list=list.filter(function(p){return(p.category||'Other')===activeCat});
  }
  if(q)list=list.filter(function(p){return((p.name||'')+(p.category||'')+(p.hindiname||'')+(p.description||'')).toLowerCase().indexOf(q)>=0});
  if(!list.length){$('menu').innerHTML='<div class="empty-msg"><div class="empty-em">🍽</div><h3>No items found</h3><p>Try clearing filters or search</p></div>';return}
  var html='';
  // Group by category ONLY when viewing All
  if(activeCat==='all'&&!q&&!vegOnly&&!bestOnly){
    var grouped={};
    list.forEach(function(p){var c=(p.category||'Other').trim()||'Other';if(!grouped[c])grouped[c]=[];grouped[c].push(p)});
    var first=true;
    Object.keys(grouped).sort().forEach(function(c){
      html+='<div class="cat-section'+(first?' first':'')+'"><div class="cat-h"><h2>'+catEmoji(c)+' '+esc(c)+'</h2><span class="cat-n">'+grouped[c].length+' item'+(grouped[c].length!==1?'s':'')+'</span></div>';
      grouped[c].forEach(function(p){html+=productHTML(p)});
      html+='</div>';
      first=false;
    });
  }else{
    // Virtual category headers
    var sectionTitle='';
    if(activeCat==='__reorder')sectionTitle='🔁 Your Past Orders';
    else if(activeCat==='__trending')sectionTitle='🔥 Trending Now';
    else if(bestOnly)sectionTitle='⭐ Bestsellers';
    else if(q)sectionTitle='🔍 Search results';
    html+='<div class="cat-section first">';
    if(sectionTitle)html+='<div class="cat-h"><h2>'+sectionTitle+'</h2><span class="cat-n">'+list.length+' item'+(list.length!==1?'s':'')+'</span></div>';
    list.forEach(function(p){html+=productHTML(p)});
    html+='</div>';
  }
  $('menu').innerHTML=html;
}
// Trending strip (top of menu) — horizontal scrollable
function renderTrendingStrip(){
  if(!trendingItems.length)return '';
  // Map trending item names back to actual product objects
  var picks=trendingItems.map(function(t){return products.find(function(p){return p.name===t.name})}).filter(function(p){return p});
  if(!picks.length)return '';
  var html='<div class="strip"><div class="strip-h"><h2>🔥 Trending Now</h2><span class="strip-sub">Most ordered in last 24h</span></div><div class="strip-row">';
  picks.slice(0,6).forEach(function(p){
    var price=parseFloat(p.price||'0')||0;
    var img=p.image?'<img src="'+esc(p.image)+'" onerror="this.style.display=\'none\'">':catEmoji(p.category);
    var imgClass=p.image?'':'placeholder';
    var oos=/out\s*of\s*stock|sold\s*out/i.test(p.stock||'')&&!/in\s*stock/i.test(p.stock||'');
    html+='<div class="strip-card'+(oos?' oos':'')+'" onclick="onProductTap(\''+jss(p.name)+'\')">'
      +'<div class="strip-img '+imgClass+'">'+img+'<span class="strip-fire">🔥</span></div>'
      +'<div class="strip-name">'+esc(p.name)+'</div>'
      +'<div class="strip-bottom">'+(price?'<span class="strip-price">'+fmt(price)+'</span>':'')+(oos?'<span class="strip-oos">Sold out</span>':'<button class="strip-add" onclick="event.stopPropagation();onAdd(\''+jss(p.name)+'\')">+ Add</button>')+'</div>'
      +'</div>';
  });
  html+='</div></div>';
  return html;
}
// Order Again strip — only for customers whose history matches available products
function renderOrderAgainStrip(){
  if(!customerHistoryItems.length)return '';
  var picks=customerHistoryItems.map(function(h){return products.find(function(p){return p.name===h.name})}).filter(function(p){return p});
  if(!picks.length)return '';
  var saved={};try{saved=JSON.parse(localStorage.getItem('ff_cust_v2')||'{}')||{}}catch(e){}
  var greeting=saved.name?'Welcome back, '+saved.name.split(' ')[0]+'!':'Welcome back!';
  var html='<div class="strip strip-again"><div class="strip-h"><h2>🔁 Order Again</h2><span class="strip-sub">'+esc(greeting)+'</span></div><div class="strip-row">';
  picks.slice(0,6).forEach(function(p){
    var price=parseFloat(p.price||'0')||0;
    var img=p.image?'<img src="'+esc(p.image)+'" onerror="this.style.display=\'none\'">':catEmoji(p.category);
    var imgClass=p.image?'':'placeholder';
    var oos=/out\s*of\s*stock|sold\s*out/i.test(p.stock||'')&&!/in\s*stock/i.test(p.stock||'');
    html+='<div class="strip-card'+(oos?' oos':'')+'" onclick="onProductTap(\''+jss(p.name)+'\')">'
      +'<div class="strip-img '+imgClass+'">'+img+'</div>'
      +'<div class="strip-name">'+esc(p.name)+'</div>'
      +'<div class="strip-bottom">'+(price?'<span class="strip-price">'+fmt(price)+'</span>':'')+(oos?'<span class="strip-oos">Sold out</span>':'<button class="strip-add" onclick="event.stopPropagation();onAdd(\''+jss(p.name)+'\')">+ Add</button>')+'</div>'
      +'</div>';
  });
  html+='</div></div>';
  return html;
}
function paintLiveActivity(){
  // Live element removed from above-the-fold. Live counter is now embedded in cart bar via updateCartUI.
  // This stub exists so other call sites don't break.
  updateCartUI();
}

function productHTML(p){
  var name=p.name||'';
  var price=parseFloat(p.price||'0')||0;
  var mrp=parseFloat(p.mrp||'0')||0;
  var disc=mrp>price?Math.round((mrp-price)/mrp*100):0;
  var oos=/out\s*of\s*stock|sold\s*out|0/i.test(p.stock||'')&&!/in\s*stock/i.test(p.stock||'');
  var isVeg=/^(yes|veg|true|1)$/i.test(p.veg||'');
  var isNonVeg=/^(no|nonveg|non-veg|false|0)$/i.test(p.veg||'')||(p.veg&&!isVeg);
  var hasOptions=(p.sizes||p.addons||p.spicy||/^(yes|true|1)$/i.test(p.combo||''));
  var qtyInCart=cartQtyFor(name);
  var imgHtml=p.image?'<img src="'+esc(p.image)+'" onerror="this.parentNode.classList.add(\'placeholder\');this.parentNode.innerHTML=\''+catEmoji(p.category)+'\'">':catEmoji(p.category);
  var imgClass=p.image?'':'placeholder';
  var badges='';
  if(disc>0)badges+='<span class="p-badge disc">'+disc+'% OFF</span>';
  if(/^(yes|true|1)$/i.test(p.bestseller||''))badges+='<span class="p-badge best">⭐ BESTSELLER</span>';
  if(/^(yes|true|1)$/i.test(p.combo||''))badges+='<span class="p-badge combo">🍱 COMBO</span>';
  // Trending badge — top item from order analysis
  var trendIdx=trendingItems.findIndex(function(t){return t.name===name});
  if(trendIdx>=0&&trendIdx<3)badges+='<span class="p-badge trending">🔥 TRENDING</span>';
  var actionHTML;
  if(oos){actionHTML='<span class="oos-tag">Sold out</span>'}
  else if(qtyInCart>0&&!hasOptions){
    actionHTML='<div class="qty-stepper"><button onclick="event.stopPropagation();qtyChange(\''+jss(name)+'\',-1)">−</button><span class="q">'+qtyInCart+'</span><button onclick="event.stopPropagation();qtyChange(\''+jss(name)+'\',1)">+</button></div>';
  }else{
    actionHTML='<button class="add-btn'+(hasOptions?' has-options':'')+'" onclick="event.stopPropagation();onAdd(\''+jss(name)+'\',event)">ADD'+(hasOptions?'':'')+'</button>';
  }
  // Real customer-review rating from Orders sheet (preferred over the static product.rating)
  var realR=itemRatings[name];
  var ratingChip='';
  if(realR&&realR.count>0){
    ratingChip='<span class="product-rating">⭐ '+realR.avg.toFixed(1)+' <span style="opacity:.85;font-weight:600">('+realR.count+')</span></span>';
  }else if(p.rating){
    ratingChip='<span class="product-rating">⭐ '+esc(p.rating)+'</span>';
  }
  // "Ordered before" chip if this customer's history has it
  var prevChip='';
  if(customerHistoryItems.find(function(h){return h.name===name})){
    prevChip='<span class="product-prev">🔁 Ordered before</span>';
  }
  return '<div class="product'+(oos?' oos':'')+'" onclick="onProductTap(\''+jss(name)+'\')"><div class="product-img '+imgClass+'">'+imgHtml+(badges?'<div class="product-badges">'+badges+'</div>':'')+'</div><div class="product-info"><div class="product-name">'+(isVeg?'<span class="veg-d veg"></span>':isNonVeg?'<span class="veg-d nonveg"></span>':'')+'<span>'+esc(name)+'</span></div>'+(p.hindiname?'<div class="product-hindi">'+esc(p.hindiname)+'</div>':'')+'<div class="product-meta">'+ratingChip+(p.preptime||p.prepTime?'<span>⏱ '+esc(p.preptime||p.prepTime)+'</span>':'')+(p.serves?'<span>🍽 Serves '+esc(p.serves)+'</span>':'')+prevChip+'</div>'+(p.description?'<div class="product-desc">'+esc(p.description)+'</div>':'')+'<div class="product-bottom"><div class="product-price"><span class="price">'+fmt(price)+'</span>'+(disc>0?'<span class="mrp">'+fmt(mrp)+'</span>':'')+(p.unit?'<span class="unit">/'+esc(p.unit)+'</span>':'')+'</div>'+actionHTML+'</div></div></div>';
}
function onProductTap(name){
  var p=products.find(function(x){return x.name===name});if(!p)return;
  var oos=/out\s*of\s*stock|sold\s*out/i.test(p.stock||'')&&!/in\s*stock/i.test(p.stock||'');
  if(oos)return;
  // Tap on card opens customization if there are options, else add
  var hasOptions=(p.sizes||p.addons||p.spicy||/^(yes|true|1)$/i.test(p.combo||''));
  if(hasOptions)openCustomize(name);
}
function onAdd(name,evt){
  var p=products.find(function(x){return x.name===name});if(!p)return;
  var hasOptions=(p.sizes||p.addons||p.spicy||/^(yes|true|1)$/i.test(p.combo||''));
  if(hasOptions){openCustomize(name);return}
  // Find the product image element near the clicked button — for fly-to-cart animation
  var srcEl=null;
  try{
    var btn=(evt&&evt.target)||document.activeElement;
    if(btn&&btn.closest){
      var card=btn.closest('.product')||btn.closest('.strip-card');
      if(card){var imgEl=card.querySelector('.product-img,.strip-img');if(imgEl)srcEl=imgEl}
      if(!srcEl)srcEl=btn;
    }
  }catch(e){}
  addToCart(p,null,1,srcEl);
}

// ════════════════════════════════════════════
// CART
// ════════════════════════════════════════════
function cartKey(){return 'ff_cart_v2_'+SHEET_ID}
function loadCart(){try{cart=JSON.parse(localStorage.getItem(cartKey())||'[]')||[]}catch(e){cart=[]}}
function saveCart(){try{localStorage.setItem(cartKey(),JSON.stringify(cart))}catch(e){}}
function cartQtyFor(name){var n=0;cart.forEach(function(c){if(c.name===name&&!c.customization)n+=c.qty});return n}
function addToCart(product,customization,qty,sourceEl){
  qty=qty||1;
  var basePrice=parseFloat(product.price||'0')||0;
  var price=basePrice;
  if(customization){
    if(customization.size)price=customization.size.price;
    if(customization.addons)customization.addons.forEach(function(a){price+=parseFloat(a.price||0)||0});
  }
  try{if(navigator.vibrate)navigator.vibrate(12)}catch(e){}
  // Try to merge if no customization
  if(!customization){
    var existing=cart.find(function(c){return c.name===product.name&&!c.customization});
    if(existing){existing.qty+=qty;saveCart();updateCartUI();flyToCart(sourceEl,product);flashCartBar();return}
  }
  cart.push({name:product.name,category:product.category||'',basePrice:basePrice,price:price,qty:qty,customization:customization,veg:product.veg||'',image:product.image||''});
  saveCart();updateCartUI();flyToCart(sourceEl,product);flashCartBar();
}

// Signature animation: clone product image and fly it to the cart icon along a curve
function flyToCart(sourceEl,product){
  try{
    if(!sourceEl||!sourceEl.getBoundingClientRect)return;
    var bar=$('cartBar');if(!bar||!bar.classList.contains('show'))return;
    var icon=bar.querySelector('.cart-bar-icon');if(!icon)return;
    var src=sourceEl.getBoundingClientRect();
    var dst=icon.getBoundingClientRect();
    var clone=document.createElement('div');
    clone.className='fly-clone';
    var img=product.image?'<img src="'+esc(product.image)+'" style="width:100%;height:100%;object-fit:cover;border-radius:50%">':catEmoji(product.category);
    clone.innerHTML=img;
    clone.style.cssText='position:fixed;left:'+src.left+'px;top:'+src.top+'px;width:'+Math.min(60,src.width)+'px;height:'+Math.min(60,src.height)+'px;border-radius:50%;background:var(--brand);display:flex;align-items:center;justify-content:center;font-size:32px;color:#fff;z-index:500;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.3);overflow:hidden;transition:none';
    document.body.appendChild(clone);
    var midX=(src.left+dst.left)/2;
    var midY=Math.min(src.top,dst.top)-100;
    // Animate via Web Animation API along a curved path (3 keyframes)
    clone.animate([
      {left:src.left+'px',top:src.top+'px',transform:'scale(1) rotate(0deg)',opacity:1,offset:0},
      {left:midX+'px',top:midY+'px',transform:'scale(.8) rotate(180deg)',opacity:.95,offset:0.55},
      {left:dst.left+(dst.width/2-15)+'px',top:dst.top+(dst.height/2-15)+'px',transform:'scale(.15) rotate(360deg)',opacity:0,offset:1}
    ],{duration:700,easing:'cubic-bezier(.5,0,.5,1)'}).onfinish=function(){
      clone.remove();
      // Cart icon bounce + sparkle
      icon.animate([
        {transform:'scale(1)'},
        {transform:'scale(1.3)',offset:0.4},
        {transform:'scale(.92)',offset:0.7},
        {transform:'scale(1)'}
      ],{duration:500,easing:'cubic-bezier(.34,1.56,.64,1)'});
      sparkleAt(dst.left+dst.width/2,dst.top+dst.height/2);
    };
  }catch(e){}
}
function sparkleAt(x,y){
  // 6 small dots burst out from cart icon — gives a "satisfying" feel
  for(var i=0;i<6;i++){
    var d=document.createElement('div');
    var ang=(Math.PI*2/6)*i;
    var dx=Math.cos(ang)*40,dy=Math.sin(ang)*40;
    d.style.cssText='position:fixed;left:'+x+'px;top:'+y+'px;width:6px;height:6px;border-radius:50%;background:#facc15;z-index:501;pointer-events:none;box-shadow:0 0 6px rgba(250,204,21,.6)';
    document.body.appendChild(d);
    d.animate([
      {transform:'translate(-50%,-50%) scale(1)',opacity:1},
      {transform:'translate(calc(-50% + '+dx+'px),calc(-50% + '+dy+'px)) scale(.2)',opacity:0}
    ],{duration:550,easing:'cubic-bezier(.4,0,.2,1)',fill:'forwards'}).onfinish=function(){d.remove()};
  }
}
function qtyChange(name,delta){
  var item=cart.find(function(c){return c.name===name&&!c.customization});
  if(!item){
    if(delta>0){var p=products.find(function(x){return x.name===name});if(p)addToCart(p,null,1);return}
    return;
  }
  item.qty+=delta;
  if(item.qty<=0)cart=cart.filter(function(c){return c!==item});
  saveCart();updateCartUI();renderMenu();
}
function removeCartItem(idx){cart.splice(idx,1);saveCart();updateCartUI();renderMenu()}
function cartItemQtyChange(idx,delta){
  var item=cart[idx];if(!item)return;
  item.qty+=delta;
  if(item.qty<=0)cart.splice(idx,1);
  saveCart();updateCartUI();renderMenu();
}
function cartTotals(){
  var sub=cart.reduce(function(s,c){return s+(c.price*c.qty)},0);
  var deliveryFee=parseFloat(getCfg('DeliveryFee','0'))||0;
  var freeDeliveryThresh=parseFloat(getCfg('FreeDelivery','0'))||0;
  var packingFee=parseFloat(getCfg('PackingFee','0'))||0;
  var taxes=parseFloat(getCfg('Taxes','0'))||0;
  var mode=window._coMode||'delivery';
  var actualDelivery=mode==='delivery'?(freeDeliveryThresh>0&&sub>=freeDeliveryThresh?0:deliveryFee):0;
  var total=sub+actualDelivery+packingFee+taxes;
  return{sub:sub,delivery:actualDelivery,deliveryFee:deliveryFee,freeDeliveryThresh:freeDeliveryThresh,packing:packingFee,taxes:taxes,total:total,mode:mode};
}
function cartCount(){return cart.reduce(function(n,c){return n+c.qty},0)}
function updateCartUI(){
  var n=cartCount();
  var t=cartTotals();
  var bar=$('cartBar');
  if(n>0){
    bar.classList.add('show');
    var cbCount=$('cbCount');if(cbCount)cbCount.textContent=n>9?'9+':n;
    var cbItems=$('cbItemsTxt');if(cbItems)cbItems.textContent=n+' item'+(n!==1?'s':'');
    var cbEta=$('cbEta');
    if(cbEta){
      var eta=getCfg('EstimatedDeliveryTime','25-30 min');
      // Embed live signal — appended subtly to the meta line
      if(_liveOrderCount>0){
        cbEta.innerHTML='ETA '+esc(eta)+' · <span style="color:#7CFFA6">●</span> '+_liveOrderCount+' ordering now';
      }else if(_todayOrderCount>0){
        cbEta.textContent='ETA '+eta+' · '+_todayOrderCount+' orders today';
      }else{
        cbEta.textContent='ETA '+eta;
      }
    }
    $('cbTotal').textContent=fmt(t.sub);
    if(t.freeDeliveryThresh>0&&t.sub<t.freeDeliveryThresh){
      $('cbProgress').style.display='block';
      $('cbProgressFill').style.width=Math.min(100,(t.sub/t.freeDeliveryThresh*100))+'%';
      var pt=$('cbProgressText');if(pt){pt.style.display='block';pt.textContent='Add '+fmt(t.freeDeliveryThresh-t.sub)+' more for FREE delivery 🛵'}
    }else if(t.freeDeliveryThresh>0&&t.sub>=t.freeDeliveryThresh&&t.mode==='delivery'){
      $('cbProgress').style.display='block';
      $('cbProgressFill').style.width='100%';
      var pt2=$('cbProgressText');if(pt2){pt2.style.display='block';pt2.textContent='✓ FREE delivery applied'}
    }else{
      $('cbProgress').style.display='none';
      var pt3=$('cbProgressText');if(pt3)pt3.style.display='none';
    }
    var tb=$('tbCartN');if(tb){tb.style.display='flex';tb.textContent=n>9?'9+':n}
  }else{
    bar.classList.remove('show');
    var tb2=$('tbCartN');if(tb2)tb2.style.display='none';
  }
}
function flashCartBar(){
  var b=$('cartBar');if(!b)return;
  b.style.animation='cartPop .35s cubic-bezier(.34,1.5,.64,1)';
  setTimeout(function(){b.style.animation=''},360);
}
function clearCart(){
  if(!cart.length)return;
  if(!confirm('Remove all items from cart?'))return;
  cart=[];saveCart();updateCartUI();renderCartSheet();renderMenu();
  showToast('Cart cleared','success');
}

// ════════════════════════════════════════════
// CART SHEET
// ════════════════════════════════════════════
function openCart(){renderCartSheet();$('cartSheet').classList.add('open')}
function closeSheet(id){$(id).classList.remove('open')}
function renderCartSheet(){
  if(!cart.length){$('cartBody').innerHTML='<div class="cart-empty"><div class="cart-empty-em">🛒</div><h3 style="font:800 16px var(--f);color:var(--ink);margin-bottom:4px">Your cart is empty</h3><p style="font:500 12px var(--f);color:var(--ink3)">Add some delicious items to get started!</p><button class="btn btn-primary" style="margin-top:18px" onclick="closeSheet(\'cartSheet\')">Browse Menu</button></div>';$('cartFoot').style.display='none';return}
  var html='';
  // Free-delivery progress at top of cart (for delivery mode)
  var t=cartTotals();
  if(t.freeDeliveryThresh>0&&t.sub<t.freeDeliveryThresh&&t.mode==='delivery'){
    var pct=Math.min(100,(t.sub/t.freeDeliveryThresh*100));
    html+='<div class="cart-fdp"><div class="cart-fdp-text">🛵 Add <b>'+fmt(t.freeDeliveryThresh-t.sub)+'</b> more for FREE delivery</div><div class="cart-fdp-bar"><div class="cart-fdp-fill" style="width:'+pct+'%"></div></div></div>';
  }else if(t.freeDeliveryThresh>0&&t.delivery===0&&t.mode==='delivery'&&t.sub>=t.freeDeliveryThresh){
    html+='<div class="cart-fdp done"><div class="cart-fdp-text">🎉 <b>FREE delivery</b> unlocked!</div></div>';
  }
  // Items header
  html+='<div class="cart-items-h"><span>'+cartCount()+' item'+(cartCount()!==1?'s':'')+' in cart</span><button class="cart-clear" onclick="clearCart()">Clear all</button></div>';
  // Items list
  cart.forEach(function(c,i){
    var isVeg=/^(yes|veg|true|1)$/i.test(c.veg||'');
    var custTxt='';
    if(c.customization){
      var parts=[];
      if(c.customization.size)parts.push(c.customization.size.name);
      if(c.customization.spice)parts.push(c.customization.spice);
      if(c.customization.addons&&c.customization.addons.length)parts.push('+'+c.customization.addons.map(function(a){return a.name}).join(', +'));
      if(c.customization.instructions)parts.push('📝 '+c.customization.instructions);
      custTxt=parts.join(' · ');
    }
    var img=c.image?'<img src="'+esc(c.image)+'" onerror="this.parentNode.classList.add(\'placeholder\');this.parentNode.innerHTML=\''+catEmoji(c.category)+'\'">':catEmoji(c.category);
    var imgClass=c.image?'':'placeholder';
    html+='<div class="cart-item"><div class="cart-item-img '+imgClass+'">'+img+'</div><div class="cart-item-info"><div class="cart-item-name">'+(c.veg?'<span class="veg-d '+(isVeg?'veg':'nonveg')+'"></span>':'')+'<span>'+esc(c.name)+'</span></div>'+(custTxt?'<div class="cart-item-cust">'+esc(custTxt)+'</div>':'')+'<div class="cart-item-bottom"><div class="cart-item-mini-stepper"><button onclick="cartItemQtyChange('+i+',-1);renderCartSheet()">−</button><span class="q">'+c.qty+'</span><button onclick="cartItemQtyChange('+i+',1);renderCartSheet()">+</button></div><div class="cart-item-price">'+fmt(c.price*c.qty)+'</div></div></div></div>';
  });
  // Bill summary — premium style
  html+='<div class="bill-card"><div class="bill-h">💰 Bill Details</div>';
  html+='<div class="bill-row"><span>Item Total</span><span>'+fmt(t.sub)+'</span></div>';
  if(t.deliveryFee>0&&t.mode==='delivery'){
    if(t.delivery===0)html+='<div class="bill-row"><span>Delivery Charge</span><span><s style="opacity:.5">'+fmt(t.deliveryFee)+'</s> <span class="bill-free">FREE</span></span></div>';
    else html+='<div class="bill-row"><span>Delivery Charge</span><span>'+fmt(t.delivery)+'</span></div>';
  }
  if(t.packing>0)html+='<div class="bill-row"><span>Packing Charges</span><span>'+fmt(t.packing)+'</span></div>';
  if(t.taxes>0)html+='<div class="bill-row"><span>Taxes</span><span>'+fmt(t.taxes)+'</span></div>';
  html+='<div class="bill-row total"><span>To Pay</span><span>'+fmt(t.total)+'</span></div>';
  html+='</div>';
  $('cartBody').innerHTML=html;
  $('cartFoot').style.display='block';
  $('cartFootTotal').textContent=fmt(t.total);
}

// ════════════════════════════════════════════
// CUSTOMIZATION
// ════════════════════════════════════════════
function openCustomize(name){
  var p=products.find(function(x){return x.name===name});if(!p)return;
  _custCtx={product:p,size:null,addons:[],spice:'',instructions:'',qty:1};
  var sizes=parseSizes(p.sizes);
  var addons=parseSizes(p.addons);
  if(sizes.length)_custCtx.size=sizes[0];
  $('custTitle').textContent=p.name;
  var html='<div class="cust-img" style="'+(p.image?'background-image:url('+esc(p.image)+')':'')+'">'+(p.image?'':catEmoji(p.category))+'</div>';
  html+='<div class="cust-name">'+esc(p.name)+'</div>';
  if(p.description)html+='<div class="cust-desc">'+esc(p.description)+'</div>';
  if(sizes.length){
    html+='<div class="cust-section"><div class="cust-section-h">Choose Size <span class="cust-section-h-r">Required</span></div><div class="cust-opts" id="custSizes"></div></div>';
  }
  if(addons.length){
    html+='<div class="cust-section"><div class="cust-section-h">Add-ons <span class="cust-section-h-r">Optional</span></div><div class="cust-opts" id="custAddons"></div></div>';
  }
  if(p.spicy||/spice|spicy/i.test(p.spicelevel||'')){
    html+='<div class="cust-section"><div class="cust-section-h">Spice Level <span class="cust-section-h-r">Choose one</span></div><div class="cust-spice"><div class="cust-spice-opt" data-spice="Mild"><span class="cust-spice-em">🌶</span>Mild</div><div class="cust-spice-opt" data-spice="Medium"><span class="cust-spice-em">🌶🌶</span>Medium</div><div class="cust-spice-opt" data-spice="Spicy"><span class="cust-spice-em">🌶🌶🌶</span>Spicy</div></div></div>';
  }
  html+='<div class="cust-section"><div class="cust-section-h">Special Instructions <span class="cust-section-h-r">Optional</span></div><textarea class="field-i" id="custInstr" placeholder="e.g. less oil, extra spicy, no onions..."></textarea></div>';
  $('custBody').innerHTML=html;
  // Populate sizes
  if(sizes.length){
    $('custSizes').innerHTML=sizes.map(function(s,i){
      return '<div class="cust-opt'+(i===0?' active':'')+'" data-size-i="'+i+'" onclick="custSelectSize('+i+')"><div class="cust-radio"></div><div class="cust-opt-name">'+esc(s.name)+'</div><div class="cust-opt-price">'+fmt(s.price)+'</div></div>';
    }).join('');
    _custCtx._sizes=sizes;
  }
  // Populate addons
  if(addons.length){
    $('custAddons').innerHTML=addons.map(function(a,i){
      return '<div class="cust-opt" data-addon-i="'+i+'" onclick="custToggleAddon('+i+')"><div class="cust-checkbox">✓</div><div class="cust-opt-name">'+esc(a.name)+'</div><div class="cust-opt-price">+'+fmt(a.price)+'</div></div>';
    }).join('');
    _custCtx._addons=addons;
  }
  // Spice levels
  document.querySelectorAll('.cust-spice-opt').forEach(function(el){
    el.onclick=function(){_custCtx.spice=el.dataset.spice;document.querySelectorAll('.cust-spice-opt').forEach(function(e){e.classList.remove('active')});el.classList.add('active');updateCustTotal()};
  });
  $('custQty').textContent='1';
  $('custQtyMinus').disabled=true;
  updateCustTotal();
  $('custSheet').classList.add('open');
}
function parseSizes(s){
  if(!s)return[];
  return s.split(/[,;\n]/).map(function(x){
    var p=x.split(':');
    var name=(p[0]||'').trim();var price=parseFloat((p[1]||'').replace(/[^\d.]/g,''))||0;
    return name?{name:name,price:price}:null;
  }).filter(Boolean);
}
function custSelectSize(i){
  if(!_custCtx||!_custCtx._sizes)return;
  _custCtx.size=_custCtx._sizes[i];
  document.querySelectorAll('[data-size-i]').forEach(function(e){e.classList.remove('active')});
  document.querySelector('[data-size-i="'+i+'"]').classList.add('active');
  updateCustTotal();
}
function custToggleAddon(i){
  if(!_custCtx||!_custCtx._addons)return;
  var a=_custCtx._addons[i];
  var existing=_custCtx.addons.findIndex(function(x){return x.name===a.name});
  if(existing>=0)_custCtx.addons.splice(existing,1);
  else _custCtx.addons.push(a);
  document.querySelector('[data-addon-i="'+i+'"]').classList.toggle('active');
  updateCustTotal();
}
function custQtyChange(d){
  _custCtx.qty=Math.max(1,_custCtx.qty+d);
  $('custQty').textContent=_custCtx.qty;
  $('custQtyMinus').disabled=_custCtx.qty<=1;
  updateCustTotal();
}
function updateCustTotal(){
  if(!_custCtx)return;
  var price=_custCtx.size?_custCtx.size.price:(parseFloat(_custCtx.product.price||'0')||0);
  _custCtx.addons.forEach(function(a){price+=parseFloat(a.price||0)||0});
  $('custTotal').textContent=fmt(price*_custCtx.qty);
}
function addCustomized(){
  if(!_custCtx)return;
  var instr=$('custInstr').value.trim();
  _custCtx.instructions=instr;
  var customization={size:_custCtx.size,addons:_custCtx.addons.slice(),spice:_custCtx.spice,instructions:instr};
  // If no real customization (no size, no addons, no spice, no instructions), simplify
  if(!customization.size&&!customization.addons.length&&!customization.spice&&!customization.instructions)customization=null;
  addToCart(_custCtx.product,customization,_custCtx.qty);
  closeSheet('custSheet');
  showToast('✓ Added to cart','success');
  renderMenu();
}

// ════════════════════════════════════════════
// CHECKOUT
// ════════════════════════════════════════════
function openCheckout(){
  if(!cart.length)return;
  var minOrd=parseFloat(getCfg('MinOrder','0'))||0;
  var t=cartTotals();
  if(minOrd&&t.sub<minOrd){showToast('Min order: '+fmt(minOrd)+'. Add '+fmt(minOrd-t.sub)+' more','error');return}
  if(!isStoreOpen()){if(!confirm('Store is currently closed. Place advance order anyway?'))return}
  closeSheet('cartSheet');
  window._coMode=window._coMode||'delivery';
  window._coPayment=window._coPayment||'cod';
  renderCheckout();
  $('checkoutSheet').classList.add('open');
}
function renderCheckout(){
  var saved={};try{saved=JSON.parse(localStorage.getItem('ff_cust_v2')||'{}')||{}}catch(e){}
  var html='';
  // ─── How would you like it? ───
  html+='<div class="checkout-section-h">📦 How would you like it?</div>';
  html+='<div class="mode-tabs">'
    +'<button class="mode-tab '+(window._coMode==='delivery'?'active':'')+'" onclick="setMode(\'delivery\')"><span class="mode-em">🛵</span><span>Delivery</span><span class="mode-sub">to your door</span></button>'
    +'<button class="mode-tab '+(window._coMode==='pickup'?'active':'')+'" onclick="setMode(\'pickup\')"><span class="mode-em">🏪</span><span>Pickup</span><span class="mode-sub">save delivery fee</span></button>'
    +'</div>';
  // ─── Contact info ───
  html+='<div class="checkout-section-h">👤 Your Details</div>';
  html+='<div class="field"><label class="field-l">Your Name *</label><input class="field-i" id="coName" value="'+esc(saved.name||'')+'" placeholder="Full name"></div>';
  html+='<div class="field"><label class="field-l">Phone Number *</label><input class="field-i" id="coPhone" type="tel" value="'+esc(saved.phone||'')+'" placeholder="10-digit number" maxlength="10" inputmode="numeric"></div>';
  if(window._coMode==='delivery'){
    html+='<div class="checkout-section-h">📍 Delivery Address</div>';
    html+='<div class="field"><div class="field-row"><textarea class="field-i" id="coAddress" placeholder="House/Flat no., Street, Landmark, Area">'+esc(saved.address||'')+'</textarea><button class="use-loc" onclick="useLocation()">📍 GPS</button></div></div>';
  }
  html+='<div class="field"><label class="field-l">Notes for the shop (optional)</label><input class="field-i" id="coNotes" placeholder="e.g. ring the bell · less spicy · call before delivery"></div>';
  // ─── Payment ───
  html+='<div class="checkout-section-h">💳 Payment Method</div>';
  html+='<div class="pay-grid"><div class="pay-opt '+(window._coPayment==='cod'?'active':'')+'" onclick="setPayment(\'cod\')"><div class="pay-em">💵</div><div class="pay-name">Cash</div><div class="pay-sub">Pay on '+(window._coMode==='pickup'?'pickup':'delivery')+'</div></div><div class="pay-opt '+(window._coPayment==='upi'?'active':'')+'" onclick="setPayment(\'upi\')"><div class="pay-em">📱</div><div class="pay-name">UPI / QR</div><div class="pay-sub">GPay · PhonePe · Paytm</div></div></div>';
  // UPI section
  var upi=getCfg('UPI','');
  if(window._coPayment==='upi'&&upi){
    html+='<div class="upi-card" id="upiCard"><div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;margin-bottom:8px">Scan to pay</div><div class="upi-qr-wrap" id="qrWrap"></div><div class="upi-id" onclick="copyUpi()">'+esc(upi)+' · tap to copy</div><div class="upi-amt" id="upiAmt"></div><div class="upi-apps"><a class="upi-app gpay" id="upiGpay">GPay</a><a class="upi-app phonepe" id="upiPhonepe">PhonePe</a><a class="upi-app paytm" id="upiPaytm">Paytm</a></div></div>';
  }
  // Bill summary
  html+='<div class="checkout-section-h">💰 Bill Details</div>';
  var t=cartTotals();
  html+='<div class="bill-card" style="margin-top:0"><div class="bill-row"><span>Item Total ('+cartCount()+' items)</span><span>'+fmt(t.sub)+'</span></div>';
  if(t.deliveryFee>0&&window._coMode==='delivery'){
    if(t.delivery===0)html+='<div class="bill-row"><span>Delivery</span><span><s style="opacity:.5">'+fmt(t.deliveryFee)+'</s> <span class="bill-free">FREE</span></span></div>';
    else html+='<div class="bill-row"><span>Delivery</span><span>'+fmt(t.delivery)+'</span></div>';
  }
  if(t.packing>0)html+='<div class="bill-row"><span>Packing</span><span>'+fmt(t.packing)+'</span></div>';
  if(t.taxes>0)html+='<div class="bill-row"><span>Taxes</span><span>'+fmt(t.taxes)+'</span></div>';
  html+='<div class="bill-row total"><span>To Pay</span><span>'+fmt(t.total)+'</span></div></div>';
  $('checkoutBody').innerHTML=html;
  $('coTotal').textContent=fmt(t.total);
  if(window._coPayment==='upi'&&upi)renderUPI(upi,t.total);
}
function setMode(m){window._coMode=m;renderCheckout()}
function setPayment(p){window._coPayment=p;renderCheckout()}
function renderUPI(upi,amount){
  var amt=Math.round(amount);
  $('upiAmt').textContent='₹'+amt;
  var shop=getCfg('ShopName','Store');
  var note='Order from '+shop;
  var url='upi://pay?pa='+encodeURIComponent(upi)+'&pn='+encodeURIComponent(shop)+'&am='+amt+'&cu=INR&tn='+encodeURIComponent(note);
  $('upiGpay').href=url;$('upiGpay').target='_blank';
  $('upiPhonepe').href='phonepe://pay?pa='+encodeURIComponent(upi)+'&pn='+encodeURIComponent(shop)+'&am='+amt+'&cu=INR';
  $('upiPaytm').href='paytmmp://pay?pa='+encodeURIComponent(upi)+'&pn='+encodeURIComponent(shop)+'&am='+amt+'&cu=INR';
  $('qrWrap').innerHTML='';
  try{new QRCode($('qrWrap'),{text:url,width:176,height:176,correctLevel:QRCode.CorrectLevel.M})}catch(e){}
}
function copyUpi(){var u=getCfg('UPI','');if(!u)return;navigator.clipboard.writeText(u).then(function(){showToast('✓ UPI ID copied','success')})}
function useLocation(){
  if(!navigator.geolocation){showToast('Location not supported','error');return}
  showToast('📍 Getting your location...');
  navigator.geolocation.getCurrentPosition(function(pos){
    var lat=pos.coords.latitude.toFixed(5),lng=pos.coords.longitude.toFixed(5);
    var addr='https://maps.google.com/?q='+lat+','+lng;
    var current=$('coAddress').value;
    $('coAddress').value=(current?current+'\n':'')+'GPS: '+lat+', '+lng+' ('+addr+')';
    showToast('✓ Location added','success');
  },function(){showToast('Could not get location','error')},{enableHighAccuracy:true,timeout:10000});
}

// ════════════════════════════════════════════
// PLACE ORDER
// ════════════════════════════════════════════
function placeOrder(){
  var name=$('coName').value.trim();
  var phone=$('coPhone').value.trim().replace(/\D/g,'');
  var addr=window._coMode==='delivery'?$('coAddress').value.trim():'';
  var notes=$('coNotes').value.trim();
  var bad=false;
  ['coName','coPhone'].forEach(function(id){var el=$(id);if(!el.value.trim()){el.classList.add('invalid');bad=true}else el.classList.remove('invalid')});
  if(window._coMode==='delivery'&&!addr){$('coAddress').classList.add('invalid');bad=true}else if($('coAddress'))$('coAddress').classList.remove('invalid');
  if(phone.length<10){$('coPhone').classList.add('invalid');bad=true}
  if(bad){showToast('Please fill required fields','error');return}
  // Build order
  var orderId='ORD-'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).substr(2,3).toUpperCase();
  var t=cartTotals();
  var itemsStr=cart.map(function(c){
    var line=c.qty+'x '+c.name;
    if(c.customization){
      var parts=[];
      if(c.customization.size)parts.push(c.customization.size.name);
      if(c.customization.spice)parts.push(c.customization.spice);
      if(c.customization.addons&&c.customization.addons.length)parts.push('+'+c.customization.addons.map(function(a){return a.name}).join(', +'));
      if(c.customization.instructions)parts.push('Note: '+c.customization.instructions);
      if(parts.length)line+=' ['+parts.join(' | ')+']';
    }
    line+=' = '+fmt(c.price*c.qty);
    return line;
  }).join('\n');
  // Save customer
  try{localStorage.setItem('ff_cust_v2',JSON.stringify({name:name,phone:phone,address:addr}))}catch(e){}
  // Save order ID for tracking
  try{
    var arr=JSON.parse(localStorage.getItem('ff_recent_v2')||'[]');
    arr.unshift({id:orderId,ts:Date.now(),total:t.total,name:name});
    arr=arr.slice(0,8);
    localStorage.setItem('ff_recent_v2',JSON.stringify(arr));
  }catch(e){}
  // Track item frequency for "Order Again" suggestions
  try{
    var hist=JSON.parse(localStorage.getItem('ff_history_items_v2')||'{}')||{};
    cart.forEach(function(c){if(c.name)hist[c.name]=(hist[c.name]||0)+(c.qty||1)});
    localStorage.setItem('ff_history_items_v2',JSON.stringify(hist));
  }catch(e){}
  lastOrder={id:orderId,name:name,phone:phone,addr:addr,notes:notes,items:itemsStr,total:t.total,subtotal:t.sub,delivery:t.delivery,packing:t.packing,mode:window._coMode,payment:window._coPayment};
  $('placeOrderBtn').textContent='Placing order...';
  $('placeOrderBtn').disabled=true;
  // Send to Apps Script (fire-and-forget)
  var params='action=newOrder&id='+encodeURIComponent(orderId)+'&name='+encodeURIComponent(name)+'&phone='+encodeURIComponent(phone)+'&address='+encodeURIComponent(addr)+'&items='+encodeURIComponent(itemsStr)+'&total='+t.total+'&mode='+window._coMode+'&payment='+window._coPayment+'&notes='+encodeURIComponent(notes)+'&date='+encodeURIComponent(new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}));
  sendCmd(params,function(){});
  // Clear cart
  cart=[];saveCart();updateCartUI();
  closeSheet('checkoutSheet');
  setTimeout(function(){$('placeOrderBtn').textContent='Place Order';$('placeOrderBtn').disabled=false},2000);
  showOrderSuccess();
}
function showOrderSuccess(){
  $('successId').textContent='#'+lastOrder.id;
  var eta=getCfg('EstimatedDeliveryTime','30-45 min');
  $('successEta').textContent='⏱ ETA: '+eta+' · '+(lastOrder.mode==='delivery'?'Delivery':'Pickup');
  $('successSub').textContent=lastOrder.mode==='delivery'?"We're preparing your order. The shop will confirm shortly":"Your order is confirmed. Visit the store to pick up";
  $('successModal').classList.add('open');
  // Sound + vibrate (gesture from button click)
  try{if(navigator.vibrate)navigator.vibrate([100,50,100])}catch(e){}
}
function closeSuccess(){$('successModal').classList.remove('open')}
// One-tap from success modal → tracking opens AND auto-fires lookup with the just-placed order ID
function trackLastOrder(){
  var id=lastOrder&&lastOrder.id?lastOrder.id:'';
  closeSuccess();
  if(id)openTrack(id);
  else openTrack();
}
function copySuccessOrderId(el){
  var id=lastOrder&&lastOrder.id?lastOrder.id:el.textContent.replace(/^#/,'');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(id).then(function(){
      var orig=el.textContent;el.textContent='✓ Copied!';
      setTimeout(function(){el.textContent=orig},1400);
    }).catch(function(){});
  }
}
function shareToWhatsApp(){
  if(!lastOrder)return;
  var shop=getCfg('ShopName','Store');
  var wa=getCfg('WhatsApp','')||getCfg('Phone','');
  wa=wa.replace(/\D/g,'');if(wa.length===10)wa='91'+wa;
  var modeStr=lastOrder.mode==='delivery'?'🛵 Home Delivery':'🏪 Pickup';
  var msg='Hi! New order:\n\n*Order #'+lastOrder.id+'*\n\n👤 '+lastOrder.name+'\n📞 '+lastOrder.phone+'\n'+(lastOrder.addr?'📍 '+lastOrder.addr:'🏪 Pickup')+'\n\n*Items:*\n'+lastOrder.items+'\n\n💰 Subtotal: '+fmt(lastOrder.subtotal)+'\n'+(lastOrder.delivery>0?'🛵 Delivery: '+fmt(lastOrder.delivery):lastOrder.mode==='delivery'?'🛵 FREE delivery':'')+'\n*Total: '+fmt(lastOrder.total)+'*\n\n💳 Payment: '+(lastOrder.payment==='upi'?'UPI':'Cash on '+(lastOrder.mode==='pickup'?'Pickup':'Delivery'))+'\n\n_'+modeStr+'_'+(lastOrder.notes?'\n📝 '+lastOrder.notes:'');
  if(wa)window.open('https://wa.me/'+wa+'?text='+encodeURIComponent(msg),'_blank');
  else window.open('https://wa.me/?text='+encodeURIComponent(msg),'_blank');
}

// ════════════════════════════════════════════
// TRACK ORDER
// ════════════════════════════════════════════
function openTrack(prefilledId){
  renderTrack(prefilledId);
  $('trackSheet').classList.add('open');
  if(prefilledId){
    setTimeout(function(){
      var el=$('trackId');if(el){el.value=prefilledId;checkTrack()}
    },50);
  }
}
function renderTrack(prefilledId){
  var html='<div class="track-input-row"><input class="field-i" id="trackId" placeholder="Enter order ID (e.g. ORD-XXXXX)" value="'+esc(prefilledId||'')+'"><button class="btn btn-primary" onclick="checkTrack()">Track</button></div>';
  var recent=[];try{recent=JSON.parse(localStorage.getItem('ff_recent_v2')||'[]')||[]}catch(e){}
  if(recent.length){
    html+='<div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;margin:14px 0 6px">Recent Orders</div><div class="recent-orders">';
    recent.forEach(function(o){
      var ago=Math.floor((Date.now()-o.ts)/60000);
      var agoTxt=ago<1?'now':ago<60?ago+'m ago':ago<1440?Math.floor(ago/60)+'h ago':Math.floor(ago/1440)+'d ago';
      html+='<div class="recent-order" onclick="document.getElementById(\'trackId\').value=\''+jss(o.id)+'\';checkTrack()"><span class="id">#'+esc(o.id)+'</span><span style="font-size:11px;color:var(--ink2);font-weight:600">'+esc(o.name||'Order')+'</span><span class="ago">'+agoTxt+'</span></div>';
    });
    html+='</div>';
  }
  html+='<div id="trackResult" style="margin-top:14px"></div>';
  $('trackBody').innerHTML=html;
}
function checkTrack(){
  var id=$('trackId').value.trim().toUpperCase();
  if(!id){return}
  $('trackResult').innerHTML='<div class="spinner" style="margin:30px auto"></div>';
  loadSheet(SHEET_ID,'Orders',function(r){
    if(!r){$('trackResult').innerHTML='<div class="empty-msg" style="padding:30px"><p>Could not load orders</p></div>';return}
    var parsed=parseSheetRows(r);
    var found=parsed.rows.find(function(o){return(o.orderid||'').toUpperCase()===id});
    if(!found){$('trackResult').innerHTML='<div class="empty-msg" style="padding:30px"><div style="font-size:36px">🔍</div><p>Order not found. Check the ID and try again.</p></div>';return}
    var status=(found.status||'New').toLowerCase().trim();
    var steps=[
      {k:'new',l:'Received',e:'📥'},
      {k:'confirmed',l:'Confirmed',e:'✅'},
      {k:'packed',l:(found.mode||'').toLowerCase()==='delivery'?'On the Way':'Ready',e:(found.mode||'').toLowerCase()==='delivery'?'🛵':'📦'},
      {k:'done',l:'Delivered',e:'🎉'}
    ];
    var sIdx=0;
    if(/cancel/.test(status))sIdx=-1;
    else if(/deliver|done|complete|picked/.test(status))sIdx=3;
    else if(/pack|out\s*for/.test(status))sIdx=2;
    else if(/confirm/.test(status))sIdx=1;
    var statusClass=sIdx<0?'cancelled':(sIdx===3?'done':'');
    var statusEmoji=sIdx<0?'❌':steps[sIdx>=0?sIdx:0].e;
    var statusLabel=sIdx<0?'Cancelled':steps[sIdx].l;
    var eta=getCfg('EstimatedDeliveryTime','25-30 min');
    var modeLabel=String(found.mode||'').toLowerCase()==='delivery'?'🛵 Delivery':'🏪 Pickup';
    var html='<div class="track-status">';
    html+='<div class="track-status-card '+statusClass+'">';
    html+='<div class="track-status-l">Order #'+esc(id)+' · '+modeLabel+'</div>';
    html+='<div class="track-status-v">'+statusEmoji+' '+esc(statusLabel)+'</div>';
    if(sIdx>=0&&sIdx<3)html+='<div class="track-status-eta"><span class="track-live-dot"></span><span>ETA: '+esc(eta)+'</span></div>';
    if(sIdx===3)html+='<div class="track-status-eta">🎉 Order delivered · enjoy!</div>';
    html+='</div>';
    // Shopkeeper update — surface prominently
    if(found.shopkeepercomment||found.comment){html+='<div style="margin-top:14px;padding:14px;background:linear-gradient(135deg,rgba(37,211,102,.08),rgba(37,211,102,.04));border-left:4px solid #25d366;border-radius:0 14px 14px 0;font-size:13px;line-height:1.5;color:var(--ink)"><b style="color:#1da851;font-size:10px;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">💬 Message from the shop</b>'+esc(found.shopkeepercomment||found.comment).split(' | ').map(function(p){return p.trim()}).filter(function(p){return p}).map(function(p){return '<div style="margin-top:4px">'+p+'</div>'}).join('')+'</div>'}
    if(sIdx>=0){
      html+='<div class="track-stepper">';
      steps.forEach(function(s,i){
        var cls=i<sIdx?'done':(i===sIdx?'current':'');
        html+='<div class="track-step '+cls+'"><div class="track-dot">'+(i<sIdx?'✓':s.e)+'</div><div class="track-step-l">'+s.l+'</div></div>';
      });
      html+='</div>';
    }
    // Order details
    html+='<div style="margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px"><div style="font:800 11px var(--f);color:var(--ink3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">📋 Order details</div><div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:var(--ink);padding:6px 0;border-top:1px dashed var(--line)"><span>Total Paid</span><span>'+fmt(found.total||0)+'</span></div></div>';

    // ─── REVIEW: prompt if delivered & not yet reviewed; show if already reviewed ───
    var rStars=parseInt(found.reviewstars||'0')||0;
    var rText=found.reviewtext||'';
    var rWhen=found.reviewedat||'';
    var done=sIdx===3;
    if(rStars>0){
      var starGlyphs='';for(var s=0;s<5;s++)starGlyphs+=(s<rStars?'⭐':'☆');
      html+='<div class="ff-review-shown"><div class="ff-review-shown-stars">'+starGlyphs+'</div>'+(rText?'<div class="ff-review-shown-text">"'+esc(rText)+'"</div>':'')+(rWhen?'<div class="ff-review-shown-when">Reviewed '+esc(rWhen)+'</div>':'')+'</div>';
    }else if(done){
      html+='<div class="ff-review-card">'
        +'<div class="ff-review-card-l">⭐ Your feedback</div>'
        +'<h3>How was your order?</h3>'
        +'<p>Help the shop improve — takes 5 seconds.</p>'
        +'<div class="ff-stars" id="ffStars">'
        +'<button class="ff-star" data-star="1" onclick="ffSetStars(1)">★</button>'
        +'<button class="ff-star" data-star="2" onclick="ffSetStars(2)">★</button>'
        +'<button class="ff-star" data-star="3" onclick="ffSetStars(3)">★</button>'
        +'<button class="ff-star" data-star="4" onclick="ffSetStars(4)">★</button>'
        +'<button class="ff-star" data-star="5" onclick="ffSetStars(5)">★</button>'
        +'</div>'
        +'<textarea class="ff-review-text" id="ffReviewText" placeholder="Optional comment about quality, speed, packaging..."></textarea>'
        +'<button class="ff-review-submit" id="ffReviewSubmit" disabled onclick="ffSubmitReview(\''+esc(id)+'\')">Submit Review</button>'
        +'</div>';
    }
    $('trackResult').innerHTML=html;
  });
}

// ─── REVIEW: star picker + submit (fastfood-v2) ───
var _ffStars=0;
function ffSetStars(n){
  _ffStars=n;
  document.querySelectorAll('#ffStars .ff-star').forEach(function(el){
    var s=parseInt(el.dataset.star);el.classList.toggle('on',s<=n);
  });
  var btn=$('ffReviewSubmit');if(btn)btn.disabled=false;
}
function ffSubmitReview(orderId){
  if(!_ffStars)return;
  var text=($('ffReviewText')||{}).value||'';text=String(text).trim().slice(0,500);
  var btn=$('ffReviewSubmit');
  if(btn){btn.disabled=true;btn.innerHTML='Sending...'}
  if(!SCRIPT_URL){if(btn){btn.innerHTML='⚠️ No script URL';btn.style.background='var(--red)'}return}
  var img=new Image();
  img.onload=img.onerror=function(){
    if(btn){btn.innerHTML='✓ Thanks for your review!';btn.style.background='var(--green)'}
    setTimeout(function(){checkTrack()},1200);
  };
  img.src=SCRIPT_URL+'?action=submitReview&orderId='+encodeURIComponent(orderId)+'&stars='+_ffStars+'&text='+encodeURIComponent(text);
  _ffStars=0;
}

// ════════════════════════════════════════════
// DAILY SPECIAL
// ════════════════════════════════════════════
function paintDailySpecial(){
  var name=getCfg('DailySpecial','');if(!name){$('dailySpecialSlot').innerHTML='';return}
  var price=getCfg('DailySpecialPrice','');
  var hindi=getCfg('DailySpecialHindi','');
  var desc=getCfg('DailySpecialDesc','');
  var img=getCfg('DailySpecialImage','');
  if(!img){var p=products.find(function(x){return x.name.toLowerCase()===name.toLowerCase()});if(p)img=p.image||''}
  var html='<div class="special" onclick="onSpecialTap()">';
  if(img)html+='<div class="special-img" style="background-image:url('+esc(img)+')"></div>';
  html+='<div class="special-content"><div class="special-pre">🔥 आज का स्पेशल · Today\'s Special</div><div class="special-name">'+esc(name)+'</div>';
  if(hindi)html+='<div class="special-hindi">'+esc(hindi)+'</div>';
  if(desc)html+='<div class="special-desc">'+esc(desc)+'</div>';
  html+='<div class="special-bottom">';
  html+='<button class="special-cta">Order Now ›</button>';
  if(price)html+='<div class="special-price"><span class="special-price-l">Only</span><span class="special-price-amt">'+(getCfg('Currency','₹'))+esc(price)+'</span></div>';
  html+='</div>';
  html+='</div></div>';
  $('dailySpecialSlot').innerHTML=html;
}
function onSpecialTap(){
  var name=(getCfg('DailySpecial','')||'').trim();
  if(!name)return;
  // 1. Try exact match
  var p=products.find(function(x){return(x.name||'').toLowerCase().trim()===name.toLowerCase()});
  if(p){onProductTap(p.name)||onAdd(p.name);return}
  // 2. Try contains match — special name "contains" product name (or vice versa)
  var nLow=name.toLowerCase();
  p=products.find(function(x){var pn=(x.name||'').toLowerCase().trim();return pn&&(nLow.indexOf(pn)>=0||pn.indexOf(nLow)>=0)});
  if(p){onProductTap(p.name)||onAdd(p.name);return}
  // 3. Fallback — just scroll to the menu, don't break it by filtering
  showToast('Add this combo to your Products sheet to make it tappable','success');
  var m=$('menu');if(m)m.scrollIntoView({behavior:'smooth',block:'start'});
}

// ════════════════════════════════════════════
// PWA INSTALL
// ════════════════════════════════════════════
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();_installEvt=e;showInstallBanner()});
function isStandalone(){return window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true}
function isIOS(){return /iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream}
function showInstallBanner(){
  if(isStandalone())return;
  if(localStorage.getItem('ff_install_dismissed_v2'))return;
  var b=$('installBanner');if(!b)return;
  setTimeout(function(){b.classList.add('show')},3500);
  $('installBtn').textContent=_installEvt?'Install':'How?';
}
function clickInstall(){
  if(isStandalone()){showToast('✓ Already installed','success');return}
  if(_installEvt){_installEvt.prompt();_installEvt.userChoice.then(function(c){if(c.outcome==='accepted')showToast('📱 Installing...','success');_installEvt=null;$('installBanner').classList.remove('show')})}
  else if(isIOS())alert('To install on iPhone:\n\n1. Tap the Share button (square with arrow ↑) at the bottom\n2. Scroll down and tap "Add to Home Screen"\n3. Tap "Add"\n\nThe app will appear on your home screen!');
  else alert('To install:\n\n• Look for the install icon (⊕) in the address bar\n• Or open the browser menu (⋮) → "Install app"');
}
function dismissInstall(){$('installBanner').classList.remove('show');try{localStorage.setItem('ff_install_dismissed_v2','1')}catch(e){}}
window.addEventListener('appinstalled',function(){var b=$('installBanner');if(b)b.classList.remove('show')});

// ════════════════════════════════════════════
// MISC
// ════════════════════════════════════════════
function callShop(){var p=getCfg('Phone','');if(!p)return;location.href='tel:+91'+p.replace(/\D/g,'').slice(-10)}
window.addEventListener('scroll',function(){
  var tb=$('topbar');if(tb)tb.style.boxShadow=window.scrollY>40?'0 2px 8px rgba(0,0,0,.06)':'';
},{passive:true});

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════
function init(){
  resolveStore(function(){
    if(!SHEET_ID)return;
    loadConfig(function(){
      paintHeader();
      loadProducts(function(){
        loadCart();
        paintFilters();
        paintDailySpecial();
        renderMenu();
        updateCartUI();
        showInstallBanner();
        // Dismiss splash once menu is painted
        setTimeout(function(){var s=$('splash');if(s)s.classList.add('gone')},800);
        // Orders are loaded last so menu shows immediately; trend/stars/live counter populate in
        loadOrders(function(){
          paintLiveActivity();
          renderMenu(); // re-render with stars + trending
        });
      });
    });
  });
}
init();
