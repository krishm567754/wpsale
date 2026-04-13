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

// ——— EXCEL FROM GITHUB ——————————————————————————————————
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) { console.log('[EXCEL] GITHUB_RAW_BASE not set'); return 'No Excel data.'; }
    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) fileList = await r.json();
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
        } catch (e) {}
    }
    return combined.slice(-14000) || 'No data.';
}

// ——— SEND TEXT ————————————————————————————————————————
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    if (!baseUrl || !instance || !apiKey) return;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    try {
        await fetch(`${baseUrl}/message/sendText/${instance}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body:    JSON.stringify({ number, text }),
        });
    } catch (e) {}
}

// ——— AI REPLY — OpenRouter (MiniMax-M2.5 Free) ————————
async function getAIReply(userMessage, excelData, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return 'API key missing.';

    try {
        console.log('[AI] Calling MiniMax-M2.5...');
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  'https://shrilaxmiauto.in',
                'X-Title':       'Shri Laxmi Auto Bot',
            },
            body: JSON.stringify({
                // Updated to MiniMax-M2.5 Free ID
                model:      'minimax/minimax-m2.5:free',
                max_tokens: 800,
                temperature: 0.1, // Kam temperature taaki data se answer accurate mile
                messages: [
                    {
                        role:    'system',
                        content: `${systemPrompt}\n\nBUSINESS DATA (Excel):\n${excelData}`
                    },
                    { role: 'user', content: userMessage },
                ],
            }),
        });

        const d = await r.json();

        if (d.error) {
            console.error('[AI] Error:', d.error.message);
            return `AI Error: ${d.error.message}`;
        }

        return d?.choices?.[0]?.message?.content?.trim() || 'No response.';

    } catch (e) {
        return 'Technical issue. Baad mein try karein.';
    }
}

// ——— MAIN WEBHOOK —————————————————————————————————————
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).json({ status: 'ok' });

    try {
        const body  = req.body;
        if (body?.event !== 'messages.upsert') return res.status(200).json({ status: 'ignored' });

        const msgData = body?.data;
        if (msgData?.key?.fromMe) return res.status(200).json({ status: 'skip' });

        const from = msgData?.key?.remoteJid;
        const text = (msgData?.message?.conversation || msgData?.message?.extendedTextMessage?.text || '').trim();

        if (!text || !from) return res.status(200).json({ status: 'empty' });

        const [sysPrompt, excelData] = await Promise.all([
            getSystemPrompt(),
            loadExcelData()
        ]);

        const reply = await getAIReply(text, excelData, sysPrompt);
        await sendText(from, reply);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        return res.status(200).json({ status: 'error' });
    }
};
