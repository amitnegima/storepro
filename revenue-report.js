function revenueReportCycleHtml_(cycle, rows, outlook, currency){
  function money(value){return revenueReportMoney_(value,currency);}
  var range=revenueReportRange_(cycle);
  var metrics=[
    ['Payments received',money(cycle.revenue)],
    [cycle.done?'Total settled':'Booked',money(cycle.val)],
    ['Discounts',money(cycle.discount)],
    ['Members',E(cycle.count||0)]
  ];
  if(outlook){
    var settled=outlook.collected+outlook.extras;
    var rate=outlook.booked>0?Math.min(100,Math.round(settled/outlook.booked*100)):100;
    metrics.push(['Pending balance',money(outlook.outstanding)],['Collection rate',rate+'%'],
      ['Expected renewals ('+outlook.renewals.length+')',money(outlook.renewalAmt)],['Projected total',money(outlook.projected)]);
  }
  if(Number.isFinite(cycle.mom)){
    metrics.push(['Change vs previous cycle',(cycle.mom>0?'+':'')+Math.round(cycle.mom)+'%'+(cycle.done?'':' so far')]);
  }
  var memberRows=rows.map(function(row){
    return '<tr><td>'+E(row.name||'Unnamed')+'</td><td>'+E(row.seat||'-')+'</td><td>'+E(row.plan||'-')+'</td><td>'+E(row.shift||'-')+'</td>'+
      '<td class="num">'+money(row.paid)+'</td><td class="num">'+money(row.discount)+'</td>'+
      (outlook?'<td class="num">'+money(row.due)+'</td>':'')+'</tr>';
  }).join('');
  var note=cycle.done?'The summary uses the saved cycle snapshot. Member rows reflect available enrollment records and may differ from snapshot totals.':
    'Projection includes booked amounts and expected renewals. Payments received show cash recorded. Collection rate includes discounts as settled amounts.';
  return '<section class="cycle-detail"><h2>'+E(range)+' <span class="status">'+(cycle.done?'Completed':'In progress')+'</span></h2><div class="metrics" aria-label="Revenue summary">'+
    metrics.map(function(metric){return '<div class="metric"><span>'+metric[0]+'</span><strong>'+metric[1]+'</strong></div>';}).join('')+
    '</div><p>'+note+'</p><h3>Member payment details</h3>'+
    (rows.length?'<p>'+rows.length+' available '+(rows.length===1?'record':'records')+'</p><table><thead><tr><th>Member</th><th>Seat</th><th>Plan</th><th>Shift</th><th class="num">Paid</th><th class="num">Discount</th>'+
      (outlook?'<th class="num">Pending</th>':'')+'</tr></thead><tbody>'+memberRows+'</tbody></table>':'<p>No member records are available for this cycle.</p>')+
    '</section>';
}

function revenueReportMoney_(value,currency){
  return E(currency+(Number(value)||0).toLocaleString('en-IN',{maximumFractionDigits:2}));
}
function revenueReportDate_(value){
  return value?value.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'';
}
function revenueReportRange_(cycle){
  return cycle.start&&cycle.end?revenueReportDate_(cycle.start)+' - '+revenueReportDate_(cycle.end):cycle.label.replace(/\u2013/g,' - ');
}

function revenueReportHtml_(entries, library, currency, generated, allMonths){
  var title=allMonths?'Revenue History Report':'Monthly Revenue Report';
  var caption=allMonths?entries.length+' billing cycles | '+revenueReportRange_(entries[0].cycle)+' to '+revenueReportRange_(entries[entries.length-1].cycle):revenueReportRange_(entries[0].cycle);
  var summary=allMonths?revenueReportOverview_(entries,currency):'';
  var details=entries.map(function(entry){return revenueReportCycleHtml_(entry.cycle,entry.rows,entry.outlook,currency);}).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+E(library+' | '+title)+'</title><style>'+
    '@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#102c39;background:#fff;font:12px/1.45 system-ui,sans-serif;print-color-adjust:exact;-webkit-print-color-adjust:exact}'+
    'header{border-top:5px solid #087e79;border-bottom:1px solid #b8d8d4;background:#edf8f6;padding:22px 24px;margin-bottom:18px}h1{font-size:30px;letter-spacing:-.035em;margin:3px 0 5px}'+
    '.eyebrow,.metric span{color:#355f64;text-transform:uppercase;letter-spacing:.075em;font-size:10px;font-weight:750}.range{font-size:14px}.status{display:inline-block;margin-left:8px;padding:2px 7px;border:1px solid #99c4bf;border-radius:12px;font-size:10px;font-weight:700}'+
    '.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-bottom:13px;break-inside:avoid}.metric{padding:9px;border:1px solid #d4e6e5;border-radius:8px}.metric strong{display:block;font-size:17px;margin-top:3px;overflow-wrap:anywhere}'+
    'h2{margin:20px 0 7px;font-size:17px;break-after:avoid}p{margin:0 0 8px;color:#425e67}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}thead{display:table-header-group}th,td{padding:6px 5px;border-bottom:1px solid #d9e6e7;text-align:left;overflow-wrap:anywhere}th{background:#e4f2f0}th:first-child{width:23%}th:nth-child(3){width:20%}tr{break-inside:avoid}tbody tr:nth-child(even){background:#f4f9f9}.num{text-align:right;font-variant-numeric:tabular-nums}footer{margin-top:14px;padding-top:8px;border-top:1px solid #d9e6e7;color:#425e67;font-size:10px}'+
    '.cycle-detail{margin-top:22px}.cycle-detail h2{border-top:2px solid #087e79;padding-top:8px}.cycle-detail h3{margin:12px 0 6px;font-size:13px;break-after:avoid}.overview th:first-child{width:29%}.overview th:nth-child(3){width:auto}.overview tfoot td{font-weight:750;background:#e4f2f0}.overview{margin-bottom:20px}'+
    '</style></head><body><header><div class="eyebrow">'+E(library)+'</div><h1>'+title+'</h1><div class="range">'+E(caption)+'</div></header>'+
    summary+details+'<footer>Generated '+E(revenueReportDate_(generated))+' | StorePro</footer></body></html>';
}

function revenueReportOverview_(entries,currency){
  var received=0,discount=0,settled=0;
  var rows=entries.map(function(entry){
    var cycle=entry.cycle;
    var cash=Number(cycle.revenue)||0, disc=Number(cycle.discount)||0;
    var total=cycle.done?(Number(cycle.val)||0):cash+disc;
    received+=cash;discount+=disc;settled+=total;
    return '<tr><td>'+E(revenueReportRange_(cycle))+'</td><td>'+(cycle.done?'Completed':'In progress')+'</td>'+
      [cash,disc,total].map(function(value){return '<td class="num">'+revenueReportMoney_(value,currency)+'</td>';}).join('')+'<td class="num">'+E(cycle.count||0)+'</td></tr>';
  }).join('');
  return '<section class="overview"><h2>Cycle comparison</h2><p>Settled amounts include discounts. Pending balances and projected renewals appear in the current cycle details.</p>'+
    '<table><thead><tr><th>Billing cycle</th><th>Status</th><th class="num">Received</th><th class="num">Discounts</th><th class="num">Settled</th><th class="num">Members</th></tr></thead><tbody>'+rows+
    '</tbody><tfoot><tr><td colspan="2">All cycles</td>'+[received,discount,settled].map(function(value){return '<td class="num">'+revenueReportMoney_(value,currency)+'</td>';}).join('')+'<td></td></tr></tfoot></table></section>';
}

function revenueWorkbook_(xlsx, entries, currency){
  var workbook=xlsx.utils.book_new();
  var summary=[['Billing cycle','Status','Received','Discounts','Settled','Booked','Members','Pending','Collection rate','Expected renewals','Renewal estimate','Projected','Change vs prior','Available member rows','Currency']];
  var members=[['Billing cycle','Member','Seat','Plan','Shift','Paid','Discount','Pending','Currency']];
  entries.forEach(function(entry){
    var cycle=entry.cycle,outlook=entry.outlook,range=revenueReportRange_(cycle);
    var received=Number(cycle.revenue)||0,discount=Number(cycle.discount)||0;
    var rate=outlook?(outlook.booked>0?Math.min(1,(outlook.collected+outlook.extras)/outlook.booked):1):null;
    summary.push([range,cycle.done?'Completed':'In progress',received,discount,cycle.done?cycle.val:received+discount,
      cycle.done?null:cycle.val,cycle.count||0,outlook?outlook.outstanding:null,rate,outlook?outlook.renewals.length:null,
      outlook?outlook.renewalAmt:null,outlook?outlook.projected:null,Number.isFinite(cycle.mom)?cycle.mom/100:null,entry.rows.length,currency]);
    entry.rows.forEach(function(row){
      members.push([range,row.name||'',row.seat||'',row.plan||'',row.shift||'',row.paid,row.discount,outlook?row.due:null,currency]);
    });
  });
  function addSheet(name,rows,widths,percentColumns){
    var sheet=xlsx.utils.aoa_to_sheet(rows);
    sheet['!cols']=widths.map(function(width){return {wch:width};});
    sheet['!autofilter']={ref:sheet['!ref']};
    percentColumns.forEach(function(column){
      for(var i=2;i<=rows.length;i++){
        var cell=sheet[column+i];if(cell)cell.z='0.0%';
      }
    });
    xlsx.utils.book_append_sheet(workbook,sheet,name);
  }
  addSheet('Cycle summary',summary,[30,15,14,13,14,13,10,13,17,19,16,14,18,22,10],['I','M']);
  addSheet('Member payments',members,[30,27,12,23,12,13,13,13,10],[]);
  return workbook;
}
