const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse'); 

let db = null;
let globalCache = null;      // ✅ FAST CACHE: Har baar data download nahi karega
let lastCacheTime = 0;
let memoryPending = {};      // ✅ FALLBACK: Agar Firebase slow hua to ye yaad rakhega

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

// ✅ IMPROVED PDF PARSER (Ab koi bhi product skip nahi hoga)
function cleanPDFText(rawText) {
  if (!rawText) return '';
  // Convert double spaces/tabs to pipe (|) so AI can understand columns easily
  return rawText.replace(/[ \t]{2,}/g, ' | ').replace(/\n{3,}/g, '\n\n').slice(0, 15000); 
}

// ✅ IMPROVED SEARCH (List repeat hone wala issue fix)
function searchInvoices(query, invoiceMap) {
  const q = query.replace(/[^a-zA-Z0-9\/\- ]/g, '').toLowerCase().trim();
  
  // FIX: Agar query sirf ek ya do number hai (Jaise '1' ya '4'), toh search mat karo
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
  // ✅ CACHE SYSTEM: Har message par PDF download nahi karega (Super Fast Reply)
  if (globalCache && (Date.now() - lastCacheTime < 3600000)) { 
      return globalCache; 
  }

  const base = process.env.GITHUB_RAW_BASE;
  if (!base) return { excelData: 'Missing', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} };
  
  let fileList = []; 
  try { fileList = (await axios.get(`${base}/index.json`)).data; } catch(e) { return { excelData: 'Error', mrpPdfUrl: '', listPdfUrl: '', invoiceMap: {} }; }
  
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
  
  const lines = ['INVOICE DATABASE:','Format: InvNo|Date|Customer|Town|District|SalesExec|Products(Vol)|TotalVol|TotalWithGST|WithoutGST|CGST|SGST|Payment',''];
  const invKeys = Object.keys(invoiceMap); 
  
  for (let n = Math.max(0, invKeys.length - 100); n < invKeys.length; n++) { 
      const invNo = invKeys[n]; 
      const rows = invoiceMap[invNo]; 
      const f = rows[0]; 
      const prods = rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + '); 
      const tG = rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0); 
      const wG = rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0); 
      const cg = rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0); 
      const sg = rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0); 
      const vl = rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0); 
      lines.push(`${invNo}|${cleanDate(f['Invoice Date'])}|${f['Customer Name']}|${f['Town Name']}|${f['District Name']}|${f['Sales Executive Name']}|${prods}|${vl.toFixed(1)}L|Rs.${tG.toFixed(2)}|Rs.${wG.toFixed(2)}|Rs.${cg.toFixed(2)}|Rs.${sg.toFixed(2)}|${f['Mode Of Payement']}`); 
  }
  
  const mrpText = mrpPdfUrl ? cleanPDFText(await extractPDFText(mrpPdfUrl)) : '';
  const listText = listPdfUrl ? cleanPDFText(await extractPDFText(listPdfUrl)) : '';
  
  const excelData = [
      lines.join('\n'), 
      mrpText ? `\n\n[MRP DATA]\n${mrpText}` : '', 
      listText ? `\n\n[DLP DATA]\n${listText}` : ''
  ].join('');
  
  globalCache = { excelData, mrpPdfUrl, listPdfUrl, mrpFile, listFile, invoiceMap };
  lastCacheTime = Date.now();
  return globalCache;
}

async function getAIReply(userMsg, data, prompt) {
  const key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try { 
      const res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { 
          model: 'meta/llama-3.1-70b-instruct', 
          messages: [{ role: 'system', content: prompt + '\n\nCONTEXT DATA:\n' + data }, { role: 'user', content: userMsg }], 
          max_tokens: 600, 
          temperature: 0.1 
      }, { headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 25000 }); 
      const raw = res.data.choices[0].message.content; 
      return sanitizeReply(raw) || 'Kuch error aaya.'; 
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

    // ✅ FIXED SELECTION LOGIC: Only triggers if a list was actually sent
    if (/^\d+$/.test(text)) {
      let pending = null;
      if (database) {
        try {
          const snap = await database.ref('pending/' + safeFrom).get();
          if (snap.exists()) pending = snap.val();
        } catch (e) {}
      }
      // Backup Memory Check
      if (!pending && memoryPending[safeFrom]) pending = memoryPending[safeFrom];

      if (pending && pending.matches) {
        const idx = parseInt(text) - 1;
        if (pending.matches[idx]) {
          const m = pending.matches[idx]; const f = m.rows[0];
          const prods = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
          const tG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
          const wG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
          const cg = m.rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
          const sg = m.rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
          const vl = m.rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
          
          await sendText(from, `*Invoice:* ${m.invNo}\n*Customer:* ${f['Customer Name']}\n*Products:* ${prods}\n*Total:* Rs.${tG.toFixed(2)}\n*Total Volume:* ${vl.toFixed(1)} L\n*Tax:* CGST Rs.${cg.toFixed(2)} + SGST Rs.${sg.toFixed(2)}\n*Date:* ${cleanDate(f['Invoice Date'])}\n*Payment:* ${f['Mode Of Payement']}`);
          
          // Clear Memory so it doesn't trigger again
          if (database) await database.ref('pending/' + safeFrom).remove();
          delete memoryPending[safeFrom];
          
          return res.status(200).json({ status: 'ok' });
        } else {
          // Agar galat number dabaya
          await sendText(from, `Galat number. Sahi number chunein (1 to ${pending.matches.length}).`);
          return res.status(200).json({ status: 'ok' });
        }
      }
    }

    // ✅ ADMIN COMMANDS
    if (isAdmin && text.startsWith('!setprompt ')) { await saveSystemPrompt(text.slice(11).trim()); await sendText(from, 'Prompt update ho gaya!'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text === '!status') { await sendText(from, '*Bot Status*\nOnline'); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text.startsWith('!addpdf ')) { const parts = text.slice(8).split('|').map(s => s.trim()); if (parts.length === 3) { const list = await getPDFList(); list[parts[0].toLowerCase()] = { name: parts[1], url: parts[2] }; await savePDFList(list); await sendText(from, 'PDF added!'); } else { await sendText(from, 'Format: !addpdf keyword | Name | URL'); } return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text === '!listpdf') { const list = await getPDFList(); const txt = Object.keys(list).length === 0 ? 'No PDFs.' : Object.keys(list).map(k => `${list[k].name}\nKeyword: ${k}`).join('\n\n'); await sendText(from, `PDFs:\n\n${txt}`); return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text.startsWith('!removepdf ')) { const kw = text.slice(11).trim().toLowerCase(); const list2 = await getPDFList(); if (list2[kw]) { delete list2[kw]; await savePDFList(list2); await sendText(from, 'Removed: ' + kw); } else { await sendText(from, 'Not found'); } return res.status(200).json({ status: 'ok' }); }
    if (isAdmin && text === '!help') { await sendText(from, 'Commands: !status, !setprompt, !addpdf, !listpdf, !removepdf'); return res.status(200).json({ status: 'ok' }); }

    const lower = text.toLowerCase();
    if (['hi', 'hello', 'namaste', 'hey', 'hii', 'good morning', 'kaise ho'].some(g => lower.includes(g))) {
      await sendText(from, 'Hello! Main Krish hoon, Shri Laxmi Auto Store ki assistant. Invoice details, MRP/DLP rates, ya koi bhi query pooch sakte hain!');
      return res.status(200).json({ status: 'ok' });
    }

    const results = await Promise.all([getSystemPrompt(), loadAllData(), getPDFList()]);
    const sysPrompt = results[0]; const dataResult = results[1]; const savedPDFs = results[2];
    const intent = detectIntent(text, dataResult.mrpPdfUrl, dataResult.listPdfUrl, dataResult.mrpFile, dataResult.listFile, savedPDFs);

    if (intent.type === 'pdf') { await sendText(from, `Sending ${intent.pdf.name}...`); await sendDocument(from, intent.pdf.url, intent.pdf.name, intent.pdf.name); return res.status(200).json({ status: 'ok' }); }

    if (intent.type === 'ai_rate') {
      const aiReply = await getAIReply(text, dataResult.excelData, sysPrompt);
      if (!aiReply || aiReply.includes('Error') || aiReply.includes('missing')) { await sendText(from, 'Thoda wait karein ya product naam aur size clear likhein (e.g., Activ 4T 20W-40 900ml).'); } else { await sendText(from, aiReply); }
      return res.status(200).json({ status: 'ok' });
    }

    const matches = searchInvoices(text, dataResult.invoiceMap);
    if (matches.length === 1) {
      const m = matches[0]; const f = m.rows[0];
      const prods = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
      const tG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
      const wG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value Without GST']) || 0), 0);
      const cg = m.rows.reduce((s, r) => s + (parseFloat(r['CGST Value']) || 0), 0);
      const sg = m.rows.reduce((s, r) => s + (parseFloat(r['SGST Value']) || 0), 0);
      const vl = m.rows.reduce((s, r) => s + (parseFloat(r['Product Volume']) || 0), 0);
      await sendText(from, `*Invoice:* ${m.invNo}\n*Customer:* ${f['Customer Name']}\n*Products:* ${prods}\n*Total:* Rs.${tG.toFixed(2)}\n*Total Volume:* ${vl.toFixed(1)} L\n*Tax:* CGST Rs.${cg.toFixed(2)} + SGST Rs.${sg.toFixed(2)}\n*Date:* ${cleanDate(f['Invoice Date'])}\n*Payment:* ${f['Mode Of Payement']}`);
      return res.status(200).json({ status: 'ok' });
    } else if (matches.length > 1) {
      let msg = '*Multiple matches found. Reply with number (1, 2, 3):*\n\n';
      for (let i = 0; i < matches.length; i++) { msg += `${i + 1}. ${matches[i].customer} (Inv: ${matches[i].invNo})\n`; }
      
      // Save Pending State (Firebase + Backup Memory)
      if (database) { try { await database.ref('pending/' + safeFrom).set({ matches: matches, ts: Date.now() }); } catch (e) {} }
      memoryPending[safeFrom] = { matches: matches, ts: Date.now() };
      
      await sendText(from, msg);
      return res.status(200).json({ status: 'ok' });
    } else if (matches.length === 0 && (text.match(/^\d+$/) || text.toLowerCase().includes('inv'))) {
      // User sent random numbers that are not in list
      await sendText(from, 'Invoice nahi mila. Sahi customer name ya invoice number check karke dobara try karein.');
      return res.status(200).json({ status: 'ok' });
    }

    const aiReply = await getAIReply(text, dataResult.excelData, sysPrompt);
    if (!aiReply || aiReply.includes('Error') || aiReply.includes('missing')) { await sendText(from, 'Thoda wait karein ya clear likhein.'); } else { await sendText(from, aiReply); }
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    return res.status(200).send('System Error');
  }
};
