const fetch = require('node-fetch');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// —— FIREBASE (Stable Connection) ——
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
    } catch (e) { return null; }
}

// —— EXCEL LOADER (Fixed: No more broken logic) ——
async function loadFullData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'Data URL missing.';
    
    try {
        const rList = await fetch(`${base}/index.json`);
        if (!rList.ok) return 'Index file not found.';
        const fileList = await rList.json();

        let combinedData = "";
        // Hum sirf top files uthayenge taaki Vercel crash na ho
        for (const f of fileList.slice(0, 15)) { 
            const rFile = await fetch(`${base}/${f}`);
            if (!rFile.ok) continue;
            
            const buf = Buffer.from(await rFile.arrayBuffer());
            const wb  = XLSX.read(buf, { type: 'buffer' });
            
            for (const s of wb.SheetNames) {
                const csv = XLSX.utils.sheet_to_csv(wb.Sheets[s]);
                if (csv.trim()) {
                    combinedData += `\n[File: ${f} | Sheet: ${s}]\n${csv}\n`;
                }
            }
        }
        // AI ko utna hi data denge jitna wo handle kar sake (Last 25000 chars)
        // Isse latest invoices kabhi nahi chhutenge
        return combinedData.slice(-25000); 
    } catch (e) {
        return "Excel read error.";
    }
}

// —— AI CALL (GPT-OSS-120B) ——
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.OPENROUTER_API_KEY;
    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://shrilaxmiauto.in'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b:free',
                messages: [
                    { role: 'system', content: `${prompt}\n\nKNOWLEDGE BASE:\n${data}` },
                    { role: 'user', content: userMsg }
                ],
                temperature: 0.2, // Accuracy ke liye low temperature
                max_tokens: 1000
            })
        });
        const d = await res.json();
        return d.choices?.[0]?.message?.content || "Jawab nahi mil pa raha hai.";
    } catch (e) {
        return "AI connect nahi ho pa raha.";
    }
}

// —— EVOLUTION SEND ——
async function sendText(to, text) {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    
    try {
        await fetch(`${baseUrl}/message/sendText/${instance}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body: JSON.stringify({ number, text }),
        });
    } catch (e) {}
}

// —— MAIN WEBHOOK ——
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data?.key?.fromMe) return res.status(200).send('Skip Me');

        const from = body.data.key.remoteJid;
        const text = (body.data.message?.conversation || body.data.message?.extendedTextMessage?.text || '').trim();

        if (!text) return res.status(200).send('Empty');

        // Parallel Processing
        const [sysPromptSnap, excelData] = await Promise.all([
            getFirebase()?.ref('botConfig/systemPrompt').get(),
            loadFullData()
        ]);

        const sysPrompt = sysPromptSnap?.exists() ? sysPromptSnap.val() : "Tu Laxmi hai, Shri Laxmi Auto Store ki assistant.";

        const reply = await getAIReply(text, excelData, sysPrompt);
        await sendText(from, reply);

        res.status(200).json({ status: 'success' });
    } catch (e) {
        console.error("FATAL:", e.message);
        res.status(200).send('System Error');
    }
};
