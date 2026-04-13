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

*GREETING:*
Jab koi Hello/Hi/Namaste kare: "Hello! ðŸ˜Š Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, customer sales, MRP/DLP ya koi bhi query pooch sakte hain!"

*EXCEL DATA FORMAT:*
Compressed format mein data hai:
InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment

*SEARCH RULES:*
1. INVOICE: "00049" ya "INV/26-27/00049" â†’ exact match dhundo pipe-separated data mein
2. CUSTOMER: Partial name match karo â€” "KARNI" â†’ "JAI SHREE KARNI MOTORS, LKS"
3. PRODUCT/MRP: Product name se saari entries dhundo, total volume aur value batao
4. DATE: Date se saare invoices list karo

*REPLY FORMAT (WhatsApp bold = *single asterisk*):*
Invoice reply:
ðŸ“‹ *Invoice: INV/26-27/00049*
ðŸ‘¤ *Customer:* JAI SHREE KARNI MOTORS, LKS (Lunkaransar)
ðŸ“¦ *Products:* GTX SUV 5W-30 (9L)
ðŸ’° *Total (with GST):* â‚¹3,474
ðŸ§¾ *Tax:* CGST â‚¹265 + SGST â‚¹265
ðŸ“… *Date:* 06-Apr-2026 | ðŸ’³ Cash

*STRICT RULES:*
- Sirf data se jawab do â€” kuch bhi invent mat karo
- Amounts mein â‚¹ aur comma lagao (â‚¹3,474)
- Negative amount = Credit Note (CN)
- Data na mile: "âŒ Nahi mila. Number/naam check karke dobara try karein."
- Hinglish mein baat karo, max 6 lines`;

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

// â”€â”€â”€ EXCEL LOAD + SMART COMPRESS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX: slice(0,50) hataya â€” ab SAARI rows load hoti hain
// FIX: compress karke 158 invoices ~26000 chars mein fit ho jaati hain
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'Data URL missing.';

    try {
        const rList = await axios.get(`${base}/index.json`);
        const fileList = rList.data;

        let allRows = [];

        for (const f of fileList) {
            try {
                const rFile = await axios.get(`${base}/${f}`, { responseType: 'arraybuffer' });
                const wb    = XLSX.read(rFile.data, { type: 'buffer' });

                for (const s of wb.SheetNames) {
                    // FIX: sheet_to_json use karo â€” saari rows milti hain
                    const rows = XLSX.utils.sheet_to_json(wb.Sheets[s], { defval: '' });
                    allRows    = allRows.concat(rows);
                }
                console.log(`[EXCEL] Loaded: ${f} (${allRows.length} rows)`);
            } catch (err) { console.log(`[EXCEL] Skip: ${f}`); }
        }

        if (!allRows.length) return 'No data loaded.';

        // Invoice wise group karo
        const invoiceMap = {};
        for (const row of allRows) {
            const inv = row['Invoice No'] || '';
            if (!inv) continue;
            if (!invoiceMap[inv]) invoiceMap[inv] = [];
            invoiceMap[inv].push(row);
        }

        // Compress â€” ek invoice = ek line (saara data fit ho jaata hai)
        const lines = [
            'SHRI LAXMI AUTO STORE â€” INVOICE DATABASE',
            'Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment',
            '='.repeat(80),
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

            lines.push(
                `${invNo}|${date}|${first['Customer Name']}|${first['Town Name']}|${first['District Name']}|${first['Sales Executive Name']}|${products}|${vol.toFixed(1)}L|â‚¹${totalGST.toFixed(2)}|â‚¹${woGST.toFixed(2)}|â‚¹${cgst.toFixed(2)}|â‚¹${sgst.toFixed(2)}|${first['Mode Of Payement']}`
            );
        }

        const compressed = lines.join('\n');
        console.log(`[EXCEL] ${Object.keys(invoiceMap).length} invoices, ${compressed.length} chars`);
        return compressed;

    } catch (e) {
        console.error('[EXCEL] Fatal:', e.message);
        return 'Excel load error.';
    }
}

// â”€â”€â”€ AI REPLY â€” NVIDIA API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'âš ï¸ NVIDIA_API_KEY missing in Vercel variables.';

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

        return response.data?.choices?.[0]?.message?.content || 'âš ï¸ Empty response from AI.';

    } catch (e) {
        if (e.response) {
            console.error('[AI] NVIDIA Error:', e.response.status, JSON.stringify(e.response.data).slice(0, 200));
            return `âš ï¸ AI Error ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 100)}`;
        }
        console.error('[AI] Error:', e.message);
        return `âš ï¸ System Error: ${e.message}`;
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
        console.log('[SEND] OK to:', number);
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

// â”€â”€â”€ PDF DETECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectPDF(text, pdfList) {
    const lower = text.toLowerCase();
    for (const [k, v] of Object.entries(pdfList)) {
        if (lower.includes(k.toLowerCase()) || lower.includes(v.name.toLowerCase())) return v;
    }
    return null;
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
            await sendText(from, 'âœ… Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }

        if (isAdmin && text === '!status') {
            await sendText(from, `ðŸ¤– *Bot Status*\nâœ… Online\nðŸ§  NVIDIA Llama 3.1 70B\nðŸ“¡ Evolution API\nâš¡ Vercel Active`);
            return res.status(200).json({ status: 'ok' });
        }

        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name, url };
                await savePDFList(list);
                await sendText(from, `âœ… PDF added!\nðŸ“„ Name: ${name}\nðŸ”‘ Keyword: ${keyword}`);
            } else {
                await sendText(from, 'âŒ Format: !addpdf keyword | File Name | https://pdf-url');
            }
            return res.status(200).json({ status: 'ok' });
        }

        if (isAdmin && text === '!listpdf') {
            const list = await getPDFList();
            if (!Object.keys(list).length) {
                await sendText(from, 'ðŸ“‚ Koi PDF nahi hai.\n!addpdf se add karo.');
            } else {
                const txt = Object.entries(list)
                    .map(([k, v]) => `ðŸ“„ ${v.name}\n   ðŸ”‘ Keyword: ${k}`)
                    .join('\n\n');
                await sendText(from, `ðŸ“š *Available PDFs:*\n\n${txt}`);
            }
            return res.status(200).json({ status: 'ok' });
        }

        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw   = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) {
                delete list[kw];
                await savePDFList(list);
                await sendText(from, `âœ… PDF removed: ${kw}`);
            } else {
                await sendText(from, `âŒ Keyword not found: ${kw}`);
            }
            return res.status(200).json({ status: 'ok' });
        }

        if (isAdmin && text === '!help') {
            await sendText(from, `ðŸ¤– *Admin Commands:*\n\n*Bot:*\n!status â€” Bot check\n!setprompt [text] â€” Prompt change\n\n*PDF:*\n!addpdf keyword | Name | URL\n!listpdf â€” Saari PDFs\n!removepdf keyword â€” PDF hatao`);
            return res.status(200).json({ status: 'ok' });
        }

        // â”€â”€ USER â†’ AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const [sysPrompt, excelData, pdfList] = await Promise.all([
            getSystemPrompt(),
            loadExcelData(),
            getPDFList(),
        ]);

        // Direct PDF request?
        const reqPDF = detectPDF(text, pdfList);
        if (reqPDF) {
            await sendDocument(from, reqPDF.url, reqPDF.name, `ðŸ“„ ${reqPDF.name}`);
            return res.status(200).json({ status: 'ok' });
        }

        // AI reply
        const reply = await getAIReply(text, excelData, sysPrompt);
        await sendText(from, reply);

        // AI ne PDF suggest kiya?
        const sugPDF = detectPDF(reply, pdfList);
        if (sugPDF) await sendDocument(from, sugPDF.url, sugPDF.name, `ðŸ“„ ${sugPDF.name}`);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message);
        return res.status(200).send('System Error');
    }
};
