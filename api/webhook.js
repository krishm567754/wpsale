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

// —— SAFE DATA LOADER (No Overload) ——
async function loadSafeData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'Data URL missing.';
    
    try {
        const rList = await fetch(`${base}/index.json`);
        if (!rList.ok) return 'Index file failed.';
        const fileList = await rList.json();

        let combinedData = "";
        
        // Sirf top 5 files uthayenge taaki AI crash na ho
        for (const f of fileList.slice(0, 5)) { 
            const rFile = await fetch(`${base}/${f}`);
            if (!rFile.ok) continue;
            
            const buf = Buffer.from(await rFile.arrayBuffer());
            const wb  = XLSX.read(buf, { type: 'buffer' });
            
            for (const s of wb.SheetNames) {
                const sheetData = XLSX.utils.sheet_to_json(wb.Sheets[s]);
                // Har sheet se sirf top 50 rows uthayenge (Memory safe)
                const safeData = sheetData.slice(0, 50); 
                if (safeData.length > 0) {
                    combinedData += `\n[File: ${f}]\n${JSON.stringify(safeData)}\n`;
                }
            }
        }
        
        // Strictly limit to 10,000 characters (Free models ki safe limit)
        return combinedData.slice(-10000); 
    } catch (e) {
        return "Excel load error.";
    }
}

// —— AI CALL (With Real Error Reporting) ——
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
                // Fixed: Wapas aapka chuna hua GPT-OSS-120B
                model: 'openai/gpt-oss-120b:free', 
                messages: [
                    { role: 'system', content: `${prompt}\n\nDATA:\n${data}` },
                    { role: 'user', content: userMsg }
                ],
                temperature: 0.2
            })
        });

        const d = await res.json();
        
        // ASLI ERROR YAHAN PAKDA JAYEGA
        if (d.error) {
            console.error("OpenRouter Error:", d.error);
            return `⚠️ AI Error: ${d.error.message}`; 
        }

        return d.choices?.[0]?.message?.content || "⚠️ API ne khali jawab diya.";
    } catch (e) {
        return `⚠️ System Catch Error: ${e.message}`;
    }
}

// —— EVOLUTION API SEND ——
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
    } catch (e) { console.error("Message send fail:", e.message); }
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

        const [sysPromptSnap, excelData] = await Promise.all([
            getFirebase()?.ref('botConfig/systemPrompt').get(),
            loadSafeData()
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
