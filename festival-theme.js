function festivalDateActive_(endDate, date){
  var today=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  return !endDate||today<=endDate;
}

function resolveFestivalTheme_(theme,date){
  if(theme!=='auto')return theme;
  return date.getMonth()===0&&date.getDate()===1?'newyear':'off';
}

function nextNewYearEnd_(date){
  var year=date.getFullYear();
  if(date.getMonth()!==0||date.getDate()!==1)year++;
  return year+'-01-01';
}

function renderFestivalGreeting_(element, theme, endDate, now){
  var greetings={diwali:'🪔 Happy Diwali',newyear:'✨ Happy New Year'};
  var date=now||new Date();
  if(theme==='auto')endDate='';
  theme=resolveFestivalTheme_(theme,date);
  var greeting=Object.hasOwn(greetings,theme)&&festivalDateActive_(endDate,date)?greetings[theme]:'';
  var diwali=theme==='diwali'&&!!greeting;
  var newYear=theme==='newyear'&&!!greeting;
  element.classList.toggle('festival-newyear',newYear);
  element.ownerDocument.body.classList.toggle('newyear-active',newYear);
  element.classList.toggle('festival-diwali',diwali);
  element.ownerDocument.body.classList.toggle('diwali-active',diwali);
  if(diwali){
    if(element.dataset.greeting!=='diwali'){
      var banner=element.classList.contains('festival-banner');
      element.innerHTML=(banner?"<svg class=\"diwali-art\" aria-hidden=\"true\" viewBox=\"0 0 420 120\" preserveAspectRatio=\"xMidYMid slice\"><defs><g id=\"diwali-burst\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M0-13v-15m0 41v15m13-28h15m-41 0h-15M9-9l11-11M-9 9l-11 11M9 9l11 11M-9-9l-11-11\"/><circle r=\"7\" stroke-dasharray=\"1 4\"/><circle r=\"34\" stroke-dasharray=\"1 7\"/></g></defs><path d=\"M0 4Q105 38 210 4Q315 38 420 4\" fill=\"none\" stroke=\"#e7a753\" opacity=\".65\"/><path d=\"M24 10h.01M48 15h.01M76 19h.01M106 21h.01M136 19h.01M165 15h.01M194 9h.01M228 10h.01M256 16h.01M286 20h.01M315 21h.01M346 19h.01M376 15h.01M400 10h.01\" stroke=\"#ffdd87\" stroke-width=\"3\" stroke-linecap=\"round\"/><g transform=\"translate(57 65)\" color=\"#f7b86a\"><g class=\"diwali-sparks\"><use href=\"#diwali-burst\"/></g></g><g transform=\"translate(363 48) scale(.8)\" color=\"#ff9cb8\"><g class=\"diwali-sparks\"><use href=\"#diwali-burst\"/></g></g><g transform=\"translate(353 136)\" fill=\"none\" stroke=\"#ffc075\" opacity=\".48\"><circle r=\"42\"/><circle r=\"29\"/><ellipse rx=\"17\" ry=\"48\"/><ellipse rx=\"17\" ry=\"48\" transform=\"rotate(60)\"/><ellipse rx=\"17\" ry=\"48\" transform=\"rotate(120)\"/></g></svg>":'')+'<span class="diwali-title"><span class="diwali-diya" aria-hidden="true">&#129684;</span> '+(banner?'<span class="diwali-kicker">Festival of Lights</span>':'')+'Happy Diwali</span>';
    }
    element.dataset.greeting='diwali';
  }else{
    element.textContent=greeting;
    delete element.dataset.greeting;
  }
  element.hidden=!greeting;
}

function updateFestivalSplash_(slug, theme, endDate){
  var key='storepro:festival:'+slug.toLowerCase();
  if(theme===undefined){
    try{
      var cached=JSON.parse(localStorage.getItem(key)||'null');
      if(cached){theme=cached.theme;endDate=cached.endDate;}
    }catch(e){}
  }else if(slug){
    try{localStorage.setItem(key,JSON.stringify({theme:theme,endDate:endDate}));}catch(e){}
  }
  var now=new Date();
  if(theme==='auto')endDate='';
  theme=resolveFestivalTheme_(theme,now);
  var active=!!slug&&theme==='diwali'&&festivalDateActive_(endDate,now);
  document.getElementById('splash').classList.toggle('splash-diwali',active);
  var newYear=!!slug&&theme==='newyear'&&festivalDateActive_(endDate,now);
  document.getElementById('splash').classList.toggle('splash-newyear',newYear);
  var label=document.getElementById('splashFestival');
  label.hidden=!active&&!newYear;
  if(!label.hidden){
    label.querySelector('span').textContent=newYear?'✨':'🪔';
    label.querySelector('strong').textContent=newYear?'Happy New Year':'Happy Diwali';
    label.querySelector('small').textContent=newYear?'A bright year ahead':'Festival of Lights';
  }
}
