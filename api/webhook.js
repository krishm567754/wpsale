const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');

let db = null;

function getFirebase() {
  if (db) return db;
  try {
    var sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: 'https://' + sa.project_id + '-default-rtdb.firebaseio.com' });
    }
    db = admin.database();
    return db;
  } catch (e) { console.error('[FB] Err:', e.message); return null; }
}

async function getSystemPrompt() {
  var d = getFirebase();
  var def = 'Tu Laxmi hai. Rules: 1. Sirf data se jawab de. 2. Rate query pe TEXT reply de. PDF tabhi bhej jab "bhejo/send" bole. 3. Rs. lagao amounts me. 4. Hinglish, max 6 lines. 5. Bold ke liye * use karo. Emojis mat use karo. 6. Data na mile to "Nahi mila" bolo.';
  if (!d) return def;
  try { var s = await d.ref('botConfig/systemPrompt').get(); return s.exists() ? s.val() : def; } catch (e) { return def; }
}

async function saveSystemPrompt(p) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/systemPrompt').set(p); } catch(e){} } }
async function getPDFList() { var d = getFirebase(); if (!d) return {}; try { var s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e){ return {}; } }
async function savePDFList(data) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/pdfFiles').set(data); } catch(e){} } }

function sanitizeReply(t) {
  if (!t) return '';
  return t.replace(/[❌✅✨🔍📄📋]/g, '').replace(/\*\*/g, '*').replace(/\n{3,}/g, '\n\n').split('\n').map(function(l){return l.trim();}).join('\n').trim();
}

function cleanDate(val) {
  if (!val) return 'N/A';
  if (typeof val === 'number') { var dt = new Date(Math.round((val - 25569) * 86400000)); return dt.toISOString().split('T')[0]; }
  return String(val).replace(/\//g, '-').slice(0, 10);
}

function searchInvoices(query, invoiceMap) {
  var q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
  var matches = []; var keys = Object.keys(invoiceMap);
  for (var i = 0; i < keys.length; i++) {
    var invNo = keys[i]; var rows = invoiceMap[invNo];
    if (invNo.toLowerCase().indexOf(q) !== -1 || q.indexOf(invNo.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) !== -1) {
      matches.push({ invNo: invNo, rows: rows });
    }
  }
  if (matches.length === 0) {
    for (var j = 0; j < keys.length; j++) {
      var invNo2 = keys[j]; var rows2 = invoiceMap[invNo2];
      var cust = (rows2[0]['Customer Name'] || '').toLowerCase();
      var words = q.split(' '); var matchCust = false;
      for (var w = 0; w < words.length; w++) { if (words[w].length > 2 && cust.indexOf(words[w]) !== -1) { matchCust = true; break; } }
      if (matchCust || cust.indexOf(q) !== -1) { matches.push({ invNo: invNo2, rows: rows2, customer: rows2[0]['Customer Name'] }); }
    }
  }
  return matches;
}

async function extractPDFText(url) {
  try {
    var res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    var pdfParse = require('pdf-parse');
    var data = await pdfParse(Buffer.from(res.data));
    return data.text || '';
  } catch (e) { console.error('[PDF] Err:', e.message); return ''; }
}

async function loadAllData() {
  var base = process.env.GITHUB_RAW_BASE;
  if (!base) return { excelData: 'Data URL missing.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };
  var fileList = [];
  try { var r = await axios.get(base + '/index.json'); fileList = r.data; } catch (e) { return { excelData: 'index.json error.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} }; }
  
  var excelFiles = fileList.filter(function(f){ return f.match(/\.(xlsx|xls|csv)$/i); });
  var mrpFile = fileList.find(function(f){ return f.toLowerCase().indexOf('mrp') !== -1; });
  var listFile = fileList.find(function(f){ return f.toLowerCase().indexOf('list price') !== -1 || (f.toLowerCase().indexOf('list') !== -1 && f.toLowerCase().indexOf('mrp') === -1); });
  var mrpPdfUrl = mrpFile ? base + '/' + encodeURIComponent(mrpFile) : '';
  var listPdfUrl = listFile ? base + '/' + encodeURIComponent(listFile) : '';
  
  var allRows = [];
  for (var k = 0; k < excelFiles.length; k++) {
    try {
      var rf = await axios.get(base + '/' + encodeURIComponent(excelFiles[k]), { responseType: 'arraybuffer' });
      var wb = XLSX.read(rf.data, { type: 'buffer' });
      for (var s = 0; s < wb.SheetNames.length; s++) { allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { defval: '' })); }
    } catch (err) { console.log('[EXCEL] Skip:', excelFiles[k]); }
  }
  
  var invoiceMap = {};
  for (var m = 0; m < allRows.length; m++) {
    var inv = allRows[m]['Invoice No'] || ''; if (!inv) continue;
    if (!invoiceMap[inv]) invoiceMap[inv] = []; invoiceMap[inv].push(allRows[m]);
  }
  
  var lines = ['INVOICE DATABASE:', 'Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment', ''];
  var invKeys = Object.keys(invoiceMap);
  for (var n = 0; n < invKeys.length; n++) {
    var invNo = invKeys[n]; var rows = invoiceMap[invNo]; var first = rows[0];
    var products = rows.map(function(r){ return r['Product Name'] + '(' + r['Product Volume'] + 'L)'; }).join(' + ');
    var tG = rows.reduce(function(s,r){ return s + (parseFloat(r['Total Value incl VAT/GST']) || 0); }, 0);
    var wG = rows.reduce(function(s,r){ return s + (parseFloat(r['Total Value Without GST']) || 0); }, 0);
    var cg = rows.reduce(function(s,r){ return s + (parseFloat(r['CGST Value']) || 0); }, 0);
    var sg = rows.reduce(function(s,r){ return s + (parseFloat(r['SGST Value']) || 0); }, 0);
    var vl = rows.reduce(function(s,r){ return s + (parseFloat(r['Product Volume']) || 0); }, 0);
    var dt = cleanDate(first['Invoice Date']);
    lines.push(invNo + '|' + dt + '|' + first['Customer Name'] + '|' + first['Town Name'] + '|' + first['District Name'] + '|' + first['Sales Executive Name'] + '|' + products + '|' + vl.toFixed(1) + 'L|Rs.' + tG.toFixed(2) + '|Rs.' + wG.toFixed(2) + '|Rs.' + cg.toFixed(2) + '|Rs.' + sg.toFixed(2) + '|' + first['Mode Of Payement']);
  }
  
  var mrpText = ''; var listText = '';
  if (mrpPdfUrl) { var raw = await extractPDFText(mrpPdfUrl); mrpText = raw.slice(0, 8000); }
  if (listPdfUrl) { var raw2 = await extractPDFText(listPdfUrl); listText = raw2.slice(0, 8000); }
  var excelData = [lines.join('\n'), mrpText ? '\n\nMRP PRICE DATA:\n' + mrpText : '', listText ? '\n\nLIST PRICE/DLP DATA:\n' + listText : ''].join('');
  return { excelData: excelData, mrpPdfUrl: mrpPdfUrl, listPdfUrl: listPdfUrl, mrpFile: mrpFile, listFile: listFile, invoiceMap: invoiceMap };
}

async function getAIReply(userMsg, data, prompt) {
  var key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try {
    var res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
      model: 'meta/llama-3.1-70b-instruct', messages: [ { role: 'system', content: prompt + '\n\nCONTEXT DATA:\n' + data }, { role: 'user', content: userMsg } ],
      max_tokens: 600, temperature: 0.1, top_p: 0.95, stream: false
    }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 });
    var raw = res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message ? res.data.choices[0].message.content : '';
    return sanitizeReply(raw) || 'Kuch error aaya.';
  } catch (e) { console.error('[AI] Err:', e.message); return 'System Error: ' + e.message; }
}

async function sendText(to, text) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  var instance = process.env.EVOLUTION_INSTANCE; var apiKey = process.env.EVOLUTION_API_KEY;
  var number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !instance || !apiKey) return;
  try { await axios.post(baseUrl + '/message/sendText/' + instance, { number: number, text: text }, { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }); } catch (e) { console.error('[SEND] Err:', e.message); }
}

async function sendDocument(to, fileUrl, fileName, caption) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  var instance = process.env.EVOLUTION_INSTANCE; var apiKey = process.env.EVOLUTION_API_KEY;
  var number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !instance || !apiKey) return;
  try { await axios.post(baseUrl + '/message/sendMedia/' + instance, { number: number, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName: fileName, caption: caption || '' }, { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }); } catch (e) { console.error('[PDF] Err:', e.message); }
}

function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
  var lower = text.toLowerCase().trim();
  if (['hi','hello','namaste','hey','hii','good morning'].some(function(g){return lower.indexOf(g)!==-1;})) return { type: 'greeting' };
  var keys = Object.keys(savedPDFs);
  for (var i = 0; i < keys.length; i++) {
    if (lower.indexOf(keys[i].toLowerCase()) !== -1 && ['send','bhejo','share','bhej','de do','dedo','chahiye','pdf'].some(function(w){return lower.indexOf(w)!==-1;})) { return { type: 'pdf', pdf: savedPDFs[keys[i]] }; }
  }
  var hasSend = ['send','bhejo','share','bhej','de do','dedo','chahiye'].some(function(w){return lower.indexOf(w)!==-1;});
  var hasMRP = ['mrp','retail price','mrp pdf'].some(function(w){return lower.indexOf(w)!==-1;});
  var hasList = ['list price','dlp','price list','list pdf'].some(function(w){return lower.indexOf(w)!==-1;});
  if (hasSend && hasMRP && mrpPdfUrl) return { type: 'pdf', pdf: { url: mrpPdfUrl, name: mrpFile || 'MRP.pdf' } };
  if (hasSend && hasList && listPdfUrl) return { type: 'pdf', pdf: { url: listPdfUrl, name: listFile || 'List.pdf' } };
  if (['rate','kya hai','kitna','price','mrp','dlp','kitne ka'].some(function(w){return lower.indexOf(w)!==-1;}) && !hasSend) return { type: 'ai_rate' };
  return { type: 'ai' };
}

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');
  try {
    var body = req.body;
    if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
    if (body.data && body.data.key && body.data.key.fromMe) return res.status(200).send('Skip');
    var from = body.data.key.remoteJid;
    var text = ((body.data.message && body.data.message.conversation) || (body.data.message && body.data.message.extendedTextMessage && body.data.message.extendedTextMessage.text) || '').trim();
    if (!text || !from) return res.status(200).send('Empty');
    var adminNum = process.env.ADMIN_NUMBER || '916375636354';
    var isAdmin = from.indexOf(adminNum) !== -1;

    if (isAdmin && text.indexOf('!setprompt ') === 0) { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({status:'ok'}); }
    if (isAdmin && text === '!status') { await sendText(from, '*Bot Status*\nOnline'); return res.status(200).json({status:'ok'}); }
    if (isAdmin && text.indexOf('!addpdf ') === 0) { var parts = text.slice(8).split('|').map(function(s){return s.trim();}); if (parts.length===3) { var list = await getPDFList(); list[parts[0].toLowerCase()] = {name:parts[1], url:parts[2]}; await savePDFList(list); await sendText(from, 'PDF added!'); } else { await sendText(from, 'Format: !addpdf keyword | Name | URL'); } return res.status(200).json({status:'ok'}); }
    if (isAdmin && text === '!listpdf') { var list = await getPDFList(); var txt = Object.keys(list).length === 0 ? 'No PDFs.' : Object.keys(list).map(function(k){return list[k].name + '\nKeyword: '+k;}).join('\n\n'); await sendText(from, 'PDFs:\n\n'+txt); return res.status(200).json({status:'ok'}); }
    if (isAdmin && text.indexOf('!removepdf ') === 0) { var kw = text.slice(11).trim().toLowerCase(); var list2 = await getPDFList(); if (list2[kw]) { delete list2[kw]; await savePDFList(list2); await sendText(from, 'Removed: '+kw); } else { await sendText(from, 'Not found'); } return res.status(200).json({status:'ok'}); }
    if (isAdmin && text === '!help') { await sendText(from, 'Commands: !status, !setprompt, !addpdf, !listpdf, !removepdf'); return res.status(200).json({status:'ok'}); }

    var database = getFirebase();
    if (database && /^\d+$/.test(text)) {
      var snap = await database.ref('pending/' + from).get();
      if (snap.exists()) {
        var pending = snap.val(); var idx = parseInt(text) - 1;
        if (pending.matches && pending.matches[idx]) {
          var m = pending.matches[idx]; var first = m.rows[0];
          var products = m.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + ');
          var tG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
          var wG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value Without GST'])||0);},0);
          var cg = m.rows.reduce(function(s,r){return s+(parseFloat(r['CGST Value'])||0);},0);
          var sg = m.rows.reduce(function(s,r){return s+(parseFloat(r['SGST Value'])||0);},0);
          var vl = m.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
          var dt = cleanDate(first['Invoice Date']);
          await sendText(from, '*Invoice:* '+m.invNo+'\n*Customer:* '+first['Customer Name']+'\n*Products:* '+products+'\n*Total:* Rs.'+tG.toFixed(2)+'\n*Tax:* CGST Rs.'+cg.toFixed(2)+' + SGST Rs.'+sg.toFixed(2)+'\n*Date:* '+dt+'\n*Payment:* '+first['Mode Of Payement']);
          await database.ref('pending/' + from).remove();
          return res.status(200).json({status:'ok'});
        }
      }
    }

    var results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
    var sysPrompt = results[0]; var dataResult = results[1]; var savedPDFs = results[2];
    var intent = detectIntent(text, dataResult.mrpPdfUrl, dataResult.listPdfUrl, dataResult.mrpFile, dataResult.listFile, savedPDFs);

    if (intent.type === 'greeting') { await sendText(from, 'Hello! Main Laxmi hoon. Invoice, MRP/DLP rates pooch sakte hain!'); return res.status(200).json({status:'ok'}); }
    if (intent.type === 'pdf') { await sendText(from, 'Sending '+intent.pdf.name+'...'); await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name); return res.status(200).json({status:'ok'}); }

    var matches = searchInvoices(text, dataResult.invoiceMap);
    if (matches.length === 1) {
      var m = matches[0]; var first = m.rows[0];
      var products = m.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + ');
      var tG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
      var wG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value Without GST'])||0);},0);
      var cg = m.rows.reduce(function(s,r){return s+(parseFloat(r['CGST Value'])||0);},0);
      var sg = m.rows.reduce(function(s,r){return s+(parseFloat(r['SGST Value'])||0);},0);
      var vl = m.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
      var dt = cleanDate(first['Invoice Date']);
      await sendText(from, '*Invoice:* '+m.invNo+'\n*Customer:* '+first['Customer Name']+'\n*Products:* '+products+'\n*Total:* Rs.'+tG.toFixed(2)+'\n*Tax:* CGST Rs.'+cg.toFixed(2)+' + SGST Rs.'+sg.toFixed(2)+'\n*Date:* '+dt+'\n*Payment:* '+first['Mode Of Payement']);
      return res.status(200).json({status:'ok'});
    } else if (matches.length > 1 && matches.length <= 5) {
      var msg = '*Multiple matches. Reply 1, 2, etc.:\n\n';
      for (var i=0; i<matches.length; i++) { msg += (i+1)+'. '+(matches[i].customer||matches[i].rows[0]['Customer Name'])+' (Inv: '+matches[i].invNo+')\n'; }
      if (database) await database.ref('pending/' + from).set({matches: matches, ts: Date.now()});
      await sendText(from, msg); return res.status(200).json({status:'ok'});
    } else if (matches.length > 5) {
      await sendText(from, '*Too many matches. Please refine.'); return res.status(200).json({status:'ok'});
    }

    var aiReply = await getAIReply(text, dataResult.excelData, sysPrompt);
    if (!aiReply || aiReply.indexOf('Error')!==-1 || aiReply.indexOf('missing')!==-1) await sendText(from, 'Thoda wait karein ya clear likhein.');
    else await sendText(from, aiReply);
    return res.status(200).json({status:'ok'});
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
