const express = require('express');
const axios = require('axios');
const XLSX = require('xlsx');
const pdf = require('pdf-parse');
const fs = require('fs');
const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const EVO_API_URL = "https://your-evolution-api-link.com"; // Evolution API ka URL
const EVO_API_KEY = "YOUR_EVO_API_KEY"; // Instance ki API key
const INSTANCE_NAME = "ShriLaxmiBot";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// --- 1. DATA LOADER (EXCEL & PDF) ---
async function getKnowledgeBase() {
    let context = "INSTRUCTIONS: Tu Shri Laxmi Auto Store ka assistant hai. Hinglish mein jawab de.\n\n";
    const dataDir = './data';

    if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        for (const file of files) {
            const filePath = `${dataDir}/${file}`;
            
            // Excel Files
            if (file.endsWith('.xlsx')) {
                const wb = XLSX.readFile(filePath);
                const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                context += `\nExcel ${file}: ${JSON.stringify(data.slice(0, 50))}`;
            }
            
            // PDF Files
            if (file.endsWith('.pdf')) {
                const dataBuffer = fs.readFileSync(filePath);
                const pdfData = await pdf(dataBuffer);
                context += `\nPDF ${file}: ${pdfData.text.slice(0, 2000)}`;
            }
        }
    }
    return context;
}

// --- 2. AI PROCESSING ---
async function askAI(userMsg) {
    const knowledge = await getKnowledgeBase();
    try {
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "meta-llama/llama-3.1-8b-instruct:free",
            messages: [
                { role: "system", content: knowledge },
                { role: "user", content: userMsg }
            ]
        }, {
            headers: { 'Authorization': `Bearer ${OPENROUTER_KEY}` }
        });
        return res.data.choices[0].message.content;
    } catch (e) { return "AI server thoda busy hai, baad mein try karein."; }
}

// --- 3. WEBHOOK ENDPOINT (Evolution API connects here) ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Evolution API ko turant response dein
    
    const data = req.body;
    // Check if it's a message and not sent by the bot itself
    if (data.event === "messages.upsert" && !data.data.key.fromMe) {
        const from = data.data.key.remoteJid;
        const text = data.data.message.conversation || data.data.message.extendedTextMessage?.text;

        if (!text) return;

        // Get AI Answer
        const reply = await askAI(text);

        // Send Reply via Evolution API
        try {
            await axios.post(`${EVO_API_URL}/message/sendText/${INSTANCE_NAME}`, {
                number: from.split('@')[0],
                text: reply
            }, {
                headers: { 'apikey': EVO_API_KEY }
            });
        } catch (err) { console.error("Error sending message:", err.message); }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook listener on port ${PORT}`));
