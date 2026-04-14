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
    var def = 'Tu Laxmi hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf CONTEXT DATA se jawab de. Kuch bhi invent mat kar.\n2. 0.9L aur 900ml dono same hote hain.\n3. Exact Size ki value batayein jo user ne puchi hai.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho.\n6. Emojis ya special symbols bilkul use mat karo. Rupee sign ki jagah sirf "Rs." likho.\n7. Agar data na mile to exactly likho: "Please wait, admin will reply soon."';
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

function getDateObj(val) {
    if (!val) return null;
    var dt = typeof val === 'number' ? new Date(Math.round((val - 25569) * 86400000)) : new Date(val);
    return isNaN(dt.getTime()) ? null : dt;
}

// ─── SIZE NORMALIZER ───────────────────────────────────────────────────────
function normalizeSizeHeader(header) {
    if (!header) return '';
    var h = String(header).toLowerCase().replace(/\s+/g,'').replace(/\/+$/,'').replace(/\\+$/,'');
    if (h.indexOf('brand') !== -1) return 'BRAND NAME';
    var map = {'900ml':'900ML','0.9l':'900ML','900':'900ML','800ml':'800ML','0.8l':'800ML','600ml':'600ML','0.6l':'600ML','500ml':'500ML','0.5l':'500ML','350ml':'350ML','250ml':'250ML','175ml':'175ML','100ml':'100ML','1':'1L','1l':'1L','11':'1L','1.2/11':'1L','1.2/1l':'1L','1.2':'1.2L','1.2l':'1.2L','1.5':'1.5L','1.5l':'1.5L','2':'2L','2l':'2L','2.5':'2.5L','2.5l':'2.5L','2.51':'2.5L','3':'3L','3l':'3L','31':'3L','3.5':'3.5L','3.5l':'3.5L','4':'4L','4l':'4L','4.5':'4.5L','4.5l':'4.5L','5':'5L','5l':'5L','51':'5L','7':'7L','7l':'7L','71':'7L','7.5':'7.5L','7.5l':'7.5L','8.5':'8.5L','8.5l':'8.5L','10':'10L','10l':'10L','101':'10L','15':'15L','15l':'15L','18':'18L','18l':'18L','20':'20L','20l':'20L','201':'20L','50':'50L','50l':'50L','210':'210L'};
    return map[h] || String(header).trim().toUpperCase();
}

// ─── PRICE LIST LOADER ─────────────────────────────────────────────────────
function loadPriceListFromExcel(wb) {
    var priceMap = {};
    for (var s = 0; s < wb.SheetNames.length; s++) {
        var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], { header: 1, defval: '' });
        var currentHeaders = [];
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!row || row.length === 0) continue;
            var col0 = String(row[0] || '').trim();
            if (col0.toLowerCase().indexOf('brand name') !== -1) {
                currentHeaders = row.map(function(c) { return normalizeSizeHeader(c); });
                continue;
            }
            if (currentHeaders.length > 0 && col0.length > 3) {
                var hasPrice = false;
                for (var j = 1; j < row.length; j++) { if (row[j] !== '' && !isNaN(parseFloat(row[j]))) { hasPrice = true; break; } }
                if (!hasPrice) continue;
                if (!priceMap[col0]) priceMap[col0] = {};
                for (var j = 1; j < row.length; j++) {
                    var size = currentHeaders[j]; var val = parseFloat(row[j]);
                    if (size && size !== '' && !isNaN(val)) priceMap[col0][size] = val;
                }
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
    for (var mName in mrpMap) {
        var norm = mName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!combined[norm]) combined[norm] = { orig: mName, sizes: {} };
        for (var sz in mrpMap[mName]) { if (!combined[norm].sizes[sz]) combined[norm].sizes[sz] = {}; combined[norm].sizes[sz].mrp = mrpMap[mName][sz]; }
    }
    for (var dName in dlpMap) {
        var normD = dName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!combined[normD]) combined[normD] = { orig: dName, sizes: {} };
        for (var sz in dlpMap[dName]) { if (!combined[normD].sizes[sz]) combined[normD].sizes[sz] = {}; combined[normD].sizes[sz].dlp = dlpMap[dName][sz]; }
    }
    var products = [];
    for (var key in combined) {
        var score = 0;
        for (var t = 0; t < searchTerms.length; t++) { if (key.indexOf(searchTerms[t]) !== -1) score++; }
        var required = Math.min(2, Math.max(1, searchTerms.length - 1));
        if (score >= required) {
            var pData = combined[key];
            var chunk = 'Product: ' + pData.orig + '\n';
            var hasData = false;
            for (var sz in pData.sizes) {
                chunk += '- Size [' + sz + '] : MRP Rs. ' + (pData.sizes[sz].mrp || 'N/A') + ' | DLP Rs. ' + (pData.sizes[sz].dlp || 'N/A') + '\n';
                hasData = true;
            }
            if (hasData) products.push({ name: pData.orig, score: score, chunk: chunk });
        }
    }
    products.sort(function(a,b){ return b.score - a.score; });
    return products.slice(0, 5);
}

// ─── INVOICE SEARCH ────────────────────────────────────────────────────────
function searchInvoices(query, invoiceMap) {
    var q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
    if (/^\d{1,2}$/.test(q) || q.length < 3) return [];
    var matches = [];
    var userKeywords = q.split(' ').filter(function(w){ return w.length > 3; });
    if (userKeywords.length === 0) userKeywords = [q];
    for (var invNo in invoiceMap) {
        var rows = invoiceMap[invNo];
        var custName = (rows[0]['Customer Name'] || '').toLowerCase();
        var invClean = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        var qClean = q.replace(/[^a-zA-Z0-9]/g, '');
        var matchInv = invClean.indexOf(qClean) !== -1 || qClean.indexOf(invClean) !== -1;
        var keywordScore = userKeywords.filter(function(k){ return custName.indexOf(k) !== -1; }).length;
        if (matchInv || keywordScore > 0) matches.push({ invNo: invNo, rows: rows, customer: rows[0]['Customer Name'], score: matchInv ? 10 : keywordScore });
    }
    matches.sort(function(a,b){ return b.score - a.score; });
    return matches.slice(0, 5);
}

// ─── CUSTOMER SEARCH (Improved for partial matches) ────────────────────────
function searchCustomers(query, invoiceMap) {
    var q = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    var stopWords = ['ka','ki','ke','ko','batao','dikhao','data','report','invoice','bill','total','volume','wale','wali','mahine','month','week','hafte','is','this','last','pichle','aaj','today'];
    var words = q.split(/\s+/).filter(function(w){ return w.length > 2 && stopWords.indexOf(w) === -1; });
    if (words.length === 0) return [];
    
    var custSet = {};
    for (var inv in invoiceMap) {
        var cName = invoiceMap[inv][0]['Customer Name'];
        if (cName) custSet[cName] = true;
    }
    
    var matches = [];
    for (var cName in custSet) {
        var cLower = cName.toLowerCase().replace(/[^a-z0-9 ]/g, '');
        var score = words.filter(function(w){ return cLower.indexOf(w) !== -1; }).length;
        // Also check if any single word is a strong match (>=3 chars)
        var strongMatch = words.some(function(w){ return w.length >= 3 && cLower.indexOf(w) !== -1; });
        if (score > 0 || strongMatch) matches.push({ name: cName, score: score + (strongMatch ? 1 : 0) });
    }
    matches.sort(function(a,b){ return b.score - a.score; });
    return matches.slice(0, 5);
}

// ─── SMART QUERY DETECTOR ──────────────────────────────────────────────────
function detectQueryIntent(text) {
    var lower = text.toLowerCase();

    // Date range keywords
    var hasThisMonth  = ['is month','this month','mahine','is mahine','current month','aaj ka mahina'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasLastMonth  = ['last month','pichle mahine','pichla mahina','previous month'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasThisWeek   = ['is hafte','this week','weekly','is week','current week','aaj ka hafte'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasLastWeek   = ['last week','pichle hafte','pichla hafte'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasToday      = ['aaj','today','aaj ke'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasAll        = ['all','saare','sab','poora','history','purana','pichla sab'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasTop        = ['top','highest','sabse zyada','best','max'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasExec       = ['executive','salesman','jagdish','daya','rakesh','gajanand','naresh'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasCustomer   = ['ka','ki','ke','wale','customer'].some(function(w){return lower.indexOf(' '+w+' ')!==-1 || lower.indexOf(w+' ')===0;});
    var hasInvoice    = ['invoice','bill','inv'].some(function(w){return lower.indexOf(w)!==-1;});
    var hasSummary    = ['summary','report','total','kitna','volume','sale','bika','hisab'].some(function(w){return lower.indexOf(w)!==-1;});

    // Date filter determine karo
    var dateFilter = 'all';
    if (hasToday)     dateFilter = 'today';
    else if (hasThisWeek)  dateFilter = 'this_week';
    else if (hasLastWeek)  dateFilter = 'last_week';
    else if (hasThisMonth) dateFilter = 'this_month';
    else if (hasLastMonth) dateFilter = 'last_month';
    else if (hasAll)       dateFilter = 'all';

    if (hasTop)    return { type: 'top_customers', dateFilter: dateFilter };
    if (hasExec)   return { type: 'executive_report', dateFilter: dateFilter };

    if (hasCustomer || hasSummary || (hasInvoice && !lower.match(/inv\/\d/i))) {
        return { type: 'customer_query', dateFilter: dateFilter };
    }

    return { type: 'general' };
}

// ─── DATE FILTER FUNCTIONS ─────────────────────────────────────────────────
function getDateRange(filter) {
    var now   = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (filter === 'today') {
        return { from: today, to: new Date(today.getTime() + 86400000 - 1) };
    }
    if (filter === 'this_week') {
        var day  = today.getDay(); // 0=Sun
        var mon  = new Date(today); mon.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
        return { from: mon, to: new Date(mon.getTime() + 7 * 86400000 - 1) };
    }
    if (filter === 'last_week') {
        var day2 = today.getDay();
        var mon2 = new Date(today); mon2.setDate(today.getDate() - (day2 === 0 ? 6 : day2 - 1) - 7);
        return { from: mon2, to: new Date(mon2.getTime() + 7 * 86400000 - 1) };
    }
    if (filter === 'this_month') {
        return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59) };
    }
    if (filter === 'last_month') {
        return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59) };
    }
    return null; // all
}

function isInRange(dateVal, range) {
    if (!range) return true;
    var dt = getDateObj(dateVal);
    if (!dt) return false;
    return dt >= range.from && dt <= range.to;
}

// ─── CUSTOMER REPORT (with date filter) ────────────────────────────────────
function getCustomerReport(custName, invoiceMap, dateFilter) {
    var range = getDateRange(dateFilter);
    var filtered = [];

    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv];
        if (rows[0]['Customer Name'] !== custName) continue;
        if (range && !isInRange(rows[0]['Invoice Date'], range)) continue;
        filtered.push({ inv: inv, rows: rows });
    }

    if (filtered.length === 0) {
        var label = dateFilter === 'all' ? 'koi bhi' : dateFilter.replace('_', ' ');
        return custName + ' ke liye ' + label + ' period mein koi invoice nahi mila.';
    }

    filtered.sort(function(a,b){
        var da = getDateObj(a.rows[0]['Invoice Date']) || new Date(0);
        var db2 = getDateObj(b.rows[0]['Invoice Date']) || new Date(0);
        return db2 - da;
    });

    var totalVol = 0, totalVal = 0;
    var periodLabel = dateFilter === 'all' ? 'All Time' : dateFilter.replace('_', ' ').replace(/\b\w/g, function(c){return c.toUpperCase();});
    var msg = '*Customer: ' + custName + '*\n*Period: ' + periodLabel + '*\n\n';

    var showMax = Math.min(filtered.length, 10);
    for (var i = 0; i < filtered.length; i++) {
        var m   = filtered[i].rows;
        var f   = m[0];
        var vol = m.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
        var val = m.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
        totalVol += vol; totalVal += val;
        if (i < showMax) {
            msg += 'Inv: ' + filtered[i].inv + ' | ' + cleanDate(f['Invoice Date']) + '\nProducts: ' + m.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(', ') + '\nVal: Rs.' + val.toFixed(2) + ' | Vol: ' + vol.toFixed(1) + 'L\n\n';
        }
    }
    if (filtered.length > showMax) msg += '...aur ' + (filtered.length - showMax) + ' aur invoices.\n\n';
    msg += '*Total Invoices: ' + filtered.length + '*\n*Total Volume: ' + totalVol.toFixed(1) + ' L*\n*Total Value: Rs.' + totalVal.toFixed(2) + '*';
    return msg;
}

// ─── TOP CUSTOMERS REPORT ──────────────────────────────────────────────────
function getTopCustomers(invoiceMap, dateFilter, limit) {
    limit = limit || 5;
    var range   = getDateRange(dateFilter);
    var custMap = {};

    for (var inv in invoiceMap) {
        var rows  = invoiceMap[inv];
        var cName = rows[0]['Customer Name'] || 'Unknown';
        if (range && !isInRange(rows[0]['Invoice Date'], range)) continue;
        if (!custMap[cName]) custMap[cName] = { vol: 0, val: 0, count: 0 };
        rows.forEach(function(r){
            custMap[cName].vol   += parseFloat(r['Product Volume']) || 0;
            custMap[cName].val   += parseFloat(r['Total Value incl VAT/GST']) || 0;
        });
        custMap[cName].count++;
    }

    var sorted = Object.keys(custMap).sort(function(a,b){ return custMap[b].vol - custMap[a].vol; }).slice(0, limit);
    if (sorted.length === 0) return 'Is period mein koi data nahi mila.';

    var periodLabel = dateFilter === 'all' ? 'All Time' : dateFilter.replace('_',' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
    var msg = '*Top ' + limit + ' Customers by Volume (' + periodLabel + ')*\n\n';
    sorted.forEach(function(name, i){
        var s = custMap[name];
        msg += (i+1) + '. ' + name + '\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n';
    });
    return msg;
}

// ─── EXECUTIVE REPORT ──────────────────────────────────────────────────────
function getExecutiveReport(invoiceMap, dateFilter) {
    var range   = getDateRange(dateFilter);
    var execMap = {};

    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv];
        if (range && !isInRange(rows[0]['Invoice Date'], range)) continue;
        var exec = rows[0]['Sales Executive Name'] || 'Unknown';
        if (!execMap[exec]) execMap[exec] = { vol: 0, val: 0, count: 0 };
        rows.forEach(function(r){
            execMap[exec].vol += parseFloat(r['Product Volume']) || 0;
            execMap[exec].val += parseFloat(r['Total Value incl VAT/GST']) || 0;
        });
        execMap[exec].count++;
    }

    if (Object.keys(execMap).length === 0) return 'Is period mein koi data nahi.';
    var periodLabel = dateFilter === 'all' ? 'All Time' : dateFilter.replace('_',' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
    var msg = '*Sales Executive Report (' + periodLabel + ')*\n\n';
    Object.keys(execMap).sort(function(a,b){return execMap[b].vol - execMap[a].vol;}).forEach(function(exec){
        var s = execMap[exec];
        msg += '*' + exec + '*\n   Vol: ' + s.vol.toFixed(1) + 'L | Val: Rs.' + s.val.toFixed(0) + ' | Bills: ' + s.count + '\n\n';
    });
    return msg;
}

// ─── DATE-WISE INVOICE SUMMARY ─────────────────────────────────────────────
function getDateWiseSummary(invoiceMap, dateFilter) {
    var range = getDateRange(dateFilter);
    var found = [];
    for (var inv in invoiceMap) {
        var rows = invoiceMap[inv];
        if (range && !isInRange(rows[0]['Invoice Date'], range)) continue;
        var vol = rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
        var val = rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
        found.push({ inv: inv, customer: rows[0]['Customer Name'], date: cleanDate(rows[0]['Invoice Date']), vol: vol, val: val });
    }
    if (found.length === 0) return 'Is period mein koi invoice nahi mila.';
    var periodLabel = dateFilter === 'all' ? '' : ' (' + dateFilter.replace('_',' ') + ')';
    var msg = '*Invoices' + periodLabel + '*\n\n';
    found.slice(0, 15).forEach(function(f){
        msg += f.inv + ' | ' + f.customer.split(',')[0] + '\n' + f.date + ' | Vol: ' + f.vol.toFixed(1) + 'L | Rs.' + f.val.toFixed(0) + '\n\n';
    });
    if (found.length > 15) msg += '...aur ' + (found.length - 15) + ' aur hain.\n';
    var tv = found.reduce(function(s,f){return s+f.vol;},0);
    var tval = found.reduce(function(s,f){return s+f.val;},0);
    msg += '\n*Total: ' + found.length + ' invoices | ' + tv.toFixed(1) + 'L | Rs.' + tval.toFixed(0) + '*';
    return msg;
}

// ─── DEEP BUSINESS SUMMARY (for AI fallback) ───────────────────────────────
function generateDeepBusinessSummary(allRows) {
    var custStats = {}, monthStats = {}, execStats = {};
    for (var i = 0; i < allRows.length; i++) {
        var r = allRows[i]; if (!r['Invoice No']) continue;
        var cName = (r['Customer Name'] || 'Unknown').trim();
        var exec  = (r['Sales Executive Name'] || 'Unknown').trim();
        var vol   = parseFloat(r['Product Volume']) || 0;
        var val   = parseFloat(r['Total Value incl VAT/GST']) || 0;
        var dt    = typeof r['Invoice Date'] === 'number' ? new Date(Math.round((r['Invoice Date']-25569)*86400000)) : new Date(r['Invoice Date']);
        var month = isNaN(dt.getTime()) ? 'Unknown' : dt.toLocaleString('en-US',{month:'short',year:'numeric'});
        if (!custStats[cName])  custStats[cName]  = {vol:0,val:0};  custStats[cName].vol  += vol; custStats[cName].val  += val;
        if (!monthStats[month]) monthStats[month] = {vol:0,val:0};  monthStats[month].vol += vol; monthStats[month].val += val;
        if (!execStats[exec])   execStats[exec]   = {vol:0,val:0};  execStats[exec].vol   += vol; execStats[exec].val   += val;
    }
    var summary = '[BUSINESS DATA]\n\n-- MONTHLY --\n';
    for (var m in monthStats) summary += '['+m+'] Vol:'+monthStats[m].vol.toFixed(1)+'L Val:Rs.'+monthStats[m].val.toFixed(0)+'\n';
    summary += '\n-- CUSTOMERS --\n';
    Object.keys(custStats).sort(function(a,b){return custStats[b].vol-custStats[a].vol;}).forEach(function(k){ summary += '[CUST] '+k+' Vol:'+custStats[k].vol.toFixed(1)+'L Val:Rs.'+custStats[k].val.toFixed(0)+'\n'; });
    summary += '\n-- EXECUTIVES --\n';
    for (var e in execStats) summary += '[EXEC] '+e+' Vol:'+execStats[e].vol.toFixed(1)+'L Val:Rs.'+execStats[e].val.toFixed(0)+'\n';
    return summary.slice(0, 18000);
}

// ─── LOAD ALL DATA ─────────────────────────────────────────────────────────
async function loadAllData() {
    if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache;
    var base = process.env.GITHUB_RAW_BASE;
    if (!base) return null;
    var fileList = []; try { fileList = (await axios.get(base+'/index.json')).data; } catch(e){ return null; }

    var excelFiles = fileList.filter(function(f){ return f.match(/\.(xlsx|xls|csv)$/i) && !f.toLowerCase().includes('mrp') && !f.toLowerCase().includes('dlp') && !f.toLowerCase().includes('list'); });
    var allRows = [];
    for (var k = 0; k < excelFiles.length; k++) {
        try { var res = await axios.get(base+'/'+encodeURIComponent(excelFiles[k]),{responseType:'arraybuffer'}); var wb = XLSX.read(res.data,{type:'buffer'}); for (var s = 0; s < wb.SheetNames.length; s++) { allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]],{defval:''})); } } catch(e){}
    }
    var invoiceMap = {};
    for (var m = 0; m < allRows.length; m++) { var inv = allRows[m]['Invoice No']||''; if(inv){if(!invoiceMap[inv])invoiceMap[inv]=[];invoiceMap[inv].push(allRows[m]);} }

    var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var mrpMap  = {};
    if (mrpFile) { try { var r2 = await axios.get(base+'/'+encodeURIComponent(mrpFile),{responseType:'arraybuffer'}); mrpMap = loadPriceListFromExcel(XLSX.read(r2.data,{type:'buffer'})); } catch(e){} }

    var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp')||f.toLowerCase().includes('list')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var dlpMap  = {};
    if (dlpFile) { try { var r3 = await axios.get(base+'/'+encodeURIComponent(dlpFile),{responseType:'arraybuffer'}); dlpMap = loadPriceListFromExcel(XLSX.read(r3.data,{type:'buffer'})); } catch(e){} }

    // PDF files ke URLs
    var mrpPdfFile  = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.pdf$/i); });
    var listPdfFile = fileList.find(function(f){ return (f.toLowerCase().includes('list')||f.toLowerCase().includes('dlp')) && !f.toLowerCase().includes('mrp') && f.match(/\.pdf$/i); });
    var mrpPdfUrl   = mrpPdfFile  ? base+'/'+encodeURIComponent(mrpPdfFile)  : '';
    var listPdfUrl  = listPdfFile ? base+'/'+encodeURIComponent(listPdfFile) : '';

    globalCache = {
        invoiceMap:     invoiceMap,
        allRows:        allRows,
        mrpMap:         mrpMap,
        dlpMap:         dlpMap,
        businessSummary: generateDeepBusinessSummary(allRows),
        mrpFile:        mrpFile,
        dlpFile:        dlpFile,
        mrpPdfUrl:      mrpPdfUrl,
        listPdfUrl:     listPdfUrl,
        mrpPdfFile:     mrpPdfFile,
        listPdfFile:    listPdfFile,
    };
    lastCacheTime = Date.now();
    console.log('[CACHE] Invoices:'+Object.keys(invoiceMap).length+' MRP:'+Object.keys(mrpMap).length+' DLP:'+Object.keys(dlpMap).length);
    return globalCache;
}

// ─── AI REPLY ──────────────────────────────────────────────────────────────
async function getAIReply(userMsg, data, prompt) {
    var key = process.env.NVIDIA_API_KEY; if (!key) return null;
    try {
        var res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model: 'meta/llama-3.1-70b-instruct',
            messages: [{ role: 'system', content: prompt+'\n\nCONTEXT DATA:\n'+data }, { role: 'user', content: userMsg }],
            max_tokens: 800, temperature: 0.1
        }, { headers: { 'Authorization': 'Bearer '+key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 });
        return sanitizeReply(res.data.choices[0].message.content);
    } catch (e) { return null; }
}

// ─── SEND ──────────────────────────────────────────────────────────────────
async function sendText(to, text) {
    var base = (process.env.EVOLUTION_API_URL||'').replace(/\/$/,''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/,'').replace(/@g\.us$/,'');
    if (!base||!inst||!key) return;
    try { await axios.post(base+'/message/sendText/'+inst,{number:num,text:text},{headers:{'Content-Type':'application/json','apikey':key}}); } catch(e){}
}
async function sendDocument(to, fileUrl, fileName, caption) {
    var base = (process.env.EVOLUTION_API_URL||'').replace(/\/$/,''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY; var num = to.replace(/@s\.whatsapp\.net$/,'').replace(/@g\.us$/,'');
    if (!base||!inst||!key) return;
    try { await axios.post(base+'/message/sendMedia/'+inst,{number:num,mediatype:'document',mimetype:'application/pdf',media:fileUrl,fileName:fileName,caption:caption||''},{headers:{'Content-Type':'application/json','apikey':key}}); } catch(e){}
}

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

        var invoiceMap = dataResult.invoiceMap || {};
        var mrpMap     = dataResult.mrpMap     || {};
        var dlpMap     = dataResult.dlpMap     || {};

        // ── PENDING NUMBER SELECTION ──────────────────────────────────────
        if (/^\d+$/.test(text)) {
            var pending = null;
            if (database) { try { var snap = await database.ref('pending/'+safeFrom).get(); if(snap.exists()) pending = snap.val(); } catch(e){} }
            if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];

            if (pending && pending.matches) {
                var idx = parseInt(text) - 1;
                if (pending.matches[idx]) {
                    if (pending.type === 'invoice') {
                        var m = pending.matches[idx]; var f = m.rows[0];
                        var prods = m.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + ');
                        var tG = m.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
                        var vl = m.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
                        await sendText(from, '*Invoice:* '+m.invNo+'\n*Customer:* '+f['Customer Name']+'\n*Products:* '+prods+'\n*Total Value:* Rs.'+tG.toFixed(2)+'\n*Total Volume:* '+vl.toFixed(1)+' L\n*Date:* '+cleanDate(f['Invoice Date'])+'\n*Payment:* '+f['Mode Of Payement']);
                    } else if (pending.type === 'product') {
                        var p = pending.matches[idx];
                        var aiReply = await getAIReply('User ORIGINAL query: "'+pending.originalQuery+'". Selected: '+p.name+'. Give exact MRP and DLP for the SPECIFIC SIZE asked. 0.9L=900ml.', '[PRICE DATA]\n'+p.chunk, sysPrompt);
                        await sendText(from, aiReply || 'Data nahi mila.');
                    } else if (pending.type === 'customer_report') {
                        var report = getCustomerReport(pending.matches[idx].name, invoiceMap, pending.dateFilter || 'all');
                        await sendText(from, report);
                    } else if (pending.type === 'customer_select') {
                        var report2 = getCustomerReport(pending.matches[idx].name, invoiceMap, pending.dateFilter || 'all');
                        await sendText(from, report2);
                    }
                    if (database) try { await database.ref('pending/'+safeFrom).remove(); } catch(e){}
                    delete memoryPending[safeFrom];
                } else {
                    await sendText(from, 'Galat number. 1 se '+pending.matches.length+' ke beech chunein.');
                }
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── ADMIN COMMANDS ────────────────────────────────────────────────
        if (isAdmin && text.indexOf('!setprompt ') === 0)  { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!status')  { await sendText(from, '*Bot Status*\nOnline\nInvoices: '+Object.keys(invoiceMap).length+'\nMRP: '+Object.keys(mrpMap).length+'\nDLP: '+Object.keys(dlpMap).length); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!clearcache') { globalCache = null; await sendText(from, 'Cache cleared!'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text.indexOf('!addpdf ') === 0) {
            var parts = text.slice(8).split('|').map(function(s){return s.trim();});
            if (parts.length === 3) { var lst = await getPDFList(); lst[parts[0].toLowerCase()] = {name:parts[1],url:parts[2]}; await savePDFList(lst); await sendText(from, 'PDF added: '+parts[1]); }
            else await sendText(from, 'Format: !addpdf keyword | Name | URL');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') { var pl = await getPDFList(); await sendText(from, Object.keys(pl).length ? Object.entries(pl).map(function(e){return e[1].name+' ['+e[0]+']';}).join('\n') : 'No PDFs saved.'); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text.indexOf('!removepdf ') === 0) { var kw = text.slice(11).trim().toLowerCase(); var pl2 = await getPDFList(); if(pl2[kw]){delete pl2[kw]; await savePDFList(pl2); await sendText(from,'Removed: '+kw);} else await sendText(from,'Not found: '+kw); return res.status(200).json({ status: 'ok' }); }
        if (isAdmin && text === '!help') { await sendText(from, '*Admin Commands:*\n!status\n!setprompt [text]\n!clearcache\n!addpdf keyword|Name|URL\n!listpdf\n!removepdf keyword'); return res.status(200).json({ status: 'ok' }); }

        // ── GREETING ──────────────────────────────────────────────────────
        var lower = text.toLowerCase();
        if (['hi','hello','namaste','hey','hii','good morning','kaise ho','helo'].some(function(g){return lower===g||lower.startsWith(g+' ');})) {
            await sendText(from, 'Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant.\nInvoice details, MRP/DLP rates, customer reports pooch sakte hain!');
            return res.status(200).json({ status: 'ok' });
        }

        // ── PDF SEND REQUEST ──────────────────────────────────────────────
        var hasSend = ['send','bhejo','share','bhej','de do','chahiye','pdf'].some(function(w){return lower.includes(w);});
        var hasMRP  = ['mrp','maximum retail'].some(function(w){return lower.includes(w);});
        var hasDLP  = ['list price','dlp','dealer price','price list'].some(function(w){return lower.includes(w);});
        if (hasSend && hasMRP  && dataResult.mrpPdfUrl)  { await sendDocument(from, dataResult.mrpPdfUrl,  dataResult.mrpPdfFile,  dataResult.mrpPdfFile);  return res.status(200).json({status:'ok'}); }
        if (hasSend && hasDLP  && dataResult.listPdfUrl) { await sendDocument(from, dataResult.listPdfUrl, dataResult.listPdfFile, dataResult.listPdfFile); return res.status(200).json({status:'ok'}); }
        for (var k in savedPDFs) { if (lower.includes(k) && hasSend) { await sendDocument(from, savedPDFs[k].url, savedPDFs[k].name, savedPDFs[k].name); return res.status(200).json({status:'ok'}); } }

        // ── PRODUCT RATE QUERY ────────────────────────────────────────────
        var prodMatches = searchProducts(text, mrpMap, dlpMap);
        var invMatches  = searchInvoices(text, invoiceMap);
        var isRateQ     = ['rate','price','mrp','dlp','kitne ka','dam','rupay'].some(function(w){return lower.includes(w);});

        if (isRateQ || (prodMatches.length > 0 && invMatches.length === 0)) {
            if (prodMatches.length === 0) { await sendText(from, 'Please wait, admin will reply soon.'); return res.status(200).json({status:'ok'}); }
            if (prodMatches.length === 1) {
                var aiR = await getAIReply('Query: '+text+'\nGive exact MRP and DLP for the size mentioned. 0.9L=900ml.', '[PRICE DATA]\n'+prodMatches[0].chunk, sysPrompt);
                await sendText(from, aiR || 'Data nahi mila.');
                return res.status(200).json({status:'ok'});
            }
            var msg = '*Kaunsa product? Number reply karein:*\n\n';
            prodMatches.forEach(function(p,i){ msg += (i+1)+'. '+p.name+'\n'; });
            var pend = { type:'product', matches:prodMatches, originalQuery:text, ts:Date.now() };
            if (database) try { await database.ref('pending/'+safeFrom).set(pend); } catch(e){}
            memoryPending[safeFrom] = pend;
            await sendText(from, msg);
            return res.status(200).json({status:'ok'});
        }

        // ── INVOICE SEARCH ────────────────────────────────────────────────
        if (invMatches.length === 1) {
            var m2 = invMatches[0]; var f2 = m2.rows[0];
            var prods2 = m2.rows.map(function(r){return r['Product Name']+'('+r['Product Volume']+'L)';}).join(' + ');
            var tG2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Total Value incl VAT/GST'])||0);},0);
            var vl2 = m2.rows.reduce(function(s,r){return s+(parseFloat(r['Product Volume'])||0);},0);
            await sendText(from, '*Invoice:* '+m2.invNo+'\n*Customer:* '+f2['Customer Name']+'\n*Products:* '+prods2+'\n*Total Value:* Rs.'+tG2.toFixed(2)+'\n*Total Volume:* '+vl2.toFixed(1)+' L\n*Date:* '+cleanDate(f2['Invoice Date'])+'\n*Payment:* '+f2['Mode Of Payement']);
            return res.status(200).json({status:'ok'});
        }
        if (invMatches.length > 1) {
            var msg2 = '*Multiple invoices. Number reply karein:*\n\n';
            invMatches.forEach(function(m,i){ msg2 += (i+1)+'. '+m.customer+' ('+m.invNo+')\n'; });
            var pend2 = { type:'invoice', matches:invMatches, ts:Date.now() };
            if (database) try { await database.ref('pending/'+safeFrom).set(pend2); } catch(e){}
            memoryPending[safeFrom] = pend2;
            await sendText(from, msg2);
            return res.status(200).json({status:'ok'});
        }

        // ── SMART CUSTOMER/ANALYTICS QUERIES ─────────────────────────────
        var qIntent = detectQueryIntent(text);
        console.log('[INTENT] type:'+qIntent.type+' dateFilter:'+qIntent.dateFilter+' query:'+text);

        if (qIntent.type === 'top_customers') {
            var topReport = getTopCustomers(invoiceMap, qIntent.dateFilter, 5);
            await sendText(from, topReport);
            return res.status(200).json({status:'ok'});
        }

        if (qIntent.type === 'executive_report') {
            var execReport = getExecutiveReport(invoiceMap, qIntent.dateFilter);
            await sendText(from, execReport);
            return res.status(200).json({status:'ok'});
        }

        if (qIntent.type === 'customer_query') {
            // Customer naam dhundo
            var cMatches = searchCustomers(text, invoiceMap);

            if (cMatches.length === 0) {
                // Date-only query (today/this week) — date-wise summary do
                if (qIntent.dateFilter !== 'all') {
                    var dateSummary = getDateWiseSummary(invoiceMap, qIntent.dateFilter);
                    await sendText(from, dateSummary);
                    return res.status(200).json({status:'ok'});
                }
                await sendText(from, 'Please wait, admin will reply soon.');
                return res.status(200).json({status:'ok'});
            }

            if (cMatches.length === 1) {
                var cReport = getCustomerReport(cMatches[0].name, invoiceMap, qIntent.dateFilter);
                await sendText(from, cReport);
                return res.status(200).json({status:'ok'});
            }

            // Multiple customer matches → Show numbered selection
            var cMsg = '*Kaunse customer ka data? Number reply karein:*\n\n';
            cMatches.forEach(function(c,i){ cMsg += (i+1)+'. '+c.name+'\n'; });
            var cPend = { type:'customer_select', matches:cMatches, dateFilter:qIntent.dateFilter, ts:Date.now() };
            if (database) try { await database.ref('pending/'+safeFrom).set(cPend); } catch(e){}
            memoryPending[safeFrom] = cPend;
            await sendText(from, cMsg);
            return res.status(200).json({status:'ok'});
        }

        // ── AI FALLBACK (general analytics only) ─────────────────────────
        var aiReply2 = await getAIReply(
            'User Query: "'+text+'"\nInstructions: Use CONTEXT DATA to answer. If answer not clearly in data, say exactly: "Please wait, admin will reply soon."',
            dataResult.businessSummary || '',
            sysPrompt
        );
        if (!aiReply2 || aiReply2.toLowerCase().includes('admin will reply soon') || aiReply2.includes('Error')) {
            await sendText(from, 'Please wait, admin will reply soon.');
        } else {
            await sendText(from, aiReply2);
        }
        return res.status(200).json({status:'ok'});

    } catch (e) {
        console.error('[WH] Fatal:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};
