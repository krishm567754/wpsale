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

async function getSystemPrompt() {
    var d = getFirebase();
    var def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf CONTEXT DATA se jawab de. Kuch bhi invent mat kar.\n2. 0.9L aur 900ml dono same hote hain.\n3. Exact Size ki value batayein jo user ne puchi hai.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho.\n6. Emojis ya special symbols bilkul use mat karo. Rupee sign ki jagah sirf "Rs." likho.\n7. Agar answer CONTEXT DATA me clearly nahi milta to exactly likho: "Please wait, admin will reply soon."';
    if (!d) return def;
    try { var s = await d.ref('botConfig/systemPrompt').get(); return s.exists() ? s.val() : def; } catch (e) { return def; }
}
async function saveSystemPrompt(p) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/systemPrompt').set(p); } catch(e){} } }
async function getPDFList() { var d = getFirebase(); if (!d) return {}; try { var s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e){ return {}; } }
async function savePDFList(data) { var d = getFirebase(); if (d) { try { await d.ref('botConfig/pdfFiles').set(data); } catch(e){} } }

// ─── HELPERS ───────────────────────────────────────────────────────────────
function sanitizeReply(t) {
    if (!t) return '';
    return t.replace(/[❌✅✨🔍📄📋📊💰]/g, '').replace(/₹/g, 'Rs.').replace(/\*\*/g, '*').replace(/\n{3,}/g, '\n\n').split('\n').map(function(l){return l.trim();}).join('\n').trim();
}

function cleanDate(val) {
    if (!val) return 'N/A';
    var dt = typeof val === 'number' ? new Date(Math.round((val - 25569) * 86400000)) : new Date(val);
    if (isNaN(dt.getTime())) return String(val).trim();
    return String(dt.getDate()).padStart(2,'0') + '/' + String(dt.getMonth()+1).padStart(2,'0') + '/' + dt.getFullYear();
}

// ─── ROBUST DATE RANGE EXTRACTOR ──────────────────────────────────────────
function extractDateRange(text) {
    var lower = text.toLowerCase();
    var now = new Date(new Date().toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    var cy = now.getFullYear(); var cm = now.getMonth(); var cd = now.getDate();
    
    // Helper for serial
    function toSerial(y, m, d) { return Math.floor((Date.UTC(y, m, d) / 86400000) + 25569); }
    
    var monthMap = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, september:9, oct:10, october:10, nov:11, november:11, dec:12, december:12 };
    for (var m in monthMap) {
        if (lower.indexOf(m) !== -1) {
            var mIdx = monthMap[m] - 1;
            var y = mIdx > cm ? cy - 1 : cy;
            return { from: toSerial(y, mIdx, 1), to: toSerial(y, mIdx + 1, 0) };
        }
    }
    
    if (lower.match(/\btoday\b|\baaj\b/)) return { from: toSerial(cy, cm, cd), to: toSerial(cy, cm, cd) };
    if (lower.match(/\byesterday\b|\bkal\b/)) return { from: toSerial(cy, cm, cd - 1), to: toSerial(cy, cm, cd - 1) };
    
    if (lower.match(/\bthis\s*week\b|\bis\s*hafte\b|\bchalu\s*hafte\b/)) {
        var d = now.getDay() === 0 ? 6 : now.getDay() - 1;
        return { from: toSerial(cy, cm, cd - d), to: toSerial(cy, cm, cd + (6 - d)) };
    }
    if (lower.match(/\blast\s*week\b|\bpichla\s*hafte\b|\bpichhle\s*hafte\b|\bprevious\s*week\b/)) {
        var d2 = now.getDay() === 0 ? 6 : now.getDay() - 1;
        return { from: toSerial(cy, cm, cd - d2 - 7), to: toSerial(cy, cm, cd - d2 - 1) };
    }
    if (lower.match(/\bthis\s*month\b|\bis\s*month\b|\bchalu\s*mahine\b|\bis\s*mahine\b/)) {
        return { from: toSerial(cy, cm, 1), to: toSerial(cy, cm + 1, 0) };
    }
    if (lower.match(/\blast\s*month\b|\bpichla\s*mahine\b|\bpichhle\s*mahine\b|\bprevious\s*month\b|\bgaya\s*mahine\b/)) {
        return { from: toSerial(cy, cm - 1, 1), to: toSerial(cy, cm, 0) };
    }
    return null;
}

function extractLimit(text) { var m = text.match(/\b(\d{1,3})\b/); return m ? parseInt(m[1]) : 5; }

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

// ─── INVOICE SEARCH (FIXED & DEFINED) ──────────────────────────────────────
function searchInvoices(query, invoiceMap) {
    var q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
    if (/^\d{1,2}$/.test(q) || q.length < 3) return [];
    var matches = []; var userKeywords = q.split(' ').filter(function(w){ return w.length > 3; }); if (userKeywords.length === 0) userKeywords = [q];
    for (var invNo in invoiceMap) { 
        var rows = invoiceMap[invNo]; 
        var custName = (rows[0]['Customer Name'] || '').toLowerCase(); 
        var invClean = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); 
        var qClean = q.replace(/[^a-zA-Z0-9]/g, ''); 
        var matchInv = invClean.indexOf(qClean) !== -1 || qClean.indexOf(invClean) !== -1; 
        var keywordScore = userKeywords.filter(function(k){ return custName.indexOf(k) !== -1; }).length; 
        if (matchInv || keywordScore > 0) matches.push({ invNo: invNo, rows: rows, customer: rows[0]['Customer Name'], score: matchInv ? 10 : keywordScore }); 
    }
    matches.sort(function(a,b){ return b.score - a.score; }); return matches.slice(0, 5);
}

// ─── CUSTOMER SEARCH ───────────────────────────────────────────────────────
function searchCustomers(query, invoiceMap) {
    var lower = query.toLowerCase();
    var custStop = ['ka','ki','ke','ko','ne','liya','batao','dikhao','data','report','invoice','bill','total','volume','wale','wali','mahine','month','week','hafte','is','this','last','pichle','aaj','today','all','sab','poora','maal','liter','l','hisab','kitna','sale','bika'];
    var cleanQuery = lower.replace(new RegExp('\\b(' + custStop.join('|') + ')\\b', 'g'), ' ').trim();
    if (cleanQuery.length < 3) return [];
    
    var custSet = {}; for (var inv in invoiceMap) { var c = invoiceMap[inv][0]['Customer Name']; if (c) custSet[c] = true; }
    var matches = [];
    for (var c in custSet) {
        var cLower = c.toLowerCase(); var score = 0;
        if (cLower === cleanQuery) score = 100;
        else if (cLower.indexOf(cleanQuery) !== -1) score = 50;
        else if (cleanQuery.indexOf(cLower) !== -1) score = 30;
        else { var words = cleanQuery.split(/\s+/); for (var w = 0; w < words.length; w++) { if (words[w].length >= 3 && cLower.indexOf(words[w]) !== -1) score += 10; } }
        if (score > 0) matches.push({ name: c, score: score });
    }
    matches.sort(function(a,b){ return b.score - a.score; });
    return matches.slice(0, 5);
}

// ─── DATA QUERY & REPORTS ──────────────────────────────────────────────────
function parseDataQuery(text, allRows) {
    var lower = text.toLowerCase();
    var result = { type: null, filters: { customer: null, executive: null, product: null, dateRange: null, district: null, town: null }, metrics: { volume: false, value: false, count: false }, groupBy: null, limit: extractLimit(text), lastOnly: lower.indexOf('last invoice') !== -1 || lower.indexOf('latest invoice') !== -1 || lower.indexOf('aakhri invoice') !== -1, allInvoices: lower.indexOf('all invoices') !== -1 || lower.indexOf('sab invoices') !== -1 };
    result.filters.dateRange = extractDateRange(text);
    
    // Simple customer check (will be refined by searchCustomers later)
    var custStop = ['ka','ki','ke','ko','ne','liya','batao','dikhao','data','report','invoice','bill','total','volume','wale','wali','mahine','month','week','hafte','is','this','last','pichle','aaj','today','all','sab','poora','maal','liter','l','hisab','kitna','sale','bika','center','service','enterprises','motors','parts'];
    var cleanForCust = lower.replace(new RegExp('\\b(' + custStop.join('|') + ')\\b', 'g'), ' ').trim();
    if (cleanForCust.length > 3) result.filters.customer = cleanForCust; // Placeholder
    return result;
}

function filterRows(allRows, filters) {
    return allRows.filter(function(row) {
        if (!row['Invoice No']) return false;
        if (filters.customer && row['Customer Name'] !== filters.customer) return false;
        if (filters.executive && row['Sales Executive Name'] !== filters.executive) return false;
        if (filters.product && (!row['Product Name'] || row['Product Name'].toLowerCase().indexOf(filters.product.toLowerCase()) === -1)) return false;
        if (filters.dateRange) { var invDate = row['Invoice Date']; if (typeof invDate === 'number') { if (invDate < filters.dateRange.from || invDate > filters.dateRange.to) return false; } }
        return true;
    });
}

function aggregateData(rows, query) {
    var result = { totalVolume: 0, totalValue: 0, totalCount: 0, breakdown: {} };
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i]; var vol = parseFloat(row['Product Volume']) || 0; var val = parseFloat(row['Total Value incl VAT/GST']) || 0;
        result.totalVolume += vol; result.totalValue += val; result.totalCount++;
        if (query.groupBy === 'customer') { var key = row['Customer Name'] || 'Unknown'; if (!result.breakdown[key]) result.breakdown[key] = { volume: 0, value: 0, count: 0 }; result.breakdown[key].volume += vol; result.breakdown[key].value += val; result.breakdown[key].count++; }
        else if (query.groupBy === 'executive') { var key = row['Sales Executive Name'] || 'Unknown'; if (!result.breakdown[key]) result.breakdown[key] = { volume: 0, value: 0, count: 0 }; result.breakdown[key].volume += vol; result.breakdown[key].value += val; result.breakdown[key].count++; }
        else if (query.groupBy === 'product') { var key = row['Product Name'] || 'Unknown'; if (!result.breakdown[key]) result.breakdown[key] = { volume: 0, value: 0, count: 0 }; result.breakdown[key].volume += vol; result.breakdown[key].value += val; result.breakdown[key].count++; }
    }
    return result;
}

function formatResponse(query, agg, rows) {
    var lines = [];
    if (query.type === 'customer_detail' && query.filters.customer) {
        lines.push('*Customer: ' + query.filters.customer + '*');
        if (query.filters.dateRange) lines.push('*Period: ' + (query.filters.dateRange.from ? cleanDate(excelSerialToDate(query.filters.dateRange.from)) : '') + ' to ' + cleanDate(excelSerialToDate(query.filters.dateRange.to)) + '*');
        lines.push('');
        if (query.allInvoices || query.lastOnly) {
            rows.sort(function(a,b){ var da = excelSerialToDate(a['Invoice Date']); var db = excelSerialToDate(b['Invoice Date']); return db - da; });
            var showRows = query.lastOnly ? rows.slice(0, 1) : rows.slice(0, 10);
            for (var i = 0; i < showRows.length; i++) { var r = showRows[i]; lines.push('Inv: ' + r['Invoice No'] + ' | ' + cleanDate(r['Invoice Date']) + '\nProduct: ' + r['Product Name'] + ' (' + r['Product Volume'] + 'L)\nValue: Rs.' + (parseFloat(r['Total Value incl VAT/GST'])||0).toFixed(2) + '\n'); }
            if (rows.length > showRows.length) lines.push('...aur ' + (rows.length - showRows.length) + ' aur invoices.\n');
        }
        lines.push('*Total Volume: ' + agg.totalVolume.toFixed(1) + ' L*'); lines.push('*Total Value: Rs.' + agg.totalValue.toFixed(2) + '*'); lines.push('*Total Invoices: ' + agg.totalCount + '*');
    } else if (query.type === 'top_customers' || query.type === 'top_products') {
        var label = query.type === 'top_customers' ? 'Customers' : 'Products';
        lines.push('*Top ' + query.limit + ' ' + label + ' by Volume*');
        if (query.filters.dateRange) lines.push('*Period: ' + cleanDate(excelSerialToDate(query.filters.dateRange.from)) + ' to ' + cleanDate(excelSerialToDate(query.filters.dateRange.to)) + '*'); lines.push('');
        var sorted = Object.keys(agg.breakdown).sort(function(a,b){ return agg.breakdown[b].volume - agg.breakdown[a].volume; }).slice(0, query.limit);
        for (var i = 0; i < sorted.length; i++) { var key = sorted[i]; var s = agg.breakdown[key]; lines.push((i+1) + '. ' + key + '\n   Vol: ' + s.volume.toFixed(1) + 'L | Val: Rs.' + s.value.toFixed(0) + ' | Count: ' + s.count + '\n'); }
    } else if (query.type === 'executive_report') {
        lines.push('*Sales Executive Report*'); if (query.filters.dateRange) lines.push('*Period: ' + cleanDate(excelSerialToDate(query.filters.dateRange.from)) + ' to ' + cleanDate(excelSerialToDate(query.filters.dateRange.to)) + '*'); lines.push('');
        var sorted = Object.keys(agg.breakdown).sort(function(a,b){ return agg.breakdown[b].volume - agg.breakdown[a].volume; });
        for (var i = 0; i < sorted.length; i++) { var exec = sorted[i]; var s = agg.breakdown[exec]; lines.push('*' + exec + '*\n   Vol: ' + s.volume.toFixed(1) + 'L | Val: Rs.' + s.value.toFixed(0) + ' | Bills: ' + s.count + '\n'); }
    } else {
        lines.push('*Data Summary*'); if (query.filters.customer) lines.push('Customer: ' + query.filters.customer); if (query.filters.executive) lines.push('Executive: ' + query.filters.executive); lines.push(''); lines.push('*Total Volume: ' + agg.totalVolume.toFixed(1) + ' L*'); lines.push('*Total Value: Rs.' + agg.totalValue.toFixed(2) + '*'); lines.push('*Total Records: ' + agg.totalCount + '*');
    }
    return lines.join('\n');
}

function getCustomerReport(custName, invoiceMap, dateRange, lastOnly) {
    var filtered = [];
    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv]; if (rows[0]['Customer Name'] !== custName) continue;
        if (dateRange) { var invDate = rows[0]['Invoice Date']; if (typeof invDate === 'number') { if (invDate < dateRange.from || invDate > dateRange.to) continue; } }
        filtered.push({ inv: inv, rows: rows });
    }
    if (filtered.length === 0) return custName + ' ke liye is period mein koi data nahi mila.';
    filtered.sort(function(a,b){ var da = excelSerialToDate(a.rows[0]['Invoice Date']); var db = excelSerialToDate(b.rows[0]['Invoice Date']); return db - da; });
    var totalVol = 0, totalVal = 0; var showList = lastOnly ? filtered.slice(0, 1) : filtered;
    var msg = lastOnly ? '*Last Invoice Details:* ' + custName + '\n\n' : '*Customer: ' + custName + '*\n\n';
    for (var i = 0; i < showList.length; i++) { var m = showList[i].rows; var f = m[0]; var vol = m.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); var val = m.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); totalVol += vol; totalVal += val; msg += 'Inv: ' + showList[i].inv + ' | ' + cleanDate(f['Invoice Date']) + '\nProducts: ' + m.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(', ') + '\nVal: Rs.' + val.toFixed(2) + ' | Vol: ' + vol.toFixed(1) + 'L\n\n'; }
    if (filtered.length > showList.length) msg += '...aur ' + (filtered.length - showList.length) + ' aur invoices.\n\n';
    msg += '*Total Volume: ' + totalVol.toFixed(1) + ' L*\n*Total Value: Rs.' + totalVal.toFixed(2) + '*';
    return msg;
}

function getTopCustomers(invoiceMap, dateRange, limit) {
    limit = limit || 5; var custMap = {};
    for (var inv in invoiceMap) { var rows  = invoiceMap[inv]; var cName = rows[0]['Customer Name'] || 'Unknown'; if (dateRange) { var invDate = rows[0]['Invoice Date']; if (typeof invDate === 'number' && (invDate < dateRange.from || invDate > dateRange.to)) continue; }
    if (!custMap[cName]) custMap[cName] = { vol: 0, val: 0, count: 0 }; rows.forEach(function(r){ custMap[cName].vol += parseFloat(r['Product Volume'])||0; custMap[cName].val += parseFloat(r['Total Value incl VAT/GST'])||0; }); custMap[cName].count++; }
    var sorted = Object.keys(custMap).sort(function(a,b){ return custMap[b].vol - custMap[a].vol; }).slice(0, limit);
    if (sorted.length === 0) return 'Is period mein koi data nahi mila.'; var msg = '*Top ' + limit + ' Customers by Volume*\n\n'; sorted.forEach(function(name, i){ var s = custMap[name]; msg += (i+1) + '. ' + name + '\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n'; }); return msg;
}

function getTopProducts(allRows, dateRange, limit) {
    limit = limit || 5; var prodMap = {};
    for (var i = 0; i < allRows.length; i++) { var r = allRows[i]; if (!r['Invoice No']) continue; if (dateRange) { var invDate = r['Invoice Date']; if (typeof invDate === 'number' && (invDate < dateRange.from || invDate > dateRange.to)) continue; } var prodName = (r['Product Name'] || 'Unknown').trim(); var vol = parseFloat(r['Product Volume']) || 0; var val = parseFloat(r['Total Value incl VAT/GST']) || 0; if (!prodMap[prodName]) prodMap[prodName] = { vol: 0, val: 0, count: 0 }; prodMap[prodName].vol += vol; prodMap[prodName].val += val; prodMap[prodName].count++; }
    var sorted = Object.keys(prodMap).sort(function(a,b){ return prodMap[b].vol - prodMap[a].vol; }).slice(0, limit);
    if (sorted.length === 0) return 'Is period mein koi product data nahi mila.'; var msg = '*Top ' + limit + ' Products by Volume Sold*\n\n'; sorted.forEach(function(name, i){ var s = prodMap[name]; msg += (i+1) + '. ' + name + '\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Times Sold: ' + s.count + '\n\n'; }); return msg;
}

function getExecutiveReport(invoiceMap, dateRange) {
    var execMap = {}; for (var inv in invoiceMap) { var rows = invoiceMap[inv]; if (dateRange) { var invDate = rows[0]['Invoice Date']; if (typeof invDate === 'number' && (invDate < dateRange.from || invDate > dateRange.to)) continue; } var exec = rows[0]['Sales Executive Name'] || 'Unknown'; if (!execMap[exec]) execMap[exec] = { vol: 0, val: 0, count: 0 }; rows.forEach(function(r){ execMap[exec].vol += parseFloat(r['Product Volume'])||0; execMap[exec].val += parseFloat(r['Total Value incl VAT/GST'])||0; }); execMap[exec].count++; }
    if (Object.keys(execMap).length === 0) return 'Is period mein koi data nahi.'; var msg = '*Sales Executive Report*\n\n'; Object.keys(execMap).sort(function(a,b){return execMap[b].vol - execMap[a].vol;}).forEach(function(exec){ var s = execMap[exec]; msg += '*' + exec + '*\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n'; }); return msg;
}

function excelSerialToDate(serial) { if (typeof serial !== 'number') return new Date(serial); return new Date(Math.round((serial - 25569) * 86400000)); }

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

        var adminNum = process.env.ADMIN_NUMBER || '919950858818';
        var isAdmin  = from.indexOf(adminNum) !== -1;
        var safeFrom = sanitizePath(from);
        var database = getFirebase();

        var results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
        var sysPrompt = results[0]; var dataResult = results[1]||{}; var savedPDFs = results[2];
        var invoiceMap = dataResult.invoiceMap || {}; var mrpMap = dataResult.mrpMap || {}; var dlpMap = dataResult.dlpMap || {}; var allRows = dataResult.allRows || [];

        // ── PENDING SELECTION (1, 2, 3) ────────────────────────────────────
        if (/^\d+$/.test(text)) {
            var pending = null;
            try { var snap = await database.ref('pending/' + safeFrom).get(); if(snap.exists()) pending = snap.val(); } catch(e){}
            if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];
            
            if (pending && pending.matches) {
                var idx = parseInt(text) - 1;
                if (pending.matches[idx]) {
                    if (pending.type === 'invoice') { var m = pending.matches[idx]; var f = m.rows[0]; var prods = m.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + '); var tG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); var vl = m.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); await sendText(from, '*Invoice:* '+m.invNo+'\n*Customer:* '+f['Customer Name']+'\n*Products:* '+prods+'\n*Total Value:* Rs.'+tG.toFixed(2)+'\n*Total Volume:* '+vl.toFixed(1)+' L\n*Date:* '+cleanDate(f['Invoice Date'])+'\n*Payment:* '+f['Mode Of Payement']); } 
                    else if (pending.type === 'product') { var p = pending.matches[idx]; var aiR = await getAIReply('Query: '+pending.originalQuery+'\nSelected: '+p.name+'. Exact MRP/DLP. 0.9L=900ml.', '[PRICE DATA]\n'+p.chunk, sysPrompt); await sendText(from, aiR || 'Data nahi mila.'); }
                    else if (pending.type === 'customer_select') { var selectedQuery = parseDataQuery(pending.originalQuery, allRows); selectedQuery.filters.customer = pending.matches[idx].name; var filtered = filterRows(allRows, selectedQuery.filters); var agg = aggregateData(filtered, selectedQuery); var response = formatResponse(selectedQuery, agg, filtered); await sendText(from, response); }
                    else if (pending.type === 'customer_report') { var cReport = getCustomerReport(pending.matches[idx].name, invoiceMap, pending.dateRange, pending.lastOnly); await sendText(from, cReport); }
                    
                    try { await database.ref('pending/'+safeFrom).remove(); } catch(e){}
                    delete memoryPending[safeFrom];
                } else { await sendText(from, 'Galat number. 1 se '+pending.matches.length+' ke beech chunein.'); }
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── ADMIN COMMANDS ────────────────────────────────────────────────
        if (isAdmin && text.indexOf('!setprompt ') === 0)  { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!status')  { await sendText(from, '*Bot Status*\nOnline'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!clearcache') { globalCache = null; await sendText(from, 'Cache cleared!'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text.indexOf('!addpdf ') === 0) { var parts = text.slice(8).split('|').map(function(s){return s.trim();}); if (parts.length === 3) { var lst = await getPDFList(); lst[parts[0].toLowerCase()] = {name:parts[1],url:parts[2]}; await savePDFList(lst); await sendText(from, 'PDF added: '+parts[1]); } else await sendText(from, 'Format: !addpdf keyword | Name | URL'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!listpdf') { var pl = await getPDFList(); await sendText(from, Object.keys(pl).length ? Object.entries(pl).map(function(e){return e[1].name+' ['+e[0]+']';}).join('\n') : 'No PDFs saved.'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text.indexOf('!removepdf ') === 0) { var kw = text.slice(11).trim().toLowerCase(); var pl2 = await getPDFList(); if(pl2[kw]){delete pl2[kw]; await savePDFList(pl2); await sendText(from,'Removed: '+kw);} else await sendText(from,'Not found: '+kw); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!help') { await sendText(from, '*Admin Commands:*\n!status\n!setprompt [text]\n!clearcache\n!addpdf keyword|Name|URL\n!listpdf\n!removepdf keyword'); return res.status(200).json({ status: 'ok' }); }

        // ── GREETING ──────────────────────────────────────────────────────
        var lower = text.toLowerCase();
        if (['hi','hello','namaste','hey','hii','good morning','kaise ho','helo'].some(function(g){return lower===g||lower.startsWith(g+' ');})) { await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant.\nInvoice details, MRP/DLP rates, customer reports pooch sakte hain!'); return res.status(200).json({ status: 'ok' }); }

        // ── PDF SEND ──────────────────────────────────────────────────────
        var hasSend = ['send','bhejo','share','bhej','de do','chahiye','pdf'].some(function(w){return lower.includes(w);});
        var hasMRP  = ['mrp','maximum retail'].some(function(w){return lower.includes(w);});
        var hasDLP  = ['list price','dlp','dealer price','price list'].some(function(w){return lower.includes(w);});
        if (hasSend && hasMRP  && dataResult.mrpPdfUrl)  { await sendDocument(from, dataResult.mrpPdfUrl,  dataResult.mrpPdfFile,  dataResult.mrpPdfFile);  return res.status(200).json({status:'ok'}); }
        if (hasSend && hasDLP  && dataResult.listPdfUrl) { await sendDocument(from, dataResult.listPdfUrl, dataResult.listPdfFile, dataResult.listPdfFile); return res.status(200).json({status:'ok'}); }
        for (var k in savedPDFs) { if (lower.includes(k) && hasSend) { await sendDocument(from, savedPDFs[k].url, savedPDFs[k].name, savedPDFs[k].name); return res.status(200).json({status:'ok'}); } }

        // ── PRODUCT & INVOICE SEARCH ─────────────────────────────────────
        var prodMatches = searchProducts(text, mrpMap, dlpMap); var invMatches  = searchInvoices(text, invoiceMap); var isRateQ = ['rate','price','mrp','dlp','kitne ka','dam','rupay'].some(function(w){return lower.includes(w);});
        
        if (isRateQ || (prodMatches.length > 0 && invMatches.length === 0)) {
            if (prodMatches.length === 0) { await sendText(from, 'Please wait, admin will reply soon.'); return res.status(200).json({status:'ok'}); }
            if (prodMatches.length === 1) { var aiR = await getAIReply('Query: '+text+'\nExact MRP/DLP for size. 0.9L=900ml.', '[PRICE DATA]\n'+prodMatches[0].chunk, sysPrompt); await sendText(from, aiR || 'Data nahi mila.'); return res.status(200).json({status:'ok'}); }
            var msg = '*Kaunsa product? Number reply karein:*\n\n'; prodMatches.forEach(function(p,i){ msg += (i+1)+'. '+p.name+'\n'; }); var pend = { type:'product', matches:prodMatches, originalQuery:text, ts:Date.now() }; try { await database.ref('pending/'+safeFrom).set(pend); } catch(e){} memoryPending[safeFrom] = pend; await sendText(from, msg); return res.status(200).json({status:'ok'});
        }
        if (invMatches.length === 1) { var m2 = invMatches[0]; var f2 = m2.rows[0]; var prods2 = m2.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + '); var tG2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); var vl2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); await sendText(from, '*Invoice:* '+m2.invNo+'\n*Customer:* '+f2['Customer Name']+'\n*Products:* '+prods2+'\n*Total Value:* Rs.'+tG2.toFixed(2)+'\n*Total Volume:* '+vl2.toFixed(1)+' L\n*Date:* '+cleanDate(f2['Invoice Date'])+'\n*Payment:* '+f2['Mode Of Payement']); return res.status(200).json({status:'ok'}); }
        if (invMatches.length > 1) { var msg2 = '*Multiple invoices. Number reply karein:*\n\n'; invMatches.forEach(function(m,i){ msg2 += (i+1)+'. '+m.customer+' ('+m.invNo+')\n'; }); var pend2 = { type:'invoice', matches:invMatches, ts:Date.now() }; try { await database.ref('pending/'+safeFrom).set(pend2); } catch(e){} memoryPending[safeFrom] = pend2; await sendText(from, msg2); return res.status(200).json({status:'ok'}); }

        // ── ✅ ADVANCED ANALYTICS ROUTING ──────────────────────────────────
        var qIntent = parseDataQuery(text, allRows);
        console.log('[QUERY] type:'+qIntent.type+' filters:'+JSON.stringify(qIntent.filters));

        // Customer Resolution Logic
        if (qIntent.filters.customer) {
            var custMatches = searchCustomers(qIntent.filters.customer, invoiceMap);
            if (custMatches.length > 1) {
                var cMsg = '*Multiple customers found. Kaunsa customer? Number reply karein:*\n\n';
                custMatches.forEach(function(c,i){ cMsg += (i+1)+'. '+c.name+'\n'; });
                var cPend = { type:'customer_report', matches:custMatches, dateRange:qIntent.filters.dateRange, lastOnly:qIntent.lastOnly, originalQuery: text, ts:Date.now() };
                try { await database.ref('pending/'+safeFrom).set(cPend); } catch(e){}
                memoryPending[safeFrom] = cPend;
                await sendText(from, cMsg);
                return res.status(200).json({status:'ok'});
            }
            if (custMatches.length === 1) {
                qIntent.filters.customer = custMatches[0].name;
                qIntent.type = 'customer_detail'; // Force type
            } else {
                // If no customer matches but date query exists, show summary
                if (qIntent.filters.dateRange && !qIntent.filters.customer) {
                     var byDate = {};
                     allRows.forEach(function(r){ 
                         if (qIntent.filters.dateRange) { 
                             var invDate = r['Invoice Date']; 
                             if (typeof invDate === 'number' && (invDate < qIntent.filters.dateRange.from || invDate > qIntent.filters.dateRange.to)) return; 
                         }
                         var d = cleanDate(r['Invoice Date']);
                         if (!byDate[d]) byDate[d] = { volume: 0, value: 0, count: 0 };
                         byDate[d].volume += parseFloat(r['Product Volume'])||0;
                         byDate[d].value += parseFloat(r['Total Value incl VAT/GST'])||0;
                         byDate[d].count++;
                     });
                     var lines = ['*Date-wise Summary*'];
                     var dates = Object.keys(byDate).sort();
                     dates.slice(0, 15).forEach(function(d) { var s = byDate[d]; lines.push(d + ': ' + s.count + ' invoices | ' + s.volume.toFixed(1) + 'L | Rs.' + s.value.toFixed(0)); });
                     if (dates.length > 15) lines.push('...aur ' + (dates.length - 15) + ' aur dates.');
                     await sendText(from, lines.join('\n'));
                     return res.status(200).json({status:'ok'});
                }
            }
        }
        
        // If type is still null but we have filters, try analytics
        if (!qIntent.type && (qIntent.filters.executive || qIntent.filters.dateRange || lower.indexOf('top') !== -1)) {
            if (lower.indexOf('top') !== -1 && lower.indexOf('customer') !== -1) qIntent.type = 'top_customers';
            else if (lower.indexOf('top') !== -1 && lower.indexOf('product') !== -1) qIntent.type = 'top_products';
            else if (qIntent.filters.executive || lower.indexOf('executive') !== -1) qIntent.type = 'executive_report';
            else if (qIntent.filters.customer) qIntent.type = 'customer_detail';
            else qIntent.type = 'ai_analytics';
        } else if (!qIntent.type) {
            qIntent.type = 'ai_analytics';
        }

        if (qIntent.type === 'top_customers') { await sendText(from, getTopCustomers(invoiceMap, qIntent.filters.dateRange, qIntent.limit)); return res.status(200).json({status:'ok'}); }
        if (qIntent.type === 'top_products') { await sendText(from, getTopProducts(allRows, qIntent.filters.dateRange, qIntent.limit)); return res.status(200).json({status:'ok'}); }
        if (qIntent.type === 'executive_report') { await sendText(from, getExecutiveReport(invoiceMap, qIntent.filters.dateRange)); return res.status(200).json({status:'ok'}); }

        if (qIntent.type === 'customer_detail' && qIntent.filters.customer) {
            var cReport = getCustomerReport(qIntent.filters.customer, invoiceMap, qIntent.filters.dateRange, qIntent.lastOnly);
            await sendText(from, cReport);
            return res.status(200).json({status:'ok'});
        }

        // AI Fallback for complex queries
        var aiContext = '[INVOICE DATA - Use ONLY for customer/volume queries]\n';
        var sampleInvoices = Object.keys(invoiceMap).slice(0, 30);
        sampleInvoices.forEach(function(invNo) { var rows = invoiceMap[invNo]; if (!rows || rows.length === 0) return; var f = rows[0]; var vol = rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0); var val = rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0); aiContext += 'INV:'+invNo+'|CUST:'+f['Customer Name']+'|DATE:'+cleanDate(f['Invoice Date'])+'|VOL:'+vol.toFixed(1)+'L|VAL:Rs.'+val.toFixed(0)+'\n'; });
        aiContext += '\n[QUERY INSTRUCTIONS]\n- Sirf upar diye gaye DATA se jawab do.\n- Agar answer nahi milta to "Please wait, admin will reply soon." likho.\n- Kuch bhi invent mat karo.\n';
        
        var aiAnswer = await getAIReply(text, aiContext, sysPrompt);
        if (aiAnswer && !aiAnswer.toLowerCase().includes('admin will reply soon')) { await sendText(from, aiAnswer); } else { await sendText(from, 'Please wait, admin will reply soon.'); }
        return res.status(200).json({status:'ok'});

    } catch (e) {
        console.error('[WH] Fatal:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};
