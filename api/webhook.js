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
        console.log('[FB] Connected');
    } catch (e) { console.error('[FB] Error:', e.message); }
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
        if (snap.exists()) prompt = snap.val();
    } catch (e) {}
    return prompt;
}
async function saveSystemPrompt(p) {
    const db = getFirebase();
    if (db) try { await db.ref('botConfig/systemPrompt').set(p); } catch(e) {}
}

// â”€â”€â”€ PDF LIST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getPDFList() {
    const db = getFirebase();
    if (!db) return {};
    try {
        const snap = await db.ref('botConfig/pdfFiles').get();
        return snap.exists() ? snap.val() : {};
    } catch (e) { return {}; }
}
async function savePDFList(data) {
    const db = getFirebase();
    if (db) try { await db.ref('botConfig/pdfFiles').set(data); } catch(e) {}
}

// â”€â”€â”€ EXCEL FROM GITHUB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'No Excel data configured.';
    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) fileList = await r.json();
    } catch (e) {}
    if (!fileList.length) return 'No data files.';
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
        } catch (e) {}
    }
    return combined.slice(-14000) || 'No data.';
}

// â”€â”€â”€ SEND TEXT â€” FIXED API FORMAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX 1: Evolution API ka sahi body format use kiya
// FIX 2: number se @s.whatsapp.net hataya â€” sirf digits chahiye
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); // trailing slash remove
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;

    console.log('[SEND] baseUrl:', baseUrl);
    console.log('[SEND] instance:', instance);
    console.log('[SEND] to (raw):', to);

    if (!baseUrl || !instance || !apiKey) {
        console.error('[SEND] Missing env vars! baseUrl:', baseUrl, '| instance:', instance, '| apiKey exists:', !!apiKey);
        return;
    }

    // FIX: number format â€” sirf digits chahiye, @s.whatsapp.net ya @g.us nahi
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    console.log('[SEND] number (cleaned):', number);

    const url = `${baseUrl}/message/sendText/${instance}`;
    console.log('[SEND] URL:', url);

    try {
        const r = await fetch(url, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': apiKey,
            },
            // FIX 3: Evolution API v2 ka correct body format
            body: JSON.stringify({
                number: number,
                text:   text,
            }),
        });
        const body = await r.text();
        console.log('[SEND] Status:', r.status);
        console.log('[SEND] Response:', body.slice(0, 300));
    } catch (e) {
        console.error('[SEND] Fetch error:', e.message);
    }
}

// â”€â”€â”€ SEND PDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendDocument(to, fileUrl, fileName, caption = '') {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    if (!baseUrl || !instance || !apiKey) return;

    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');

    try {
        const r = await fetch(`${baseUrl}/message/sendMedia/${instance}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body: JSON.stringify({
                number,
                mediatype: 'document',
                mimetype:  'application/pdf',
                media:     fileUrl,
                fileName,
                caption,
            }),
        });
        console.log('[PDF] Status:', r.status);
    } catch (e) { console.error('[PDF] Error:', e.message); }
}

// â”€â”€â”€ AI REPLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAIReply(userMessage, excelData, pdfList, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) { console.error('[AI] OPENROUTER_API_KEY missing!'); return 'API key missing.'; }
    const pdfCtx = Object.keys(pdfList).length
        ? `\nPDFs available:\n${Object.entries(pdfList).map(([k,v]) => `- ${v.name} [keyword: ${k}]`).join('\n')}\n`
        : '';
    try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
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
                    { role: 'system', content: `${systemPrompt}${pdfCtx}\n\nDATA:\n${excelData}` },
                    { role: 'user',   content: userMessage },
                ],
            }),
        });
        console.log('[AI] Status:', r.status);
        const d = await r.json();
        if (d.error) { console.error('[AI] Error:', d.error.message); return `Error: ${d.error.message}`; }
        return d?.choices?.[0]?.message?.content?.trim() || 'Jawab nahi aaya.';
    } catch (e) {
        console.error('[AI] Error:', e.message);
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

// â”€â”€â”€ MAIN WEBHOOK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = async (req, res) => {

    // Non-POST requests
    if (req.method !== 'POST') {
        return res.status(200).json({ status: 'ok' });
    }

    // âœ… KEY FIX: res SABSE LAST mein â€” pehle poora async kaam
    try {
        const body  = req.body;
        const event = body?.event;

        console.log('[WH] Event:', event);

        if (event !== 'messages.upsert') {
            return res.status(200).json({ status: 'ignored' });
        }

        const msgData = body?.data;
        const fromMe  = msgData?.key?.fromMe;
        if (fromMe) return res.status(200).json({ status: 'skip_own' });

        const from = msgData?.key?.remoteJid;
        const text = (
            msgData?.message?.conversation ||
            msgData?.message?.extendedTextMessage?.text || ''
        ).trim();

        console.log('[WH] from:', from, '| text:', text);

        if (!text || !from) return res.status(200).json({ status: 'empty' });

        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin  = from.includes(adminNum);

        // â”€â”€ ADMIN COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, 'âœ… Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!status') {
            await sendText(from, `ðŸ¤– Bot Online âœ…\nðŸ“¡ Evolution API\nâš¡ Vercel Active\n\nURL: ${process.env.EVOLUTION_API_URL}\nInstance: ${process.env.EVOLUTION_INSTANCE}`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name, url };
                await savePDFList(list);
                await sendText(from, `âœ… PDF added!\nKeyword: ${keyword}\nName: ${name}`);
            } else {
                await sendText(from, 'âŒ Format: !addpdf keyword | Name | URL');
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') {
            const list = await getPDFList();
            if (!Object.keys(list).length) {
                await sendText(from, 'Koi PDF nahi. !addpdf se add karo.');
            } else {
                const txt = Object.entries(list).map(([k,v]) => `ðŸ“„ ${v.name}\n   keyword: ${k}`).join('\n\n');
                await sendText(from, `ðŸ“š PDFs:\n\n${txt}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw   = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) { delete list[kw]; await savePDFList(list); await sendText(from, `âœ… Removed: ${kw}`); }
            else await sendText(from, `âŒ Not found: ${kw}`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!help') {
            await sendText(from, `ðŸ¤– Admin Commands:\n\n!status\n!setprompt [text]\n!addpdf keyword | Name | URL\n!listpdf\n!removepdf keyword`);
            return res.status(200).json({ status: 'ok' });
        }

        // â”€â”€ USER â†’ AI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const [systemPrompt, excelData, pdfList] = await Promise.all([
            getSystemPrompt(),
            loadExcelData(),
            getPDFList(),
        ]);

        // Direct PDF?
        const reqPDF = detectPDF(text, pdfList);
        if (reqPDF) {
            await sendDocument(from, reqPDF.url, reqPDF.name, `ðŸ“„ ${reqPDF.name}`);
            return res.status(200).json({ status: 'ok' });
        }

        // AI reply
        const reply = await getAIReply(text, excelData, pdfList, systemPrompt);
        await sendText(from, reply);

        // AI ne PDF suggest kiya?
        const sugPDF = detectPDF(reply, pdfList);
        if (sugPDF) await sendDocument(from, sugPDF.url, sugPDF.name, `ðŸ“„ ${sugPDF.name}`);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message);
        return res.status(200).json({ status: 'error' });
    }
};
