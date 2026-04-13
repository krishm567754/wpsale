const axios = require('axios'); 
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// —— FIREBASE ——
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

// —— SAFE DATA LOADER ——
async function loadSafeData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'Data URL missing.';
    
    try {
        const rList = await axios.get(`${base}/index.json`);
        const fileList = rList.data;

        let combinedData = "";
        
        for (const f of fileList.slice(0, 5)) { 
            try {
                const rFile = await axios.get(`${base}/${f}`, { responseType: 'arraybuffer' });
                const wb  = XLSX.read(rFile.data, { type: 'buffer' });
                
                for (const s of wb.SheetNames) {
                    const sheetData = XLSX.utils.sheet_to_json(wb.Sheets[s]);
                    const safeData = sheetData.slice(0, 50); 
                    if (safeData.length > 0) {
                        combinedData += `\n[File: ${f}]\n${JSON.stringify(safeData)}\n`;
                    }
                }
            } catch (err) { console.log(`File ${f} skip ki gayi`); }
        }
        return combinedData.slice(-8000); 
    } catch (e) {
        return "Excel load error.";
    }
}

// —— AI CALL (NVIDIA Llama 3.1 70B - Super Stable) ——
async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY; 
    
    if (!key) return "⚠️ Vercel mein NVIDIA_API_KEY daaliye.";

    try {
        const response = await axios.post("https://integrate.api.nvidia.com/v1/chat/completions", {
            // Naya aur Stable Model
            model: "meta/llama-3.1-70b-instruct",
            messages: [
                { role: "system", content: `${prompt}\n\nDATA:\n${data}` },
                { role: "user", content: userMsg }
            ],
            max_tokens: 1500,
            temperature: 0.2, // Data logic ke liye low temperature best hai
            top_p: 0.95,
            stream: false
        }, {
            headers: {
                "Authorization": `Bearer ${key}`,
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            timeout: 25000 
        });

        const d = response.data;
        
        if (d.choices && d.choices.length > 0) {
            return d.choices[0].message.content || "⚠️ API ne 200 OK bheja par message khali tha.";
        }
        
        return "⚠️ API Format badal gaya hai: " + JSON.stringify(d).substring(0, 50);

    } catch (e) {
        if (e.response) {
            console.error("NVIDIA API Error Data:", e.response.data);
            return `⚠️ API Error HTTP ${e.response.status}: ${JSON.stringify(e.response.data).substring(0, 150)}`;
        }
        return `⚠️ System Error: ${e.message}`;
    }
}

// —— EVOLUTION API SEND ——
async function sendText(to, text) {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    
    try {
        await axios.post(`${baseUrl}/message/sendText/${instance}`, {
            number: number,
            text: text
        }, {
            headers: { 'Content-Type': 'application/json', 'apikey': apiKey }
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
