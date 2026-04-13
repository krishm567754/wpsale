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
                databaseURL: `https://${sa.project_id}-default-rtdb.firebaseio.com`
            });
        }
        db = admin.database();
        return db;
    } catch (e) {
        console.error('[FB] Error:', e.message);
        return null;
    }
}

async function getSystemPrompt() {
    const database = getFirebase();
    const defaultPrompt = `Tu "Laxmi" hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Sales Assistant.

INVOICE DATA Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment
MRP DATA Format: Product Name | Pack Size | MRP
LIST PRICE Format: Product Name | Pack Size | List Price/DLP

RULES:
1. Invoice number ya customer name se search karo
2. Rate query pe sirf TEXT reply do, PDF tabhi bhejo jab user explicitly "bhejo/send/share" bole
3. Amounts mein Rs. lagao
4. Hinglish mein reply, max 6 lines
5. Sirf *asterisk* use karo bold ke liye, emojis mat use karo`;

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
        try {
            await database.ref('botConfig/systemPrompt').set(p);
        } catch (e) {
            console.error('[PROMPT] Save error:', e.message);
        }
    }
}

async function getPDFList() {
    const database = getFirebase();
    if (!database) return {};
    try {
        const snap = await database.ref('botConfig/pdfFiles').get();
        return snap.exists() ? snap.val() : {};
    } catch (e) {
        return {};
    }
}

async function savePDFList(data) {
    const database = getFirebase();
    if (database) {
        try {
            await database.ref('botConfig/pdfFiles').set(data);
        } catch (e) {
            console.error('[PDF] Save error:', e.message);
        }
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

function findInvoiceDirectly(query, invoiceMap) {
    const q = query.replace(/[^a-zA-Z0-9\/\-]/g, '').toLowerCase();
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        if (invNo.toLowerCase().includes(q) || q.includes(invNo.toLowerCase())) {
            const first = rows[0];
            const products = rows.map(r => r['Product Name'] + '(' + r['Product Volume'] + 'L)').join(' + ');
            const totalGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
            const woGST = rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
            const cgst = rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
            const sgst = rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
            const vol = rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
            const date = String(first['Invoice Date'] || '').slice(0, 10);
            return '*Invoice:* ' + invNo + '\n*Customer:* ' + first['Customer Name'] + '\n*Products:* ' + products + '\n*Total (with GST):* Rs.' + totalGST.toFixed(2) + '\n*Without GST:* Rs.' + woGST.toFixed(2) + '\n*Tax:* CGST Rs.' + cgst.toFixed(2) + ' + SGST Rs.' + sgst.toFixed(2) + '\n*Volume:* ' + vol.toFixed(1) + 'L\n*Date:* ' + date + '\n*Payment:* ' + first['Mode Of Payement'];
        }
    }
    for (const [invNo, rows] of Object.entries(invoiceMap)) {
        const customer = (rows[0]['Customer Name'] || '').toLowerCase();
        if (customer.includes(q) || q.split(' ').some(w => customer.includes(w) && w.length > 3)) {
            const first = rows[0];
            const total = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
            return '*Invoice Found:* ' + invNo + '\n*Customer:* ' + first['Customer Name'] + '\n*Total:* Rs.' + total.toFixed(2) + '\n*Date:* ' + String(first['Invoice Date'] || '').slice(0, 10);
        }
    }
    return null;
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
        } catch (err) {
            console.log('[EXCEL] Skip:', f);
        }
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
        const date = String(first['Invoice Date'] || '').slice(0, 10);
        lines.push(invNo + '|' + date + '|' + first['Customer Name'] + '|' + first['Town Name'] + '|' + first['District Name'] + '|' + first['Sales Executive Name'] + '|' + products + '|' + vol.toFixed(1) + 'L|Rs.' + totalGST.toFixed(2) + '|Rs.' + woGST.toFixed(2) + '|Rs.' + cgst.toFixed(2) + '|Rs.' + sgst.toFixed(2) + '|' + first['Mode Of Payement']);
    }

    let mrpText = '';
    let listText = '';
    if (mrpPdfUrl) {
        const raw = await extractPDFText(mrpPdfUrl);
        mrpText = raw.slice(0, 6000);
    }
    if (listPdfUrl) {
        const raw = await extractPDFText(listPdfUrl);
        listText = raw.slice(0, 6000);
    }

    const excelData = [lines.join('\n'), mrpText ? '\n\nMRP PRICE DATA:\n' + mrpText : '', listText ? '\n\nLIST PRICE DATA:\n' + listText : ''].join('');
    return { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap };
}

async function getAIReply(userMsg, data, prompt) {
    const key = process.env.NVIDIA_API_KEY;
    if (!key) return 'NVIDIA_API_KEY missing.';
    try {
        const response = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
            model: 'meta/llama-3.1-70b-instruct',
            messages: [
                { role: 'system', content: prompt + '\n\n' + data },
                { role: 'user', content: userMsg }
            ],
            max_tokens: 600,
            temperature: 0.1,
            top_p: 0.95,
            stream: false
        }, {
            headers: {
                'Authorization': 'Bearer ' + key,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
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
    } catch (e) {
        console.error('[SEND] Error:', e.message);
    }
}

async function sendDocument(to, fileUrl, fileName, caption = '') {
    const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    const instance = process.env.EVOLUTION_INSTANCE;
    const apiKey = process.env.EVOLUTION_API_KEY;
    const number = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
    if (!baseUrl || !instance || !apiKey) return;
    try {
        await axios.post(baseUrl + '/message/sendMedia/' + instance, { number, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName, caption }, { headers: { 'Content-Type': 'application/json', 'apikey': apiKey } });
    } catch (e) {
        console.error('[PDF] Error:', e.message);
    }
}

function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
    const lower = text.toLowerCase().trim();
    for (const [k, v] of Object.entries(savedPDFs)) {
        if (lower.includes(k.toLowerCase()) && ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'pdf'].some(w => lower.includes(w))) {
            return { type: 'pdf', pdf: v };
        }
    }
    const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'send me', 'bhej do'];
    const mrpWords = ['mrp', 'maximum retail', 'retail price', 'mrp list', 'mrp pdf', 'mrp document'];
    const listWords = ['list price', 'dlp', 'dealer price', 'price list', 'list pdf', 'catalogue', 'list document'];
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
        if (body.data?.key?.fromMe) return res.status(200).send('Skip');
        const from = body.data.key.remoteJid;
        const text = (body.data.message?.conversation || body.data.message?.extendedTextMessage?.text || '').trim();
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
                const [keyword, name, url] = parts;
                const list = await getPDFList();
                list[keyword.toLowerCase()] = { name, url };
                await savePDFList(list);
                await sendText(from, 'PDF added! Name: ' + name + ' Keyword: ' + keyword);
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
                const txt = Object.entries(list).map(([k, v]) => v.name + '\nKeyword: ' + k).join('\n\n');
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

        const [sysPrompt, dataResult, savedPDFs] = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
        const { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap } = dataResult;
        const intent = detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs);
        console.log('[INTENT]', intent.type, '| Query:', text);

        if (intent.type === 'pdf') {
            await sendText(from, 'Sending ' + intent.pdf.name + '...');
            await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name);
            return res.status(200).json({ status: 'ok' });
        }

        if (text.match(/^(INV\/)?\d+$/i) || text.match(/^inv/i) || text.length <= 15) {
            const directResult = findInvoiceDirectly(text, invoiceMap);
            if (directResult) {
                await sendText(from, directResult);
                return res.status(200).json({ status: 'ok' });
            }
        }

        const reply = await getAIReply(text, excelData, sysPrompt);
        if (!reply || reply.includes('Error') || reply.includes('missing')) {
            await sendText(from, 'Thoda wait karein ya product/invoice number clear likhein.');
        } else {
            await sendText(from, reply);
        }
        return res.status(200).json({ status: 'ok' });
    } catch (e) {
        console.error('[WH] Fatal Error:', e.message, e.stack);
        return res.status(200).send('System Error');
    }
};
