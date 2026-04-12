const fetch = require('node-fetch');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// â”€â”€â”€ FIREBASE INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        console.log('[FIREBASE] Connected OK');
    } catch (e) {
        console.error('[FIREBASE] Init error:', e.message);
    }
    return db;
}

// â”€â”€â”€ SYSTEM PROMPT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getSystemPrompt() {
    const database = getFirebase();
    let prompt = `Tu Shri Laxmi Auto Store, Bikaner ka WhatsApp assistant hai.
Castrol distributor ke sales, stock aur outstanding payment data ke basis par jawab de.
- Hinglish mein baat kar.
- Jawab max 2-3 lines mein de.
- Sirf Excel data ke basis par baat kar.
- Data na mile toh: "Yeh info available nahi, Admin se contact karein."`;
    if (!database) return prompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        if (snap.exists()) { prompt = snap.val(); console.log('[FIREBASE] Prompt loaded'); }
    } catch (e) { console.error('[FIREBASE] Prompt error:', e.message); }
    return prompt;
}
async function saveSystemPrompt(p) {
    const database = getFirebase();
    if (!database) return;
    try { await database.ref('botConfig/systemPrompt').set(p); } catch (e) {}
}

// â”€â”€â”€ PDF LIST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (!database) return;
    try { await database.ref('botConfig/pdfFiles').set(data); } catch (e) {}
}

// â”€â”€â”€ EXCEL FROM GITHUB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) { console.log('[EXCEL] GITHUB_RAW_BASE not set'); return 'No Excel data.'; }
    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) { fileList = await r.json(); console.log('[EXCEL] Files:', fileList); }
        else { console.log('[EXCEL] index.json failed:', r.status); }
    } catch (e) { console.error('[EXCEL] Error:', e.message); }
    if (!fileList.length) return 'No data files found.';
    let combined = '';
    for (const f of fileList) {
        try {
            const r = await fetch(`${base}/${f}`);
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            const wb  = XLSX.read(buf, { type: 'buffer' });
            let txt   = `\n=== ${f} ===\n`;
            for (const s of wb.SheetNames) {
                const csv = XLSX.utils.sheet_to_csv(wb.Sheets[s]);
                if (csv.trim()) txt += `${s}:\n${csv}\n`;
            }
            combined += txt;
            console.log('[EXCEL] Loaded:', f);
        } catch (e) { console.error('[EXCEL] File error:', e.message); }
    }
    return combined.slice(-14000) || 'No data loaded.';
}

// â”€â”€â”€ SEND TEXT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendText(to, text) {
    const base     = process.env.EVOLUTION_API_URL;
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;

    console.log('[SEND] URL:', base, '| Instance:', instance);

    if (!base || !instance || !apiKey) {
        console.error('[SEND] Missing env vars! base:', base, 'instance:', instance, 'key exists:', !!apiKey);
        return;
    }
    try {
        const url = `${base}/message/sendText/${instance}`;
        console.log('[SEND] Calling:', url);
        const r = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body:    JSON.stringify({ number: to, text }),
        });
        const body = await r.text();
        console.log('[SEND] Status:', r.status, '| Body:', body.slice(0, 200));
    } catch (e) {
        console.error('[SEND] Error:', e.message);
    }
}

// â”€â”€â”€ SEND PDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendDocument(to, fileUrl, fileName, caption = '') {
    const base     = process.env.EVOLUTION_API_URL;
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    if (!base || !instance || !apiKey) return;
    try {
        const r = await fetch(`${base}/message/sendMedia/${instance}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body:    JSON.stringify({
                number: to, mediatype: 'document',
                mimetype: 'application/pdf',
                media: fileUrl, fileName, caption,
            }),
        });
        console.log('[PDF] Status:', r.status);
    } catch (e) { console.error('[PDF] Error:', e.message); }
}

// â”€â”€â”€ AI REPLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAIReply(userMessage, excelData, pdfList, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) { console.error('[AI] OPENROUTER_API_KEY missing!'); return 'API key missing.'; }
    const pdfContext = Object.keys(pdfList).length
        ? `\nAvailable PDFs:\n${Object.entries(pdfList).map(([k,v]) => `- ${v.name} [keyword: ${k}]`).join('\n')}\n`
        : '';
    try {
        console.log('[AI] Calling OpenRouter...');
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  'https://shrilaxmiauto.in',
                'X-Title':       'Shri Laxmi Auto Bot',
            },
            body: JSON.stringify({
                model:      'meta-llama/llama-3.1-8b-instruct:free',
                max_tokens: 400,
                messages: [
                    { role: 'system', content: `${systemPrompt}${pdfContext}\n\nDATA:\n${excelData}` },
                    { role: 'user',   content: userMessage },
                ],
            }),
        });
        console.log('[AI] Status:', r.status);
        const d = await r.json();
        console.log('[AI] Response:', JSON.stringify(d).slice(0, 300));
        if (d.error) { console.error('[AI] Error:', d.error.message); return `AI Error: ${d.error.message}`; }
        return d?.choices?.[0]?.message?.content?.trim() || 'Jawab nahi aaya.';
    } catch (e) {
        console.error('[AI] Fetch error:', e.message);
        return 'Technical issue. Baad mein try karein.';
    }
}

// â”€â”€â”€ PDF DETECT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectPDF(text, pdfList) {
    const lower = text.toLowerCase();
    for (const [k, v] of Object.entries(pdfList)) {
        if (lower.includes(k.toLowerCase()) || lower.includes(v.name.toLowerCase())) return v;
    }
    return null;
}

// â”€â”€â”€ MAIN HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// âœ… KEY FIX: res.status(200) ab SABSE LAST mein â€” async kaam pehle poora hoga
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(200).json({ status: 'ok' });
    }

    try {
        const body  = req.body;
        const event = body?.event;

        console.log('[WEBHOOK] Event:', event);
        console.log('[WEBHOOK] Body:', JSON.stringify(body).slice(0, 400));

        if (event !== 'messages.upsert') {
            console.log('[WEBHOOK] Ignoring event:', event);
            return res.status(200).json({ status: 'ignored' });
        }

        const msgData = body?.data;
        const fromMe  = msgData?.key?.fromMe;

        if (fromMe) {
            console.log('[WEBHOOK] Own message â€” skip');
            return res.status(200).json({ status: 'skipped' });
        }

        const from = msgData?.key?.remoteJid;
        const text = (
            msgData?.message?.conversation ||
            msgData?.message?.extendedTextMessage?.text || ''
        ).trim();

        console.log('[WEBHOOK] From:', from, '| Text:', text);

        if (!text || !from) {
            return res.status(200).json({ status: 'empty' });
        }

        const adminNumber = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin     = from.includes(adminNumber);

        // â”€â”€ ADMIN COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, 'âœ… Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!status') {
            await sendText(from, `ðŸ¤– Bot Online âœ…\nðŸ“¡ Evolution API Connected\nâš¡ Vercel Active`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const pdfList = await getPDFList();
                pdfList[keyword.toLowerCase()] = { name, url };
                await savePDFList(pdfList);
                await sendText(from, `âœ… PDF added!\nKeyword: ${keyword}\nName: ${name}`);
            } else {
                await sendText(from, 'âŒ Format: !addpdf keyword | Name | URL');
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') {
            const pdfList = await getPDFList();
            if (!Object.keys(pdfList).length) {
                await sendText(from, 'Koi PDF nahi hai. !addpdf se add karo.');
            } else {
                const list = Object.entries(pdfList).map(([k,v]) => `ðŸ“„ ${v.name}\n   Keyword: ${k}`).join('\n\n');
                await sendText(from, `ðŸ“š *PDFs:*\n\n${list}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const keyword = text.replace('!removepdf ', '').trim().toLowerCase();
            const pdfList = await getPDFList();
            if (pdfList[keyword]) {
                delete pdfList[keyword];
                await savePDFList(pdfList);
                await sendText(from, `âœ… Removed: ${keyword}`);
            } else {
                await sendText(from, `âŒ Not found: ${keyword}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!help') {
            await sendText(from, `ðŸ¤– *Admin Commands:*\n\n!status\n!setprompt [text]\n!addpdf keyword | Name | URL\n!listpdf\n!removepdf keyword`);
            return res.status(200).json({ status: 'ok' });
        }

        // â”€â”€ USER MESSAGE â†’ AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        console.log('[FLOW] Loading all data...');
        const [systemPrompt, excelData, pdfList] = await Promise.all([
            getSystemPrompt(),
            loadExcelData(),
            getPDFList(),
        ]);

        // Direct PDF request?
        const requestedPDF = detectPDF(text, pdfList);
        if (requestedPDF) {
            console.log('[FLOW] Direct PDF request:', requestedPDF.name);
            await sendDocument(from, requestedPDF.url, requestedPDF.name, `ðŸ“„ ${requestedPDF.name}`);
            return res.status(200).json({ status: 'ok' });
        }

        // AI reply
        const reply = await getAIReply(text, excelData, pdfList, systemPrompt);
        console.log('[FLOW] AI Reply:', reply);
        await sendText(from, reply);

        // AI ne PDF suggest kiya?
        const suggestedPDF = detectPDF(reply, pdfList);
        if (suggestedPDF) {
            await sendDocument(from, suggestedPDF.url, suggestedPDF.name, `ðŸ“„ ${suggestedPDF.name}`);
        }

        console.log('[FLOW] âœ… Done!');
        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WEBHOOK] Fatal error:', e.message, e.stack);
        return res.status(200).json({ status: 'error', message: e.message });
    }
};
