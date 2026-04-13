const axios    = require('axios');
const XLSX     = require('xlsx');
const admin    = require('firebase-admin');
const pdfParse = require('pdf-parse');

// ─── FIREBASE ────────────────────────────────────────────────────────────────
let db = null;
function getFirebase() {
    if (db) return db;
    try {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential:   admin.credential.cert(sa),
                databaseURL: `https://${sa.project_id}-default-rtdb.firebaseio.com`
            });
        }
        db = admin.database();
        return db;
    } catch (e) { console.error('[FB]', e.message); return null; }
}

// sanitize Firebase path
function sp(s) { return s.replace(/[@.\[\]#$\/]/g, '_'); }

// ─── PROMPTS & PDF LIST ───────────────────────────────────────────────────────
const DEFAULT_PROMPT = `Tu "Laxmi" hai — Shri Laxmi Auto Store, Bikaner (Castrol Distributor) ki official WhatsApp Sales Assistant.

GREETING: Hello/Hi/Namaste pe reply: "Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!"

STRICT RULES:
1. Sirf diye gaye data se EXACT values batao — kuch bhi invent mat karo
2. MRP query ke liye SIRF [MRP DATA] dekho
3. DLP/List Price query ke liye SIRF [DLP DATA] dekho
4. Size match: 0.9L = 900ml = 0.9 litre — sab ek hi hain
5. Agar size nahi mila toh bolo: "Yeh size available nahi data mein"
6. Bold ke liye *single asterisk* use karo
7. Hinglish mein jawab do, max 5 lines
8. Amount mein Rs. lagao

REPLY FORMAT:
*Product:* GTX SUV 5W-30
*Size:* 4.5L
*MRP:* Rs.XXX
*DLP:* Rs.XXX`;

async function getSystemPrompt() {
    const d = getFirebase();
    if (!d) return DEFAULT_PROMPT;
    try {
        const s = await d.ref('botConfig/systemPrompt').get();
        return s.exists() ? s.val() : DEFAULT_PROMPT;
    } catch (e) { return DEFAULT_PROMPT; }
}
async function saveSystemPrompt(p) {
    const d = getFirebase();
    if (d) try { await d.ref('botConfig/systemPrompt').set(p); } catch(e) {}
}
async function getPDFList() {
    const d = getFirebase();
    if (!d) return {};
    try { const s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e) { return {}; }
}
async function savePDFList(data) {
    const d = getFirebase();
    if (d) try { await d.ref('botConfig/pdfFiles').set(data); } catch(e) {}
}

// ─── DATE CLEANER ─────────────────────────────────────────────────────────────
function cleanDate(v) {
    if (!v) return 'N/A';
    if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400000));
        return d.toISOString().split('T')[0];
    }
    return String(v).replace(/\//g, '-').slice(0, 10);
}

// ─── REPLY SANITIZER ─────────────────────────────────────────────────────────
function sanitizeReply(t) {
    if (!t) return '';
    return t
        .replace(/\*\*/g, '*')           // double asterisk → single
        .replace(/\n{3,}/g, '\n\n')      // max 2 newlines
        .split('\n').map(l => l.trim()).join('\n')
        .trim();
}

// ─── PDF CSV LINE PARSER ──────────────────────────────────────────────────────
// Handles quoted fields with commas inside them
function parseCSVLine(line) {
    const cols = [];
    let inQ = false, cur = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += c; }
    }
    cols.push(cur.trim());
    return cols.map(c => c.replace(/^"|"$/g, '').trim());
}

// ─── SIZE HEADER NORMALIZER ───────────────────────────────────────────────────
// PDF mein size headers garbled hote hain — fix karo
function normalizeHeader(h) {
    return h
        .replace(/\s+/g, ' ')
        .replace(/^11$/, '1L')
        .replace(/^51$/, '5L')
        .replace(/^71$/, '7L')
        .replace(/^31$/, '3L')
        .replace(/^41$/, '4L')
        .replace(/^0\.91$/, '0.9L')
        .replace(/^2\.51$/, '2.5L')
        .replace(/^3\.51$/, '3.5L')
        .replace(/^4\.51$/, '4.5L')
        .replace(/^201$/, '20L')
        .replace(/^101$/, '10L')
        .replace(/1\.2\/\s*11/, '1.2L/1L')
        .replace(/(\d+)l$/i, '$1L')
        .replace(/\/$/, 'L')
        .trim();
}

// ─── KEY: PDF SMART PARSER ────────────────────────────────────────────────────
// Raw PDF text → clean key-value product chunks
// FIX: Dono MRP aur DLP files ka format ALAG hai — handle kiya
function parsePDFToProductMap(rawText, type) {
    if (!rawText) return {};
    const productMap = {};
    const lines      = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    let headers = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Header row detect karo — "Brand Name" wali line
        if (line.toLowerCase().includes('brand name') || line.toLowerCase().includes('product name')) {
            headers = parseCSVLine(line).map(normalizeHeader);
            continue;
        }

        if (headers.length === 0) continue;

        const cols = parseCSVLine(line);
        if (cols.length < 2) continue;

        const productName = cols[0].replace(/"/g, '').trim();

        // Skip header-like rows aur short rows
        if (
            productName.length < 4 ||
            productName.toLowerCase().includes('passenger car') ||
            productName.toLowerCase().includes('diesel engine') ||
            productName.toLowerCase().includes('motorcycle') ||
            productName.toLowerCase().includes('commercial') ||
            productName.toLowerCase().includes('product') ||
            /^[\d\s.]+$/.test(productName)  // sirf numbers
        ) continue;

        // Product ke liye size → price map banao
        const sizeMap = {};
        for (let c = 1; c < cols.length && c < headers.length; c++) {
            const price  = cols[c].replace(/[^\d.]/g, '').trim();
            const header = headers[c];
            if (price && parseFloat(price) > 0 && header) {
                sizeMap[header] = `Rs.${parseFloat(price).toFixed(2)}`;
            }
        }

        if (Object.keys(sizeMap).length === 0) continue;

        // Clean product name as key
        const key = productName.toLowerCase();
        if (!productMap[key]) {
            productMap[key] = { name: productName, sizes: {} };
        }
        // Sizes merge karo (multi-line products ke liye)
        Object.assign(productMap[key].sizes, sizeMap);
    }

    console.log(`[PDF-PARSE] ${type}: ${Object.keys(productMap).length} products parsed`);
    return productMap;
}

// ─── FORMAT PRODUCT CHUNK FOR AI ─────────────────────────────────────────────
function formatProductChunk(product, type) {
    if (!product || !product.sizes) return '';
    let lines = [`Product: ${product.name}`];
    for (const [size, price] of Object.entries(product.sizes)) {
        lines.push(`- Size [${size}] : ${price}`);
    }
    return lines.join('\n');
}

// ─── TOKENIZED FUZZY SEARCH ───────────────────────────────────────────────────
// FIX: Normalize both query aur product name before matching
const STOP_WORDS = new Set(['price','rate','mrp','dlp','kya','hai','batao','aur','ka','ke','liye','ye','pucha','mujhe','bata','de','do']);

function tokenize(str) {
    return str.toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function searchProducts(query, mrpMap, dlpMap) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    const allNames = new Set([...Object.keys(mrpMap), ...Object.keys(dlpMap)]);
    const results  = [];

    for (const key of allNames) {
        const nameTokens = tokenize(key);
        const matches    = tokens.filter(t => nameTokens.some(n => n.includes(t) || t.includes(n)));
        const required   = Math.max(1, Math.min(2, tokens.length - 1));

        if (matches.length >= required) {
            results.push({
                key,
                name:     (mrpMap[key] || dlpMap[key]).name,
                score:    matches.length,
                mrpChunk: mrpMap[key] ? formatProductChunk(mrpMap[key], 'MRP') : '',
                dlpChunk: dlpMap[key] ? formatProductChunk(dlpMap[key], 'DLP') : '',
            });
        }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ─── INVOICE SEARCH ───────────────────────────────────────────────────────────
function searchInvoices(query, invoiceMap) {
    const q = query.toLowerCase().replace(/[^a-z0-9\/ -]/g, '').trim();
    if (q.length < 3) return [];

    const tokens  = tokenize(q);
    const matches = [];

    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const custName = (rows[0]['Customer Name'] || '').toLowerCase();
        const invNorm  = invNo.replace(/[^a-z0-9]/g, '').toLowerCase();
        const qNorm    = q.replace(/[^a-z0-9]/g, '');

        const invMatch  = invNorm.includes(qNorm) || qNorm.includes(invNorm.slice(-5));
        const custScore = tokens.filter(t => custName.includes(t)).length;

        if (invMatch || custScore > 0) {
            matches.push({ invNo, rows, customer: rows[0]['Customer Name'], score: invMatch ? 10 : custScore });
        }
    }

    return matches.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ─── FORMAT INVOICE REPLY ────────────────────────────────────────────────────
function formatInvoiceReply(m) {
    const f      = m.rows[0];
    const prods  = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join('\n  + ');
    const tGST   = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
    const woGST  = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST'])  || 0), 0);
    const cgst   = m.rows.reduce((s, r) => s + (parseFloat(r['CGST Value'])               || 0), 0);
    const sgst   = m.rows.reduce((s, r) => s + (parseFloat(r['SGST Value'])               || 0), 0);

    return [
        `*Invoice:* ${m.invNo}`,
        `*Customer:* ${f['Customer Name']}`,
        `*Location:* ${f['Town Name']}, ${f['District Name']}`,
        `*Products:*\n  + ${prods}`,
        `*Total (with GST):* Rs.${tGST.toFixed(2)}`,
        `*Without GST:* Rs.${woGST.toFixed(2)}`,
        `*Tax:* CGST Rs.${cgst.toFixed(2)} + SGST Rs.${sgst.toFixed(2)}`,
        `*Date:* ${cleanDate(f['Invoice Date'])} | *Payment:* ${f['Mode Of Payement']}`,
    ].join('\n');
}

// ─── PDF EXTRACT ──────────────────────────────────────────────────────────────
async function extractPDFText(url) {
    try {
        const res  = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        const data = await pdfParse(Buffer.from(res.data));
        return data.text || '';
    } catch (e) { console.error('[PDF-EXTRACT]', e.message); return ''; }
}

// ─── CACHE (1 hour) ───────────────────────────────────────────────────────────
let _cache = null, _cacheTime = 0;

async function loadAllData() {
    if (_cache && Date.now() - _cacheTime < 3600000) return _cache;

    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return null;

    let fileList = [];
    try {
        fileList = (await axios.get(`${base}/index.json`)).data;
        console.log('[DATA] Files:', fileList);
    } catch (e) { console.error('[DATA] index.json error:', e.message); return null; }

    const excelFiles = fileList.filter(f => f.match(/\.(xlsx|xls|csv)$/i));

    // FIX: Exact file names use karo jo user ne bataye
    // "Catrol MRP Price Page..." aur "Catrol List Price Page..."
    const mrpFile  = fileList.find(f => f.toLowerCase().includes('mrp'));
    const listFile = fileList.find(f => f.toLowerCase().includes('list') && !f.toLowerCase().includes('mrp'));

    const mrpPdfUrl  = mrpFile  ? `${base}/${encodeURIComponent(mrpFile)}`  : '';
    const listPdfUrl = listFile ? `${base}/${encodeURIComponent(listFile)}` : '';

    console.log('[DATA] MRP PDF :', mrpFile);
    console.log('[DATA] List PDF:', listFile);

    // Excel load
    let allRows = [];
    for (const f of excelFiles) {
        try {
            const res = await axios.get(`${base}/${encodeURIComponent(f)}`, { responseType: 'arraybuffer' });
            const wb  = XLSX.read(res.data, { type: 'buffer' });
            for (const s of wb.SheetNames) {
                allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[s], { defval: '' }));
            }
            console.log(`[EXCEL] Loaded ${f}: ${allRows.length} rows`);
        } catch (e) { console.log(`[EXCEL] Skip ${f}:`, e.message); }
    }

    // Invoice map
    const invoiceMap = {};
    for (const row of allRows) {
        const inv = row['Invoice No'] || '';
        if (!inv) continue;
        if (!invoiceMap[inv]) invoiceMap[inv] = [];
        invoiceMap[inv].push(row);
    }
    console.log(`[EXCEL] ${Object.keys(invoiceMap).length} unique invoices`);

    // PDF parse — KEY FIX: parsePDFToProductMap use karo raw text ki jagah
    const [mrpRaw, listRaw] = await Promise.all([
        mrpPdfUrl  ? extractPDFText(mrpPdfUrl)  : Promise.resolve(''),
        listPdfUrl ? extractPDFText(listPdfUrl) : Promise.resolve(''),
    ]);

    const mrpMap  = parsePDFToProductMap(mrpRaw,  'MRP');
    const dlpMap  = parsePDFToProductMap(listRaw, 'DLP');

    console.log(`[PDF] MRP products: ${Object.keys(mrpMap).length}, DLP products: ${Object.keys(dlpMap).length}`);

    _cache = { invoiceMap, mrpMap, dlpMap, mrpPdfUrl, listPdfUrl, mrpFile, listFile };
    _cacheTime = Date.now();
    return _cache;
}

// ─── AI REPLY ─────────────────────────────────────────────────────────────────
async function getAIReply(userMsg, contextData, sysPrompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'NVIDIA_API_KEY missing.';
    try {
        const res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model:    'meta/llama-3.1-70b-instruct',
            messages: [
                { role: 'system', content: `${sysPrompt}\n\nNote: 0.9L = 900ml = 0.9 litre — sab ek hi hain.\nMatch size EXACTLY from data below.\n\nCONTEXT:\n${contextData}` },
                { role: 'user',   content: userMsg }
            ],
            max_tokens: 500, temperature: 0.1, top_p: 0.95, stream: false
        }, {
            headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 25000
        });
        return sanitizeReply(res.data?.choices?.[0]?.message?.content) || 'Empty response.';
    } catch (e) {
        if (e.response) return `AI Error ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 100)}`;
        return `System Error: ${e.message}`;
    }
}

// ─── SEND TEXT / DOCUMENT ────────────────────────────────────────────────────
async function sendText(to, text) {
    const base = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const inst = process.env.EVOLUTION_INSTANCE;
    const key  = process.env.EVOLUTION_API_KEY;
    const num  = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!base || !inst || !key) return;
    try {
        await axios.post(`${base}/message/sendText/${inst}`, { number: num, text }, { headers: { 'Content-Type': 'application/json', 'apikey': key } });
    } catch (e) { console.error('[SEND]', e.message); }
}

async function sendDocument(to, url, fileName, caption = '') {
    const base = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const inst = process.env.EVOLUTION_INSTANCE;
    const key  = process.env.EVOLUTION_API_KEY;
    const num  = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!base || !inst || !key) return;
    try {
        await axios.post(`${base}/message/sendMedia/${inst}`,
            { number: num, mediatype: 'document', mimetype: 'application/pdf', media: url, fileName, caption },
            { headers: { 'Content-Type': 'application/json', 'apikey': key } }
        );
        console.log('[PDF] Sent:', fileName);
    } catch (e) { console.error('[PDF]', e.message); }
}

// ─── PENDING STATE (Firebase + Memory fallback) ───────────────────────────────
const _mem = {};

async function savePending(from, data) {
    _mem[from] = { ...data, ts: Date.now() };
    const d = getFirebase();
    if (d) try { await d.ref(`pending/${sp(from)}`).set(_mem[from]); } catch(e) {}
}

async function getPending(from) {
    if (_mem[from]) return _mem[from];
    const d = getFirebase();
    if (d) try { const s = await d.ref(`pending/${sp(from)}`).get(); if (s.exists()) return s.val(); } catch(e) {}
    return null;
}

async function clearPending(from) {
    delete _mem[from];
    const d = getFirebase();
    if (d) try { await d.ref(`pending/${sp(from)}`).remove(); } catch(e) {}
}

// ─── MAIN WEBHOOK ─────────────────────────────────────────────────────────────
module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data?.key?.fromMe)           return res.status(200).send('Skip');

        const from  = body.data.key.remoteJid;
        const text  = (body.data.message?.conversation || body.data.message?.extendedTextMessage?.text || '').trim();
        if (!text || !from) return res.status(200).send('Empty');

        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin  = from.includes(adminNum);

        // Load all data + prompt in parallel
        const [sysPrompt, data, savedPDFs] = await Promise.all([
            getSystemPrompt(),
            loadAllData(),
            getPDFList(),
        ]);

        if (!data) {
            await sendText(from, 'Data load nahi hua. Thodi der baad try karein.');
            return res.status(200).json({ status: 'ok' });
        }

        const { invoiceMap, mrpMap, dlpMap, mrpPdfUrl, listPdfUrl, mrpFile, listFile } = data;

        // ── ADMIN COMMANDS ────────────────────────────────────────────────────
        if (isAdmin) {
            if (text.startsWith('!setprompt '))  { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
            if (text === '!status')               { await sendText(from, `*Bot Status*\nOnline\nMRP Products: ${Object.keys(mrpMap).length}\nDLP Products: ${Object.keys(dlpMap).length}\nInvoices: ${Object.keys(invoiceMap).length}`); return res.status(200).json({ status: 'ok' }); }
            if (text === '!clearcache')           { _cache = null; await sendText(from, 'Cache cleared! Next request pe fresh data load hoga.'); return res.status(200).json({ status: 'ok' }); }
            if (text.startsWith('!addpdf '))      {
                const p = text.slice(8).split('|').map(s => s.trim());
                if (p.length === 3) { const l = await getPDFList(); l[p[0].toLowerCase()] = { name: p[1], url: p[2] }; await savePDFList(l); await sendText(from, `PDF added!\nName: ${p[1]}\nKeyword: ${p[0]}`); }
                else await sendText(from, 'Format: !addpdf keyword | Name | URL');
                return res.status(200).json({ status: 'ok' });
            }
            if (text === '!listpdf')              {
                const l = await getPDFList();
                if (!Object.keys(l).length) await sendText(from, 'Koi saved PDF nahi.');
                else await sendText(from, Object.entries(l).map(([k,v]) => `${v.name}\nKeyword: ${k}`).join('\n\n'));
                return res.status(200).json({ status: 'ok' });
            }
            if (text.startsWith('!removepdf '))   {
                const kw = text.slice(11).trim().toLowerCase(); const l = await getPDFList();
                if (l[kw]) { delete l[kw]; await savePDFList(l); await sendText(from, `Removed: ${kw}`); }
                else await sendText(from, `Not found: ${kw}`);
                return res.status(200).json({ status: 'ok' });
            }
            if (text === '!help')                 {
                await sendText(from, `*Admin Commands:*\n\n!status — Bot check\n!setprompt [text] — Prompt\n!clearcache — Data refresh\n!addpdf k|Name|URL\n!listpdf\n!removepdf k`);
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── PENDING SELECTION (user typed a number) ───────────────────────────
        if (/^\d+$/.test(text.trim())) {
            const pending = await getPending(from);
            if (pending) {
                const idx = parseInt(text.trim()) - 1;
                if (pending.matches && pending.matches[idx]) {
                    if (pending.type === 'invoice') {
                        await sendText(from, formatInvoiceReply(pending.matches[idx]));
                    } else if (pending.type === 'product') {
                        const p   = pending.matches[idx];
                        const ctx = `[MRP DATA]\n${p.mrpChunk}\n\n[DLP DATA]\n${p.dlpChunk}`;
                        // KEY FIX: originalQuery recall — user ne pehle kya poocha tha
                        const prompt = `User ka ORIGINAL sawal tha: "${pending.originalQuery}"\nUser ne select kiya: ${p.name}\nIsi product ka EXACT size ke liye MRP aur DLP batao jo original query mein tha.\nNote: 0.9L = 900ml`;
                        const reply  = await getAIReply(prompt, ctx, sysPrompt);
                        await sendText(from, reply);
                    }
                    await clearPending(from);
                } else {
                    await sendText(from, `Galat number. 1 se ${(pending.matches || []).length} ke beech chunein.`);
                }
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── GREETING ──────────────────────────────────────────────────────────
        const lower = text.toLowerCase();
        const greetings = ['hi', 'hello', 'namaste', 'hey', 'hii', 'helo', 'good morning', 'good evening', 'kaise ho', 'namaskar'];
        if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) {
            await sendText(from, 'Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
            return res.status(200).json({ status: 'ok' });
        }

        // ── SEND PDF REQUESTS ────────────────────────────────────────────────
        const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'pdf', 'list bhejo', 'list do'];
        const hasSend   = sendWords.some(w => lower.includes(w));
        const hasMRP    = ['mrp', 'maximum retail', 'mrp list', 'mrp pdf'].some(w => lower.includes(w));
        const hasDLP    = ['list price', 'dlp', 'dealer price', 'price list', 'list pdf'].some(w => lower.includes(w));

        if (hasSend && hasMRP && mrpPdfUrl) {
            await sendText(from, `Sending MRP list...`);
            await sendDocument(from, mrpPdfUrl, mrpFile, mrpFile);
            return res.status(200).json({ status: 'ok' });
        }
        if (hasSend && hasDLP && listPdfUrl) {
            await sendText(from, `Sending List Price...`);
            await sendDocument(from, listPdfUrl, listFile, listFile);
            return res.status(200).json({ status: 'ok' });
        }
        // Saved PDFs
        for (const [k, v] of Object.entries(savedPDFs)) {
            if (lower.includes(k) && hasSend) {
                await sendDocument(from, v.url, v.name, v.name);
                return res.status(200).json({ status: 'ok' });
            }
        }

        // ── PRODUCT RATE QUERY (MRP/DLP) ─────────────────────────────────────
        const rateWords = ['rate', 'price', 'mrp', 'dlp', 'kitna', 'kitne', 'dam', 'batao', 'kya hai', 'cost', 'value'];
        const isRateQ   = rateWords.some(w => lower.includes(w));
        const prodMatches = searchProducts(text, mrpMap, dlpMap);

        if (isRateQ || (prodMatches.length > 0 && searchInvoices(text, invoiceMap).length === 0)) {
            if (prodMatches.length === 0) {
                await sendText(from, 'Product list mein nahi mila. Spelling check karke dobara try karein.\nExample: "GTX SUV MRP" ya "Activ 4T rate"');
                return res.status(200).json({ status: 'ok' });
            }
            if (prodMatches.length === 1) {
                const p   = prodMatches[0];
                const ctx = `[MRP DATA]\n${p.mrpChunk || 'MRP data available nahi'}\n\n[DLP DATA]\n${p.dlpChunk || 'DLP data available nahi'}`;
                const reply = await getAIReply(`User Query: "${text}"\nGive exact MRP and DLP for the size mentioned. Note: 0.9L = 900ml`, ctx, sysPrompt);
                await sendText(from, reply);
                return res.status(200).json({ status: 'ok' });
            }
            // Multiple matches — user se select karwao
            let msg = '*Kaunsa product? Number reply karein:*\n\n';
            prodMatches.forEach((p, i) => { msg += `${i+1}. ${p.name}\n`; });
            await savePending(from, { type: 'product', matches: prodMatches, originalQuery: text });
            await sendText(from, msg);
            return res.status(200).json({ status: 'ok' });
        }

        // ── INVOICE SEARCH ────────────────────────────────────────────────────
        const invMatches = searchInvoices(text, invoiceMap);

        if (invMatches.length === 1) {
            await sendText(from, formatInvoiceReply(invMatches[0]));
            return res.status(200).json({ status: 'ok' });
        }
        if (invMatches.length > 1) {
            let msg = '*Multiple invoices. Number reply karein:*\n\n';
            invMatches.forEach((m, i) => { msg += `${i+1}. ${m.customer} — ${m.invNo}\n`; });
            await savePending(from, { type: 'invoice', matches: invMatches });
            await sendText(from, msg);
            return res.status(200).json({ status: 'ok' });
        }

        // ── FALLBACK ──────────────────────────────────────────────────────────
        await sendText(from, 'Main invoice details aur product MRP/DLP batane ke liye bani hoon.\n\nExamples:\n- "INV/26-27/00049"\n- "KARNI MOTORS ka invoice"\n- "GTX SUV ka MRP"\n- "Activ 4T 0.9L rate"');
        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};
