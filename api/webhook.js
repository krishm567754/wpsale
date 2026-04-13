const fetch = require('node-fetch');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// ——— FIREBASE INIT ——————————————————————————————————————
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

// ——— SYSTEM PROMPT ——————————————————————————————————————
async function getSystemPrompt() {
    const database = getFirebase();
    let prompt = `Tu Shri Laxmi Auto Store, Bikaner ka official WhatsApp assistant "Laxmi" hai.`;
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

// ——— PDF LIST —————————————————————————————————————————
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

// ——— EXCEL FROM GITHUB ——————————————————————————————————
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) { console.log('[EXCEL] GITHUB_RAW_BASE not set'); return 'No Excel data.'; }
    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) fileList = await r.json();
        else console.log('[EXCEL] index.json failed:', r.status);
    } catch (e) { console.error('[EXCEL] Error:', e.message); }
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
            console.log('[EXCEL] Loaded:', f);
        } catch (e) { console.error('[EXCEL] Error:', e.message); }
    }
    return combined.slice(-14000) || 'No data.';
}

// ——— SEND TEXT ————————————————————————————————————————
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    if (!baseUrl || !instance || !apiKey) {
        console.error('[SEND] Missing env vars!');
        return;
    }
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    try {
        const r = await fetch(`${baseUrl}/message/sendText/${instance}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body:    JSON.stringify({ number, text }),
        });
        console.log('[SEND] Status:', r.status);
    } catch (e) { console.error('[SEND] Error:', e.message); }
}

// ——— SEND PDF —————————————————————————————————————————
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
            body:    JSON.stringify({
                number, mediatype: 'document',
                mimetype: 'application/pdf',
                media: fileUrl, fileName, caption,
            }),
        });
        console.log('[PDF] Status:', r.status);
    } catch (e) { console.error('[PDF] Error:', e.message); }
}

// ——— AI REPLY — OpenRouter (Mistral NeMo 12B Free) ————————
async function getAIReply(userMessage, excelData, pdfList, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) { console.error('[AI] OPENROUTER_API_KEY missing!'); return 'API key missing.'; }

    const pdfCtx = Object.keys(pdfList).length
        ? `\nAvailable PDFs:\n${Object.entries(pdfList).map(([k,v]) => `- ${v.name} [keyword: ${k}]`).join('\n')}\n`
        : '';

    try {
        console.log('[AI] Calling Mistral NeMo 12B...');
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  'https://shrilaxmiauto.in',
                'X-Title':       'Shri Laxmi Auto Bot',
            },
            body: JSON.stringify({
                // Updated to Mistral NeMo 12B Free
                model:      'mistralai/mistral-nemo-12b-instruct:free',
                max_tokens: 500,
                temperature: 0.1,
                messages: [
                    {
                        role:    'system',
                        content: `${systemPrompt}${pdfCtx}\n\nBUSINESS DATA (Excel):\n${excelData}`
                    },
                    { role: 'user', content: userMessage },
                ],
            }),
        });

        console.log('[AI] Status:', r.status);
        const d = await r.json();

        if (d.error) {
            console.error('[AI] Error:', d.error.message);
            return `AI Error: ${d.error.message}`;
        }

        const reply = d?.choices?.[0]?.message?.content?.trim();
        return reply || 'Jawab nahi aaya, baad mein try karein.';

    } catch (e) {
        console.error('[AI] Fetch error:', e.message);
        return 'Technical issue. Baad mein try karein.';
    }
}

// ——— PDF DETECT ———————————————————————————————————————
function detectPDF(text, pdfList) {
    const lower = text.toLowerCase();
    for (const [k, v] of Object.entries(pdfList)) {
        if (lower.includes(k.toLowerCase()) || lower.includes(v.name.toLowerCase())) return v;
    }
    return null;
}

// ——— MAIN WEBHOOK —————————————————————————————————————
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).json({ status: 'ok' });

    try {
        const body  = req.body;
        const event = body?.event;
        console.log('[WH] Event:', event);

        if (event !== 'messages.upsert') return res.status(200).json({ status: 'ignored' });

        const msgData = body?.data;
        if (msgData?.key?.fromMe) return res.status(200).json({ status: 'skip' });

        const from = msgData?.key?.remoteJid;
        const text = (
            msgData?.message?.conversation ||
            msgData?.message?.extendedTextMessage?.text || ''
        ).trim();

        console.log('[WH] From:', from, '| Text:', text);
        if (!text || !from) return res.status(200).json({ status: 'empty' });

        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin  = from.includes(adminNum);

        // —— ADMIN COMMANDS ——————————————————————————————————
        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, '✅ Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!status') {
            await sendText(from, `🤖 *Bot Status*\n✅ Online\n🧠 Model: Mistral NeMo 12B (OpenRouter)\n📡 Evolution API\n⚡ Vercel Active`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name, url };
                await savePDFList(list);
                await sendText(from, `✅ PDF added!\nKeyword: ${keyword}\nName: ${name}`);
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
                const txt = Object.entries(list).map(([k,v]) => `📄 ${v.name}\n    keyword: ${k}`).join('\n\n');
                await sendText(from, `📚 *PDFs:*\n\n${txt}`);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw   = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) { delete list[kw]; await savePDFList(list); await sendText(from, `✅ Removed: ${kw}`); }
            else await sendText(from, `❌ Not found: ${kw}`);
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!help') {
            await sendText(from, `🤖 *Admin Commands:*\n\n!status\n!setprompt [text]\n!addpdf keyword | Name | URL\n!listpdf\n!removepdf keyword`);
            return res.status(200).json({ status: 'ok' });
        }

        // —— USER → AI ——————————————————————————————————————
        const [systemPrompt, excelData, pdfList] = await Promise.all([
            getSystemPrompt(),
            loadExcelData(),
            getPDFList(),
        ]);

        const reqPDF = detectPDF(text, pdfList);
        if (reqPDF) {
            await sendDocument(from, reqPDF.url, reqPDF.name, `📄 ${reqPDF.name}`);
            return res.status(200).json({ status: 'ok' });
        }

        const reply = await getAIReply(text, excelData, pdfList, systemPrompt);
        await sendText(from, reply);

        const sugPDF = detectPDF(reply, pdfList);
        if (sugPDF) await sendDocument(from, sugPDF.url, sugPDF.name, `📄 ${sugPDF.name}`);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('[WH] Fatal:', e.message);
        return res.status(200).json({ status: 'error' });
    }
};
