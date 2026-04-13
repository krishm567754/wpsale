const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse'); 

let db = null;
let globalCache = null;      
let lastCacheTime = 0;
let memoryPending = {};      // Bot ki Memory (Option 1, 2 chunne ke liye)

function getFirebase() {
  if (db) return db;
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: 'https://' + sa.project_id + '-default-rtdb.firebaseio.com' });
    }
    db = admin.database();
    return db;
  } catch (e) { console.error('[FB] Err:', e.message); return null; }
}

function sanitizePath(str) { return str.replace(/[@.\[\]#\$\/]/g, '_'); }

async function getSystemPrompt() {
  const d = getFirebase();
  const def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf provided data se jawab de. Kuch bhi invent mat kar.\n2. MRP vs DLP: Agar "MRP" bola to SIRF [MRP DATA] se rate batao. "DLP/List Price" bola to SIRF [DLP DATA] se batao.\n3. Size EXACT match karo (900ML, 1L, 4.5L, etc).\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y (sirf agar DLP pucha ho)\n5. Amounts me Rs. lagao. Hinglish, max 5 lines. Sirf * use karo bold ke liye.';
  if (!d) return def;
  try { const s = await d.ref('botConfig/systemPrompt').get(); return s.exists() ? s.val() : def; } catch (e) { return def; }
}

async function saveSystemPrompt(p) { const d = getFirebase(); if (d) { try { await d.ref('botConfig/systemPrompt').set(p); } catch(e){} } }
async function getPDFList() { const d = getFirebase(); if (!d) return {}; try { const s = await d.ref('botConfig/pdfFiles').get(); return s.exists() ? s.val() : {}; } catch(e){ return {}; } }
async function savePDFList(data) { const d = getFirebase(); if (d) { try { await d.ref('botConfig/pdfFiles').set(data); } catch(e){} } }

function sanitizeReply(t) {
  if (!t) return '';
  return t.replace(/[❌✅✨🔍📄📋]/g, '').replace(/\*\*/g, '*').replace(/\n{3,}/g, '\n\n').split('\n').map(l => l.trim()).join('\n').trim();
}

function cleanDate(val) {
  if (!val) return 'N/A';
  if (typeof val === 'number') { const dt = new Date(Math.round((val - 25569) * 86400000)); return dt.toISOString().split('T')[0]; }
  return String(val).replace(/\//g, '-').slice(0, 10);
}

// ✅ IMPROVED PDF TEXT FORMATTER
function cleanPDFText(rawText) {
  if (!rawText) return '';
  // Spaces ko | me badalta hai taaki AI table asani se padh sake
  return rawText.replace(/[ \t]{2,}/g, ' | ').replace(/\n{3,}/g, '\n\n').slice(0, 20000); 
}

// ✅ NEW: SMART PRODUCT SEARCH (MRP/DLP Accuracy ke liye)
function searchProducts(query, mrpText, dlpText) {
  let q = query.replace(/[^a-zA-Z0-9 ]/g, '').toLowerCase().trim();
  if (/^\d{1,2}$/.test(q) || q.length < 3) return []; // Ignore single numbers
  
  let keywords = q.split(' ').filter(w => w.length > 2 && !['price', 'rate', 'mrp', 'dlp', 'kya', 'hai', 'batao'].includes(w));
  if (keywords.length === 0) return [];

  let products = [];
  let seenNames = new Set();

  const scanText = (text, type) => {
      if (!text) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
          let lower = lines[i].toLowerCase();
          if (lower.includes('brand name') || lower.includes('passenger car')) continue;
          
          if (keywords.every(k => lower.includes(k))) {
              // Product ka naam extract karna (Pehle | se pehle ka text)
              let name = lines[i].split(/[|,]/)[0].replace(/"/g, '').trim();
              if (name.length > 3 && !seenNames.has(name.toLowerCase())) {
                  seenNames.add(name.toLowerCase());
                  
                  // AI ko exactly Header + Line dene ke liye 10 line upar ka chunk
                  let start = Math.max(0, i - 10);
                  let end = Math.min(lines.length, i + 3);
                  let chunk = lines.slice(start, end).join('\n');
                  
                  products.push({
                      name: name,
                      mrpChunk: type === 'MRP' ? chunk : '',
                      dlpChunk: type === 'DLP' ? chunk : ''
                  });
              } else if (name.length > 3) {
                  let existing = products.find(p => p.name.toLowerCase() === name.toLowerCase());
                  if (existing) {
                      let start = Math.max(0, i - 10);
                      let end = Math.min(lines.length, i + 3);
                      let chunk = lines.slice(start, end).join('\n');
                      if (type === 'MRP') existing.mrpChunk = chunk;
                      if (type === 'DLP') existing.dlpChunk = chunk;
                  }
              }
          }
      }
  };

  scanText(mrpText, 'MRP');
  scanText(dlpText, 'DLP');
  return products.slice(0, 6); // Max 6 options dikhayega
}

function searchInvoices(query, invoiceMap) {
  const q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
  if (/^\d{1,2}$/.test(q) || q.length < 3) return [];

  const matches = []; 
  const keys = Object.keys(invoiceMap);
  let userKeywords = q.split(' ').filter(w => w.length > 3);
  if (userKeywords.length === 0) userKeywords = [q];

  for (let i = 0; i < keys.length; i++) {
    const invNo = keys[i]; 
    const rows = invoiceMap[invNo];
    const custName = (rows[0]['Customer Name'] || '').toLowerCase();
    
    const matchInv = invNo.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().includes(q.replace(/[^a-zA-Z0-9]/g, ''));
    let keywordScore = 0;
    for (let k = 0; k < userKeywords.length; k++) { 
        if (custName.includes(userKeywords[k])) keywordScore++; 
    }
    
    if (matchInv || keywordScore > 0) { 
        matches.push({ invNo, rows, customer: rows[0]['Customer Name'], score: matchInv ? 10 : keywordScore }); 
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

async function extractPDFText(url) {
  try { 
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 }); 
      const data = await pdfParse(Buffer.from(res.data)); 
      return data.text || ''; 
  } catch (e) { 
      console.error('[PDF] Err:', e.message); return ''; 
  }
}

async function loadAllData() {
  if (globalCache && (Date.now() - lastCacheTime < 3600000)) return globalCache; 

  const base = process.env.GITHUB_RAW_BASE;
  if (!base) return { excelData: '', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {}, mrpTextRaw: '', listTextRaw: '' };
  
  let fileList = []; 
  try { fileList = (await axios.get(`${base}/index.json`)).data; } catch(e) { return null; }
  
  const excelFiles = fileList.filter(f => f.match(/\.(xlsx|xls|csv)$/i));
  const mrpFile = fileList.find(f => f.toLowerCase().includes('mrp'));
  const listFile = fileList.find(f => f.toLowerCase().includes('list') && !f.toLowerCase().includes('mrp'));
  
  const mrpPdfUrl = mrpFile ? `${base}/${encodeURIComponent(mrpFile)}` : '';
  const listPdfUrl = listFile ? `${base}/${encodeURIComponent(listFile)}` : '';
  
  let allRows = [];
  for (let k = 0; k < excelFiles.length; k++) {
    try { 
        const res = await axios.get(`${base}/${encodeURIComponent(excelFiles[k])}`, {responseType:'arraybuffer'});
        const wb = XLSX.read(res.data, {type:'buffer'}); 
        for (let s = 0; s < wb.SheetNames.length; s++) { 
            allRows = allRows.concat(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[s]], {defval:''})); 
        } 
    } catch(e){}
  }
  
  const invoiceMap = {}; 
  for (let m = 0; m < allRows.length; m++) { 
      const inv = allRows[m]['Invoice No'] || ''; 
      if(inv) {
          if(!invoiceMap[inv]) invoiceMap[inv] = []; 
          invoiceMap[inv].push(allRows[m]);
      } 
  }
  
  const mrpTextRaw = mrpPdfUrl ? cleanPDFText(await extractPDFText(mrpPdfUrl)) : '';
  const listTextRaw = listPdfUrl ? cleanPDFText(await extractPDFText(listPdfUrl)) : '';
  
  globalCache = { mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap, mrpTextRaw, listTextRaw };
  lastCacheTime = Date.now();
  return globalCache;
}

// —— AI CALL (Llama 70B via NVIDIA) ——
async function getAIReply(userMsg, data, prompt) {
  const key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try { 
      const res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { 
          model: 'meta/llama-3.1-70b-instruct', 
          messages: [
              { role: 'system', content: prompt + '\n\nCarefully look at the table headers above the product to determine the sizes.\n\nCONTEXT DATA:\n' + data }, 
              { role: 'user', content: userMsg }
          ], 
          max_tokens: 600, 
          temperature: 0.1 
      }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 }); 
      return sanitizeReply(res.data.choices[0].message.content) || 'Kuch error aaya.'; 
  } catch (e) { return 'System Error: ' + e.message; }
}

async function sendText(to, text) {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); 
  const inst = process.env.EVOLUTION_INSTANCE; 
  const key = process.env.EVOLUTION_API_KEY; 
  const num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(`${baseUrl}/message/sendText/${inst}`, { number: num, text: text }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) { console.error('[SEND] Err:', e.message); }
}

async function sendDocument(to, fileUrl, fileName, caption) {
  const baseUrl = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''); 
  const inst = process.env.EVOLUTION_INSTANCE; 
  const key = process.env.EVOLUTION_API_KEY; 
  const num = to.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  if (!baseUrl || !inst || !key) return;
  try { await axios.post(`${baseUrl}/message/sendMedia/${inst}`, { number: num, mediatype: 'document', mimetype: 'application/pdf', media: fileUrl, fileName: fileName, caption: caption || '' }, { headers: { 'Content-Type': 'application/json', 'apikey': key } }); } catch (e) { console.error('[PDF] Err:', e.message); }
}

function detectIntent(text, mrpPdfUrl, listPdfUrl, mrpFile, listFile, savedPDFs) {
  const lower = text.toLowerCase().trim();
  const sendWords = ['send', 'bhejo', 'share', 'bhej', 'de do', 'dedo', 'chahiye', 'pdf'];
  const hasSend = sendWords.some(w => lower.includes(w));
  const hasMRP = ['mrp', 'maximum retail'].some(w => lower.includes(w));
  const hasList = ['list price', 'dlp', 'dealer price'].some(w => lower.includes(w));
  
  if (hasSend && hasMRP && mrpPdfUrl) return { type: 'pdf', pdf: { url: mrpPdfUrl, name: mrpFile || 'MRP_List.pdf' } };
  if (hasSend && hasList && listPdfUrl) return { type: 'pdf', pdf: { url: listPdfUrl, name: listFile || 'List_Price.pdf' } };
  
  for (const k in savedPDFs) { if (lower.includes(k.toLowerCase()) && hasSend) return { type: 'pdf', pdf: savedPDFs[k] }; }
  
  const isRateQuery = ['rate', 'kya hai', 'kitna', 'price', 'mrp', 'dlp', 'kitne ka', 'dam', 'rupay'].some(w => lower.includes(w));
  if (isRateQuery && !hasSend) return { type: 'ai_rate' };
  return { type: 'ai' };
}

module.exports = async function(req, res) {
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
    const safeFrom = sanitizePath(from);
    const database = getFirebase();

    const results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
    const sysPrompt = results[0]; const dataResult = results[1] || {}; const savedPDFs = results[2];

    // ✅ FIXED: SELECTION LOGIC (For 1, 2, 3...)
    if (/^\d+$/.test(text)) {
      let pending = null;
      if (database) {
        try {
          const snap = await database.ref('pending/' + safeFrom).get();
          if (snap.exists()) pending = snap.val();
        } catch (e) {}
      }
      if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];

      if (pending && pending.matches) {
        const idx = parseInt(text) - 1;
        if (pending.matches[idx]) {
          
          if (pending.type === 'invoice') {
              const m = pending.matches[idx]; const f = m.rows[0];
              const prods = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
              const tG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
              await sendText(from, `*Invoice:* ${m.invNo}\n*Customer:* ${f['Customer Name']}\n*Products:* ${prods}\n*Total:* Rs.${tG.toFixed(2)}\n*Date:* ${cleanDate(f['Invoice Date'])}\n*Payment:* ${f['Mode Of Payement']}`);
          } 
          else if (pending.type === 'product') {
              const p = pending.matches[idx];
              const context = `Product: ${p.name}\n\n[MRP TABLE]\n${p.mrpChunk}\n\n[DLP TABLE]\n${p.dlpChunk}`;
              const aiReply = await getAIReply("User selected this product. Provide exact rates.", context, sysPrompt);
              await sendText(from, aiReply);
          }

          if (database) await database.ref('pending/' + safeFrom).remove();
          delete memoryPending[safeFrom];
          return res.status(200).json({ status: 'ok' });
        } else {
          await sendText(from, `Galat number. Sahi number chunein (1 to ${pending.matches.length}).`);
          return res.status(200).json({ status: 'ok' });
        }
      }
    }

    // ✅ ADMIN COMMANDS
    if (isAdmin && text.startsWith('!setprompt ')) { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text === '!status') { await sendText(from, '*Bot Status*\nOnline'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text.startsWith('!addpdf ')) { const parts = text.slice(8).split('|').map(s => s.trim()); if (parts.length === 3) { const list = await getPDFList(); list[parts[0].toLowerCase()] = { name: parts[1], url: parts[2] }; await savePDFList(list); await sendText(from, 'PDF added!'); } else { await sendText(from, 'Format: !addpdf keyword | Name | URL'); } return res.status(200).json({ status: 'ok' }); }

    const lower = text.toLowerCase();
    if (['hi', 'hello', 'namaste', 'hey', 'hii', 'good morning', 'kaise ho'].some(g => lower.includes(g))) {
      await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
      return res.status(200).json({ status: 'ok' });
    }

    const intent = detectIntent(text, dataResult.mrpPdfUrl, dataResult.listPdfUrl, dataResult.mrpFile, dataResult.listFile, savedPDFs);

    if (intent.type === 'pdf') { await sendText(from, `Sending ${intent.pdf.name}...`); await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name); return res.status(200).json({ status: 'ok' }); }

    // ✅ FIXED: SMART RATE QUERY HANDLING
    if (intent.type === 'ai_rate') {
      const prodMatches = searchProducts(text, dataResult.mrpTextRaw, dataResult.listTextRaw);
      
      if (prodMatches.length === 1) {
          // Exactly 1 match found
          const p = prodMatches[0];
          const context = `[MRP TABLE CHUNK]\n${p.mrpChunk}\n\n[DLP TABLE CHUNK]\n${p.dlpChunk}`;
          const aiReply = await getAIReply(text, context, sysPrompt);
          await sendText(from, aiReply);
          return res.status(200).json({ status: 'ok' });
      } else if (prodMatches.length > 1) {
          // Multiple matches found - Ask User
          let msg = '*Kaunsa product check karna hai? Number reply karein:*\n\n';
          for (let i = 0; i < prodMatches.length; i++) { msg += `${i + 1}. ${prodMatches[i].name}\n`; }
          
          if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'product', matches: prodMatches, ts: Date.now() }); } catch (e) {} }
          memoryPending[safeFrom] = { type: 'product', matches: prodMatches, ts: Date.now() };
          
          await sendText(from, msg);
          return res.status(200).json({ status: 'ok' });
      } else {
          await sendText(from, 'Ye product list mein nahi mila. Spelling check karke dobara try karein.');
          return res.status(200).json({ status: 'ok' });
      }
    }

    // ✅ FIXED: INVOICE SEARCH
    const matches = searchInvoices(text, dataResult.invoiceMap);
    if (matches.length === 1) {
      const m = matches[0]; const f = m.rows[0];
      const prods = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
      const tG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
      await sendText(from, `*Invoice:* ${m.invNo}\n*Customer:* ${f['Customer Name']}\n*Products:* ${prods}\n*Total:* Rs.${tG.toFixed(2)}\n*Date:* ${cleanDate(f['Invoice Date'])}\n*Payment:* ${f['Mode Of Payement']}`);
      return res.status(200).json({ status: 'ok' });
    } else if (matches.length > 1) {
      let msg = '*Multiple invoices found. Number reply karein:*\n\n';
      for (let i = 0; i < matches.length; i++) { msg += `${i + 1}. ${matches[i].customer} (Inv: ${matches[i].invNo})\n`; }
      
      if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'invoice', matches: matches, ts: Date.now() }); } catch (e) {} }
      memoryPending[safeFrom] = { type: 'invoice', matches: matches, ts: Date.now() };
      
      await sendText(from, msg);
      return res.status(200).json({ status: 'ok' });
    } else if (matches.length === 0 && (text.match(/^\d+$/) || text.toLowerCase().includes('inv'))) {
      await sendText(from, 'Invoice nahi mila. Sahi details daalein.');
      return res.status(200).json({ status: 'ok' });
    }

    await sendText(from, 'Main sirf Invoices aur Product Rates (MRP/DLP) batane ke liye bani hoon. Sahi sawal puchein.');
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
