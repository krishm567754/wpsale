const axios    = require('axios');
const XLSX     = require('xlsx');
const admin    = require('firebase-admin');

let db = null;
let globalCache = null;
let lastCacheTime = 0;
let memoryPending = {};

// ─── FIREBASE ──────────────────────────────────────────────────────────────
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

// ─── SETTINGS, WHITELIST & ADMINS ──────────────────────────────────────────
async function isWhitelistActive() {
    var d = getFirebase(); if (!d) return false;
    try { var s = await d.ref('botConfig/whitelistActive').get(); return s.exists() ? s.val() : false; } catch(e) { return false; }
}
async function setWhitelistActive(val) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/whitelistActive').set(val); } catch(e){} } }
async function getAllowedNumbers() {
    var d = getFirebase(); if (!d) return {};
    try { var s = await d.ref('botConfig/allowedNumbers').get(); return s.exists() ? s.val() : {}; } catch(e) { return {}; }
}
async function allowNumber(num) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/allowedNumbers/' + num).set(true); } catch(e){} } }
async function blockNumber(num) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/allowedNumbers/' + num).remove(); } catch(e){} } }

async function getBotSettings() {
    var d = getFirebase(); if (!d) return { botEnabled: true, aiEnabled: true };
    try { var s = await d.ref('botConfig/settings').get(); return s.exists() ? s.val() : { botEnabled: true, aiEnabled: true }; } catch(e) { return { botEnabled: true, aiEnabled: true }; }
}
async function updateBotSetting(key, val) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/settings/' + key).set(val); } catch(e){} } }

async function getAdmins() {
    var d = getFirebase(); if (!d) return {};
    try { var s = await d.ref('botConfig/admins').get(); return s.exists() ? s.val() : {}; } catch(e) { return {}; }
}
async function addAdminNumber(num) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/admins/' + num).set(true); } catch(e){} } }

async function getSystemPrompt() {
    var d = getFirebase();
    var def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf CONTEXT DATA se jawab de. Kuch bhi invent mat kar.\n2. 0.9L aur 900ml dono same hote hain.\n3. Exact Size ki value batayein jo user ne puchi hai.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho.\n6. Emojis ya special symbols bilkul use mat karo. Rupee sign ki jagah sirf "Rs." likho.\n7. Agar answer CONTEXT DATA me clearly nahi milta to exactly likho: "Please wait, admin will reply soon."';
    if (!d) return def;
    try { var s = await d.ref('botConfig/systemPrompt').get(); return s.exists() ? s.val() : def; } catch (e) { return def; }
}
async function saveSystemPrompt(p) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/systemPrompt').set(p); } catch(e){} } }
async function getPDFList() { var d = getFirebase(); if (!d) return {}; try { var s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e){ return {}; } }
async function savePDFList(data) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/pdfFiles').set(data); } catch(e){} } }

// ─── 100% STRICT SANITIZER ───────────────────────────────
function sanitizeReply(t) {
    if (!t) return '';
    var clean = t.replace(/₹/g, 'Rs.').replace(/â‚¹/g, 'Rs.').replace(/Rs\./g, 'Rs.');
    clean = clean.replace(/[^\x20-\x7E\n]/g, '');
    return clean.replace(/\*\*/g, '*').replace(/\n{3,}/g, '\n\n').split('\n').map(function(l){return l.trim();}).join('\n').trim();
}

function getTimestamp(val) {
    if (!val) return 0;
    if (typeof val === 'number') {
        if (val > 1000000) return val; 
        return Math.round((val - 25569) * 86400000); 
    }
    var d = new Date(val);
    return isNaN(d.getTime()) ? 0 : d.getTime();
}

function cleanDate(val) {
    if (!val) return 'N/A';
    var ts = getTimestamp(val);
    if (ts === 0) return String(val).trim();
    var dt = new Date(ts);
    return String(dt.getDate()).padStart(2,'0') + '/' + String(dt.getMonth()+1).padStart(2,'0') + '/' + dt.getFullYear();
}

// ─── ROBUST DATE EXTRACTOR ───────────────────────────────────
function extractDateRange(text) {
    var lower = text.toLowerCase();
    var now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    var cy = now.getFullYear(); var cm = now.getMonth(); var cd = now.getDate();
    
    function toTS(y, m, d, h, min, s) { return new Date(y, m, d, h||0, min||0, s||0).getTime(); }
    
    var monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    var monthFull = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    
    var yearMatch = lower.match(/\b(202\d)\b/);
    var targetYear = yearMatch ? parseInt(yearMatch[1]) : null;

    var targetMonth = -1;
    for(var i=0; i<12; i++){
        if(lower.match(new RegExp("\\b" + monthFull[i] + "\\b")) || lower.match(new RegExp("\\b" + monthNames[i] + "\\b"))) {
            targetMonth = i; break;
        }
    }

    if (targetYear === null) {
        targetYear = (targetMonth > cm) ? cy - 1 : cy; 
        if (targetMonth === -1) targetYear = cy;
    }

    var rangeMatch = lower.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:to|-|se)\s*(\d{1,2})\s*(?:st|nd|rd|th)?/);
    if (rangeMatch && targetMonth !== -1) {
        return { from: toTS(targetYear, targetMonth, parseInt(rangeMatch[1])), to: toTS(targetYear, targetMonth, parseInt(rangeMatch[2]), 23, 59, 59), label: rangeMatch[1] + ' to ' + rangeMatch[2] + ' ' + monthFull[targetMonth].toUpperCase() + ' ' + targetYear, exactMonth: targetMonth };
    }
    if (rangeMatch && targetMonth === -1) {
        return { from: toTS(cy, cm, parseInt(rangeMatch[1])), to: toTS(cy, cm, parseInt(rangeMatch[2]), 23, 59, 59), label: rangeMatch[1] + ' to ' + rangeMatch[2] + ' ' + monthFull[cm].toUpperCase() + ' ' + cy };
    }

    var singleDateMatch = lower.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
    if (singleDateMatch) {
        var day = parseInt(singleDateMatch[1]);
        var mStr = singleDateMatch[2];
        var tm = monthNames.indexOf(mStr);
        if (tm !== -1) {
            var y = yearMatch ? targetYear : (tm > cm ? cy - 1 : cy);
            return { from: toTS(y, tm, day, 0, 0, 0), to: toTS(y, tm, day, 23, 59, 59), label: day + ' ' + monthFull[tm].toUpperCase() + ' ' + y, exactMonth: tm };
        }
    }

    if (lower.includes('1st week') || lower.includes('first week') || lower.includes('pehla hafta') || lower.includes('week 1')) {
        var tm = targetMonth !== -1 ? targetMonth : cm;
        return { from: toTS(targetYear, tm, 1), to: toTS(targetYear, tm, 7, 23, 59, 59), label: '1st Week of ' + monthFull[tm].toUpperCase() + ' ' + targetYear, exactMonth: tm };
    }

    if (targetMonth !== -1) {
        return { from: toTS(targetYear, targetMonth, 1), to: toTS(targetYear, targetMonth + 1, 0, 23, 59, 59), label: monthFull[targetMonth].toUpperCase() + ' ' + targetYear, exactMonth: targetMonth };
    }
    
    if (lower.match(/\btoday\b|\baaj\b/)) return { from: toTS(cy, cm, cd), to: toTS(cy, cm, cd, 23, 59, 59), label: 'Today' };
    if (lower.match(/\byesterday\b|\bkal\b/)) return { from: toTS(cy, cm, cd - 1), to: toTS(cy, cm, cd - 1, 23, 59, 59), label: 'Yesterday' };
    if (lower.match(/\bthis\s*week\b|\bis\s*hafte\b|\bchalu\s*hafte\b/)) {
        var d = now.getDay() === 0 ? 6 : now.getDay() - 1;
        return { from: toTS(cy, cm, cd - d), to: toTS(cy, cm, cd + (6 - d), 23, 59, 59), label: 'This Week' };
    }
    if (lower.match(/\blast\s*week\b|\bpichla\s*hafte\b|\bpichhle\s*hafte\b|\bprevious\s*week\b/)) {
        var d2 = now.getDay() === 0 ? 6 : now.getDay() - 1;
        return { from: toTS(cy, cm, cd - d2 - 7), to: toTS(cy, cm, cd - d2 - 1, 23, 59, 59), label: 'Last Week' };
    }
    if (lower.match(/\bthis\s*month\b|\bis\s*mahine\b|\bchalu\s*mahine\b/)) {
        return { from: toTS(cy, cm, 1), to: toTS(cy, cm + 1, 0, 23, 59, 59), label: 'This Month' };
    }
    if (lower.match(/\blast\s*month\b|\bpichla\s*mahine\b|\bprevious\s*month\b/)) {
        var lm = cm === 0 ? 11 : cm - 1;
        var ly = cm === 0 ? cy - 1 : cy;
        return { from: toTS(ly, lm, 1), to: toTS(ly, lm + 1, 0, 23, 59, 59), label: 'Last Month' };
    }
    return null;
}

function extractLimit(text) { 
    var m = text.match(/(?:top|sabse|highest|best)\s*(\d{1,3})/i); 
    if (m) return parseInt(m[1]);
    if (text.toLowerCase().includes('top')) {
        var m2 = text.match(/\b(\d{1,2})\b/);
        if (m2) return parseInt(m2[1]);
    }
    return 5; 
}

function parseDataQuery(text) {
    var result = { type: null, filters: { customer: null, dateRange: null }, limit: extractLimit(text) };
    result.filters.dateRange = extractDateRange(text);
    return result;
}

function isDateInRange(ts, dateRange) {
    if (!dateRange) return true; 
    if (ts <= 0) return false; 
    if (dateRange.exactMonth !== undefined) {
        var d = new Date(ts);
        if (d.getMonth() === dateRange.exactMonth) return true;
    }
    return (ts >= dateRange.from && ts <= dateRange.to);
}

// ─── SIZE NORMALIZER ───────────────────────────────────────────────────────
function normalizeSizeHeader(header) {
    if (!header) return '';
    var h = String(header).toLowerCase().replace(/\s+/g,'').replace(/\/+$/,'').replace(/\\+$/,'');
    if (h.indexOf('brand') !== -1) return 'BRAND NAME';
    var map = {'900ml':'900ML','0.9l':'900ML','900':'900ML','800ml':'800ML','0.8l':'800ML','600ml':'600ML','0.6l':'600ML','500ml':'500ML','0.5l':'500ML','350ml':'350ML','250ml':'250ML','175ml':'175ML','100ml':'100ML','1':'1L','1l':'1L','11':'1L','1.2/11':'1L','1.2/1l':'1L','1.2':'1.2L','1.2l':'1.2L','1.5':'1.5L','1.5l':'1.5L','2':'2L','2l':'2L','2.5':'2.5L','2.5l':'2.5L','2.51':'2.5L','3':'3L','3l':'3L','31':'3L','3.5':'3.5L','3.5l':'3.5L','4':'4L','4l':'4L','4.5':'4.5L','4.5l':'4.5L','5':'5L','5l':'5L','51':'5L','7':'7L','7l':'7L','71':'7L','7.5':'7.5L','7.5l':'7.5L','8.5':'8.5L','8.5l':'8.5L','10':'10L','10l':'10L','101':'10L','15':'15L','15l':'15L','18':'18L','18l':'18L','20':'20L','20l':'20L','201':'20L','50':'50L','50l':'50L','210':'210L'};
    return map[h] || String(header).trim().toUpperCase();
}

function loadPriceListFromExcel(wb) {
    var priceMap = {};
    for (var s = 0; s < wb.SheetNames.length; s++) {
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { header: 1, defval: '' });
        var currentHeaders = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || row.length === 0) continue;
            var col0 = String(row[0] || '').trim();
            if (col0.toLowerCase().indexOf('brand name') !== -1) { currentHeaders = row.map(function(c) { return normalizeSizeHeader(c); }); continue; }
            if (currentHeaders.length > 0 && col0.length > 3) {
                var hasPrice = false; for (var j = 1; j < row.length; j++) { if (row[j] !== '' && !isNaN(parseFloat(row[j]))) { hasPrice = true; break; } }
                if (!hasPrice) continue;
                if (!priceMap[col0]) priceMap[col0] = {};
                for (var j = 1; j < row.length; j++) { var size = currentHeaders[j]; var val = parseFloat(row[j]); if (size && size !== '' && !isNaN(val)) priceMap[col0][size] = val; }
            }
        }
    }
    return priceMap;
}

// ─── PRODUCT SEARCH ────────────────────────────────────────────────────────
function searchProducts(query, mrpMap, dlpMap) {
    var q = query.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    var stopWords = ['price','rate','mrp','dlp','kya','hai','batao','aur','ka','ke','liye','ye','pucha','list'];
    var searchTerms = q.split(/\s+/).filter(function(w){ return w.length > 1 && stopWords.indexOf(w) === -1; });
    if (searchTerms.length === 0) return [];
    var combined = {};
    for (var mName in mrpMap) { var norm = mName.toLowerCase().replace(/[^a-z0-9]/g, ''); if (!combined[norm]) combined[norm] = { orig: mName, sizes: {} }; for (var sz in mrpMap[mName]) { if (!combined[norm].sizes[sz]) combined[norm].sizes[sz] = {}; combined[norm].sizes[sz].mrp = mrpMap[mName][sz]; } }
    for (var dName in dlpMap) { var normD = dName.toLowerCase().replace(/[^a-z0-9]/g, ''); if (!combined[normD]) combined[normD] = { orig: dName, sizes: {} }; for (var sz in dlpMap[dName]) { if (!combined[normD].sizes[sz]) combined[normD].sizes[sz] = {}; combined[normD].sizes[sz].dlp = dlpMap[dName][sz]; } }
    var products = [];
    for (var key in combined) { var score = 0; for (var t = 0; t < searchTerms.length; t++) { if (key.indexOf(searchTerms[t]) !== -1) score++; } if (score >= Math.min(2, Math.max(1, searchTerms.length - 1))) { var pData = combined[key]; var chunk = 'Product: ' + pData.orig + '\n'; var hasData = false; for (var sz in pData.sizes) { chunk += '- Size [' + sz + '] : MRP Rs. ' + (pData.sizes[sz].mrp || 'N/A') + ' | DLP Rs. ' + (pData.sizes[sz].dlp || 'N/A') + '\n'; hasData = true; } if (hasData) products.push({ name: pData.orig, score: score, chunk: chunk }); } }
    products.sort(function(a,b){ return b.score - a.score; }); return products.slice(0, 5);
}

function searchInvoices(query, invoiceMap) {
    var q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
    if (q.length < 3 && !/^\d+$/.test(q.replace(/\s+/g,''))) return [];
    var matches = []; var userKeywords = q.split(' ').filter(function(w){ return w.length > 2; }); if (userKeywords.length === 0) userKeywords = [q];
    var qClean = q.replace(/[^a-z0-9]/g, ''); 
    if (!qClean) return [];

    for (var invNo in invoiceMap) { 
        var rows = invoiceMap[invNo]; 
        var custName = (rows[0]['Customer Name'] || '').toLowerCase().replace(/[^a-z0-9 ]/g, ''); 
        var invClean = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); 
        
        var exactMatch = (invClean === qClean);
        var endsWithMatch = invClean.endsWith(qClean);
        var matchInv = (invClean.indexOf(qClean) !== -1); 
        
        var keywordScore = 0;
        if (custName === qClean) keywordScore += 1000;
        else if (custName.startsWith(qClean)) keywordScore += 500;
        else if (custName.indexOf(qClean) !== -1) keywordScore += 100;
        else { userKeywords.forEach(function(k){ if (custName.indexOf(k) !== -1) keywordScore += 10; }); }
        
        var score = keywordScore;
        if (exactMatch) score += 5000;
        else if (endsWithMatch && /^\d+$/.test(qClean)) score += 3000; 
        else if (matchInv) score += 2000;
        
        if (score > 0) matches.push({ invNo: invNo, rows: rows, customer: rows[0]['Customer Name'], score: score }); 
    }
    matches.sort(function(a,b){ return b.score - a.score; }); return matches.slice(0, 5);
}

function searchCustomers(query, invoiceMap) {
    var lower = query.toLowerCase();
    var custStop = ['ka','ki','ke','ko','ne','liya','batao','dikhao','data','report','invoice','bill','total','volume','wale','wali','mahine','month','week','hafte','is','this','last','pichle','aaj','today','all','sab','poora','maal','liter','l','hisab','kitna','sale','bika'];
    var cleanQuery = lower.replace(new RegExp('\\b(' + custStop.join('|') + ')\\b', 'g'), ' ').replace(/[^a-z0-9 ]/g, '').trim();
    if (cleanQuery.length < 3) return [];
    
    var custSet = {}; for (var inv in invoiceMap) { var c = invoiceMap[inv][0]['Customer Name']; if (c) custSet[c] = true; }
    var matches = [];
    for (var c in custSet) {
        var cLower = c.toLowerCase().replace(/[^a-z0-9 ]/g, ''); 
        var score = 0;
        if (cLower === cleanQuery) score = 1000;
        else if (cLower.startsWith(cleanQuery)) score = 500;
        else if (cLower.indexOf(cleanQuery) !== -1) score = 100;
        else { 
            var words = cleanQuery.split(/\s+/); var matchedWords = 0;
            for (var w = 0; w < words.length; w++) { if (words[w].length >= 3 && cLower.indexOf(words[w]) !== -1) { score += 10; matchedWords++; } }
            if (matchedWords === 0) score = 0;
        }
        if (score > 0) matches.push({ name: c, score: score });
    }
    matches.sort(function(a,b){ return b.score - a.score; });
    return matches.slice(0, 5);
}

// ─── EXACT ANALYTICS DATA GENERATORS ───────────────────────────────────────
function getTopCustomers(invoiceMap, dateRange, limit) {
    limit = limit || 5; var custMap = {};
    for (var inv in invoiceMap) { 
        var rows = invoiceMap[inv]; 
        var cName = rows[0]['Customer Name'] || 'Unknown'; 
        var ts = getTimestamp(rows[0]['Invoice Date']);
        if (!isDateInRange(ts, dateRange)) continue;
        
        if (!custMap[cName]) custMap[cName] = { vol: 0, val: 0, count: 0 }; 
        rows.forEach(function(r){ custMap[cName].vol += parseFloat(r['Product Volume'])||0; custMap[cName].val += parseFloat(r['Total Value incl VAT/GST'])||0; }); 
        custMap[cName].count++; 
    }
    var sorted = Object.keys(custMap).sort(function(a,b){ return custMap[b].vol - custMap[a].vol; }).slice(0, limit);
    if (sorted.length === 0) return 'NO_DATA'; 
    
    var msg = '*Top ' + limit + ' Customers by Volume*\n';
    if (dateRange && dateRange.label) msg += '*Period:* ' + dateRange.label + '\n';
    msg += '\n';
    sorted.forEach(function(name, i){ 
        var s = custMap[name]; 
        msg += (i+1) + '. ' + name + '\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n'; 
    }); 
    return msg.trim();
}

function getTopProducts(allRows, dateRange, limit) {
    limit = limit || 5; var prodMap = {};
    for (var i = 0; i < allRows.length; i++) {
        var r = allRows[i];
        if (!r['Invoice No']) continue;
        var ts = getTimestamp(r['Invoice Date']);
        if (!isDateInRange(ts, dateRange)) continue;

        var prodName = (r['Product Name'] || '').trim();
        if(!prodName) continue;
        var vol = parseFloat(r['Product Volume']) || 0;
        var val = parseFloat(r['Total Value incl VAT/GST']) || 0;
        
        if (!prodMap[prodName]) prodMap[prodName] = { vol: 0, val: 0, count: 0 };
        prodMap[prodName].vol += vol;
        prodMap[prodName].val += val;
        prodMap[prodName].count++;
    }
    var sorted = Object.keys(prodMap).sort(function(a,b){ return prodMap[b].vol - prodMap[a].vol; }).slice(0, limit);
    if (sorted.length === 0) return 'NO_DATA';
    
    var msg = '*Top ' + limit + ' Products by Volume*\n';
    if (dateRange && dateRange.label) msg += '*Period:* ' + dateRange.label + '\n';
    msg += '\n';
    sorted.forEach(function(name, i){
        var s = prodMap[name];
        msg += (i+1) + '. ' + name + '\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Sold: ' + s.count + ' times\n\n';
    });
    return msg.trim();
}

// ✅ SE WISE REPORT WITH GRAND TOTAL
function getExecutiveReport(invoiceMap, dateRange) {
    var execMap = {}; 
    var grandVol = 0, grandVal = 0, grandCount = 0;
    
    for (var inv in invoiceMap) { 
        var rows = invoiceMap[inv]; 
        var ts = getTimestamp(rows[0]['Invoice Date']);
        if (!isDateInRange(ts, dateRange)) continue;

        var exec = (rows[0]['Sales Executive Name'] || '').trim(); 
        if (!exec) exec = 'Unknown Executive';
        if (!execMap[exec]) execMap[exec] = { vol: 0, val: 0, count: 0 }; 
        
        rows.forEach(function(r){ 
            var v = parseFloat(r['Product Volume'])||0;
            var val = parseFloat(r['Total Value incl VAT/GST'])||0;
            execMap[exec].vol += v; 
            execMap[exec].val += val; 
            grandVol += v;
            grandVal += val;
        }); 
        execMap[exec].count++; 
        grandCount++;
    }
    var keys = Object.keys(execMap);
    if (keys.length === 0) return 'NO_DATA'; 
    
    var msg = '*Sales Executive-wise Volume*\n';
    if (dateRange && dateRange.label) msg += '*Period:* ' + dateRange.label + '\n';
    msg += '\n';
    
    keys.sort(function(a,b){return execMap[b].vol - execMap[a].vol;}).forEach(function(exec){ 
        var s = execMap[exec]; 
        msg += '*' + exec + '*\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n'; 
    }); 
    
    msg += '----------------------\n';
    msg += '*📌 Grand Total*\n';
    msg += 'Vol: ' + grandVol.toFixed(1) + 'L | Val: Rs.' + grandVal.toFixed(0) + ' | Bills: ' + grandCount;
    
    return msg.trim();
}

function getPeriodSummary(invoiceMap, dateRange) {
    var totalVol = 0, totalVal = 0, count = 0;
    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv];
        var ts = getTimestamp(rows[0]['Invoice Date']);
        if (!isDateInRange(ts, dateRange)) continue;
        
        rows.forEach(function(r) {
            totalVol += parseFloat(r['Product Volume']) || 0;
            totalVal += parseFloat(r['Total Value incl VAT/GST']) || 0;
        });
        count++;
    }
    if (count === 0) return 'NO_DATA';
    var msg = '*Sales Summary*\n';
    if (dateRange && dateRange.label) msg += '*Period:* ' + dateRange.label + '\n';
    msg += '\n*Total Volume:* ' + totalVol.toFixed(1) + ' L\n';
    msg += '*Total Value:* Rs.' + totalVal.toFixed(2) + '\n';
    msg += '*Total Invoices:* ' + count;
    return msg;
}

function getCustomerReport(custName, invoiceMap, dateRange, lastOnly) {
    var filtered = [];
    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv]; 
        if (rows[0]['Customer Name'] !== custName) continue;
        var ts = getTimestamp(rows[0]['Invoice Date']);
        if (!isDateInRange(ts, dateRange)) continue;
        filtered.push({ inv: inv, rows: rows });
    }
    if (filtered.length === 0) return custName + ' ke liye is period mein koi data nahi mila.';
    filtered.sort(function(a,b){ return getTimestamp(b.rows[0]['Invoice Date']) - getTimestamp(a.rows[0]['Invoice Date']); });
    
    var totalVol = 0, totalVal = 0; 
    var showList = lastOnly ? filtered.slice(0, 1) : filtered;
    var msg = lastOnly ? '*Last Invoice Details:* ' + custName + '\n\n' : '*Customer: ' + custName + '*\n\n';
    if (dateRange && dateRange.label) msg += '*Period:* ' + dateRange.label + '\n\n';
    
    for (var i = 0; i < showList.length; i++) { 
        var m = showList[i].rows; var f = m[0]; 
        var vol = m.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); 
        var val = m.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); 
        totalVol += vol; totalVal += val; 
        msg += 'Inv: ' + showList[i].inv + ' | ' + cleanDate(f['Invoice Date']) + '\nProducts: ' + m.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(', ') + '\nVal: Rs.' + val.toFixed(2) + ' | Vol: ' + vol.toFixed(1) + 'L\n\n'; 
    }
    if (filtered.length > showList.length) msg += '...aur ' + (filtered.length - showList.length) + ' aur invoices.\n\n';
    msg += '*Total Volume:* ' + totalVol.toFixed(1) + ' L\n*Total Value:* Rs.' + totalVal.toFixed(2);
    return msg;
}

function generateDeepBusinessSummary(allRows) {
    var custStats = {}; var monthStats = {}; var execStats = {}; var prodStats = {};
    for (var i=0; i<allRows.length; i++) {
        var r = allRows[i]; if (!r['Invoice No']) continue;
        var cName = (r['Customer Name'] || 'Unknown').trim();
        var exec = (r['Sales Executive Name'] || 'Unknown').trim();
        var pName = (r['Product Name'] || 'Unknown').trim();
        var vol = parseFloat(r['Product Volume']) || 0;
        var val = parseFloat(r['Total Value incl VAT/GST']) || 0;
        var ts = getTimestamp(r['Invoice Date']);
        var month = (ts === 0) ? 'Unknown' : new Date(ts).toLocaleString('en-US', { month: 'short', year: 'numeric' });

        if(!custStats[cName]) custStats[cName] = {vol:0, val:0}; custStats[cName].vol += vol; custStats[cName].val += val;
        if(!monthStats[month]) monthStats[month] = {vol:0, val:0}; monthStats[month].vol += vol; monthStats[month].val += val;
        if(!execStats[exec]) execStats[exec] = {vol:0, val:0}; execStats[exec].vol += vol; execStats[exec].val += val;
        if(!prodStats[pName]) prodStats[pName] = {vol:0, val:0}; prodStats[pName].vol += vol; prodStats[pName].val += val;
    }

    var summary = "[FULL BUSINESS LEDGER]\n\n-- MONTHLY TOTALS --\n";
    for(var m in monthStats) { summary += "[" + m + "] Vol:" + monthStats[m].vol.toFixed(1) + "L, Val:Rs." + monthStats[m].val.toFixed(0) + "\n"; }
    
    summary += "\n-- ALL PRODUCTS (Vol & Val) --\n";
    var sortedProds = Object.keys(prodStats).sort(function(a,b){return prodStats[b].vol - prodStats[a].vol;});
    for(var p=0; p<sortedProds.length; p++) { var k = sortedProds[p]; summary += "[PROD] " + k + " -> Vol:" + prodStats[k].vol.toFixed(1) + "L\n"; }

    summary += "\n-- ALL CUSTOMERS (Vol & Val) --\n";
    var sortedCusts = Object.keys(custStats).sort(function(a,b){return custStats[b].vol - custStats[a].vol;});
    for(var c=0; c<sortedCusts.length; c++) { var k = sortedCusts[c]; summary += "[CUST] " + k + " -> Vol:" + custStats[k].vol.toFixed(1) + "L, Val:Rs." + custStats[k].val.toFixed(0) + "\n"; }

    summary += "\n-- ALL SALES EXECUTIVES --\n";
    for(var e in execStats) { summary += "[EXEC] " + e + " -> Vol:" + execStats[e].vol.toFixed(1) + "L, Val:Rs." + execStats[e].val.toFixed(0) + "\n"; }

    return summary.slice(0, 100000); 
}

// ─── LOAD ALL DATA ─────────────────────────────────────────────────────────
async function loadAllData() {
    if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache;
    var base = process.env.GITHUB_RAW_BASE; if (!base) return null;
    var fileList = []; try { fileList = (await axios.get(base+'/index.json')).data; } catch(e){ return null; }
    var excelFiles = fileList.filter(function(f){ return f.match(/\.(xlsx|xls|csv)$/i) && !f.toLowerCase().includes('mrp') && !f.toLowerCase().includes('dlp') && !f.toLowerCase().includes('list'); });
    var allRows = []; for (var k = 0; k < excelFiles.length; k++) { try { var res = await axios.get(base+'/'+encodeURIComponent(excelFiles[k]),{responseType:'arraybuffer'}); var wb = XLSX.read(res.data,{type:'buffer'}); for (var s = 0; s < wb.SheetNames.length; s++) { allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]],{defval:''})); } } catch(e){} }
    var invoiceMap = {}; for (var m = 0; m < allRows.length; m++) { var inv = allRows[m]['Invoice No']||''; if(inv){if(!invoiceMap[inv])invoiceMap[inv]=[];invoiceMap[inv].push(allRows[m]);} }
    var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); }); var mrpMap  = {}; if (mrpFile) { try { var r2 = await axios.get(base+'/'+encodeURIComponent(mrpFile),{responseType:'arraybuffer'}); mrpMap = loadPriceListFromExcel(XLSX.read(r2.data,{type:'buffer'})); } catch(e){} }
    var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp')||f.toLowerCase().includes('list')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); }); var dlpMap  = {}; if (dlpFile) { try { var r3 = await axios.get(base+'/'+encodeURIComponent(dlpFile),{responseType:'arraybuffer'}); dlpMap = loadPriceListFromExcel(XLSX.read(r3.data,{type:'buffer'})); } catch(e){} }
    var mrpPdfFile  = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.pdf$/i); }); var listPdfFile = fileList.find(function(f){ return (f.toLowerCase().includes('list')||f.toLowerCase().includes('dlp')) && !f.toLowerCase().includes('mrp') && f.match(/\.pdf$/i); });
    var mrpPdfUrl   = mrpPdfFile  ? base+'/'+encodeURIComponent(mrpPdfFile)  : ''; var listPdfUrl  = listPdfFile ? base+'/'+encodeURIComponent(listPdfFile) : '';
    globalCache = { invoiceMap: invoiceMap, allRows: allRows, mrpMap: mrpMap, dlpMap: dlpMap, mrpFile: mrpFile, dlpFile: dlpFile, mrpPdfUrl: mrpPdfUrl, listPdfUrl: listPdfUrl, mrpPdfFile: mrpPdfFile, listPdfFile: listPdfFile };
    lastCacheTime = Date.now(); console.log('[CACHE] Loaded.'); return globalCache;
}

// ─── AI REPLY ──────────────────────────────────────────────────────────────
async function getAIReply(userMsg, contextData, prompt) {
    var key = process.env.NVIDIA_API_KEY; if (!key) return null;
    try { var res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { model: 'meta/llama-3.1-70b-instruct', messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'CONTEXT DATA:\n' + contextData + '\n\nUSER QUERY: ' + userMsg }], max_tokens: 800, temperature: 0.1 }, { headers: { 'Authorization': 'Bearer '+key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 30000 }); var reply = res.data.choices[0].message.content; if (!reply || reply.toLowerCase().includes('cannot') || reply.toLowerCase().includes('not found') || reply.toLowerCase().includes('admin will reply')) return null; return sanitizeReply(reply); } catch (e) { console.error('[AI] Error:', e.message); return null; }
}

async function sendText(to, text) { var base = (process.env.EVOLUTION_API_URL||'').replace(/\/$/,''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/,'').replace(/@g\.us$/,''); if (!base||!inst||!key) return; try { await axios.post(base+'/message/sendText/'+inst,{number:num,text:text},{headers:{'Content-Type':'application/json','apikey':key}}); } catch(e){} }
async function sendDocument(to, fileUrl, fileName, caption) { var base = (process.env.EVOLUTION_API_URL||'').replace(/\/$/,''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/,'').replace(/@g\.us$/,''); if (!base||!inst||!key) return; try { await axios.post(base+'/message/sendMedia/'+inst,{number:num,mediatype:'document',mimetype:'application/pdf',media:fileUrl,fileName:fileName,caption:caption||''},{headers:{'Content-Type':'application/json','apikey':key}}); } catch(e){} }

// ─── MAIN WEBHOOK ──────────────────────────────────────────────────────────
module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');
    try {
        var body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data && body.data.key && body.data.key.fromMe) return res.status(200).send('Skip');
        var from = body.data.key.remoteJid;
        var text = ((body.data.message&&body.data.message.conversation)||(body.data.message&&body.data.message.extendedTextMessage&&body.data.message.extendedTextMessage.text)||'').trim();
        if (!text||!from) return res.status(200).send('Empty');

        var envAdmin = process.env.ADMIN_NUMBER || '919950858818';
        var pureNumber = from.split('@')[0];
        var safeFrom = sanitizePath(from);
        var database = getFirebase();

        // Load all configs and data at once
        var results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList(), isWhitelistActive(), getAllowedNumbers(), getBotSettings(), getAdmins()]);
        var sysPrompt = results[0]; var dataResult = results[1]||{}; var savedPDFs = results[2];
        var wlActive = results[3]; var allowedNums = results[4]; var settings = results[5]; var adminDict = results[6];
        
        var invoiceMap = dataResult.invoiceMap || {}; var mrpMap = dataResult.mrpMap || {}; var dlpMap = dataResult.dlpMap || {}; var allRows = dataResult.allRows || [];

        // Check if user is Admin
        var isAdmin = (pureNumber === envAdmin) || adminDict[pureNumber];

        // ── 🚨 GLOBAL BOT TOGGLE 🚨 ──
        if (!settings.botEnabled && !isAdmin) {
            // If bot is turned off, ignore everyone except Admins.
            return res.status(200).send('Bot is OFF');
        }

        // ── 🚨 WHITELIST SECURITY CHECK 🚨 ──
        if (!isAdmin && wlActive && !allowedNums[pureNumber]) {
            console.log('[WHITELIST] Blocked: ' + pureNumber);
            return res.status(200).send('Blocked by Whitelist'); 
        }

        // ── PENDING SELECTION (Options Menu) ──────────────────────────────────
        if (/^\d+$/.test(text)) {
            var pending = null;
            try { var snap = await database.ref('pending/' + safeFrom).get(); if(snap.exists()) pending = snap.val(); } catch(e){}
            if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];
            
            if (pending && pending.matches) {
                var idx = parseInt(text) - 1;
                if (idx >= 0 && idx < pending.matches.length) {
                    if (pending.type === 'invoice') { var m = pending.matches[idx]; var f = m.rows[0]; var prods = m.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + '); var tG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); var vl = m.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); await sendText(from, '*Invoice:* '+m.invNo+'\n*Customer:* '+f['Customer Name']+'\n*Products:* '+prods+'\n*Total Value:* Rs.'+tG.toFixed(2)+'\n*Total Volume:* '+vl.toFixed(1)+' L\n*Date:* '+cleanDate(f['Invoice Date'])+'\n*Payment:* '+f['Mode Of Payement']); } 
                    else if (pending.type === 'product') { 
                        var p = pending.matches[idx]; 
                        var aiPrompt = 'User Query: "'+pending.originalQuery+'"\nSelected: '+p.name+'\n\nRULES:\n1. Match EXACT size requested (1ltr=1L).\n2. CRITICAL: DO NOT divide or calculate prices. Just extract from data.\n3. If size not listed, say EXACTLY: "Bhai, is product ka ye size price list mein nahi hai."';
                        var aiR = await getAIReply(aiPrompt, '[PRICE DATA]\n'+p.chunk, sysPrompt); 
                        await sendText(from, aiR || 'Data nahi mila.'); 
                    }
                    else if (pending.type === 'customer_report') { var cReport = getCustomerReport(pending.matches[idx].name, invoiceMap, pending.dateRange, pending.lastOnly); await sendText(from, cReport); }
                    
                    try { await database.ref('pending/'+safeFrom).remove(); } catch(e){}
                    delete memoryPending[safeFrom];
                    return res.status(200).json({ status: 'ok' });
                } else {
                    // Out of bounds -> clear pending and let it run as direct invoice number search below
                    try { await database.ref('pending/'+safeFrom).remove(); } catch(e){}
                    delete memoryPending[safeFrom];
                }
            }
        }

        var lower = text.toLowerCase();

        // ── 🌍 THE PUBLIC `!ASK` COMMAND (WITH TOGGLE) ─────────────────────
        if (lower.indexOf('!ask ') === 0) { 
            if (!settings.aiEnabled && !isAdmin) {
                await sendText(from, "❌ Bhai, AI features abhi admin dvara disable kiye gaye hain.");
                return res.status(200).json({ status: 'ok' });
            }
            var aiQuery = text.slice(5).trim();
            var publicAiPrompt = 'You are Krish, a helpful assistant. Answer the user query using the CONTEXT DATA if related to business, otherwise answer from general knowledge. If you do not know, say "Bhai, iska jawab mujhe nahi pata." NO EMOJIS.';
            var bizSummaryAI = generateDeepBusinessSummary(allRows);
            var aiReplyText = await getAIReply(aiQuery, bizSummaryAI, publicAiPrompt);
            await sendText(from, aiReplyText || "Bhai, iska jawab mujhe nahi pata."); 
            return res.status(200).json({ status: 'ok' }); 
        }

        // ── 👑 ALL ADMIN MASTER COMMANDS ──────────────────────────────────
        if (isAdmin) {
            if (text === '!bot off') { await updateBotSetting('botEnabled', false); await sendText(from, '🔴 *Bot is now OFF*\nKoi bhi customer response nahi paayega.'); return res.status(200).json({status: 'ok'}); }
            if (text === '!bot on') { await updateBotSetting('botEnabled', true); await sendText(from, '🟢 *Bot is now ON*\nBot public ke liye active hai.'); return res.status(200).json({status: 'ok'}); }
            
            if (text === '!ai off') { await updateBotSetting('aiEnabled', false); await sendText(from, '🔴 *AI (!ask) is now OFF*\nCustomers ab AI se nahi pooch sakte.'); return res.status(200).json({status: 'ok'}); }
            if (text === '!ai on') { await updateBotSetting('aiEnabled', true); await sendText(from, '🟢 *AI (!ask) is now ON*\nCustomers ab AI command use kar sakte hain.'); return res.status(200).json({status: 'ok'}); }

            if (text === '!whitelist on') { await setWhitelistActive(true); await sendText(from, '🔒 *Whitelist ON*\nSirf allowed numbers allowed hain.'); return res.status(200).json({ status: 'ok' }); }
            if (text === '!whitelist off') { await setWhitelistActive(false); await sendText(from, '🔓 *Whitelist OFF*\nBot sabke liye khula hai.'); return res.status(200).json({ status: 'ok' }); }
            
            if (text.indexOf('!allow ') === 0) { var wNum = text.slice(7).trim(); await allowNumber(wNum); await sendText(from, '✅ *' + wNum + '* ko access mil gaya.'); return res.status(200).json({ status: 'ok' }); }
            if (text.indexOf('!block ') === 0) { var bNum = text.slice(7).trim(); await blockNumber(bNum); await sendText(from, '❌ *' + bNum + '* block ho gaya.'); return res.status(200).json({ status: 'ok' }); }
            
            if (text.indexOf('!addadmin ') === 0) { var aNum = text.slice(10).trim(); await addAdminNumber(aNum); await sendText(from, '👑 *' + aNum + '* ab Admin ban gaya hai.'); return res.status(200).json({ status: 'ok' }); }
            
            if (text === '!listallowed') { var keys = Object.keys(allowedNums); if (keys.length === 0) await sendText(from, 'Koi number whitelist nahi hai.'); else await sendText(from, '*Allowed Numbers:*\n' + keys.join('\n')); return res.status(200).json({ status: 'ok' }); }
            
            if (text.indexOf('!setprompt ') === 0)  { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
            if (text === '!status')  { await sendText(from, '*Bot Status*\nBot: ' + (settings.botEnabled ? 'ON' : 'OFF') + '\nAI: ' + (settings.aiEnabled ? 'ON' : 'OFF') + '\nWhitelist: ' + (wlActive ? 'ON' : 'OFF')); return res.status(200).json({ status: 'ok' }); }
            if (text === '!clearcache') { globalCache = null; await sendText(from, 'Cache cleared!'); return res.status(200).json({ status: 'ok' }); }
            
            if (text === '!commands') {
                var cMsg = "👑 *Admin Master Commands:*\n\n" +
                           "🤖 *Bot Toggles:*\n!bot on / !bot off\n!ai on / !ai off\n\n" +
                           "🔒 *Security:*\n!whitelist on / !whitelist off\n!allow <9199XXXXXX>\n!block <9199XXXXXX>\n!listallowed\n\n" +
                           "👨‍💼 *Roles:*\n!addadmin <9199XXXXXX>\n\n" +
                           "🛠️ *System:*\n!status\n!clearcache\n!setprompt <text>\n\n" +
                           "💬 *Ask AI:*\n!ask <question>";
                await sendText(from, cMsg); 
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── GREETING ───────────────────────────────────────────────────────
        if (['hi','hello','namaste','hey','hii','good morning','kaise ho','helo','ok','okay'].some(function(g){return lower===g||lower.startsWith(g+' ');})) { await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant.\nInvoice details, MRP/DLP rates, customer reports pooch sakte hain!'); return res.status(200).json({ status: 'ok' }); }

        // ── PDF SEND ───────────────────────────────────────────────────────
        var hasSend = ['send','bhejo','share','bhej','de do','chahiye','pdf'].some(function(w){return lower.includes(w);});
        var hasMRP  = ['mrp','maximum retail'].some(function(w){return lower.includes(w);});
        var hasDLP  = ['list price','dlp','dealer price','price list'].some(function(w){return lower.includes(w);});
        if (hasSend && hasMRP  && dataResult.mrpPdfUrl)  { await sendDocument(from, dataResult.mrpPdfUrl,  dataResult.mrpPdfFile,  dataResult.mrpPdfFile);  return res.status(200).json({status:'ok'}); }
        if (hasSend && hasDLP  && dataResult.listPdfUrl) { await sendDocument(from, dataResult.listPdfUrl, dataResult.listPdfFile, dataResult.listPdfFile); return res.status(200).json({status:'ok'}); }
        for (var k in savedPDFs) { if (lower.includes(k) && hasSend) { await sendDocument(from, savedPDFs[k].url, savedPDFs[k].name, savedPDFs[k].name); return res.status(200).json({status:'ok'}); } }

        // ── 1. EXACT ANALYTICS ROUTING ────────────
        var qIntent = parseDataQuery(text);
        
        if (lower.match(/top.*(cust|coust|party|log|client|dukandar|dukan)/) || lower.match(/(highest|zyada|sabse).*(cust|coust)/)) qIntent.type = 'top_customers';
        else if (lower.match(/top.*(prod|item|oil|brand|maal)/) || lower.match(/(highest|zyada|sabse).*prod/)) qIntent.type = 'top_products';
        else if (lower.match(/\b(se|se wise|executive|exec|salesman)\b/)) qIntent.type = 'executive_report';
        else if (lower.match(/\b(total volume|sales summary|kitna bika|total sale)\b/) || (lower.includes('volume') && lower.match(/\b(month|mahine|week|hafte|din|aaj)\b/))) qIntent.type = 'period_summary';

        if (qIntent.type) {
            var autoDate = false;
            if (!qIntent.filters.dateRange) {
                var now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
                var cy = now.getFullYear(); var cm = now.getMonth();
                qIntent.filters.dateRange = { 
                    from: new Date(cy, cm, 1).getTime(), 
                    to: new Date(cy, cm + 1, 0, 23, 59, 59).getTime(),
                    label: 'Current Month'
                };
                autoDate = true;
            }

            var resultText = "";
            if (qIntent.type === 'top_customers') resultText = getTopCustomers(invoiceMap, qIntent.filters.dateRange, qIntent.limit);
            else if (qIntent.type === 'top_products') resultText = getTopProducts(allRows, qIntent.filters.dateRange, qIntent.limit);
            else if (qIntent.type === 'executive_report') resultText = getExecutiveReport(invoiceMap, qIntent.filters.dateRange);
            else if (qIntent.type === 'period_summary') resultText = getPeriodSummary(invoiceMap, qIntent.filters.dateRange);

            if (autoDate && resultText === 'NO_DATA') {
                if (qIntent.type === 'top_customers') resultText = "*(Current Month me data nahi mila. All-Time data de raha hu)*\n\n" + getTopCustomers(invoiceMap, null, qIntent.limit);
                else if (qIntent.type === 'top_products') resultText = "*(Current Month me data nahi mila. All-Time data de raha hu)*\n\n" + getTopProducts(allRows, null, qIntent.limit);
                else if (qIntent.type === 'executive_report') resultText = "*(Current Month me data nahi mila. All-Time data de raha hu)*\n\n" + getExecutiveReport(invoiceMap, null);
                else if (qIntent.type === 'period_summary') resultText = "*(Current Month me data nahi mila. All-Time data de raha hu)*\n\n" + getPeriodSummary(invoiceMap, null);
            }

            if (resultText === 'NO_DATA') {
                await sendText(from, 'Please wait, admin will reply soon.');
            } else {
                await sendText(from, resultText);
            }
            return res.status(200).json({status:'ok'}); 
        }

        // ── 2. PRICE & INVOICE SEARCH ──────────
        var isRateQ = ['rate','price','mrp','dlp','kitne ka','dam','rupay'].some(function(w){return lower.includes(w);});
        var prodMatches = searchProducts(text, mrpMap, dlpMap); 
        var invMatches  = searchInvoices(text, invoiceMap); 

        if (isRateQ || (prodMatches.length > 0 && invMatches.length === 0)) {
            if (prodMatches.length === 0) { await sendText(from, 'Please wait, admin will reply soon.'); return res.status(200).json({status:'ok'}); }
            if (prodMatches.length === 1) { 
                var aiPrompt = 'User Query: "'+text+'"\n\nRULES:\n1. Match exact requested size (e.g. 1ltr=1L, 900ml=0.9L).\n2. NEVER calculate or divide prices. If exact size is missing, say EXACTLY: "Ye size price list me nahi hai."\n3. Format:\n*Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y';
                var aiR = await getAIReply(aiPrompt, '[PRICE DATA]\n'+prodMatches[0].chunk, sysPrompt); 
                await sendText(from, aiR || 'Data nahi mila.'); 
                return res.status(200).json({status:'ok'}); 
            }
            var msg = '*Kaunsa product? Number reply karein:*\n\n'; prodMatches.forEach(function(p,i){ msg += (i+1)+'. '+p.name+'\n'; }); var pend = { type:'product', matches:prodMatches, originalQuery:text, ts:Date.now() }; try { await database.ref('pending/'+safeFrom).set(pend); } catch(e){} memoryPending[safeFrom] = pend; await sendText(from, msg); return res.status(200).json({status:'ok'});
        }

        if (invMatches.length === 1) { var m2 = invMatches[0]; var f2 = m2.rows[0]; var prods2 = m2.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + '); var tG2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); var vl2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); await sendText(from, '*Invoice:* '+m2.invNo+'\n*Customer:* '+f2['Customer Name']+'\n*Products:* '+prods2+'\n*Total Value:* Rs.'+tG2.toFixed(2)+'\n*Total Volume:* '+vl2.toFixed(1)+' L\n*Date:* '+cleanDate(f2['Invoice Date'])+'\n*Payment:* '+f2['Mode Of Payement']); return res.status(200).json({status:'ok'}); }
        if (invMatches.length > 1) { var msg2 = '*Multiple invoices. Number reply karein:*\n\n'; invMatches.forEach(function(m,i){ msg2 += (i+1)+'. '+m.customer+' ('+m.invNo+')\n'; }); var pend2 = { type:'invoice', matches:invMatches, ts:Date.now() }; try { await database.ref('pending/'+safeFrom).set(pend2); } catch(e){} memoryPending[safeFrom] = pend2; await sendText(from, msg2); return res.status(200).json({status:'ok'}); }

        // ── 3. SPECIFIC CUSTOMER SEARCH ───────────────────
        var cMatches = searchCustomers(text, invoiceMap);
        var isCustQuery = ['bill', 'invoice', 'khata', 'hisab', 'data', 'report', 'ka', 'ki', 'batao'].some(function(w){return lower.includes(w);});
        
        if (cMatches.length > 0 && cMatches[0].score >= 30 && (isCustQuery || lower.includes(cMatches[0].name.toLowerCase()))) {
            if (cMatches.length === 1 || (cMatches.length > 1 && cMatches[0].score > cMatches[1].score + 200)) {
                var cReport = getCustomerReport(cMatches[0].name, invoiceMap, qIntent.filters.dateRange, false);
                await sendText(from, cReport);
                return res.status(200).json({ status: 'ok' });
            } else {
                var cMsg = '*Kaunse customer ka data dekhna hai? Number reply karein:*\n\n';
                cMatches.forEach(function(c,i){ cMsg += (i+1)+'. '+c.name+'\n'; });
                var cPend = { type:'customer_report', matches:cMatches, dateRange:qIntent.filters.dateRange, lastOnly:false, ts:Date.now() };
                try { await database.ref('pending/'+safeFrom).set(cPend); } catch(e){}
                memoryPending[safeFrom] = cPend;
                await sendText(from, cMsg);
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── 4. AI DATA ANALYST FALLBACK ──
        if (settings.aiEnabled || isAdmin) {
            var isCustomAnalytics = ['sabse', 'kam', 'lowest', 'low', 'aaj', 'kal', 'din', 'bika', 'invoice', 'bill', 'hisab'].some(function(w){return lower.includes(w);});

            if (isCustomAnalytics) {
                var aiPrompt = 'You are a Data Analyst. Answer the user query using ONLY the [FULL BUSINESS LEDGER] below.\n\nRULES:\n1. Answer clearly based ONLY on the provided data.\n2. Write in plain Hinglish. NO EMOJIS.\n3. Add EXACTLY this line at the end of your answer: "\n*(Note: Data may incorrect please reverify)*"\n4. If data is not found, output EXACTLY: "Please wait, admin will reply soon."';
                var bizSummary = generateDeepBusinessSummary(allRows);
                var aiReply = await getAIReply(text, bizSummary, aiPrompt);
                
                if (!aiReply || aiReply.toLowerCase().includes('admin will reply soon') || aiReply.toLowerCase().includes('error')) {
                    await sendText(from, 'Please wait, admin will reply soon.');
                } else {
                    await sendText(from, aiReply);
                }
                return res.status(200).json({ status: 'ok' });
            }
        }

        // Final Ultimate Fallback
        await sendText(from, 'Please wait, admin will reply soon.');
        return res.status(200).json({status:'ok'});

    } catch (e) {
        console.error('[WH] Fatal:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};
// END OF FILE
