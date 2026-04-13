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
        return db;
    } catch (e) { return null; }
}

// ——— SYSTEM PROMPT ——————————————————————————————————————
async function getSystemPrompt() {
    const database = getFirebase();
    let prompt = `Tu Shri Laxmi Auto Store, Bikaner ka official WhatsApp assistant "Laxmi" hai. Excel data ke hisab se jawab de.`;
    if (!database) return prompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        if (snap.exists()) prompt = snap.val();
    } catch (e) {}
    return prompt;
}

// ——— SMART DATA LOADER ——————————————————————————————————
async function loadData(query) {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'No Data URL.';
    
    try {
        const rList = await fetch(`${base}/index.json`);
        if (!rList.ok) return 'File list error.';
        const fileList = await rList.json();

        let context = "";
        let foundAny = false;
        const searchTerm = query.toLowerCase().trim();

        for (const f of fileList) {
            const rFile = await fetch(`${base}/${f}`);
            if (!rFile.ok) continue;
            
            const buf = Buffer.from(await rFile.arrayBuffer());
            const wb  = XLSX.read(buf, { type: 'buffer' });
            
            for (const s of wb.SheetNames) {
                const sheetData = XLSX.utils.sheet_to_json(wb.Sheets[s]);
                
                // Filter rows that contain ANY part of the user's query
                const matches = sheetData.filter(row => 
                    JSON.stringify(row).toLowerCase().includes(searchTerm)
                );

                if (matches.length > 0) {
                    context += `\nFile: ${f}\n${JSON.stringify(matches.slice(0, 10))}\n`;
                    foundAny = true;
                }
            }
        }

        // Agar filtering se kuch na mile, toh pehli file ka thoda data bhej do default
        if (!foundAny && fileList.length > 0) {
            return "No direct match found. Please check manually.";
        }
        
        return context.slice(0, 20000); // Limit context size
    } catch (e) {
        return "Data loading failed.";
    }
}

// ——— SEND TEXT ————————————————————————————————————————
async function sendText(to, text) {
    const baseUrl  = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    
    try {
        await fetch(`${baseUrl}/message/sendText/${instance}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
            body:    JSON.stringify({ number, text }),
        });
    } catch (e) { console.error("Send Error:", e.message); }
}

// ——— AI REPLY —————————————————————————————————————————
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.OPENROUTER_API_KEY;
    try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method:  'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type':  'application/json',
                'HTTP-Referer':  'https://shrilaxmiauto.in'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b:free',
                messages: [
                    { role: 'system', content: `${prompt}\n\nDATA:\n${data}` },
                    { role: 'user', content: userMsg }
                ],
                temperature: 0.1
            })
        });
        const d = await r.json();
        return d.choices?.[0]?.message?.content || "Maaf kijiye, main abhi samajh nahi pa rahi hoon.";
    } catch (e) {
        return "AI server down hai, thodi der mein try karein.";
    }
}

// ——— MAIN WEBHOOK —————————————————————————————————————
module.exports = async (req, res) => {
    // 1. Check if POST
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const body = req.body;
        
        // 2. Filter Events
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data?.key?.fromMe) return res.status(200).send('From Me');

        const from = body.data.key.remoteJid;
        const text = (body.data.message?.conversation || body.data.message?.extendedTextMessage?.text || '').trim();

        if (!text) return res.status(200).send('No Text');

        // 3. Process
        const [sysPrompt, excelData] = await Promise.all([
            getSystemPrompt(),
            loadData(text)
        ]);

        const reply = await getAIReply(text, excelData, sysPrompt);
        
        // 4. Final Send
        await sendText(from, reply);

        res.status(200).json({ status: 'sent' });
    } catch (e) {
        console.error("Fatal Error:", e.message);
        res.status(200).send('Error');
    }
};
