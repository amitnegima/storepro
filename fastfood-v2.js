// ════════════════════════════════════════════
// FASTFOOD V2 — Modern mobile-first food ordering
// ════════════════════════════════════════════
var MASTER_SHEET_ID="1K6jYaOrnmMLw_0_N5EvrgE5jEOpbIsWZjyCM8Yf6OLg";
var SHEET_ID="",SCRIPT_URL="";
var STORE_META={};
var configData=[],products=[],cart=[],lastOrder=null;
var activeCat='all',vegOnly=false,bestOnly=false;
var _custCtx=null,_installEvt=null;

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
  s.src='https://docs.google.com/spreadsheets/d/'+sheetId+'/gviz/tq?tqx=out:json&sheet='+encodeURIComponent(name)+'&_t='+Date.now();
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
  var p1=(getCfg('Phone','')||'').replace(/\D/g,'').slice(-10);
  var p2=(getCfg('Phone2','')||getCfg('SecondaryPhone','')||'').replace(/\D/g,'').slice(-10);
  var wa=(getCfg('WhatsApp','')||getCfg('Phone','')).replace(/\D/g,'');
  if(wa.length===10)wa='91'+wa;
  var html='';
  if(p1)html+='<a class="contact-btn" href="tel:+91'+p1+'">📞 '+p1+'</a>';
  if(p2&&p2!==p1)html+='<a class="contact-btn" href="tel:+91'+p2+'">📞 '+p2+'</a>';
  if(wa){
    var shop=getCfg('ShopName','Store');
    var msg='Hi! I want to place an order at '+shop;
    html+='<a class="contact-btn wa" href="https://wa.me/'+wa+'?text='+encodeURIComponent(msg)+'" target="_blank">💬 WhatsApp</a>';
  }
  if(!html){$('contactBar').style.display='none';return}
  $('contactBar').style.display='flex';
  $('contactBtns').innerHTML=html;
}
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
  h+='<button class="f-tab'+(activeCat==='all'&&!bestOnly?' active':'')+'" onclick="setCat(\'all\')">All<b>'+products.length+'</b></button>';
  if(products.some(function(p){return/^(yes|true|1)$/i.test(p.bestseller||'')})){
    h+='<button class="f-tab best'+(bestOnly?' active':'')+'" onclick="toggleBest()">⭐ Bestsellers</button>';
  }
  keys.forEach(function(k){
    h+='<button class="f-tab'+(activeCat===k?' active':'')+'" onclick="setCat(\''+jss(k)+'\')">'+esc(k)+'<b>'+cats[k]+'</b></button>';
  });
  $('filters').innerHTML=h;
  // Reflect veg-toggle state on the inline button
  var vt=$('vegToggleBtn');if(vt)vt.classList.toggle('active',vegOnly);
}
function setCat(c){activeCat=c;bestOnly=false;paintFilters();renderMenu();var menu=$('menu');if(menu)menu.scrollIntoView({behavior:'smooth',block:'start'})}
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
  if(activeCat!=='all')list=list.filter(function(p){return(p.category||'Other')===activeCat});
  if(q)list=list.filter(function(p){return((p.name||'')+(p.category||'')+(p.hindiname||'')+(p.description||'')).toLowerCase().indexOf(q)>=0});
  if(!list.length){$('menu').innerHTML='<div class="empty-msg"><div class="empty-em">🍽</div><h3>No items found</h3><p>Try clearing filters or search</p></div>';return}
  // Group by category if showing all
  var html='';
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
    html+='<div class="cat-section first">';
    list.forEach(function(p){html+=productHTML(p)});
    html+='</div>';
  }
  $('menu').innerHTML=html;
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
  var actionHTML;
  if(oos){actionHTML='<span class="oos-tag">Sold out</span>'}
  else if(qtyInCart>0&&!hasOptions){
    actionHTML='<div class="qty-stepper"><button onclick="event.stopPropagation();qtyChange(\''+jss(name)+'\',-1)">−</button><span class="q">'+qtyInCart+'</span><button onclick="event.stopPropagation();qtyChange(\''+jss(name)+'\',1)">+</button></div>';
  }else{
    actionHTML='<button class="add-btn'+(hasOptions?' has-options':'')+'" onclick="event.stopPropagation();onAdd(\''+jss(name)+'\')">ADD'+(hasOptions?'':'')+'</button>';
  }
  return '<div class="product'+(oos?' oos':'')+'" onclick="onProductTap(\''+jss(name)+'\')"><div class="product-img '+imgClass+'">'+imgHtml+(badges?'<div class="product-badges">'+badges+'</div>':'')+'</div><div class="product-info"><div class="product-name">'+(isVeg?'<span class="veg-d veg"></span>':isNonVeg?'<span class="veg-d nonveg"></span>':'')+'<span>'+esc(name)+'</span></div>'+(p.hindiname?'<div class="product-hindi">'+esc(p.hindiname)+'</div>':'')+'<div class="product-meta">'+(p.rating?'<span class="product-rating">⭐ '+esc(p.rating)+'</span>':'')+(p.preptime||p.prepTime?'<span>⏱ '+esc(p.preptime||p.prepTime)+'</span>':'')+(p.serves?'<span>🍽 Serves '+esc(p.serves)+'</span>':'')+'</div>'+(p.description?'<div class="product-desc">'+esc(p.description)+'</div>':'')+'<div class="product-bottom"><div class="product-price"><span class="price">'+fmt(price)+'</span>'+(disc>0?'<span class="mrp">'+fmt(mrp)+'</span>':'')+(p.unit?'<span class="unit">/'+esc(p.unit)+'</span>':'')+'</div>'+actionHTML+'</div></div></div>';
}
function onProductTap(name){
  var p=products.find(function(x){return x.name===name});if(!p)return;
  var oos=/out\s*of\s*stock|sold\s*out/i.test(p.stock||'')&&!/in\s*stock/i.test(p.stock||'');
  if(oos)return;
  // Tap on card opens customization if there are options, else add
  var hasOptions=(p.sizes||p.addons||p.spicy||/^(yes|true|1)$/i.test(p.combo||''));
  if(hasOptions)openCustomize(name);
}
function onAdd(name){
  var p=products.find(function(x){return x.name===name});if(!p)return;
  var hasOptions=(p.sizes||p.addons||p.spicy||/^(yes|true|1)$/i.test(p.combo||''));
  if(hasOptions){openCustomize(name);return}
  addToCart(p,null,1);
}

// ════════════════════════════════════════════
// CART
// ════════════════════════════════════════════
function cartKey(){return 'ff_cart_v2_'+SHEET_ID}
function loadCart(){try{cart=JSON.parse(localStorage.getItem(cartKey())||'[]')||[]}catch(e){cart=[]}}
function saveCart(){try{localStorage.setItem(cartKey(),JSON.stringify(cart))}catch(e){}}
function cartQtyFor(name){var n=0;cart.forEach(function(c){if(c.name===name&&!c.customization)n+=c.qty});return n}
function addToCart(product,customization,qty){
  qty=qty||1;
  var basePrice=parseFloat(product.price||'0')||0;
  var price=basePrice;
  if(customization){
    if(customization.size)price=customization.size.price;
    if(customization.addons)customization.addons.forEach(function(a){price+=parseFloat(a.price||0)||0});
  }
  // Try to merge if no customization
  if(!customization){
    var existing=cart.find(function(c){return c.name===product.name&&!c.customization});
    if(existing){existing.qty+=qty;saveCart();updateCartUI();flashCartBar();return}
  }
  cart.push({name:product.name,category:product.category||'',basePrice:basePrice,price:price,qty:qty,customization:customization,veg:product.veg||'',image:product.image||''});
  saveCart();updateCartUI();flashCartBar();
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
    $('cbCount').textContent=n+' item'+(n!==1?'s':'');
    $('cbTotal').textContent=fmt(t.sub);
    if(t.freeDeliveryThresh>0&&t.sub<t.freeDeliveryThresh){
      $('cbProgress').style.display='block';
      $('cbProgressFill').style.width=Math.min(100,(t.sub/t.freeDeliveryThresh*100))+'%';
    }else{$('cbProgress').style.display='none'}
    var tb=$('tbCartN');if(tb){tb.style.display='flex';tb.textContent=n>9?'9+':n}
  }else{
    bar.classList.remove('show');
    var tb2=$('tbCartN');if(tb2)tb2.style.display='none';
  }
}
function flashCartBar(){
  var b=$('cartBar');b.style.transition='transform .25s';b.style.transform='scale(1.04)';
  setTimeout(function(){b.style.transform=''},220);
}

// ════════════════════════════════════════════
// CART SHEET
// ════════════════════════════════════════════
function openCart(){renderCartSheet();$('cartSheet').classList.add('open')}
function closeSheet(id){$(id).classList.remove('open')}
function renderCartSheet(){
  if(!cart.length){$('cartBody').innerHTML='<div class="cart-empty"><div class="cart-empty-em">🛒</div><div style="font-weight:700;font-size:14px">Your cart is empty</div><div style="font-size:12px;margin-top:4px">Add some delicious items!</div></div>';$('cartFoot').style.display='none';return}
  var html='';
  cart.forEach(function(c,i){
    var isVeg=/^(yes|veg|true|1)$/i.test(c.veg||'');
    var custTxt='';
    if(c.customization){
      var parts=[];
      if(c.customization.size)parts.push(c.customization.size.name);
      if(c.customization.spice)parts.push(c.customization.spice);
      if(c.customization.addons&&c.customization.addons.length)parts.push(c.customization.addons.map(function(a){return a.name}).join(', '));
      if(c.customization.instructions)parts.push('Note: '+c.customization.instructions);
      custTxt=parts.join(' · ');
    }
    html+='<div class="cart-item">'+(c.veg?'<span class="veg-d '+(isVeg?'veg':'nonveg')+' cart-item-veg"></span>':'')+'<div class="cart-item-info"><div class="cart-item-name">'+esc(c.name)+'</div>'+(custTxt?'<div class="cart-item-cust">'+esc(custTxt)+'</div>':'')+'<div class="cart-item-bottom"><div class="cart-item-mini-stepper"><button onclick="cartItemQtyChange('+i+',-1);renderCartSheet()">−</button><span class="q">'+c.qty+'</span><button onclick="cartItemQtyChange('+i+',1);renderCartSheet()">+</button></div><div class="cart-item-price">'+fmt(c.price*c.qty)+'</div></div></div></div>';
  });
  // Bill summary
  var t=cartTotals();
  html+='<div class="bill-card"><div class="bill-row"><span>Subtotal</span><span>'+fmt(t.sub)+'</span></div>';
  if(t.deliveryFee>0&&t.mode==='delivery'){
    if(t.delivery===0)html+='<div class="bill-row"><span>Delivery <span class="bill-free">(FREE)</span></span><span><s style="opacity:.5">'+fmt(t.deliveryFee)+'</s> '+fmt(0)+'</span></div>';
    else html+='<div class="bill-row"><span>Delivery</span><span>'+fmt(t.delivery)+'</span></div>';
  }
  if(t.packing>0)html+='<div class="bill-row"><span>Packing</span><span>'+fmt(t.packing)+'</span></div>';
  if(t.taxes>0)html+='<div class="bill-row"><span>Taxes</span><span>'+fmt(t.taxes)+'</span></div>';
  html+='<div class="bill-row total"><span>Total</span><span>'+fmt(t.total)+'</span></div>';
  if(t.freeDeliveryThresh>0&&t.sub<t.freeDeliveryThresh&&t.mode==='delivery'){
    html+='<div class="free-progress">🛵 Add '+fmt(t.freeDeliveryThresh-t.sub)+' more to get FREE delivery</div>';
  }else if(t.freeDeliveryThresh>0&&t.delivery===0&&t.mode==='delivery'){
    html+='<div class="free-progress done">✓ FREE delivery applied!</div>';
  }
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
  html+='<div class="mode-tabs"><button class="mode-tab '+(window._coMode==='delivery'?'active':'')+'" onclick="setMode(\'delivery\')">🛵 Delivery</button><button class="mode-tab '+(window._coMode==='pickup'?'active':'')+'" onclick="setMode(\'pickup\')">🏪 Pickup</button></div>';
  html+='<div class="field"><label class="field-l">Your Name *</label><input class="field-i" id="coName" value="'+esc(saved.name||'')+'" placeholder="Full name"></div>';
  html+='<div class="field"><label class="field-l">Phone Number *</label><input class="field-i" id="coPhone" type="tel" value="'+esc(saved.phone||'')+'" placeholder="10-digit number" maxlength="10"></div>';
  if(window._coMode==='delivery'){
    html+='<div class="field"><label class="field-l">Delivery Address *</label><div class="field-row"><textarea class="field-i" id="coAddress" placeholder="House no, Street, Landmark, City">'+esc(saved.address||'')+'</textarea><button class="use-loc" onclick="useLocation()">📍 GPS</button></div></div>';
  }
  html+='<div class="field"><label class="field-l">Notes (optional)</label><input class="field-i" id="coNotes" placeholder="e.g. ring the bell, call before delivery"></div>';
  html+='<div class="cust-section-h" style="margin-top:6px">Payment Method</div>';
  html+='<div class="pay-grid"><div class="pay-opt '+(window._coPayment==='cod'?'active':'')+'" onclick="setPayment(\'cod\')"><div class="pay-em">💵</div><div class="pay-name">Cash</div><div class="pay-sub">Pay on '+(window._coMode==='pickup'?'pickup':'delivery')+'</div></div><div class="pay-opt '+(window._coPayment==='upi'?'active':'')+'" onclick="setPayment(\'upi\')"><div class="pay-em">📱</div><div class="pay-name">UPI / QR</div><div class="pay-sub">GPay · PhonePe · Paytm</div></div></div>';
  // UPI section
  var upi=getCfg('UPI','');
  if(window._coPayment==='upi'&&upi){
    html+='<div class="upi-card" id="upiCard"><div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;margin-bottom:8px">Scan to pay</div><div class="upi-qr-wrap" id="qrWrap"></div><div class="upi-id" onclick="copyUpi()">'+esc(upi)+' · tap to copy</div><div class="upi-amt" id="upiAmt"></div><div class="upi-apps"><a class="upi-app gpay" id="upiGpay">GPay</a><a class="upi-app phonepe" id="upiPhonepe">PhonePe</a><a class="upi-app paytm" id="upiPaytm">Paytm</a></div></div>';
  }
  // Bill summary
  var t=cartTotals();
  html+='<div class="bill-card"><div class="bill-row"><span>Subtotal ('+cartCount()+' items)</span><span>'+fmt(t.sub)+'</span></div>';
  if(t.deliveryFee>0&&window._coMode==='delivery'){
    if(t.delivery===0)html+='<div class="bill-row"><span>Delivery <span class="bill-free">(FREE)</span></span><span><s style="opacity:.5">'+fmt(t.deliveryFee)+'</s> '+fmt(0)+'</span></div>';
    else html+='<div class="bill-row"><span>Delivery</span><span>'+fmt(t.delivery)+'</span></div>';
  }
  if(t.packing>0)html+='<div class="bill-row"><span>Packing</span><span>'+fmt(t.packing)+'</span></div>';
  if(t.taxes>0)html+='<div class="bill-row"><span>Taxes</span><span>'+fmt(t.taxes)+'</span></div>';
  html+='<div class="bill-row total"><span>Total</span><span>'+fmt(t.total)+'</span></div></div>';
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
function openTrack(){
  renderTrack();$('trackSheet').classList.add('open');
}
function renderTrack(){
  var html='<div class="track-input-row"><input class="field-i" id="trackId" placeholder="Enter order ID (e.g. ORD-XXXXX)"><button class="btn btn-primary" onclick="checkTrack()">Track</button></div>';
  var recent=[];try{recent=JSON.parse(localStorage.getItem('ff_recent_v2')||'[]')||[]}catch(e){}
  if(recent.length){
    html+='<div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase;margin:14px 0 6px">Recent Orders</div><div class="recent-orders">';
    recent.forEach(function(o){
      var ago=Math.floor((Date.now()-o.ts)/60000);
      var agoTxt=ago<1?'now':ago<60?ago+'m ago':ago<1440?Math.floor(ago/60)+'h ago':Math.floor(ago/1440)+'d ago';
      html+='<div class="recent-order" onclick="document.getElementById(\'trackId\').value=\''+jss(o.id)+'\';checkTrack()"><span class="id">#'+esc(o.id.slice(-6))+'</span><span style="font-size:11px;color:var(--ink2);font-weight:600">'+esc(o.name||'Order')+'</span><span class="ago">'+agoTxt+'</span></div>';
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
    var html='<div class="track-status"><div style="font-size:11px;font-weight:700;color:var(--ink3);text-transform:uppercase">Order #'+esc(id.slice(-6))+'</div><div style="font-size:18px;font-weight:800;margin-top:4px">'+(sIdx<0?'❌ Cancelled':steps[sIdx].e+' '+steps[sIdx].l)+'</div>';
    if(found.shopkeepercomment||found.comment){html+='<div style="margin-top:10px;padding:10px 12px;background:var(--blue-bg);color:var(--blue);border-radius:10px;font-size:12px;border-left:3px solid var(--blue)"><b>💬 Update from shop:</b><br>'+esc(found.shopkeepercomment||found.comment)+'</div>'}
    if(sIdx>=0){
      html+='<div class="track-stepper">';
      steps.forEach(function(s,i){
        var cls=i<sIdx?'done':(i===sIdx?'current':'');
        html+='<div class="track-step '+cls+'"><div class="track-dot">'+(i<sIdx?'✓':s.e)+'</div><div class="track-step-l">'+s.l+'</div></div>';
      });
      html+='</div>';
    }
    html+='<div style="font-size:12px;color:var(--ink3);margin-top:8px">Total: '+fmt(found.total||0)+' · '+esc(found.mode||'')+'</div>';
    html+='</div>';
    $('trackResult').innerHTML=html;
  });
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
  var name=getCfg('DailySpecial','');
  var p=products.find(function(x){return x.name.toLowerCase()===name.toLowerCase()});
  if(p)onProductTap(p.name)||onAdd(p.name);
  else{$('qInput').value=name;renderMenu();window.scrollTo({top:300,behavior:'smooth'})}
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
      });
    });
  });
}
init();
