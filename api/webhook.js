const axios = require('axios');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// ─────────────────────────────────────────────────────────────────────────────
// 🔐 FIREBASE INIT
// ─────────────────────────────────────────────────────────────────────────────
let db;
function getFirebase() {
    if (db) return db;
    try {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(sa),
                databaseURL: `https://${sa.project_id}-default-rtdb.firebaseio.com`,
            });
        }
        db = admin.database();
        return db;
    } catch (e) { 
        console.error('[FB] Init Error:', e.message); 
        return null; 
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🤖 SYSTEM PROMPT (Firebase Configurable)
// ─────────────────────────────────────────────────────────────────────────────
async function getSystemPrompt() {
    const database = getFirebase();
    const defaultPrompt = `Tu "Laxmi" hai — Shri Laxmi Auto Store, Bikaner (Castrol Distributor) ki official WhatsApp Sales Assistant.

GREETING: Jab koi Hello/Hi kare reply karo: "Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!"

AVAILABLE DATA:
1. INVOICE DATA — pipe-separated format mein saare invoices
   Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment

2. MRP DATA — Castrol MRP Price list se extract kiya gaya
   Format: Product Name | Pack Size | MRP

3. LIST PRICE DATA — Castrol List Price (DLP) se extract kiya gaya
   Format: Product Name | Pack Size | List Price/DLP

SEARCH RULES:
1. INVOICE: "00049" ya "INV/26-27/00049" → exact/partial match karo
2. CUSTOMER: Partial name — "KARNI" se "JAI SHREE KARNI MOTORS, LKS" milega
3. MRP query: MRP DATA mein product dhundo, exact rate batao
4. DLP/List Price query: LIST PRICE DATA mein dhundo
5. Rate/price query: Dono data mein dhundo, sirf TEXT reply do — PDF mat bhejo

REPLY FORMAT (WhatsApp bold ke liye *single asterisk*):
Invoice reply:
*Invoice:* INV/26-27/00049
*Customer:* JAI SHREE KARNI MOTORS, LKS
*Products:* GTX SUV 5W-30 (9L)
*Total (with GST):* Rs.3,474
*Tax:* CGST Rs.265 + SGST Rs.265
*Date:* 06-Apr-2026 | Cash

MRP/Rate reply:
*Product:* GTX SUV 5W-30 4.5L
*MRP:* Rs.XXX per pack
*List Price (DLP):* Rs.XXX
*(Agar DLP available ho)*

STRICT RULES:
- Sirf data se jawab do — kuch bhi invent mat karo
- Amounts mein Rs. lagao
- Data na mile: "Nahi mila. Product naam check karke dobara try karein."
- Hinglish mein, max 6 lines
- ❌, ✅, ✨ jaise emojis mat use karo — sirf plain text + *bold*`;

    if (!database) return defaultPrompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        return snap.exists() ? snap.val() : defaultPrompt;
    } catch (e) { 
        console.error('[PROMPT] Error:', e.message);
        return defaultPrompt; 
    }
}

async function saveSystemPrompt(p) {
    const database = getFirebase();
    if (database) try { 
        await database.ref('botConfig/systemPrompt').set(p); 
    } catch(e) { console.error('[PROMPT SAVE] Error:', e.message); }
}

async function getPDFList() {
    const database = getFirebase();
    if (!database) return {};
    try {
        const snap = await database.ref('botConfig/pdfFiles').get();
        return snap.exists() ? snap.val() : {};
    } catch (e) { return {}; }
}

async function savePDFList(data) {
    const database = getFirebase();
    if (database) try { 
        await database.ref('botConfig/pdfFiles').set(data); 
    } catch(e) { console.error('[PDF SAVE] Error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🧹 SANITIZE AI REPLY (Remove crosses, fix formatting)
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeReply(text) {
    if (!text) return '';
    return text
        // Remove unwanted emojis/symbols
        .replace(/[❌✅✨🔍📄📋]/g, '')
        // Fix double asterisks to single for WhatsApp
        .replace(/\*\*/g, '*')
        // Remove extra newlines
        .replace(/\n{3,}/g, '\n\n')
        // Trim each line
        .split('\n').map(l => l.trim()).join('\n')
        .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔍 DIRECT INVOICE LOOKUP (Before AI - fixes "only specific invoices" issue)
// ─────────────────────────────────────────────────────────────────────────────
function findInvoiceDirectly(query, invoiceMap) {
    const q = query.replace(/[^a-zA-Z0-9\/\-]/g, '').toLowerCase();
    
    // Try exact match first
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        if (invNo.toLowerCase().includes(q) || q.includes(invNo.toLowerCase())) {
            const first = rows[0];
            const products = rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
            const totalGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
            const woGST    = rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST'])  || 0), 0);
            const cgst     = rows.reduce((s, r) => s + (parseFloat(r['CGST Value'])               || 0), 0);
            const sgst     = rows.reduce((s, r) => s + (parseFloat(r['SGST Value'])               || 0), 0);
            const vol      = rows.reduce((s, r) => s + (parseFloat(r['Product Volume'])           || 0), 0);
            const date     = String(first['Invoice Date'] || '').slice(0, 10);
            
            return `*Invoice:* ${invNo}
*Customer:* ${first['Customer Name']}
*Products:* ${products}
*Total (with GST):* Rs.${totalGST.toFixed(2)}
*Without GST:* Rs.${woGST.toFixed(2)}
*Tax:* CGST Rs.${cgst.toFixed(2)} + SGST Rs.${sgst.toFixed(2)}
*Volume:* ${vol.toFixed(1)}L
*Date:* ${date}
*Payment:* ${first['Mode Of Payement']}`;
        }
    }
    
    // Try customer name partial match
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const customer = (rows[0]['Customer Name'] || '').toLowerCase();
        if (customer.includes(q) || q.split(' ').some(w => customer.includes(w) && w.length > 3)) {
            const first = rows[0];
            return `*Invoice Found:* ${invNo}
*Customer:* ${first['Customer Name']}
*Total:* Rs.${rows.reduce((s,r)=>s+(parseFloat(r['Total Value incl VAT/GST'])||0),0).toFixed(2)}
*Date:* ${String(first['Invoice Date']||'').slice(0,10)}`;
        }
    }
    
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 📄 PDF TEXT EXTRACT
// ─────────────────────────────────────────────────────────────────────────────
async function extractPDFText(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 20000
        });
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(Buffer.from(response.data));
        return data.text || '';
    } catch (e) {
        console.error('[PDF-EXTRACT] Error:', e.message);
        return '';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📦 LOAD ALL DATA (Excel + PDF text)
// ─────────────────────────────────────────────────────────────────────────────
async function loadAllData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return { excelData: 'Data URL missing.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };

    let fileList = [];
    try {
        const rList = await axios.get(`${base}/index.json`);
        fileList = rList.data;
        console.log('[DATA] Files:', fileList);
    } catch (e) {
        return { excelData: 'index.json error.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };
    }

    const excelFiles = fileList.filter(f => f.match(/\.(xlsx|xls|csv)$/i));
    const mrpFile   = fileList.find(f => f.toLowerCase().includes('mrp'));
    const listFile  = fileList.find(f => f.toLowerCase().includes('list price') || (f.toLowerCase().includes('list') && !f.toLowerCase().includes('mrp')));

    const mrpPdfUrl  = mrpFile  ? `${base}/${encodeURIComponent(mrpFile)}`  : '';
    const listPdfUrl = listFile ? `${base}/${encodeURIComponent(listFile)}` : '';

    // Load Excel files
    let allRows = [];
    for (const f of excelFiles) {
        try {
            const rFile = await axios.get(`${base}/${encodeURIComponent(f)}`, { responseType: 'arraybuffer' });
            const wb    = XLSX.read(rFile.data, { type: 'buffer' });
            for (const s of wb.SheetNames) {
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[s], { defval: '' });
                allRows = allRows.concat(rows);
            }
            console.log(`[EXCEL] Loaded: ${f} (${allRows.length} rows)`);
        } catch (err) { console.log(`[EXCEL] Skip: ${f}`); }
    }

    // Build invoice map for direct lookup
    const invoiceMap = {};
    for (const row of allRows) {
        const inv = row['Invoice No'] || '';
        if (!inv) continue;
        if (!invoiceMap[inv]) invoiceMap[inv] = [];
        invoiceMap[inv].push(row);
    }

    // Compress invoice data for AI context
    const lines = [
        'INVOICE DATABASE:',
        'Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment',
        ''
    ];

    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const first    = rows[0];
        const products = rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
        const totalGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
        const woGST    = rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST'])  || 0), 0);
        const cgst     = rows.reduce((s, r) => s + (parseFloat(r['CGST Value'])               || 0), 0);
        const sgst     = rows.reduce((s, r) => s + (parseFloat(r['SGST Value'])               || 0), 0);
        const vol      = rows.reduce((s, r) => s + (parseFloat(r['Product Volume'])           || 0), 0);
        const date     = String(first['Invoice Date'] || '').slice(0, 10);
        lines.push(`${invNo}|${date}|${first['Customer Name']}|${first['Town Name']}|${first['District Name']}|${first['Sales Executive Name']}|${products}|${vol.toFixed(1)}L|Rs.${totalGST.toFixed(2)}|Rs.${woGST.toFixed(2)}|Rs.${cgst.toFixed(2)}|Rs.${sgst.toFixed(2)}|${first['Mode Of Payement']}`);
    }

    // Extract PDF text (limited to 6000 chars for context window)
    let mrpText = '', listText = '';
    if (mrpPdfUrl) {
        const raw = await extractPDFText(mrpPdfUrl);
        mrpText = raw.slice(0, 6000);
        console.log(`[PDF] MRP text: ${mrpText.length} chars`);
    }
    if (listPdfUrl) {
        const raw = await extractPDFText(listPdfUrl);
        listText = raw.slice(0, 6000);
        console.log(`[PDF] List text: ${listText.length} chars`);
    }

    const excelData = [
        lines.join('\n'),
        mrpText  ? `\n\nMRP PRICE DATA (from ${mrpFile}):\n${mrpText}`   : '',
        listText ? `\n\nLIST PRICE/DLP DATA (from ${listFile}):\n${listText}` : '',
    ].join('');

    console.log(`[DATA] Total context: ${excelData.length} chars`);
    return { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI REPLY GENERATION
// ─────────────────────────────────────────────────────────────────────────────
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'NVIDIA_API_KEY missing in Vercel variables.';
    
    try {
        const response = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model: 'meta/llama-3.1-70b-instruct',
            messages: [
                { role: 'system', content: `${prompt}\n\n${data}` },
                { role: 'user', content: userMsg }
            ],
            max_tokens: 600,
            temperature: 0.1,
            top_p: 0.95,
            stream: false
        }, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            timeout: 25000
        });
        const raw = response.data?.choices?.[0]?.message?.content?.trim();
        return sanitizeReply(raw) || 'Kuch error aaya. Dobara try karein.';
    } catch (e) {
        console.error('[AI] Error:', e.message);
        if (e.response) return `AI Error ${e.response.status}: ${e.response.data?.error?.message || ''}`;
        return `System Error: ${e.message}`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📤 SEND TEXT MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    const number   = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    
    if (!baseUrl || !instance || !apiKey) {
        console.error('[SEND] Missing Evolution API config');
        return;
    }
    
    try {
        await axios.post(`${baseUrl}/message/sendText/${instance}`,
            { number, text },
            { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }
        );
        console.log('[SEND] Text sent to:', number);
    } catch (e) { 
        console.error('[SEND] Error:', e.message); 
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 📎 SEND PDF DOCUMENT
// ─────────────────────────────────────────────────────────────────────────────
async function sendDocument(to, fileUrl, fileName, caption = '') {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    const number   = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    
    if (!baseUrl || !instance || !apiKey) {
        console.error('[PDF] Missing Evolution API config');
        return;
    }
    
    try {
        await axios.post(`${baseUrl}/message/sendMedia/${instance}`,
            { number, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName, caption },
            { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }
        );
        console.log('[PDF] Sent:', fileName);
    } catch (e) { 
        console.error('[PDF] Error:', e.message); 
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎯 INTENT DETECTION (FIXED: PDF only on explicit request)
// ─────────────────────────────────────────────────────────────────────────────
function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
    const lower = text.toLowerCase().trim();

    // 🔹 Saved PDFs from Firebase (admin added)
    for (const [k, v] of Object.entries(savedPDFs)) {
        if (lower.includes(k.toLowerCase())) {
            // Only send if user explicitly asks to send/share
            if (['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'pdf'].some(w => lower.includes(w))) {
                return { type: 'pdf', pdf: v };
            }
        }
    }

    // 🔹 Explicit PDF send requests (must contain BOTH send-word + pdf-word)
    const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'send me', 'bhej do'];
    const mrpWords  = ['mrp', 'maximum retail', 'retail price', 'mrp list', 'mrp pdf', 'mrp document'];
    const listWords = ['list price', 'dlp', 'dealer price', 'price list', 'list pdf', 'catalogue', 'list document'];

    const hasSend = sendWords.some(w => lower.includes(w));
    const hasMRP  = mrpWords.some(w => lower.includes(w));
    const hasList = listWords.some(w => lower.includes(w));

    // ✅ ONLY send PDF if user explicitly says "send/bhejo" + "mrp/pdf/list"
    if (hasSend && hasMRP && mrpPdfUrl) {
        return { type: 'pdf', pdf: { url: mrpPdfUrl, name: mrpFile || 'MRP_List.pdf' } };
    }
    if (hasSend && hasList && listPdfUrl) {
        return { type: 'pdf', pdf: { url: listPdfUrl, name: listFile || 'List_Price.pdf' } };
    }

    // 🔹 Rate/price queries → AI se text reply (NO PDF)
    const rateWords = ['rate', 'kya hai', 'kitna', 'price', 'mrp', 'dlp', 'kitne ka', 'cost', 'value', 'dam'];
    const hasRateQuery = rateWords.some(w => lower.includes(w));
    
    // Exclude if user also said "send pdf"
    if (hasRateQuery && !hasSend) {
        return { type: 'ai_rate' };
    }

    // 🔹 Default → AI general reply
    return { type: 'ai' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎣 MAIN WEBHOOK HANDLER
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data?.key?.fromMe) return res.status(200).send('Skip');

        const from = body.data.key.remoteJid;
        const text = (
            body.data.message?.conversation ||
            body.data.message?.extendedTextMessage?.text || ''
        ).trim();

        if (!text || !from) return res.status(200).send('Empty');

        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin  = from.includes(adminNum);

        // ─── ADMIN COMMANDS ────────────────────────────────────────────────
        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, '✅ Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!status') {
            await sendText(from, '*Bot Status*\nOnline\nNVIDIA Llama 3.1 70B\nEvolution API Active');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name, url };
                await savePDFList(list);
                await sendText(from, `✅ PDF added!\n*Name:* ${name}\n*Keyword:* ${keyword}`);
            } else {
                await sendText(from, '❌ Format: !addpdf keyword | Name | URL');
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') {
            const list = await getPDFList();
            if (!Object.keys(list).length) {
                await sendText(from, 'Koi PDF nahi. !addpdf se add karo.');
            } else {
                const txt = Object.entries(list).map(([k,v]) => `*${v.name}*\nKeyword: ${k}`).join('\n\n');
                await sendText(from, `*Available PDFs:*\n\n${txt}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) { 
                delete list[kw]; 
                await savePDFList(list); 
                awai
