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
  var def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf data se exact rate batao. 0.9L aur 900ml dono same hote hain.\n2. Exact Size ki value batayein jo user ne puchi hai. Agar user ne 900ml pucha hai, toh sirf 900ml ka batayein.\n3. Format:\n*Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n4. Text Hinglish me rakho.';
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
  var dt = typeof val === 'number' ? new Date(Math.round((val - 25569) * 86400000)) : new Date(val);
  if (isNaN(dt.getTime())) return String(val).trim();
  var m = String(dt.getMonth() + 1).padStart(2, '0');
  var d = String(dt.getDate()).padStart(2, '0');
  var y = dt.getFullYear();
  return m + '/' + d + '/' + y;
}

// ✅ FIX: Converts all varying size formats to standard clean keys
function normalizeSizeHeader(header) {
  if (!header) return '';
  var h = String(header).toLowerCase().replace(/\s+/g, '').replace(/\/+$/, '').replace(/\\+$/, '');
  
  if (h.indexOf('brand') !== -1) return 'BRAND NAME';

  if (h === '1.2/11' || h === '1.2/1l') return '1L'; // Castrol specific issue
  
  if (h === '900ml' || h === '0.9l' || h === '900') return '900ML';
  if (h === '800ml' || h === '0.8l' || h === '800') return '800ML';
  if (h === '600ml' || h === '0.6l' || h === '600') return '600ML';
  if (h === '500ml' || h === '0.5l' || h === '500') return '500ML';
  if (h === '350ml' || h === '0.35l' || h === '350') return '350ML';
  if (h === '250ml' || h === '0.25l' || h === '250') return '250ML';
  if (h === '175ml' || h === '0.175l' || h === '175') return '175ML';
  if (h === '100ml' || h === '0.1l' || h === '100') return '100ML';

  if (h === '1' || h === '1l' || h === '11') return '1L';
  if (h === '1.2' || h === '1.2l') return '1.2L';
  if (h === '1.5' || h === '1.5l') return '1.5L';
  if (h === '2' || h === '2l') return '2L';
  if (h === '2.5' || h === '2.5l' || h === '2.51') return '2.5L';
  if (h === '3' || h === '3l' || h === '31') return '3L';
  if (h === '3.5' || h === '3.5l') return '3.5L';
  if (h === '4' || h === '4l') return '4L';
  if (h === '4.5' || h === '4.5l') return '4.5L';
  if (h === '5' || h === '5l' || h === '51') return '5L';
  if (h === '7' || h === '7l' || h === '71') return '7L';
  if (h === '7.5' || h === '7.5l') return '7.5L';
  if (h === '8.5' || h === '8.5l') return '8.5L';
  if (h === '10' || h === '10l' || h === '101') return '10L';
  if (h === '11' || h === '11l' || h === '111') return '11L';
  if (h === '12' || h === '12l' || h === '121') return '12L';
  if (h === '15' || h === '15l' || h === '151') return '15L';
  if (h === '18' || h === '18l' || h === '181') return '18L';
  if (h === '20' || h === '20l' || h === '201') return '20L';
  if (h === '21' || h === '21l' || h === '211') return '21L';
  if (h === '50' || h === '50l' || h === '501') return '50L';
  if (h === '210' || h === '210l' || h === '2101') return '210L';

  return String(header).trim().toUpperCase();
}

// ✅ MEGA-FIX: Read arrays natively so empty columns do not shift data
function loadPriceListFromExcel(wb) {
  var priceMap = {};
  for (var s = 0; s < wb.SheetNames.length; s++) {
    // Read as 2D Array to preserve exact column positions
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { header: 1, defval: '' });
    var currentHeaders = [];
    
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length === 0) continue;
      
      var col0 = String(row[0] || '').trim();
      var lowerCol0 = col0.toLowerCase();
      
      // If row starts with "BRAND NAME", it's the header row
      if (lowerCol0.indexOf('brand name') !== -1) {
        currentHeaders = row.map(function(c) { return normalizeSizeHeader(c); });
        continue;
      }
      
      // If we have headers and a valid product name
      if (currentHeaders.length > 0 && col0.length > 3) {
        // Exclude category rows (e.g., "MOTORCYCLE OIL" with no prices)
        var hasPrice = false;
        for (var j = 1; j < row.length; j++) { if (row[j] !== '' && !isNaN(parseFloat(row[j]))) { hasPrice = true; break; } }
        if (!hasPrice) continue;
        
        if (!priceMap[col0]) priceMap[col0] = {};
        
        // Match exact cell to exact header
        for (var j = 1; j < row.length; j++) {
          var size = currentHeaders[j];
          var val = parseFloat(row[j]);
          if (size && size !== '' && !isNaN(val)) {
            priceMap[col0][size] = val;
          }
        }
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

  var combinedProducts = {};
  
  // Merge MRP
  for (var mName in mrpMap) {
    var normName = mName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!combinedProducts[normName]) combinedProducts[normName] = { orig: mName, sizes: {} };
    for (var mSize in mrpMap[mName]) {
      if (!combinedProducts[normName].sizes[mSize]) combinedProducts[normName].sizes[mSize] = {};
      combinedProducts[normName].sizes[mSize].mrp = mrpMap[mName][mSize];
    }
  }

  // Merge DLP
  for (var dName in dlpMap) {
    var normNameD = dName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!combinedProducts[normNameD]) combinedProducts[normNameD] = { orig: dName, sizes: {} };
    for (var dSize in dlpMap[dName]) {
      if (!combinedProducts[normNameD].sizes[dSize]) combinedProducts[normNameD].sizes[dSize] = {};
      combinedProducts[normNameD].sizes[dSize].dlp = dlpMap[dName][dSize];
    }
  }

  var products = [];
  for (var key in combinedProducts) {
    var score = 0;
    for (var t = 0; t < searchTerms.length; t++) {
      if (key.indexOf(searchTerms[t]) !== -1) score++;
    }
    var required = Math.min(2, Math.max(1, searchTerms.length - 1));
    
    if (score >= required) {
      var pData = combinedProducts[key];
      var chunk = 'Product: ' + pData.orig + '\n';
      var hasData = false;
      
      for (var s in pData.sizes) {
        var finalMrp = pData.sizes[s].mrp || 'N/A';
        var finalDlp = pData.sizes[s].dlp || 'N/A';
        chunk += '- Size [' + s + '] : MRP Rs. ' + finalMrp + ' | DLP Rs. ' + finalDlp + '\n';
        hasData = true;
      }
      
      if (hasData) {
        products.push({ name: pData.orig, score: score, chunk: chunk });
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
  
  // Sales Invoices
  var excelFiles = fileList.filter(function(f){ 
    return f.match(/\.(xlsx|xls|csv)$/i) && 
           !f.toLowerCase().includes('mrp') && 
           !f.toLowerCase().includes('dlp') && 
           !f.toLowerCase().includes('list'); 
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
  
  // MRP Extraction
  var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
  var mrpMap = {};
  if (mrpFile) {
    try {
      var mrpRes = await axios.get(base + '/' + encodeURIComponent(mrpFile), {responseType:'arraybuffer'});
      var mrpWb = XLSX.read(mrpRes.data, {type:'buffer'});
      mrpMap = loadPriceListFromExcel(mrpWb);
    } catch(e) {}
  }
  
  // DLP Extraction
  var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp') || f.toLowerCase().includes('list')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
  var dlpMap = {};
  if (dlpFile) {
    try {
      var dlpRes = await axios.get(base + '/' + encodeURIComponent(dlpFile), {responseType:'arraybuffer'});
      var dlpWb = XLSX.read(dlpRes.data, {type:'buffer'});
      dlpMap = loadPriceListFromExcel(dlpWb);
    } catch(e) {}
  }
  
  globalCache = { 
    invoiceMap: invoiceMap, 
    mrpMap: mrpMap, 
    dlpMap: dlpMap,
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
      max_tokens: 600, temperature: 0.1 
    }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 }); 
    return sanitizeReply(res.data.choices[0].message.content) || 'Kuch error aaya.'; 
  } catch (e) { return 'System Error: ' + e.message; }
}

async function sendText(to, text) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(baseUrl + '/message/sendText/' + inst, { number: num, text: text }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) {}
}

async function sendDocument(to, fileUrl, fileName, caption) {
  var baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(baseUrl + '/message/sendMedia/' + inst, { number: num, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName: fileName, caption: caption || '' }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) {}
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
            await sendText(from, '*Invoice:* ' + m.invNo + '\n*Customer:* ' + f['Customer Name'] + '\n*Products:* ' + prods + '\n*Total:* Rs.' + tG.toFixed(2) + '\n*Date:* ' + cleanDate(f['Invoice Date']) + '\n*Payment:* ' + f['Mode Of Payement']);
          } else if (pending.type === 'product') {
            var p = pending.matches[idx];
            var context = '[PRICE DATA]\n' + p.chunk;
            var aiPrompt = 'User\'s ORIGINAL query was: "' + pending.originalQuery + '". \nNow User selected Product: ' + p.name + '. \nBelow is the exact price list for this product. Provide exact MRP and DLP ONLY for the SPECIFIC SIZE the user originally asked for. Note: 0.9L = 900ml.';
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

    var lower = text.toLowerCase();
    if (['hi','hello','namaste','hey','hii','good morning','kaise ho'].some(function(g){return lower.indexOf(g)!==-1;})) {
      await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
      return res.status(200).json({ status: 'ok' });
    }

    var prodMatches = searchProducts(text, dataResult.mrpMap, dataResult.dlpMap);
    var invMatches = searchInvoices(text, dataResult.invoiceMap);
    var isRateQuery = ['rate','kya hai','kitna','price','mrp','dlp','kitne ka','dam','rupay','batao'].some(function(w){return lower.indexOf(w)!==-1;});

    if (isRateQuery || (prodMatches.length > 0 && invMatches.length === 0)) {
      if (prodMatches.length === 1) {
        var p = prodMatches[0];
        var context = '[PRICE DATA]\n' + p.chunk;
        var aiReply = await getAIReply('User Query: ' + text + '\nGive exact MRP and DLP ONLY for the size explicitly mentioned in the query. Note: 0.9L is exactly equal to 900ml.', context, sysPrompt);
        await sendText(from, aiReply);
        return res.status(200).json({ status: 'ok' });
      } else if (prodMatches.length > 1) {
        var msg = '*Kaunsa product check karna hai? Number reply karein:*\n\n';
        for (var i = 0; i < prodMatches.length; i++) { msg += (i + 1) + '. ' + prodMatches[i].name + '\n'; }
        if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() }); } catch (e) {} }
        memoryPending[safeFrom] = { type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() };
        await sendText(from, msg);
        return res.status(200).json({ status: 'ok' });
      } else {
        await sendText(from, 'Ye product list mein nahi mila. Spelling check karke dobara try karein.');
        return res.status(200).json({ status: 'ok' });
      }
    }

    if (invMatches.length === 1) {
      var m = invMatches[0]; var f = m.rows[0];
      var prods = m.rows.map(function(r){ return r['Product Name'] + '(' + r['Product Volume'] + 'L)'; }).join(' + ');
      var tG = m.rows.reduce(function(s, r){ return s + (parseFloat(r['Total Value incl VAT/GST']) || 0); }, 0);
      await sendText(from, '*Invoice:* ' + m.invNo + '\n*Customer:* ' + f['Customer Name'] + '\n*Products:* ' + prods + '\n*Total:* Rs.' + tG.toFixed(2) + '\n*Date:* ' + cleanDate(f['Invoice Date']) + '\n*Payment:* ' + f['Mode Of Payement']);
      return res.status(200).json({ status: 'ok' });
    } else if (invMatches.length > 1) {
      var msg = '*Multiple invoices found. Number reply karein:*\n\n';
      for (var i = 0; i < invMatches.length; i++) { msg += (i + 1) + '. ' + invMatches[i].customer + ' (Inv: ' + invMatches[i].invNo + ')\n'; }
      if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'invoice', matches: invMatches, ts: Date.now() }); } catch (e) {} }
      memoryPending[safeFrom] = { type: 'invoice', matches: invMatches, ts: Date.now() };
      await sendText(from, msg);
      return res.status(200).json({ status: 'ok' });
    }

    await sendText(from, 'Main sirf Invoices aur Product Rates (MRP/DLP) batane ke liye bani hoon. Sahi sawal puchein.');
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
// END OF FILE
