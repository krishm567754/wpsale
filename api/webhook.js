const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');

let db = null;

function getFirebase() {
    if (db) return db;
    try {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(sa),
                databaseURL: 'https://' + sa.project_id + '-default-rtdb.firebaseio.com'
            });
        }
        db = admin.database();
        return db;
    } catch (e) {
        console.error('[FB] Init Error:', e.message);
        return null;
    }
}

async function getSystemPrompt() {
    const database = getFirebase();
    const defaultPrompt = 'Tu Laxmi hai - Shri Laxmi Auto Store, Bikaner (Castrol Distributor) ki WhatsApp Sales Assistant.\n\n' +
        'RULES:\n' +
        '1. Sirf provided data se jawab de. Kuch bhi invent mat kar.\n' +
        '2. Rate/Price query pe sirf TEXT me MRP aur DLP batao. PDF tabhi bhejna jab user explicitly bhejo/send/share/pdf bole.\n' +
        '3. Amounts ke saath Rs. lagao.\n' +
        '4. Hinglish me reply, max 6 lines.\n' +
        '5. WhatsApp bold ke liye sirf *asterisk* use karo. Emojis ya extra symbols mat use karo.\n' +
        '6. Agar data na mile: Nahi mila. Product naam ya invoice number check karke dobara try karein.';

    if (!database) return defaultPrompt;
    try {
        const snap = await database.ref('botConfig/systemPrompt').get();
        return snap.exists() ? snap.val() : defaultPrompt;
    } catch (e) {
        return defaultPrompt;
    }
}

async function saveSystemPrompt(p) {
    const database = getFirebase();
    if (database) {
        try { await database.ref('botConfig/systemPrompt').set(p); } catch (e) {}
    }
}

async function getPDFList() {
    const database = getFirebase();
    if (!database) return {};
    try {
        const snap = await database.ref('botConfig/pdfFiles').get();
        return snap.exists() ? snap.val() : {};
    } catch (e) { return {}; }
}

async function savePDFList(data) {
    const database = getFirebase();
    if (database) {
        try { await database.ref('botConfig/pdfFiles').set(data); } catch (e) {}
    }
}

function sanitizeReply(text) {
    if (!text) return '';
    return text
        .replace(/[❌✅✨🔍📄📋]/g, '')
        .replace(/\*\*/g, '*')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n').map(l => l.trim()).join('\n')
        .trim();
}

function cleanDate(val) {
    if (!val) return 'N/A';
    if (typeof val === 'number') {
        const date = new Date(Math.round((val - 25569) * 86400 * 1000));
        return date.toISOString().split('T')[0] || String(val);
    }
    return String(val).replace(/\//g, '-').slice(0, 10);
}

function searchInvoices(query, invoiceMap) {
    const q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
    let matches = [];
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const invClean = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const qClean = q.replace(/[^a-zA-Z0-9]/g, '');
        if (invClean.includes(qClean) || qClean.includes(invClean)) {
            matches.push({ type: 'invoice', invNo, rows });
        }
    }
    if (matches.length === 0) {
        for (const [invNo, rows] of Object.entries(invoiceMap)) {
            const cust = (rows[0]['Customer Name'] || '').toLowerCase();
            const words = q.split(' ').filter(w => w.length > 2);
            if (cust.includes(q) || words.some(w => cust.includes(w))) {
                matches.push({ type: 'customer', invNo, rows, customer: rows[0]['Customer Name'] });
            }
        }
    }
    return matches;
}

async function extractPDFText(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(Buffer.from(response.data));
        return data.text || '';
    } catch (e) {
        console.error('[PDF] Error:', e.message);
        return '';
    }
}

async function loadAllData() {
    const base = process.env.GITHUB_RAW_BASE;
    if (!base) return { excelData: 'Data URL missing.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };
    let fileList = [];
    try {
        const rList = await axios.get(base + '/index.json');
        fileList = rList.data;
    } catch (e) {
        console.error('[DATA] index.json error:', e.message);
        return { excelData: 'index.json error.', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };
    }
    const excelFiles = fileList.filter(f => f.match(/\.(xlsx|xls|csv)$/i));
    const mrpFile = fileList.find(f => f.toLowerCase().includes('mrp'));
    const listFile = fileList.find(f => f.toLowerCase().includes('list price') || (f.toLowerCase().includes('list') && !f.toLowerCase().includes('mrp')));
    const mrpPdfUrl = mrpFile ? base + '/' + encodeURIComponent(mrpFile) : '';
    const listPdfUrl = listFile ? base + '/' + encodeURIComponent(listFile) : '';
    let allRows = [];
    for (const f of excelFiles) {
        try {
            const rFile = await axios.get(base + '/' + encodeURIComponent(f), { responseType: 'arraybuffer' });
            const wb = XLSX.read(rFile.data, { type: 'buffer' });
            for (const s of wb.SheetNames) {
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[s], { defval: '' });
                allRows = allRows.concat(rows);
            }
        } catch (err) { console.log('[EXCEL] Skip:', f); }
    }
    const invoiceMap = {};
    for (const row of allRows) {
        const inv = row['Invoice No'] || '';
        if (!inv) continue;
        if (!invoiceMap[inv]) invoiceMap[inv] = [];
        invoiceMap[inv].push(row);
    }
    const lines = ['INVOICE DATABASE:', 'Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment', ''];
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const first = rows[0];
        const products = rows.map(r => r['Product Name'] + '(' + r['Product Volume'] + 'L)').join(' + ');
        const totalGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
        const woGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
        const cgst = rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
        const sgst = rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
        const vol = rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
        const date = cleanDate(first['Invoice Date']);
        lines.push(invNo + '|' + date + '|' + first['Customer Name'] + '|' + first['Town Name'] + '|' + first['District Name'] + '|' + first['Sales Executive Name'] + '|' + products + '|' + vol.toFixed(1) + 'L|Rs.' + totalGST.toFixed(2) + '|Rs.' + woGST.toFixed(2) + '|Rs.' + cgst.toFixed(2) + '|Rs.' + sgst.toFixed(2) + '|' + first['Mode Of Payement']);
    }
    let mrpText = '';
    let listText = '';
    if (mrpPdfUrl) { const raw = await extractPDFText(mrpPdfUrl); mrpText = raw.slice(0, 8000); }
    if (listPdfUrl) { const raw = await extractPDFText(listPdfUrl); listText = raw.slice(0, 8000); }
    const excelData = [lines.join('\n'), mrpText ? '\n\nMRP PRICE DATA:\n' + mrpText : '', listText ? '\n\nLIST PRICE/DLP DATA:\n' + listText : ''].join('');
    return { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap };
}

async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'NVIDIA_API_KEY missing.';
    try {
        const response = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model: 'meta/llama-3.1-70b-instruct',
            messages: [
                { role: 'system', content: prompt + '\n\nCONTEXT DATA:\n' + data },
                { role: 'user', content: userMsg }
            ],
            max_tokens: 600,
            temperature: 0.1,
            top_p: 0.95,
            stream: false
        }, {
            headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' },
            timeout: 25000
        });
        const raw = response.data?.choices?.[0]?.message?.content?.trim();
        return sanitizeReply(raw) || 'Kuch error aaya. Dobara try karein.';
    } catch (e) {
        console.error('[AI] Error:', e.message);
        if (e.response) return 'AI Error ' + e.response.status;
        return 'System Error: ' + e.message;
    }
}

async function sendText(to, text) {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!baseUrl || !instance || !apiKey) return;
    try {
        await axios.post(baseUrl + '/message/sendText/' + instance, { number, text }, { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } });
    } catch (e) { console.error('[SEND] Error:', e.message); }
}

async function sendDocument(to, fileUrl, fileName, caption) {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!baseUrl || !instance || !apiKey) return;
    try {
        await axios.post(baseUrl + '/message/sendMedia/' + instance, { number, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName, caption: caption || '' }, { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } });
    } catch (e) { console.error('[PDF] Error:', e.message); }
}

function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
    const lower = text.toLowerCase().trim();
    const greetings = ['hi', 'hello', 'namaste', 'hey', 'hii', 'hello ji', 'kaise ho', 'good morning'];
    if (greetings.some(g => lower.includes(g))) return { type: 'greeting' };
    for (const [k, v] of Object.entries(savedPDFs)) {
        if (lower.includes(k.toLowerCase()) && ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'pdf'].some(w => lower.includes(w))) {
            return { type: 'pdf', pdf: v };
        }
    }
    const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'send me', 'bhej do'];
    const mrpWords = ['mrp', 'maximum retail', 'retail price', 'mrp list', 'mrp pdf'];
    const listWords = ['list price', 'dlp', 'dealer price', 'price list', 'list pdf', 'catalogue'];
    const hasSend = sendWords.some(w => lower.includes(w));
    const hasMRP = mrpWords.some(w => lower.includes(w));
    const hasList = listWords.some(w => lower.includes(w));
    if (hasSend && hasMRP && mrpPdfUrl) return { type: 'pdf', pdf: { url: mrpPdfUrl, name: mrpFile || 'MRP_List.pdf' } };
    if (hasSend && hasList && listPdfUrl) return { type: 'pdf', pdf: { url: listPdfUrl, name: listFile || 'List_Price.pdf' } };
    const rateWords = ['rate', 'kya hai', 'kitna', 'price', 'mrp', 'dlp', 'kitne ka', 'cost', 'value', 'dam'];
    if (rateWords.some(w => lower.includes(w)) && !hasSend) return { type: 'ai_rate' };
    return { type: 'ai' };
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(200).send('OK');
    try {
        const body = req.body;
        if (body.event !== 'messages.upsert') return res.status(200).send('Ignored');
        if (body.data && body.data.key && body.data.key.fromMe) return res.status(200).send('Skip');
        const from = body.data.key.remoteJid;
        const text = ((body.data.message && body.data.message.conversation) || (body.data.message && body.data.message.extendedTextMessage && body.data.message.extendedTextMessage.text) || '').trim();
        if (!text || !from) return res.status(200).send('Empty');
        const adminNum = process.env.ADMIN_NUMBER || '916375636354';
        const isAdmin = from.includes(adminNum);

        if (isAdmin && text.startsWith('!setprompt ')) {
            await saveSystemPrompt(text.replace('!setprompt ', '').trim());
            await sendText(from, 'Prompt update ho gaya!');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!status') {
            await sendText(from, '*Bot Status*\nOnline\nNVIDIA Llama 3.1 70B\nEvolution API Active');
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!addpdf ')) {
            const parts = text.replace('!addpdf ', '').split('|').map(s => s.trim());
            if (parts.length === 3) {
                const keyword = parts[0]; const name = parts[1]; const url = parts[2];
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name: name, url: url };
                await savePDFList(list);
                await sendText(from, 'PDF added! Name: ' + name + ' | Keyword: ' + keyword);
            } else {
                await sendText(from, 'Format: !addpdf keyword | Name | URL');
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!listpdf') {
            const list = await getPDFList();
            if (!Object.keys(list).length) {
                await sendText(from, 'Koi PDF nahi. !addpdf se add karo.');
            } else {
                const txt = Object.entries(list).map(function(entry) { return entry[1].name + '\nKeyword: ' + entry[0]; }).join('\n\n');
                await sendText(from, 'Available PDFs:\n\n' + txt);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text.startsWith('!removepdf ')) {
            const kw = text.replace('!removepdf ', '').trim().toLowerCase();
            const list = await getPDFList();
            if (list[kw]) {
                delete list[kw];
                await savePDFList(list);
                await sendText(from, 'Removed: ' + kw);
            } else {
                await sendText(from, 'Not found: ' + kw);
            }
            return res.status(200).json({ status: 'ok' });
        }
        if (isAdmin && text === '!help') {
            await sendText(from, 'Admin Commands:\n\n!status\n!setprompt [text]\n!addpdf keyword | Name | URL\n!listpdf\n!removepdf keyword');
            return res.status(200).json({ status: 'ok' });
        }

        const database = getFirebase();
        if (database && /^\d+$/.test(text)) {
            const pendingSnap = await database.ref('pending/' + from).get();
            if (pendingSnap.exists()) {
                const pending = pendingSnap.val();
                const idx = parseInt(text) - 1;
                if (pending.matches && pending.matches[idx]) {
                    const m = pending.matches[idx];
                    const first = m.rows[0];
                    const products = m.rows.map(r => r['Product Name'] + '(' + r['Product Volume'] + 'L)').join(' + ');
                    const totalGST = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
                    const woGST = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
                    const cgst = m.rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
                    const sgst = m.rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
                    const vol = m.rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
                    const date = cleanDate(first['Invoice Date']);
                    const reply = '*Invoice:* ' + m.invNo + '\n*Customer:* ' + first['Customer Name'] + '\n*Products:* ' + products + '\n*Total (with GST):* Rs.' + totalGST.toFixed(2) + '\n*Without GST:* Rs.' + woGST.toFixed(2) + '\n*Tax:* CGST Rs.' + cgst.toFixed(2) + ' + SGST Rs.' + sgst.toFixed(2) + '\n*Volume:* ' + vol.toFixed(1) + 'L\n*Date:* ' + date + '\n*Payment:* ' + first['Mode Of Payement'];
                    await sendText(from, reply);
                    await database.ref('pending/' + from).remove();
                    return res.status(200).json({ status: 'ok' });
                }
            }
        }

        const promises = [getSystemPrompt(), loadAllData(), getPDFList()];
        const results = await Promise.all(promises);
        const sysPrompt = results[0];
        const dataResult = results[1];
        const savedPDFs = results[2];
        const excelData = dataResult.excelData;
        const mrpPdfUrl = dataResult.mrpPdfUrl;
        const listPdfUrl = dataResult.listPdfUrl;
        const mrpFile = dataResult.mrpFile;
        const listFile = dataResult.listFile;
        const invoiceMap = dataResult.invoiceMap;

        const intent = detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs);

        if (intent.type === 'greeting') {
            await sendText(from, 'Hello! Main Laxmi hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
            return res.status(200).json({ status: 'ok' });
        }

        if (intent.type === 'pdf') {
            await sendText(from, 'Sending ' + intent.pdf.name + '...');
            await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name);
            return res.status(200).json({ status: 'ok' });
        }

        const matches = searchInvoices(text, invoiceMap);
        if (matches.length === 1) {
            const m = matches[0];
            const first = m.rows[0];
            const products = m.rows.map(r => r['Product Name'] + '(' + r['Product Volume'] + 'L)').join(' + ');
            const totalGST = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
            const woGST = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
            const cgst = m.rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
            const sgst = m.rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
            const vol = m.rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
            const date = cleanDate(first['Invoice Date']);
            const reply = '*Invoice:* ' + m.invNo + '\n*Customer:* ' + first['Customer Name'] + '\n*Products:* ' + products + '\n*Total (with GST):* Rs.' + totalGST.toFixed(2) + '\n*Without GST:* Rs.' + woGST.toFixed(2) + '\n*Tax:* CGST Rs.' + cgst.toFixed(2) + ' + SGST Rs.' + sgst.toFixed(2) + '\n*Volume:* ' + vol.toFixed(1) + 'L\n*Date:* ' + date + '\n*Payment:* ' + first['Mode Of Payement'];
            await sendText(from, reply);
            return res.status(200).json({ status: 'ok' });
        } else if (matches.length > 1 && matches.length <= 5) {
            let msg = '*Multiple matches found. Reply with number (1, 2, etc.):\n\n';
            for (let i = 0; i < matches.length; i++) {
                msg += (i + 1) + '. ' + (matches[i].customer || matches[i].rows[0]['Customer Name']) + ' (Inv: ' + matches[i].invNo + ')\n';
            }
            if (database) {
                await database.ref('pending/' + from).set({ matches: matches, timestamp: Date.now() });
            }
            await sendText(from, msg);
            return res.status(200).json({ status: 'ok' });
        } else if (matches.length > 5) {
            let msg = '*Too many matches. Please refine query. Examples:\n';
            for (let i = 0; i < 3; i++) {
                msg += (i + 1) + '. ' + (matches[i].customer || matches[i].rows[0]['Customer Name']) + ' (Inv: ' + matches[i].invNo + ')\n';
            }
            await sendText(from, msg);
            return res.status(200).json({ status: 'ok' });
      
