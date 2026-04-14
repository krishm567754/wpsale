const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');

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
    var dt = parseDate(val);
    if (!dt) return String(val);
    return String(dt.getDate()).padStart(2,'0') + '/' + String(dt.getMonth()+1).padStart(2,'0') + '/' + dt.getFullYear();
}

// Parse dates from Excel (Serial or String "4/6/26")
function parseDate(val) {
    if (!val) return null;
    if (typeof val === 'number') {
        // Excel serial to JS Date (UTC-based to avoid timezone issues)
        return new Date(Date.UTC(1900, 0, Math.floor(val) - 1));
    }
    var d = new Date(val);
    if (!isNaN(d.getTime())) return d;
    // Try DD/MM/YY if M/D/YY failed
    var parts = String(val).split('/');
    if (parts.length === 3) {
        var y = parseInt(parts[2]) > 50 ? 1900 + parseInt(parts[2]) : 2000 + parseInt(parts[2]);
        var m = parseInt(parts[1]) - 1;
        var dd = parseInt(parts[0]);
        if (m > 11) return new Date(Date.UTC(y, dd - 1, parseInt(parts[1])));
        return new Date(Date.UTC(y, m, dd));
    }
    return null;
}

// Convert JS Date to Excel Serial (for reliable comparison)
function dateToSerial(d) {
    if (!d) return null;
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000) + 25569);
}

// ─── ROBUST DATE RANGE EXTRACTOR (Returns Excel Serials) ───────────────────
function extractDateRange(text) {
    var lower = text.toLowerCase();
    var now = new Date();
    
    // Helper to get Excel serial for a JS Date
    function toSerial(y, m, d) { return Math.floor((Date.UTC(y, m, d) / 86400000) + 25569); }
    
    // Current Month
    var thisMonthStart = toSerial(now.getFullYear(), now.getMonth(), 1);
    var thisMonthEnd = toSerial(now.getFullYear(), now.getMonth() + 1, 0);
    
    // Last Month
    var lastMonthStart = toSerial(now.getFullYear(), now.getMonth() - 1, 1);
    var lastMonthEnd = toSerial(now.getFullYear(), now.getMonth(), 0);

    // This Week (Mon-Sun)
    var day = now.getDay() === 0 ? 6 : now.getDay() - 1;
    var thisWeekStart = toSerial(now.getFullYear(), now.getMonth(), now.getDate() - day);
    var thisWeekEnd = toSerial(now.getFullYear(), now.getMonth(), now.getDate() - day + 6);

    // Last Week
    var lastWeekStart = toSerial(now.getFullYear(), now.getMonth(), now.getDate() - day - 7);
    var lastWeekEnd = toSerial(now.getFullYear(), now.getMonth(), now.getDate() - day - 1);

    if (lower.match(/\bthis\s*month\b|\bis\s*month\b|\bchalu\s*mahine\b|\bis\s*mahine\b/)) {
        return { from: thisMonthStart, to: thisMonthEnd, label: 'This Month' };
    }
    if (lower.match(/\blast\s*month\b|\bpichla\s*mahine\b|\bpichhle\s*mahine\b|\bgaya\s*mahine\b/)) {
        return { from: lastMonthStart, to: lastMonthEnd, label: 'Last Month' };
    }
    if (lower.match(/\bthis\s*week\b|\bis\s*hafte\b|\bchalu\s*hafte\b/)) {
        return { from: thisWeekStart, to: thisWeekEnd, label: 'This Week' };
    }
    if (lower.match(/\blast\s*week\b|\bpichla\s*hafte\b|\bpichhle\s*hafte\b/)) {
        return { from: lastWeekStart, to: lastWeekEnd, label: 'Last Week' };
    }
    
    return null;
}

// ─── ANALYTICS ENGINE (Fixed & Robust) ─────────────────────────────────────
function handleAnalytics(text, allRows) {
    var lower = text.toLowerCase();
    var dateFilter = extractDateRange(text);
    
    console.log('[ANALYTICS] dateFilter:', dateFilter ? dateFilter.label : 'none');
    
    // 1. Filter Data using Excel Serials (timezone-safe)
    var filtered = allRows.filter(function(row) {
        var invDate = row['Invoice Date'];
        if (typeof invDate !== 'number') return false; // Skip non-numeric dates
        if (dateFilter) {
            return invDate >= dateFilter.from && invDate <= dateFilter.to;
        }
        return true;
    });

    console.log('[ANALYTICS] filtered rows:', filtered.length);
    
    if (filtered.length === 0 && dateFilter) {
        return "Is period (" + dateFilter.label + ") ke liye koi data nahi mila.";
    }
    if (filtered.length === 0) {
        return "Koi data nahi mila.";
    }

    // 2. Detect Intent - Be SPECIFIC to avoid false positives
    // -- Top Customers --
    if (lower.includes('top') && (lower.includes('customer') || lower.includes('party') || lower.includes('gahak') || lower.includes('client'))) {
        var limit = 5;
        var match = text.match(/\b(\d{1,3})\b/);
        if (match) limit = parseInt(match[1]);
        
        var custMap = {};
        filtered.forEach(function(r) {
            // Normalize customer name: trim, uppercase, remove extra spaces
            var name = (r['Customer Name'] || 'Unknown').trim().toUpperCase().replace(/\s+/g, ' ');
            var vol = parseFloat(r['Product Volume']) || 0;
            if (!custMap[name]) custMap[name] = { vol: 0, count: 0 };
            custMap[name].vol += vol;
            custMap[name].count++;
        });
        
        var sorted = Object.entries(custMap).sort(function(a,b){ return b[1].vol - a[1].vol; }).slice(0, limit);
        
        if (sorted.length === 0) return "Is period mein koi customer data nahi mila.";
        
        var res = "*Top " + limit + " Customers by Volume*\n";
        if (dateFilter) res += "*Period:* " + dateFilter.label + "\n";
        res += "\n";
        sorted.forEach(function(entry, i) {
            res += (i+1) + ". " + entry[0] + "\n   Vol: *" + entry[1].vol.toFixed(1) + " L* | Bills: " + entry[1].count + "\n\n";
        });
        return res;
    }

    // -- Executive Wise -- (More specific detection)
    if ((lower.includes('executive') || lower.includes('salesman') || lower.includes('sales man') || lower.includes('rep') || lower.includes('jagdish') || lower.includes('daya') || lower.includes('rakesh') || lower.includes('gajanand') || lower.includes('naresh')) && !lower.includes('customer')) {
        var execMap = {};
        filtered.forEach(function(r) {
            // Handle multiple possible column names
            var name = r['Sales Executive Name'] || r['Executive'] || r['Salesman'] || 'Unknown';
            name = name.trim();
            if (!name || name === 'Unknown') return;
            var vol = parseFloat(r['Product Volume']) || 0;
            var val = parseFloat(r['Total Value incl VAT/GST']) || 0;
            if (!execMap[name]) execMap[name] = { vol: 0, val: 0, count: 0 };
            execMap[name].vol += vol;
            execMap[name].val += val;
            execMap[name].count++;
        });
        
        if (Object.keys(execMap).length === 0) return "Is period mein koi executive data nahi mila.";
        
        var res = "*Executive Wise Summary*\n";
        if (dateFilter) res += "*Period:* " + dateFilter.label + "\n";
        res += "\n";
        
        var sortedExec = Object.entries(execMap).sort(function(a,b){ return b[1].vol - a[1].vol; });
        sortedExec.forEach(function(entry) {
            res += "*" + entry[0] + "*\n";
            res += "Vol: " + entry[1].vol.toFixed(1) + " L | Val: Rs." + entry[1].val.toFixed(0) + " | Bills: " + entry[1].count + "\n\n";
        });
        return res;
    }

    // -- Month Wise Grouping --
    if (lower.includes('month wise') || lower.includes('monthly')) {
        var monthMap = {};
        filtered.forEach(function(r) {
            var d = parseDate(r['Invoice Date']);
            if (d) {
                var key = d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
                var vol = parseFloat(r['Product Volume']) || 0;
                if (!monthMap[key]) monthMap[key] = 0;
                monthMap[key] += vol;
            }
        });
        if (Object.keys(monthMap).length === 0) return "Is period mein koi monthly data nahi mila.";
        var res = "*Sales Month Wise*\n\n";
        for (var m in monthMap) {
            res += "*" + m + "*: " + monthMap[m].toFixed(1) + " L\n";
        }
        return res;
    }
    
    // -- Week Wise -- (Only if specific week mentioned)
    if ((lower.includes('week wise') || lower.includes('weekly')) && dateFilter && dateFilter.label.includes('Week')) {
        var weekMap = {};
        filtered.forEach(function(r) {
            var d = parseDate(r['Invoice Date']);
            if (d) {
                var key = dateFilter.label; // Use the filter label as the week identifier
                var vol = parseFloat(r['Product Volume']) || 0;
                if (!weekMap[key]) weekMap[key] = 0;
                weekMap[key] += vol;
            }
        });
        if (Object.keys(weekMap).length === 0) return "Is week ke liye koi data nahi mila.";
        var res = "*Sales " + dateFilter.label + "*\n\n";
        for (var w in weekMap) {
            res += "*" + w + "*: " + weekMap[w].toFixed(1) + " L\n";
        }
        return res;
    }
    
    // -- General Summary --
    if (lower.includes('summary') || lower.includes('hisab') || lower.includes('total sale')) {
        var totalVol = filtered.reduce(function(s,r){ return s + (parseFloat(r['Product Volume'])||0); }, 0);
        var totalVal = filtered.reduce(function(s,r){ return s + (parseFloat(r['Total Value incl VAT/GST'])||0); }, 0);
        var totalInv = filtered.length;
        return "*Sales Summary*\n*Total Volume:* " + totalVol.toFixed(1) + " L\n*Total Value:* Rs." + totalVal.toFixed(0) + "\n*Total Invoices:* " + totalInv;
    }

    return null; // Not an analytics query
}

// ─── LOAD ALL DATA ─────────────────────────────────────────────────────────
async function loadAllData() {
    if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache;
    var base = process.env.GITHUB_RAW_BASE; if (!base) return null;
    var fileList = []; try { fileList = (await axios.get(base+'/index.json')).data; } catch(e){ return null; }
    
    var excelFiles = fileList.filter(function(f){ return f.match(/\.(xlsx|xls|csv)$/i) && !f.toLowerCase().includes('mrp') && !f.toLowerCase().includes('dlp') && !f.toLowerCase().includes('list'); });
    var allRows = [];
    for (var k = 0; k < excelFiles.length; k++) {
        try { 
            var res = await axios.get(base+'/'+encodeURIComponent(excelFiles[k]),{responseType:'arraybuffer'}); 
            var wb = XLSX.read(res.data,{type:'buffer'}); 
            for (var s = 0; s < wb.SheetNames.length; s++) { 
                var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]],{defval:''});
                allRows = allRows.concat(rows); 
            } 
        } catch(e){ console.error('[LOAD] Error:', e.message); }
    }
    
    var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var mrpMap = {}; 
    if (mrpFile) { try { var r2 = await axios.get(base+'/'+encodeURIComponent(mrpFile),{responseType:'arraybuffer'}); mrpMap = loadPriceListFromExcel(XLSX.read(r2.data,{type:'buffer'})); } catch(e){} }
    
    var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp')||f.toLowerCase().includes('list')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var dlpMap = {}; 
    if (dlpFile) { try { var r3 = await axios.get(base+'/'+encodeURIComponent(dlpFile),{responseType:'arraybuffer'}); dlpMap = loadPriceListFromExcel(XLSX.read(r3.data,{type:'buffer'})); } catch(e){} }

    globalCache = { allRows: allRows, mrpMap: mrpMap, dlpMap: dlpMap };
    lastCacheTime = Date.now();
    console.log('[CACHE] Loaded:', allRows.length, 'rows');
    return globalCache;
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
            if (col0.toLowerCase().indexOf('brand name') !== -1) { currentHeaders = row.map(function(c) { return c.replace(/\s+/g,'').toUpperCase(); }); continue; }
            if (currentHeaders.length > 0 && col0.length > 3) {
                if (!priceMap[col0]) priceMap[col0] = {};
                for (var j = 1; j < row.length; j++) { 
                    var size = currentHeaders[j]; 
                    var val = parseFloat(row[j]); 
                    if (size && !isNaN(val)) priceMap[col0][size] = val; 
                }
            }
        }
    }
    return priceMap;
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

        var results = await loadAllData();
        if (!results) return res.status(200).send('Data Error');
        var allRows = results.allRows;
        var mrpMap = results.mrpMap;
        var dlpMap = results.dlpMap;

        var lower = text.toLowerCase();

        // ─── GREETING ─────────────────────────────────────────────────────
        if (['hi','hello','namaste','hey','hii','good morning','kaise ho'].some(function(g){return lower===g||lower.startsWith(g+' ');})){
            return res.status(200).json({ status: 'ok', sent: true });
        }

        // ─── PRODUCT RATE QUERIES FIRST (Avoid analytics false positives) ─
        if (lower.match(/\b(rate|price|mrp|dlp|kitna ka|dam|rupay)\b/)) {
            var productReply = findProductRate(text, mrpMap, dlpMap);
            if (productReply) {
                await sendText(from, productReply);
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ─── ANALYTICS QUERIES (After product check) ──────────────────────
        var analyticsReply = handleAnalytics(text, allRows);
        if (analyticsReply) {
            await sendText(from, analyticsReply);
            return res.status(200).json({ status: 'ok' });
        }

        // ─── FALLBACK ─────────────────────────────────────────────────────
        await sendText(from, 'Please wait, admin will reply soon.');
        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};

// ─── HELPER FUNCTIONS ──────────────────────────────────────────────────────
async function sendText(to, text) {
    var base = (process.env.EVOLUTION_API_URL||'').replace(/\/$/,''); var inst = process.env.EVOLUTION_INSTANCE; var key = process.env.EVOLUTION_API_KEY;
    var num = to.replace(/@s\.whatsapp\.net$/,'').replace(/@g\.us$/,'');
    if (!base||!inst||!key) return;
    try { await axios.post(base+'/message/sendText/'+inst,{number:num,text:text},{headers:{'Content-Type':'application/json','apikey':key}}); } catch(e){}
}

function findProductRate(query, mrpMap, dlpMap) {
    var lower = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    var words = lower.split(' ').filter(w => w.length > 1);
    
    var foundProduct = null;
    var foundSize = null;
    
    for (var pName in mrpMap) {
        var pLower = pName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        var pWords = pLower.split(' ');
        var matchScore = 0;
        pWords.forEach(function(w) {
            if (lower.includes(w)) matchScore++;
        });
        if (matchScore >= 2 || (matchScore >= 1 && pWords.length <= 2)) {
            foundProduct = pName;
            var sizes = Object.keys(mrpMap[pName]);
            sizes.forEach(function(sz) {
                var szClean = sz.toLowerCase().replace(/\s/g,'');
                if (lower.includes(szClean) || lower.includes(szClean.replace('ml','')) || lower.includes(szClean.replace('l',''))) {
                    foundSize = sz;
                }
            });
            if (!foundSize && sizes.length > 0) foundSize = sizes[0];
            break;
        }
    }

    if (foundProduct) {
        var cleanQuerySize = lower.replace(/[^0-9ml.]/g, '');
        if (!foundSize) {
             var sizes = Object.keys(mrpMap[foundProduct]);
             if (cleanQuerySize.length > 0) {
                 foundSize = sizes.find(s => s.toLowerCase().includes(cleanQuerySize));
             }
        }
        
        if (foundSize) {
            var mrp = mrpMap[foundProduct][foundSize];
            var dlp = dlpMap[foundProduct] ? dlpMap[foundProduct][foundSize] : null;
            
            var msg = "*Product:* " + foundProduct + " (" + foundSize + ")\n";
            msg += "*MRP:* Rs." + (mrp || 'N/A') + "\n";
            if (dlp) msg += "*DLP:* Rs." + dlp + "\n";
            return msg;
        } else {
            return "Size not found for " + foundProduct + ". Available sizes: " + Object.keys(mrpMap[foundProduct]).join(', ');
        }
    }
    return null;
}
