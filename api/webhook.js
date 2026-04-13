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

// ——— SMART EXCEL SEARCH (Fix for missing invoices) ————————
async function loadRelevantExcelData(userQuery) {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'No Excel data base URL set.';
    
    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) fileList = await r.json();
    } catch (e) { return 'Error loading file list.'; }

    if (!fileList.length) return 'No data files found.';

    let foundContext = '';
    const searchTerm = userQuery.toLowerCase().trim();

    for (const f of fileList) {
        try {
            const r = await fetch(`${base}/${f}`);
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            const wb  = XLSX.read(buf, { type: 'buffer' });
            
            for (const s of wb.SheetNames) {
                const data = XLSX.utils.sheet_to_json(wb.Sheets[s]);
                
                // Filtering logic: Search in all rows
                const matches = data.filter(row => 
                    Object.values(row).some(val => 
                        String(val).toLowerCase().includes(searchTerm)
                    )
                );

                if (matches.length > 0) {
                    foundContext += `\n[From File: ${f}]\n${JSON.stringify(matches.slice(0, 15))}\n`;
                }
            }
        } catch (e) { console.error(`Error reading ${f}:`, e.message); }
    }

    // Agar keyword se kuch na mile, toh default chota chunk bhej do context ke liye
    return foundContext || "No specific invoice found for this query in the database.";
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

// ——— AI REPLY — OpenRouter (GPT-OSS-120B Free) ————————
async function getAIReply(userMessage, excelData, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return 'AI Key Missing.';

    try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  'https://shrilaxmiauto.in',
                'X-Title':       'Shri Laxmi Auto Bot',
            },
            body: JSON.stringify({
                model:      'openai/gpt-oss-120b:free',
                max_tokens: 1000,
                temperature: 0.1, // Fixed for high accuracy
                messages: [
                    {
                        role:    'system',
                        content: `${systemPrompt}\n\nSearch Results from Database:\n${excelData}\n\nNote: If the search results above are empty, tell the user politely that the record was not found.`
                    },
                    { role: 'user', content: userMessage },
                ],
            }),
        });

        const d = await r.json();
        return d?.choices?.[0]?.message?.content?.trim() || 'No response.';
    } catch (e) {
        return 'AI Connection Error.';
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

        // Step 1: Get System Prompt
        const sysPrompt = await getSystemPrompt();

        // Step 2: Search EXCEL specifically for what the user asked
        const relevantData = await loadRelevantExcelData(text);

        // Step 3: Get AI response based on filtered data
        const reply = await getAIReply(text, relevantData, sysPrompt);
        
        // Step 4: Send Reply
        await sendText(from, reply);

        return res.status(200).json({ status: 'ok' });

    } catch (e) {
        console.error('Webhook Error:', e.message);
        return res.status(200).json({ status: 'error' });
    }
};
