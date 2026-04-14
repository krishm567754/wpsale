const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');

let db = null;
let globalCache = null;
let lastCacheTime = 0;
let memoryPending = {};

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

function sanitizePath(str) { return str.replace(/[@.\[\]#\$\/]/g, '_'); }

async function getSystemPrompt() {
  var d = getFirebase();
  // ✅ FIX: Added STRICT rule to avoid corrupted emojis and force "Rs."
  var def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf data se exact rate batao. 0.9L = 900ml (ye dono same hain).\n2. MRP vs DLP: "MRP" ke liye SIRF [MRP DATA], "DLP" ke liye SIRF [DLP DATA].\n3. Exact Size ki value batayein.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho.\n6. IMPORTANT: DO NOT use any emojis or special symbols. Use plain text only. Use "Rs." instead of the Rupee symbol.';
  if (!d) return def;
  try { var s = await d.ref('botConfig/systemPrompt').get(); return s.exists() ? s.val() : def; } catch (e) { return def; }
}

async function saveSystemPrompt(p) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/systemPrompt').set(p); } catch(e){} } }
async function getPDFList() { var d = getFirebase(); if (!d) return {}; try { var s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e){ return {}; } }
async function savePDFList(data) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/pdfFiles').set(data); } catch(e){} } }

// ✅ FIX: Aggressive cleaner to remove weird UTF-8 corrupted signs
function sanitizeReply(t) {
  if (!t) return '';
  var clean = t.replace(/[❌✅✨🔍📄📋📊💰]/g, '');
  clean = clean.replace(/â‚¹/g, 'Rs.').replace(/₹/g, 'Rs.');
  clean = clean.replace(/ðŸ[^\s]*/g, ''); // Removes corrupted emoji bytes
  return clean.replace(/\*\*/g, '*').replace(/\n{3,}/g, '\n\n').split('\n').map(function(l){return l.trim();}).join('\n').trim();
}

function cleanDate(val) {
  if (!val) return 'N/A';
  var dt = typeof val === 'number' ? new Date(Math.round((val - 25569) * 86400000)) : new Date(val);
  if (isNaN(dt.getTime())) return String(val).trim();
  var m = String(dt.getMonth() + 1).padStart(2, '0');
  var d = String(dt.getDate()).padStart(2, '0');
  var y = dt.getFullYear();
  return m + '/' + d + '/' + y;
}

function normalizeSizeHeader(header) {
  var h = String(header).toLowerCase().replace(/\s+/g, '');
  if (h === '900ml' || h === '0.9l') return '900ML';
  if (h === '800ml' || h === '0.8l') return '800ML';
  if (h === '600ml' || h === '0.6l') return '600ML';
  if (h === '500ml' || h === '0.5l') return '500ML';
  if (h === '350ml' || h === '0.35l') return '350ML';
  if (h === '250ml' || h === '0.25l') return '250ML';
  if (h === '175ml' || h === '0.175l') return '175ML';
  if (h === '100ml' || h === '0.1l') return '100ML';
  if (h === '1l' || h === '11') return '1L';
  if (h === '2l' || h === '21') return '2L';
  if (h === '3l' || h === '31') return '3L';
  if (h === '4.5l' || h === '45l') return '4.5L';
  if (h === '5l' || h === '51') return '5L';
  if (h === '7l' || h === '71') return '7L';
  if (h === '9l' || h === '91') return '9L';
  if (h === '10l' || h === '101') return '10L';
  if (h === '11l' || h === '111') return '11L';
  if (h === '12l' || h === '121') return '12L';
  if (h === '15l' || h === '151') return '15L';
  if (h === '18l' || h === '181') return '18L';
  if (h === '20l' || h === '201') return '20L';
  if (h === '21l' || h === '211') return '21L';
  if (h === '50l' || h === '501') return '50L';
  if (h === '210l' || h === '2101') return '210L';
  return String(header).trim().toUpperCase();
}

function loadPriceListFromExcel(rows) {
  var priceMap = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var name = row['BRAND NAME'] || row['Brand Name'] || row['brand name'] || '';
    if (!name || name.length < 4) continue;
    name = name.trim();
    priceMap[name] = {};
    for (var key in row) {
      if (key === 'BRAND NAME' || key === 'Brand Name' || key === 'brand name') continue;
      var size = normalizeSizeHeader(key);
      var val = row[key];
      if (val && !isNaN(parseFloat(val))) {
        priceMap[name][size] = parseFloat(val);
      }
    }
  }
  return priceMap;
}

function searchProducts(query, mrpMap, dlpMap) {
  var q = query.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  var words = q.split(/\s+/);
  var stopWords = ['price','rate','mrp','dlp','kya','hai','batao','aur','ka','ke','liye','ye','pucha','list'];
  var searchTerms = words.filter(function(w){ return w.length > 1 && stopWords.indexOf(w) === -1; });
  if (searchTerms.length === 0) return [];

  var products = [];
  var seenNames = {};

  for (var name in mrpMap) {
    var nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    var score = 0;
    for (var t = 0; t < searchTerms.length; t++) {
      if (nameNorm.indexOf(searchTerms[t]) !== -1) score++;
    }
    var required = Math.min(2, Math.max(1, searchTerms.length - 1));
    if (score >= required) {
      var chunk = 'Product: ' + name + '\n';
      for (var size in mrpMap[name]) {
        var mrp = mrpMap[name][size];
        var dlp = dlpMap[name] ? dlpMap[name][size] : null;
        chunk += '- Size [' + size + '] : Rs. ' + mrp + (dlp ? ' (DLP: Rs.' + dlp + ')' : '') + '\n';
      }
      if (!seenNames[name.toLowerCase()]) {
        seenNames[name.toLowerCase()] = true;
        products.push({ name: name, score: score, mrpChunk: chunk, dlpChunk: chunk });
      }
    }
  }
  products.sort(function(a,b){ return b.score - a.score; });
  return products.slice(0, 5);
}

function searchInvoices(query, invoiceMap) {
  var q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
  if (/^\d{1,2}$/.test(q) || q.length < 3) return [];
  var matches = [];
  var keys = Object.keys(invoiceMap);
  var userKeywords = q.split(' ').filter(function(w){ return w.length > 3; });
  if (userKeywords.length === 0) userKeywords = [q];
  for (var i = 0; i < keys.length; i++) {
    var invNo = keys[i];
    var rows = invoiceMap[invNo];
    var custName = (rows[0]['Customer Name'] || '').toLowerCase();
    var invClean = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    var qClean = q.replace(/[^a-zA-Z0-9]/g, '');
    var matchInv = invClean.indexOf(qClean) !== -1 || qClean.indexOf(invClean) !== -1;
    var keywordScore = 0;
    for (var k = 0; k < userKeywords.length; k++) { if (custName.indexOf(userKeywords[k]) !== -1) keywordScore++; }
    if (matchInv || keywordScore > 0) { matches.push({ invNo: invNo, rows: rows, customer: rows[0]['Customer Name'], score: matchInv ? 10 : keywordScore }); }
  }
  matches.sort(function(a,b){ return b.score - a.score; });
  return matches.slice(0, 5);
}

async function loadAllData() {
  if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache;
  var base = process.env.GITHUB_RAW_BASE;
  if (!base) return { excelData: '', invoiceMap: {}, mrpMap: {}, dlpMap: {}, mrpFile: null, dlpFile: null };
  
  var fileList = []; try { fileList = (await axios.get(base + '/index.json')).data; } catch(e) { return null; }
  
  var excelFiles = fileList.filter(function(f){ 
    return f.match(/\.(xlsx|xls|csv)$/i) && 
           !f.toLowerCase().includes('mrp') && 
           !f.toLowerCase().includes('dlp') && 
           !f.toLowerCase().includes('list price'); 
  });
  var allRows = [];
  for (var k = 0; k < excelFiles.length; k++) {
    try { 
      var res = await axios.get(base + '/' + encodeURIComponent(excelFiles[k]), {responseType:'arraybuffer'}); 
      var wb = XLSX.read(res.data, {type:'buffer'}); 
      for (var s = 0; s < wb.SheetNames.length; s++) { allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], {defval:''})); } 
    } catch(e){}
  }
  
  var invoiceMap = {}; 
  for (var m = 0; m < allRows.length; m++) { 
    var inv = allRows[m]['Invoice No'] || ''; 
    if(inv){ if(!invoiceMap[inv]) invoiceMap[inv] = []; invoiceMap[inv].push(allRows[m]); } 
  }
  
  var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
  var mrpMap = {};
  if (mrpFile) {
    try {
      var mrpRes = await axios.get(base + '/' + encodeURIComponent(mrpFile), {responseType:'arraybuffer'});
      var mrpWb = XLSX.read(mrpRes.data, {type:'buffer'});
      var mrpRows = XLSX.utils.sheet_to_json(mrpWb.Sheets[mrpWb.SheetNames[0]], {defval:''});
      mrpMap = loadPriceListFromExcel(mrpRows);
    } catch(e) { console.error('[MRP Excel] Err:', e.message); }
  }
  
  var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp') || f.toLowerCase().includes('list price')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
  var dlpMap = {};
  if (dlpFile) {
    try {
      var dlpRes = await axios.get(base + '/' + encodeURIComponent(dlpFile), {responseType:'arraybuffer'});
      var dlpWb = XLSX.read(dlpRes.data, {type:'buffer'});
      var dlpRows = XLSX.utils.sheet_to_json(dlpWb.Sheets[dlpWb.SheetNames[0]], {defval:''});
      dlpMap = loadPriceListFromExcel(dlpRows);
    } catch(e) { console.error('[DLP Excel] Err:', e.message); }
  }
  
  var lines = ['INVOICE DATABASE:','Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment',''];
  var invKeys = Object.keys(invoiceMap); 
  for (var n = 0; n < invKeys.length; n++) { 
    var invNo = invKeys[n]; var rows = invoiceMap[invNo]; var f = rows[0]; 
    var prods = rows.map(function(r){ return r['Product Name'] + '(' + r['Product Volume'] + 'L)'; }).join(' + '); 
    var tG = rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value incl VAT/GST']) || 0); }, 0); 
    var wG = rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value Without GST']) || 0); }, 0); 
    var cg = rows.reduce(function(s, r){ return s + (parseFloat(r['CGST Value']) || 0); }, 0); 
    var sg = rows.reduce(function(s, r){ return s + (parseFloat(r['SGST Value']) || 0); }, 0); 
    var vl = rows.reduce(function(s, r){ return s + (parseFloat(r['Product Volume']) || 0); }, 0); 
    lines.push(invNo + '|' + cleanDate(f['Invoice Date']) + '|' + f['Customer Name'] + '|' + f['Town Name'] + '|' + f['District Name'] + '|' + f['Sales Executive Name'] + '|' + prods + '|' + vl.toFixed(1) + 'L|Rs.' + tG.toFixed(2) + '|Rs.' + wG.toFixed(2) + '|Rs.' + cg.toFixed(2) + '|Rs.' + sg.toFixed(2) + '|' + f['Mode Of Payement']); 
  }
  
  globalCache = { 
    invoiceMap: invoiceMap, 
    mrpMap: mrpMap, 
    dlpMap: dlpMap,
    excelData: lines.join('\n'),
    mrpFile: mrpFile,
    dlpFile: dlpFile
  };
  lastCacheTime = Date.now();
  return globalCache;
}

async function getAIReply(userMsg, data, prompt) {
  var key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try { 
    var res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { 
      model: 'meta/llama-3.1-70b-instruct', 
      messages: [{ role: 'system', content: prompt + '\n\nCONTEXT DATA:\n' + data }, { role: 'user', content: userMsg }], 
      // ✅ AI can now generate longer detailed reports if needed
      max_tokens: 1000, temperature: 0.1 
    }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 }); 
    return sanitizeReply(res.data.choices[0].message.content) || 'Kuch error aaya.'; 
  } catch (e) { return 'System Error: ' + e.message; }
}

async function sendText(to, text) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(baseUrl + '/message/sendText/' + inst, { number: num, text: text }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) { console.error('[SEND] Err:', e.message); }
}

async function sendDocument(to, fileUrl, fileName, caption) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(baseUrl + '/message/sendMedia/' + inst, { number: num, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName: fileName, caption: caption || '' }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) { console.error('[PDF] Err:', e.message); }
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
    var adminNum = process.env.ADMIN_NUMBER || '919950858818';
    var isAdmin = from.indexOf(adminNum) !== -1;
    var safeFrom = sanitizePath(from);
    var database = getFirebase();

    var results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
    var sysPrompt = results[0]; var dataResult = results[1] || {}; var savedPDFs = results[2];

    if (/^\d+$/.test(text)) {
      var pending = null;
      if (database) { try { var snap = await database.ref('pending/' + safeFrom).get(); if (snap.exists()) pending = snap.val(); } catch (e) {} }
      if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];
      if (pending && pending.matches) {
        var idx = parseInt(text) - 1;
        if (pending.matches[idx]) {
          if (pending.type === 'invoice') {
            var m = pending.matches[idx]; var f = m.rows[0];
            var prods = m.rows.map(function(r){ return r['Product Name'] + '(' + r['Product Volume'] + 'L)'; }).join(' + ');
            var tG = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value incl VAT/GST']) || 0); }, 0);
            var wG = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value Without GST']) || 0); }, 0);
            var cg = m.rows.reduce(function(s, r){ return s + (parseFloat(r['CGST Value']) || 0); }, 0);
            var sg = m.rows.reduce(function(s, r){ return s + (parseFloat(r['SGST Value']) || 0); }, 0);
            var vl = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Product Volume']) || 0); }, 0);
            await sendText(from, '*Invoice:* ' + m.invNo + '\n*Customer:* ' + f['Customer Name'] + '\n*Products:* ' + prods + '\n*Total:* Rs.' + tG.toFixed(2) + '\n*Total Volume:* ' + vl.toFixed(1) + ' L\n*Tax:* CGST Rs.' + cg.toFixed(2) + ' + SGST Rs.' + sg.toFixed(2) + '\n*Date:* ' + cleanDate(f['Invoice Date']) + '\n*Payment:* ' + f['Mode Of Payement']);
          } else if (pending.type === 'product') {
            var p = pending.matches[idx];
            var context = '[MRP DATA]\n' + p.mrpChunk + '\n\n[DLP DATA]\n' + p.dlpChunk;
            var aiPrompt = 'User\'s ORIGINAL query was: "' + pending.originalQuery + '". Now User selected Product: ' + p.name + '. Give exact MRP and DLP for the SPECIFIC SIZE they originally asked for. Note: 0.9L is exactly equal to 900ml.';
            var aiReply = await getAIReply(aiPrompt, context, sysPrompt);
            await sendText(from, aiReply);
          }
          if (database) await database.ref('pending/' + safeFrom).remove();
          delete memoryPending[safeFrom];
          return res.status(200).json({ status: 'ok' });
        } else {
          await sendText(from, 'Galat number. Sahi number chunein (1 to ' + pending.matches.length + ').');
          return res.status(200).json({ status: 'ok' });
        }
      }
    }

    if (isAdmin && text.indexOf('!setprompt ') === 0) { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text === '!status') { await sendText(from, '*Bot Status*\nOnline'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text.indexOf('!addpdf ') === 0) { var parts = text.slice(8).split('|').map(function(s){return s.trim();}); if(parts.length===3){var list=await getPDFList(); list[parts[0].toLowerCase()]={name:parts[1],url:parts[2]}; await savePDFList(list); await sendText(from,'PDF added!');} else {await sendText(from,'Format: !addpdf keyword | Name | URL');} return res.status(200).json({ status: 'ok' }); }

    var lower = text.toLowerCase();
    if (['hi','hello','namaste','hey','hii','good morning','kaise ho'].some(function(g){return lower.indexOf(g)!==-1;})) {
      await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
      return res.status(200).json({ status: 'ok' });
    }

    var sendWords = ['send','bhejo','share','bhej','de do','dedo','chahiye','pdf'];
    var hasSend = sendWords.some(function(w){return lower.indexOf(w)!==-1;});
    var hasMRP = ['mrp','maximum retail'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasList = ['list price','dlp','dealer price'].some(function(w){return lower.indexOf(w)!==-1;});
    var base = process.env.GITHUB_RAW_BASE;
    if (hasSend && hasMRP && dataResult.mrpFile) { await sendText(from, 'Sending ' + dataResult.mrpFile + '...'); await sendDocument(from, base + '/' + encodeURIComponent(dataResult.mrpFile), dataResult.mrpFile, dataResult.mrpFile); return res.status(200).json({ status: 'ok' }); }
    if (hasSend && hasList && dataResult.dlpFile) { await sendText(from, 'Sending ' + dataResult.dlpFile + '...'); await sendDocument(from, base + '/' + encodeURIComponent(dataResult.dlpFile), dataResult.dlpFile, dataResult.dlpFile); return res.status(200).json({ status: 'ok' }); }
    for (var k in savedPDFs) { if (lower.indexOf(k.toLowerCase()) !== -1 && hasSend) { await sendText(from, 'Sending ' + savedPDFs[k].name + '...'); await sendDocument(from, savedPDFs[k].url, savedPDFs[k].name, savedPDFs[k].name); return res.status(200).json({ status: 'ok' }); } }

    var prodMatches = searchProducts(text, dataResult.mrpMap, dataResult.dlpMap);
    var invMatches = searchInvoices(text, dataResult.invoiceMap);
    
    // Explicitly check if the user is asking for custom analytics
    var isAnalytics = ['top', 'highest', 'total', 'month', 'volume', 'sales', 'executive', 'report', 'summary', 'sabse', 'zyada', 'kam', 'hisab'].some(function(w){return lower.indexOf(w)!==-1;});
    var isRateQuery = ['rate','kya hai','kitna','price','mrp','dlp','kitne ka','dam','rupay','batao'].some(function(w){return lower.indexOf(w)!==-1;});

    if (isRateQuery && prodMatches.length > 0 && invMatches.length === 0) {
      if (prodMatches.length === 1) {
        var p = prodMatches[0];
        var context = '[MRP DATA]\n' + p.mrpChunk + '\n\n[DLP DATA]\n' + p.dlpChunk;
        var aiReply = await getAIReply('User Query: ' + text + '\nGive exact MRP and DLP for the specified size. Note: 0.9L = 900ml.', context, sysPrompt);
        await sendText(from, aiReply);
        return res.status(200).json({ status: 'ok' });
      } else if (prodMatches.length > 1) {
        var msg = '*Kaunsa product check karna hai? Number reply karein:*\n\n';
        for (var i = 0; i < prodMatches.length; i++) { msg += (i + 1) + '. ' + prodMatches[i].name + '\n'; }
        if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() }); } catch (e) {} }
        memoryPending[safeFrom] = { type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() };
        await sendText(from, msg);
        return res.status(200).json({ status: 'ok' });
      }
    }

    if (invMatches.length === 1) {
      var m = invMatches[0]; var f = m.rows[0];
      var prods = m.rows.map(function(r){ return r['Product Name'] + '(' + r['Product Volume'] + 'L)'; }).join(' + ');
      var tG = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value incl VAT/GST']) || 0); }, 0);
      var wG = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value Without GST']) || 0); }, 0);
      var cg = m.rows.reduce(function(s, r){ return s + (parseFloat(r['CGST Value']) || 0); }, 0);
      var sg = m.rows.reduce(function(s, r){ return s + (parseFloat(r['SGST Value']) || 0); }, 0);
      var vl = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Product Volume']) || 0); }, 0);
      await sendText(from, '*Invoice:* ' + m.invNo + '\n*Customer:* ' + f['Customer Name'] + '\n*Products:* ' + prods + '\n*Total:* Rs.' + tG.toFixed(2) + '\n*Total Volume:* ' + vl.toFixed(1) + ' L\n*Tax:* CGST Rs.' + cg.toFixed(2) + ' + SGST Rs.' + sg.toFixed(2) + '\n*Date:* ' + cleanDate(f['Invoice Date']) + '\n*Payment:* ' + f['Mode Of Payement']);
      return res.status(200).json({ status: 'ok' });
    } else if (invMatches.length > 1) {
      var msg = '*Multiple invoices found. Number reply karein:*\n\n';
      for (var i = 0; i < invMatches.length; i++) { msg += (i + 1) + '. ' + invMatches[i].customer + ' (Inv: ' + invMatches[i].invNo + ')\n'; }
      if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'invoice', matches: invMatches, ts: Date.now() }); } catch (e) {} }
      memoryPending[safeFrom] = { type: 'invoice', matches: invMatches, ts: Date.now() };
      await sendText(from, msg);
      return res.status(200).json({ status: 'ok' });
    }

    // ✅ NEW FIX: Custom Analytics AI fallback engine
    // Agar query product ki nahi hai, aur invoice ki list bhi nahi khuli, to Data Engine ko bhejo!
    var customPrompt = 'User Query: "' + text + '"\n\nInstructions:\n1. Check if the user is asking about top customers, volumes, sales executives, monthly totals, or highest bills. If YES, analyze the INVOICE DATABASE in the context below and give an accurate numeric answer in Hinglish.\n2. If the user is asking for a Product MRP/DLP, reply strictly with: "Ye product list mein nahi mila. Spelling check karke dobara try karein."\n3. Format: Plain text only. NO EMOJIS, NO SYMBOLS. Use "Rs." instead of the Rupee symbol.';
    var customReply = await getAIReply(customPrompt, dataResult.excelData, sysPrompt);
    
    // Safety check just in case the AI bugs out
    if (!customReply || customReply.indexOf('Error') !== -1 || customReply.indexOf('missing') !== -1) {
        await sendText(from, 'Maaf kijiye, mujhe is sawal ka data database me nahi mila.');
    } else {
        await sendText(from, customReply);
    }
    
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
