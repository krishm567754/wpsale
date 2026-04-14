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
        return new Date(Math.round((val - 25569) * 86400000));
    }
    var d = new Date(val);
    if (!isNaN(d.getTime())) return d;
    // Try DD/MM/YY if M/D/YY failed
    var parts = String(val).split('/');
    if (parts.length === 3) {
        var y = parseInt(parts[2]) > 50 ? 1900 + parseInt(parts[2]) : 2000 + parseInt(parts[2]);
        var m = parseInt(parts[1]) - 1;
        var dd = parseInt(parts[0]);
        // Basic check if M/D/YY logic failed (e.g. month > 12)
        if (m > 11) return new Date(y, dd - 1, parseInt(parts[1])); // Swap
        return new Date(y, m, dd);
    }
    return null;
}

// ─── ROBUST DATE RANGE EXTRACTOR ───────────────────────────────────────────
function extractDateRange(text) {
    var lower = text.toLowerCase();
    var now = new Date();
    
    // Current Month
    var thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    // Last Month
    var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    var lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    // This Week (Mon-Sun)
    var day = now.getDay() === 0 ? 6 : now.getDay() - 1;
    var thisWeekStart = new Date(now); thisWeekStart.setDate(now.getDate() - day); thisWeekStart.setHours(0,0,0,0);
    var thisWeekEnd = new Date(thisWeekStart); thisWeekEnd.setDate(thisWeekStart.getDate() + 6); thisWeekEnd.setHours(23,59,59,999);

    // Last Week
    var lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(thisWeekStart.getDate() - 7);
    var lastWeekEnd = new Date(thisWeekStart); lastWeekEnd.setDate(thisWeekStart.getDate() - 1);

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
    
    return null; // No specific filter
}

// ─── ANALYTICS ENGINE (Handles Top Customers, Executive, Grouping) ─────────
function handleAnalytics(text, allRows) {
    var lower = text.toLowerCase();
    var dateFilter = extractDateRange(text);
    
    // 1. Filter Data
    var filtered = allRows.filter(function(row) {
        var d = parseDate(row['Invoice Date']);
        if (!d) return false; // Skip invalid dates
        if (dateFilter) {
            return d >= dateFilter.from && d <= dateFilter.to;
        }
        return true;
    });

    if (filtered.length === 0 && dateFilter) {
        return "Is period (" + dateFilter.label + ") ke liye koi data nahi mila.";
    }
    if (filtered.length === 0) {
        return "Koi data nahi mila.";
    }

    // 2. Detect Intent
    // -- Top Customers --
    if (lower.includes('top') && (lower.includes('customer') || lower.includes('party') || lower.includes('gahak'))) {
        var limit = 5;
        var match = text.match(/(\d+)/);
        if (match) limit = parseInt(match[1]);
        
        var custMap = {};
        filtered.forEach(function(r) {
            var name = r['Customer Name'] || 'Unknown';
            var vol = parseFloat(r['Product Volume']) || 0;
            if (!custMap[name]) custMap[name] = 0;
            custMap[name] += vol;
        });
        
        var sorted = Object.entries(custMap).sort(function(a,b){ return b[1] - a[1]; }).slice(0, limit);
        
        var res = "*Top " + limit + " Customers by Volume*\n";
        if (dateFilter) res += "*Period:* " + dateFilter.label + "\n";
        res += "\n";
        sorted.forEach(function(entry, i) {
            res += (i+1) + ". " + entry[0] + " - *" + entry[1].toFixed(1) + " L*\n";
        });
        return res;
    }

    // -- Executive Wise --
    if (lower.includes('executive') || lower.includes('salesman') || lower.includes('rep')) {
        var execMap = {};
        filtered.forEach(function(r) {
            var name = r['Sales Executive Name'] || 'Unknown';
            var vol = parseFloat(r['Product Volume']) || 0;
            var val = parseFloat(r['Total Value incl VAT/GST']) || 0;
            if (!execMap[name]) execMap[name] = { vol: 0, val: 0 };
            execMap[name].vol += vol;
            execMap[name].val += val;
        });
        
        var res = "*Executive Wise Summary*\n";
        if (dateFilter) res += "*Period:* " + dateFilter.label + "\n";
        res += "\n";
        
        var sortedExec = Object.entries(execMap).sort(function(a,b){ return b[1].vol - a[1].vol; });
        sortedExec.forEach(function(entry) {
            res += "*" + entry[0] + "*\n";
            res += "Vol: " + entry[1].vol.toFixed(1) + " L | Val: Rs." + entry[1].val.toFixed(0) + "\n\n";
        });
        return res;
    }

    // -- Month Wise Grouping --
    if (lower.includes('month wise') || lower.includes('monthly')) {
        var monthMap = {};
        filtered.forEach(function(r) {
            var d = parseDate(r['Invoice Date']);
            if (d) {
                var key = d.toLocaleString('en-US', { month: 'short', year: 'numeric' }); // e.g. Apr 2026
                var vol = parseFloat(r['Product Volume']) || 0;
                if (!monthMap[key]) monthMap[key] = 0;
                monthMap[key] += vol;
            }
        });
        var res = "*Sales Month Wise*\n\n";
        for (var m in monthMap) {
            res += "*" + m + "*: " + monthMap[m].toFixed(1) + " L\n";
        }
        return res;
    }

    // -- Week Wise Grouping (Simple approximation by date) --
    if (lower.includes('week wise') || lower.includes('weekly')) {
         // This is complex to calculate strictly without a calendar library,
         // but we can group by Date for now as a proxy, or just give total if specific week asked.
         // Given the user wants "week ka", if they ask "is hafte ka" (this week), extractDateRange handles it.
         // If they just want "week wise breakdown", we can return daily/weekly breakdown.
         // For simplicity and reliability, I'll return a summary if they ask "week wise".
         return "Please specify which week (e.g. 'this week' or 'last week').";
    }
    
    // -- General Summary if requested --
    if (lower.includes('summary') || lower.includes('hisab')) {
        var totalVol = filtered.reduce(function(s,r){ return s + (parseFloat(r['Product Volume'])||0); }, 0);
        var totalVal = filtered.reduce(function(s,r){ return s + (parseFloat(r['Total Value incl VAT/GST'])||0); }, 0);
        return "*Sales Summary*\n*Total Volume:* " + totalVol.toFixed(1) + " L\n*Total Value:* Rs." + totalVal.toFixed(0);
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
                // Clean headers
                allRows = allRows.concat(rows); 
            } 
        } catch(e){}
    }
    
    // Price Lists
    var mrpFile = fileList.find(function(f){ return f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var mrpMap = {}; 
    if (mrpFile) { try { var r2 = await axios.get(base+'/'+encodeURIComponent(mrpFile),{responseType:'arraybuffer'}); mrpMap = loadPriceListFromExcel(XLSX.read(r2.data,{type:'buffer'})); } catch(e){} }
    
    var dlpFile = fileList.find(function(f){ return (f.toLowerCase().includes('dlp')||f.toLowerCase().includes('list')) && !f.toLowerCase().includes('mrp') && f.match(/\.(xlsx|xls)$/i); });
    var dlpMap = {}; 
    if (dlpFile) { try { var r3 = await axios.get(base+'/'+encodeURIComponent(dlpFile),{responseType:'arraybuffer'}); dlpMap = loadPriceListFromExcel(XLSX.read(r3.data,{type:'buffer'})); } catch(e){} }

    globalCache = { allRows: allRows, mrpMap: mrpMap, dlpMap: dlpMap };
    lastCacheTime = Date.now();
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

        // ─── ANALYTICS QUERIES (New Logic) ────────────────────────────────
        var analyticsReply = handleAnalytics(text, allRows);
        if (analyticsReply) {
            await sendText(from, analyticsReply);
            return res.status(200).json({ status: 'ok' });
        }

        // ─── PRODUCT RATE QUERIES ─────────────────────────────────────────
        // Check if asking for price
        if (lower.match(/\b(rate|price|mrp|dlp|kitna|cost)\b/) || lower.match(/\b(mrp|dlp)\b/)) {
            var productReply = findProductRate(text, mrpMap, dlpMap);
            if (productReply) {
                await sendText(from, productReply);
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ─── FALLBACK ─────────────────────────────────────────────────────
        await sendText(from, 'Please wait, admin will reply soon.');
        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message);
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
    
    // Find product name and size
    var foundProduct = null;
    var foundSize = null;
    
    for (var pName in mrpMap) {
        var pLower = pName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        // Check if product name is in query
        var pWords = pLower.split(' ');
        var matchScore = 0;
        pWords.forEach(function(w) {
            if (lower.includes(w)) matchScore++;
        });
        if (matchScore >= 2 || (matchScore >= 1 && pWords.length <= 2)) {
            foundProduct = pName;
            // Find size
            var sizes = Object.keys(mrpMap[pName]);
            sizes.forEach(function(sz) {
                var szClean = sz.toLowerCase().replace(/\s/g,'');
                if (lower.includes(szClean) || lower.includes(szClean.replace('ml','')) || lower.includes(szClean.replace('l',''))) {
                    foundSize = sz;
                }
            });
            if (!foundSize && sizes.length > 0) foundSize = sizes[0]; // Fallback to first size? No, better be strict.
            // Actually, for user "900ml", we should match strictly if possible.
            // If user asks "Activ 20w40 900ml", foundSize should be "900ML".
            break;
        }
    }

    if (foundProduct) {
        // Normalize sizes for matching
        var cleanQuerySize = lower.replace(/[^0-9ml.]/g, '');
        // Map query size to known size
        if (!foundSize) {
             // Simple fuzzy match for size
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
