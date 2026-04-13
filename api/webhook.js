const axios = require('axios');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// â”€â”€â”€ FIREBASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    } catch (e) { console.error('[FB] Error:', e.message); return null; }
}

async function getSystemPrompt() {
    const database = getFirebase();
    const defaultPrompt = `Tu "Laxmi" hai â€” Shri Laxmi Auto Store, Bikaner (Castrol Distributor) ki official WhatsApp Sales Assistant.

GREETING: Jab koi Hello/Hi kare reply karo: "Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!"

AVAILABLE DATA:
1. INVOICE DATA â€” pipe-separated format mein saare invoices
   Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment

2. MRP DATA â€” Castrol MRP Price list se extract kiya gaya
   Format: Product Name | Pack Size | MRP

3. LIST PRICE DATA â€” Castrol List Price (DLP) se extract kiya gaya
   Format: Product Name | Pack Size | List Price/DLP

SEARCH RULES:
1. INVOICE: "00049" ya "INV/26-27/00049" â†’ exact/partial match karo
2. CUSTOMER: Partial name â€” "KARNI" se "JAI SHREE KARNI MOTORS, LKS" milega
3. MRP query: MRP DATA mein product dhundo, exact rate batao
4. DLP/List Price query: LIST PRICE DATA mein dhundo
5. Rate/price query: Dono data mein dhundo

REPLY FORMAT (bold ke liye *single asterisk*):
Invoice reply:
*Invoice: INV/26-27/00049*
*Customer:* JAI SHREE KARNI MOTORS, LKS
*Products:* GTX SUV 5W-30 (9L)
*Total (with GST):* Rs.3,474
*Tax:* CGST Rs.265 + SGST Rs.265
*Date:* 06-Apr-2026 | Cash

MRP/Rate reply:
*Product:* GTX SUV 5W-30 4.5L
*MRP:* Rs.XXX per litre / per pack
*List Price (DLP):* Rs.XXX

STRICT RULES:
- Sirf data se jawab do â€” kuch bhi invent mat karo
- Amounts mein Rs. lagao
- Data na mile: "Nahi mila. Product naam check karke dobara try karein."
- Hinglish mein, max 6 lines`;

    if (!database) return defaultPrompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        return snap.exists() ? snap.val() : defaultPrompt;
    } catch (e) { return defaultPrompt; }
}

async function saveSystemPrompt(p) {
    const database = getFirebase();
    if (database) try { await database.ref('botConfig/systemPrompt').set(p); } catch(e) {}
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
    if (database) try { await database.ref('botConfig/pdfFiles').set(data); } catch(e) {}
}

// â”€â”€â”€ PDF TEXT EXTRACT via pdf-parse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function extractPDFText(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 20000
        });
        const pdfParse = require('pdf-parse');
        const data     = await pdfParse(Buffer.from(response.data));
        return data.text || '';
    } catch (e) {
        console.error('[PDF-EXTRACT] Error:', e.message);
        return '';
    }
}

// â”€â”€â”€ LOAD ALL DATA (Excel + PDF text) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadAllData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return { excelData: 'Data URL missing.', mrpPdfUrl: '', listPdfUrl: '' };

    let fileList = [];
    try {
        const rList = await axios.get(`${base}/index.json`);
        fileList = rList.data;
        console.log('[DATA] Files:', fileList);
    } catch (e) {
        return { excelData: 'index.json error.', mrpPdfUrl: '', listPdfUrl: '' };
    }

    // File categories
    const excelFiles = fileList.filter(f => f.match(/\.(xlsx|xls|csv)$/i));

    // Exact file names se match karo
    const mrpFile   = fileList.find(f => f.toLowerCase().includes('mrp'));
    const listFile  = fileList.find(f => f.toLowerCase().includes('list price') || (f.toLowerCase().includes('list') && !f.toLowerCase().includes('mrp')));

    const mrpPdfUrl  = mrpFile  ? `${base}/${encodeURIComponent(mrpFile)}`  : '';
    const listPdfUrl = listFile ? `${base}/${encodeURIComponent(listFile)}` : '';

    console.log('[DATA] MRP PDF:', mrpFile);
    console.log('[DATA] List PDF:', listFile);

    // Excel load + compress
    let allRows = [];
    for (const f of excelFiles) {
        try {
            const rFile = await axios.get(`${base}/${encodeURIComponent(f)}`, { responseType: 'arraybuffer' });
            const wb    = XLSX.read(rFile.data, { type: 'buffer' });
            for (const s of wb.SheetNames) {
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[s], { defval: '' });
                allRows    = allRows.concat(rows);
            }
            console.log(`[EXCEL] Loaded: ${f} (${allRows.length} rows)`);
        } catch (err) { console.log(`[EXCEL] Skip: ${f}`); }
    }

    // Invoice compress
    const invoiceMap = {};
    for (const row of allRows) {
        const inv = row['Invoice No'] || '';
        if (!inv) continue;
        if (!invoiceMap[inv]) invoiceMap[inv] = [];
        invoiceMap[inv].push(row);
    }

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

    // PDF text extract
    let mrpText  = '';
    let listText = '';

    if (mrpPdfUrl) {
        console.log('[PDF] Extracting MRP text...');
        const raw = await extractPDFText(mrpPdfUrl);
        mrpText   = raw.slice(0, 6000); // Relevant portion
        console.log(`[PDF] MRP text: ${mrpText.length} chars`);
    }

    if (listPdfUrl) {
        console.log('[PDF] Extracting List Price text...');
        const raw = await extractPDFText(listPdfUrl);
        listText  = raw.slice(0, 6000);
        console.log(`[PDF] List text: ${listText.length} chars`);
    }

    const excelData = [
        lines.join('\n'),
        mrpText  ? `\n\nMRP PRICE DATA (from ${mrpFile}):\n${mrpText}`   : '',
        listText ? `\n\nLIST PRICE/DLP DATA (from ${listFile}):\n${listText}` : '',
    ].join('');

    console.log(`[DATA] Total context: ${excelData.length} chars`);
    return { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile };
}

// â”€â”€â”€ AI REPLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'NVIDIA_API_KEY missing in Vercel variables.';
    try {
        const response = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model:       'meta/llama-3.1-70b-instruct',
            messages: [
                { role: 'system', content: `${prompt}\n\n${data}` },
                { role: 'user',   content: userMsg }
            ],
            max_tokens:  600,
            temperature: 0.1,
            top_p:       0.95,
            stream:      false
        }, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Accept':        'application/json',
                'Content-Type':  'application/json'
            },
            timeout: 25000
        });
        return response.data?.choices?.[0]?.message?.content?.trim() || 'Empty response.';
    } catch (e) {
        if (e.response) return `AI Error ${e.response.status}`;
        return `System Error: ${e.message}`;
    }
}

// â”€â”€â”€ SEND TEXT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    const number   = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    try {
        await axios.post(`${baseUrl}/message/sendText/${instance}`,
            { number, text },
            { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }
        );
    } catch (e) { console.error('[SEND] Error:', e.message); }
}

// â”€â”€â”€ SEND PDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendDocument(to, fileUrl, fileName, caption = '') {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    const number   = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    try {
        await axios.post(`${baseUrl}/message/sendMedia/${instance}`,
            { number, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName, caption },
            { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } }
        );
        console.log('[PDF] Sent:', fileName);
    } catch (e) { console.error('[PDF] Error:', e.message); }
}

// â”€â”€â”€ DETECT WHAT USER WANTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
    const lower = text.toLowerCase();

    // Saved PDFs (Firebase) check
    for (const [k, v] of Object.entries(savedPDFs)) {
        if (lower.includes(k.toLowerCase())) return { type: 'pdf', pdf: v };
    }

    // "send/bhejo/share" + MRP â†’ send MRP PDF
    const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye'];
    const mrpWords  = ['mrp', 'maximum retail', 'retail price', 'mrp list', 'mrp pdf'];
    const listWords = ['list price', 'dlp', 'dealer price', 'price list', 'list pdf', 'catalogue'];

    const wantsSend = sendWords.some(w => lower.includes(w));
    const wantsMRP  = mrpWords.some(w => lower.includes(w));
    const wantsList = listWords.some(w => lower.includes(w));

    if (wantsMRP && mrpPdfUrl)  return { type: 'pdf', pdf: { url: mrpPdfUrl,  name: mrpFile  } };
    if (wantsList && listPdfUrl) return { type: 'pdf', pdf: { url: listPdfUrl, name: listFile } };

    // "rate/price kya hai" â†’ AI se nikalo (text already loaded hai)
    const rateWords = ['rate', 'kya hai', 'kitna', 'price', 'mrp', 'dlp', 'kitne ka'];
    if (rateWords.some(w => lower.includes(w))) return { type: 'ai_rate' };

    return { type: 'ai' };
}

// â”€â”€â”€ MAIN WEBHOOK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data?.key?.fromMe)           return res.status(200).send('Skip');

        const from = body.data.key.remoteJid;
        const text = (
            body.data.message?.conversation ||
            body.data.message?.extendedTextMessage?.text || ''
        ).trim();

        if (!text || !from) return res.status(200).send('Empty');

        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin  = from.includes(adminNum);

        // â”€â”€ ADMIN COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, 'Prompt update ho gaya!');
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
                await sendText(from, `PDF added!\nName: ${name}\nKeyword: ${keyword}`);
            } else {
                await sendText(from, 'Format: !addpdf keyword | Name | URL');
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') {
            const list = await getPDFList();
            if (!Object.keys(list).length) {
                await sendText(from, 'Koi PDF nahi. !addpdf se add karo.');
            } else {
                const txt = Object.entries(list).map(([k,v]) => `${v.name}\nKeyword: ${k}`).join('\n\n');
                await sendText(from, `Available PDFs:\n\n${txt}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) { delete list[kw]; await savePDFList(list); await sendText(from, `Removed: ${kw}`); }
            else await sendText(from, `Not found: ${kw}`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!help') {
            await sendText(from, `Admin Commands:\n\n!status\n!setprompt [text]\n!addpdf keyword | Name | URL\n!listpdf\n!removepdf keyword`);
            return res.status(200).json({ status: 'ok' });
        }

        // â”€â”€ LOAD ALL DATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const [sysPrompt, dataResult, savedPDFs] = await Promise.all([
            getSystemPrompt(),
            loadAllData(),
            getPDFList(),
        ]);

        const { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile } = dataResult;

        // â”€â”€ INTENT DETECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const intent = detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs);
        console.log('[INTENT]', intent.type, '| text:', text);

        if (intent.type === 'pdf') {
            // PDF send karo
            await sendText(from, `Sending ${intent.pdf.name}...`);
            await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name);
            return res.status(200).json({ status: 'ok' });
        }

        // AI se reply lo (rate query ya general)
        const reply = await getAIReply(text, excelData, sysPrompt);
        await sendText(from, reply);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message);
        return res.status(200).send('System Error');
    }
};
