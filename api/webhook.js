const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse');

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
  var def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf data se exact rate batao. 0.9L = 900ml.\n2. MRP vs DLP: "MRP" ke liye SIRF [MRP DATA], "DLP" ke liye SIRF [DLP DATA].\n3. Exact Size ki value batayein.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho.';
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

function cleanPDFText(rawText) {
  if (!rawText) return '';
  var cleaned = '';
  var inQuotes = false;
  for (var i = 0; i < rawText.length; i++) {
    if (rawText[i] === '"') inQuotes = !inQuotes;
    if (rawText[i] === '\n' && inQuotes) { cleaned += ' '; } else { cleaned += rawText[i]; }
  }
  return cleaned;
}

function parseCSVLine(line) {
  var cols = [];
  var inQuotes = false;
  var current = '';
  for (var i = 0; i < line.length; i++) {
    var char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { cols.push(current.trim()); current = ''; }
    else { current += char; }
  }
  cols.push(current.trim());
  return cols.map(function(c){ return c.trim(); });
}

function searchProducts(query, mrpTextRaw, dlpTextRaw) {
  var q = query.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  var words = q.split(/\s+/);
  var stopWords = ['price','rate','mrp','dlp','kya','hai','batao','aur','ka','ke','liye','ye','pucha'];
  var searchTerms = words.filter(function(w){ return w.length > 1 && stopWords.indexOf(w) === -1; });
  if (searchTerms.length === 0) return [];

  var products = [];
  var seenNames = {};

  function scanText(text, type) {
    if (!text) return;
    var lines = text.split('\n');
    var currentHeaders = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var lower = line.toLowerCase();
      if (lower.indexOf('brand name') !== -1) { currentHeaders = parseCSVLine(line); continue; }
      if (currentHeaders.length === 0) continue;
      var cols = parseCSVLine(line);
      if (cols.length < 2) continue;
      var name = cols[0].replace(/"/g, '').trim();
      if (name.length < 4 || lower.indexOf('passenger car') !== -1 || lower.indexOf('diesel engine') !== -1) continue;
      var nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, ' ');
      var exactNameMatches = 0;
      for (var t = 0; t < searchTerms.length; t++) { if (nameNorm.indexOf(searchTerms[t]) !== -1) exactNameMatches++; }
      var requiredMatches = Math.min(2, Math.max(1, searchTerms.length - 1));
      if (exactNameMatches >= requiredMatches) {
        var chunkLines = ['Product: ' + name];
        for (var c = 1; c < cols.length && c < currentHeaders.length; c++) {
          if (cols[c] && cols[c] !== '') {
            var sizeHeader = currentHeaders[c].replace(/\s+/g, ' ').replace(/"/g, '').trim();
            sizeHeader = sizeHeader.replace(/^11$/, '1L').replace(/^51$/, '5L').replace(/^71$/, '7L').replace(/^31$/, '3L').replace(/^2\.51$/, '2.5L').replace(/1\.2\/\s*11/, '1.2L / 1L').replace(/\/$/, 'L');
            chunkLines.push('- Size [' + sizeHeader + '] : Rs. ' + cols[c]);
          }
        }
        var chunk = chunkLines.join('\n');
        var nameKey = name.toLowerCase();
        if (!seenNames[nameKey]) {
          seenNames[nameKey] = true;
          products.push({ name: name, score: exactNameMatches, mrpChunk: type === 'MRP' ? chunk : '', dlpChunk: type === 'DLP' ? chunk : '' });
        } else {
          for (var p = 0; p < products.length; p++) {
            if (products[p].name.toLowerCase() === nameKey) {
              if (type === 'MRP') products[p].mrpChunk = chunk;
              if (type === 'DLP') products[p].dlpChunk = chunk;
              if (exactNameMatches > products[p].score) products[p].score = exactNameMatches;
              break;
            }
          }
        }
      }
    }
  }
  scanText(mrpTextRaw, 'MRP');
  scanText(dlpTextRaw, 'DLP');
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

async function extractPDFText(url) {
  try { var res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 }); var data = await pdfParse(Buffer.from(res.data)); return data.text || ''; } catch (e) { console.error('[PDF] Err:', e.message); return ''; }
}

async function loadAllData() {
  if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache;
  var base = process.env.GITHUB_RAW_BASE;
  if (!base) return { excelData: '', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {}, mrpTextRaw: '', listTextRaw: '' };
  var fileList = []; try { fileList = (await axios.get(base + '/index.json')).data; } catch(e) { return null; }
  var excelFiles = fileList.filter(function(f){ return f.match(/\.(xlsx|xls|csv)$/i); });
  var mrpFile = fileList.find(function(f){ return f.toLowerCase().indexOf('mrp') !== -1; });
  var listFile = fileList.find(function(f){ return f.toLowerCase().indexOf('list') !== -1 && f.toLowerCase().indexOf('mrp') === -1; });
  var mrpPdfUrl = mrpFile ? base + '/' + encodeURIComponent(mrpFile) : '';
  var listPdfUrl = listFile ? base + '/' + encodeURIComponent(listFile) : '';
  var allRows = [];
  for (var k = 0; k < excelFiles.length; k++) {
    try { var res = await axios.get(base + '/' + encodeURIComponent(excelFiles[k]), {responseType:'arraybuffer'}); var wb = XLSX.read(res.data, {type:'buffer'}); for (var s = 0; s < wb.SheetNames.length; s++) { allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], {defval:''})); } } catch(e){}
  }
  var invoiceMap = {}; for (var m = 0; m < allRows.length; m++) { var inv = allRows[m]['Invoice No'] || ''; if(inv){ if(!invoiceMap[inv]) invoiceMap[inv] = []; invoiceMap[inv].push(allRows[m]); } }
  var mrpTextRaw = mrpPdfUrl ? cleanPDFText(await extractPDFText(mrpPdfUrl)) : '';
  var listTextRaw = listPdfUrl ? cleanPDFText(await extractPDFText(listPdfUrl)) : '';
  globalCache = { mrpPdfUrl: mrpPdfUrl, listPdfUrl: listPdfUrl, mrpFile: mrpFile, listFile: listFile, invoiceMap: invoiceMap, mrpTextRaw: mrpTextRaw, listTextRaw: listTextRaw };
  lastCacheTime = Date.now();
  return globalCache;
}

async function getAIReply(userMsg, data, prompt) {
  var key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try { var res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { model: 'meta/llama-3.1-70b-instruct', messages: [{ role: 'system', content: prompt + '\n\nMatch the size explicitly. 0.9L = 900ml.\n\nCONTEXT DATA:\n' + data }, { role: 'user', content: userMsg }], max_tokens: 600, temperature: 0.1 }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 }); return sanitizeReply(res.data.choices[0].message.content) || 'Kuch error aaya.'; } catch (e) { return 'System Error: ' + e.message; }
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
    var adminNum = process.env.ADMIN_NUMBER || '916375636354';
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
            var context = '[MRP DATA]\n' + p.mrpChunk + '\n\n[DLP DATA]\n' + p.dlpChunk;
            var aiPrompt = 'User query: ' + pending.originalQuery + '. Give exact MRP and DLP for the size asked. 0.9L = 900ml.';
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
    if (hasSend && hasMRP && dataResult.mrpPdfUrl) { await sendText(from, 'Sending ' + dataResult.mrpFile + '...'); await sendDocument(from, dataResult.mrpPdfUrl, dataResult.mrpFile, dataResult.mrpFile); return res.status(200).json({ status: 'ok' }); }
    if (hasSend && hasList && dataResult.listPdfUrl) { await sendText(from, 'Sending ' + dataResult.listFile + '...'); await sendDocument(from, dataResult.listPdfUrl, dataResult.listFile, dataResult.listFile); return res.status(200).json({ status: 'ok' }); }
    for (var k in savedPDFs) { if (lower.indexOf(k.toLowerCase()) !== -1 && hasSend) { await sendText(from, 'Sending ' + savedPDFs[k].name + '...'); await sendDocument(from, savedPDFs[k].url, savedPDFs[k].name, savedPDFs[k].name); return res.status(200).json({ status: 'ok' }); } }

    var prodMatches = searchProducts(text, dataResult.mrpTextRaw, dataResult.listTextRaw);
    var invMatches = searchInvoices(text, dataResult.invoiceMap);
    var isRateQuery = ['rate','kya hai','kitna','price','mrp','dlp','kitne ka','dam','rupay','batao'].some(function(w){return lower.indexOf(w)!==-1;});

    if (isRateQuery || (prodMatches.length > 0 && invMatches.length === 0)) {
      if (prodMatches.length === 1) {
        var p = prodMatches[0];
        var context = '[MRP DATA]\n' + p.mrpChunk + '\n\n[DLP DATA]\n' + p.dlpChunk;
        var aiReply = await getAIReply('User Query: ' + text + '\nGive exact MRP and DLP for the specified size.', context, sysPrompt);
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
    } else if (invMatches.length === 0 && (text.match(/^\d+$/) || text.toLowerCase().indexOf('inv') !== -1)) {
      await sendText(from, 'Invoice nahi mila. Sahi details daalein.');
      return res.status(200).json({ status: 'ok' });
    }

    await sendText(from, 'Main sirf Invoices aur Product Rates (MRP/DLP) batane ke liye bani hoon. Sahi sawal puchein.');
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
