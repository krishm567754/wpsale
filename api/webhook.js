const fetch = require('node-fetch');
const XLSX  = require('xlsx');
const admin = require('firebase-admin');

// â”€â”€â”€ FIREBASE INIT (singleton) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    } catch (e) {
        console.error('Firebase init error:', e.message);
    }
    return db;
}

// â”€â”€â”€ LOAD SYSTEM PROMPT FROM FIREBASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getSystemPrompt() {
    const database = getFirebase();
    let prompt = `Tu Shri Laxmi Auto Store, Bikaner ka WhatsApp assistant hai.
Castrol distributor ke sales, stock aur outstanding payment data ke basis par jawab de.
Rules:
- Hinglish mein baat kar (Hindi + English mix).
- Jawab short & crisp â€” max 2-3 lines.
- Sirf uploaded data ke basis par baat kar.
- Agar koi PDF/file ka naam aaye toh seedha share karne ki offer karo.
- Data na mile toh: "Yeh info available nahi, Admin se contact karein."`;

    if (!database) return prompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        if (snap.exists()) prompt = snap.val();
    } catch (e) {}
    return prompt;
}

async function saveSystemPrompt(newPrompt) {
    const database = getFirebase();
    if (!database) return;
    await database.ref('botConfig/systemPrompt').set(newPrompt);
}

// â”€â”€â”€ LOAD PDF FILE LIST FROM FIREBASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getPDFList() {
    const database = getFirebase();
    if (!database) return {};
    try {
        const snap = await database.ref('botConfig/pdfFiles').get();
        return snap.exists() ? snap.val() : {};
        // Format: { "castrol_catalog": { name: "Castrol Product Catalog", url: "https://..." }, ... }
    } catch (e) { return {}; }
}

async function savePDFList(pdfData) {
    const database = getFirebase();
    if (!database) return;
    await database.ref('botConfig/pdfFiles').set(pdfData);
}

// â”€â”€â”€ LOAD EXCEL FROM GITHUB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadExcelData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return 'No Excel data configured.';

    let fileList = [];
    try {
        const r = await fetch(`${base}/index.json`);
        if (r.ok) fileList = await r.json();
    } catch (e) {}

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
        } catch (e) {}
    }
    return combined.slice(-14000) || 'No data loaded.';
}

// â”€â”€â”€ SEND MESSAGE via Evolution API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendText(to, text) {
    const base     = process.env.EVOLUTION_API_URL;   // e.g. https://your-evo.railway.app
    const instance = process.env.EVOLUTION_INSTANCE;  // instance name
    const apiKey   = process.env.EVOLUTION_API_KEY;

    await fetch(`${base}/message/sendText/${instance}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
        body: JSON.stringify({ number: to, text }),
    });
}

// â”€â”€â”€ SEND DOCUMENT/PDF via Evolution API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendDocument(to, fileUrl, fileName, caption = '') {
    const base     = process.env.EVOLUTION_API_URL;
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey   = process.env.EVOLUTION_API_KEY;

    await fetch(`${base}/message/sendMedia/${instance}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
        body: JSON.stringify({
            number:   to,
            mediatype: 'document',
            mimetype:  'application/pdf',
            media:     fileUrl,
            fileName:  fileName,
            caption:   caption,
        }),
    });
}

// â”€â”€â”€ AI REPLY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getAIReply(userMessage, excelData, pdfList, systemPrompt) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return 'OpenRouter API key missing.';

    // PDF list bhi AI ko batao taaki wo suggest kar sake
    const pdfContext = Object.keys(pdfList).length
        ? `\nAvailable PDFs/Documents:\n${Object.entries(pdfList)
            .map(([k, v]) => `- ${v.name} [keyword: ${k}]`).join('\n')}\n`
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
                    {
                        role:    'system',
                        content: `${systemPrompt}${pdfContext}\n\nBUSINESS DATA:\n${excelData}`,
                    },
                    { role: 'user', content: userMessage },
                ],
            }),
        });
        const d = await r.json();
        return d?.choices?.[0]?.message?.content?.trim() || 'Jawab nahi aaya, baad mein try karein.';
    } catch (e) {
        return 'Technical issue. Thodi der mein try karein.';
    }
}

// â”€â”€â”€ CHECK IF PDF REQUESTED â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function detectPDFRequest(text, pdfList) {
    const lower = text.toLowerCase();
    for (const [keyword, pdf] of Object.entries(pdfList)) {
        if (lower.includes(keyword.toLowerCase()) || lower.includes(pdf.name.toLowerCase())) {
            return pdf;
        }
    }
    return null;
}

// â”€â”€â”€ MAIN WEBHOOK HANDLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
module.exports = async (req, res) => {
    // Vercel ke liye hamesha 200 jaldi do
    res.status(200).json({ status: 'ok' });

    if (req.method !== 'POST') return;

    try {
        const body = req.body;

        // Evolution API webhook payload structure
        const event = body?.event;
        if (event !== 'messages.upsert') return;

        const msgData = body?.data;
        if (!msgData) return;

        const key      = msgData?.key;
        const fromMe   = key?.fromMe;
        if (fromMe) return; // apne bheje message pe react mat karo

        const from     = key?.remoteJid;                                          // sender JID
        const text     = (
            msgData?.message?.conversation ||
            msgData?.message?.extendedTextMessage?.text || ''
        ).trim();

        if (!text || !from) return;

        const isAdmin  = from.includes(process.env.ADMIN_NUMBER || '916375636354');

        // â”€â”€ ADMIN COMMANDS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        // Prompt update
        if (isAdmin && text.startsWith('!setprompt ')) {
            const newPrompt = text.replace('!setprompt ', '').trim();
            await saveSystemPrompt(newPrompt);
            await sendText(from, 'âœ… System prompt update ho gaya!');
            return;
        }

        // Status check
        if (isAdmin && text === '!status') {
            await sendText(from, `ðŸ¤– *Bot Status*\nâœ… Online (Vercel)\nðŸ“¡ Evolution API Connected\nâš¡ Webhook Active`);
            return;
        }

        // Add PDF: !addpdf keyword | File Name | https://link-to-pdf.com/file.pdf
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const [keyword, name, url] = parts;
                const pdfList = await getPDFList();
                pdfList[keyword.toLowerCase()] = { name, url };
                await savePDFList(pdfList);
                await sendText(from, `âœ… PDF added!\nKeyword: ${keyword}\nName: ${name}`);
            } else {
                await sendText(from, 'âŒ Format: !addpdf keyword | File Name | https://pdf-url');
            }
            return;
        }

        // List all PDFs: !listpdf
        if (isAdmin && text === '!listpdf') {
            const pdfList = await getPDFList();
            if (!Object.keys(pdfList).length) {
                await sendText(from, 'Koi PDF add nahi hai abhi.\n!addpdf se add karo.');
                return;
            }
            const list = Object.entries(pdfList)
                .map(([k, v]) => `ðŸ“„ ${v.name}\n   Keyword: ${k}`)
                .join('\n\n');
            await sendText(from, `ðŸ“š *Available PDFs:*\n\n${list}`);
            return;
        }

        // Remove PDF: !removepdf keyword
        if (isAdmin && text.startsWith('!removepdf ')) {
            const keyword  = text.replace('!removepdf ', '').trim().toLowerCase();
            const pdfList  = await getPDFList();
            if (pdfList[keyword]) {
                delete pdfList[keyword];
                await savePDFList(pdfList);
                await sendText(from, `âœ… PDF removed: ${keyword}`);
            } else {
                await sendText(from, `âŒ Keyword not found: ${keyword}`);
            }
            return;
        }

        // Help
        if (isAdmin && text === '!help') {
            await sendText(from, `ðŸ¤– *Admin Commands:*

!status â€” Bot status check
!setprompt [text] â€” Bot ki personality change karo

ðŸ“„ *PDF Management:*
!addpdf keyword | File Name | URL â€” PDF add karo
!listpdf â€” Saari PDFs dekho
!removepdf keyword â€” PDF hatao

ðŸ’¡ *Example:*
!addpdf catalog | Castrol Product Catalog 2025 | https://yoursite.com/catalog.pdf`);
            return;
        }

        // â”€â”€ USER MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Load data
        const [systemPrompt, excelData, pdfList] = await Promise.all([
            getSystemPrompt(),
            loadExcelData(),
            getPDFList(),
        ]);

        // Check if user is asking for a PDF directly
        const requestedPDF = detectPDFRequest(text, pdfList);
        if (requestedPDF) {
            await sendDocument(from, requestedPDF.url, requestedPDF.name, `ðŸ“„ ${requestedPDF.name}`);
            return;
        }

        // Get AI reply
        const reply = await getAIReply(text, excelData, pdfList, systemPrompt);

        // Check if AI reply suggests a PDF â€” send that too
        const suggestedPDF = detectPDFRequest(reply, pdfList);
        await sendText(from, reply);
        if (suggestedPDF) {
            await sendDocument(from, suggestedPDF.url, suggestedPDF.name, `ðŸ“„ ${suggestedPDF.name}`);
        }

    } catch (e) {
        console.error('Webhook error:', e.message);
    }
};
