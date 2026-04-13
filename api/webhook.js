const axios = require('axios');
const XLSX = require('xlsx');
const admin = require('firebase-admin');
const pdfParse = require('pdf-parse'); 

let db = null;
let globalCache = null;      
let lastCacheTime = 0;
let memoryPending = {};      

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
  const def = 'Tu Krish hai - Shri Laxmi Auto Store, Bikaner ki WhatsApp Assistant.\n\nSTRICT RULES:\n1. Sirf data se exact rate batao. 0.9L ka matlab 900ml hai, dono ek hi baat hain.\n2. MRP vs DLP: "MRP" ke liye SIRF [MRP DATA] aur "DLP" ke liye SIRF [DLP DATA] dekhein.\n3. Exact Size ki value batayein.\n4. Format: *Product:* Name (Size)\n*MRP:* Rs.X\n*DLP:* Rs.Y\n5. Text Hinglish me rakho aur directly jawab do.';
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

// ✅ FIX: Protects newlines inside Quotes (Perfect CSV reading)
function cleanPDFText(rawText) {
  if (!rawText) return '';
  let cleaned = '';
  let inQuotes = false;
  for (let i = 0; i < rawText.length; i++) {
      if (rawText[i] === '"') inQuotes = !inQuotes;
      if (rawText[i] === '\n' && inQuotes) {
          cleaned += ' '; // Convert inner newlines to spaces so table rows don't break
      } else {
          cleaned += rawText[i];
      }
  }
  return cleaned;
}

// ✅ FIX: Strict CSV Column Parser (Prevents Alignment Errors)
function parseCSVLine(line) {
  let cols = [];
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < line.length; i++) {
      let char = line[i];
      if (char === '"') {
          inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
          cols.push(current.trim());
          current = '';
      } else {
          current += char;
      }
  }
  cols.push(current.trim());
  return cols.map(c => c.trim());
}

// ✅ HYPER-SMART MAPPER (Links exact size to exact price)
function searchProducts(query, mrpTextRaw, dlpTextRaw) {
  let q = query.toLowerCase().replace(/[^a-z0-9]/g, ' '); 
  let words = q.split(/\s+/);
  let stopWords = ['price', 'rate', 'mrp', 'dlp', 'kya', 'hai', 'batao', 'aur', 'ka', 'ke', 'liye', 'ye', 'pucha'];
  let searchTerms = words.filter(w => w.length > 1 && !stopWords.includes(w));
  
  if (searchTerms.length === 0) return [];

  let products = [];
  let seenNames = new Set();

  const scanText = (text, type) => {
      if (!text) return;
      const lines = text.split('\n');
      let currentHeaders = [];

      for (let i = 0; i < lines.length; i++) {
          let line = lines[i].trim();
          if (!line) continue;
          
          let lower = line.toLowerCase();
          
          if (lower.includes('brand name')) {
              currentHeaders = parseCSVLine(line);
              continue;
          }
          
          if (currentHeaders.length === 0) continue;

          let cols = parseCSVLine(line);
          if (cols.length < 2) continue;

          let name = cols[0].replace(/"/g, '').trim();
          if (name.length < 4 || lower.includes('passenger car') || lower.includes('diesel engine')) continue;

          let nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, ' ');
          let exactNameMatches = searchTerms.filter(t => nameNorm.includes(t)).length;
          let requiredMatches = Math.min(2, Math.max(1, searchTerms.length - 1));

          if (exactNameMatches >= requiredMatches) {
              // Yahan par hum Size aur Price ka exact Joda (Pair) bana rahe hain!
              let chunkLines = [`Product: ${name}`];
              for (let c = 1; c < cols.length && c < currentHeaders.length; c++) {
                  if (cols[c] && cols[c] !== '') {
                      let sizeHeader = currentHeaders[c].replace(/\s+/g, ' ').replace(/"/g, '').trim();
                      
                      // OCR Fixes for exact matching
                      sizeHeader = sizeHeader.replace(/^11$/, '1L')
                                             .replace(/^51$/, '5L')
                                             .replace(/^71$/, '7L')
                                             .replace(/^31$/, '3L')
                                             .replace(/^2\.51$/, '2.5L')
                                             .replace(/1\.2\/\s*11/, '1.2L / 1L')
                                             .replace(/\/$/, 'L');

                      chunkLines.push(`- Size [${sizeHeader}] : Rs. ${cols[c]}`);
                  }
              }
              let chunk = chunkLines.join('\n');

              if (!seenNames.has(name.toLowerCase())) {
                  seenNames.add(name.toLowerCase());
                  products.push({
                      name: name,
                      score: exactNameMatches,
                      mrpChunk: type === 'MRP' ? chunk : '',
                      dlpChunk: type === 'DLP' ? chunk : ''
                  });
              } else {
                  let existing = products.find(p => p.name.toLowerCase() === name.toLowerCase());
                  if (existing) {
                      if (type === 'MRP') existing.mrpChunk = chunk;
                      if (type === 'DLP') existing.dlpChunk = chunk;
                      if (exactNameMatches > existing.score) existing.score = exactNameMatches;
                  }
              }
          }
      }
  };

  scanText(mrpTextRaw, 'MRP');
  scanText(dlpTextRaw, 'DLP');
  
  return products.sort((a,b) => b.score - a.score).slice(0, 5); 
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

// —— AI CALL ——
async function getAIReply(userMsg, data, prompt) {
  const key = process.env.NVIDIA_API_KEY; if (!key) return 'NVIDIA_API_KEY missing.';
  try { 
      const res = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', { 
          model: 'meta/llama-3.1-70b-instruct', 
          messages: [
              { role: 'system', content: prompt + '\n\nMatch the size explicitly from the formatted table below. 0.9L = 900ml.\n\nCONTEXT DATA:\n' + data }, 
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

    // ✅ RECALL SYSTEM (When user types 1, 2, 3...)
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
              const context = `[MRP DATA]\n${p.mrpChunk}\n\n[DLP DATA]\n${p.dlpChunk}`;
              const aiPrompt = `User's ORIGINAL query was: "${pending.originalQuery}". \nNow User selected Product: ${p.name}. Give exact MRP and DLP for the SPECIFIC SIZE they originally asked for. Note: 0.9L is equal to 900ml.`;
              
              const aiReply = await getAIReply(aiPrompt, context, sysPrompt);
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

    // ✅ EXACT RATE & INVOICE SEARCH
    const prodMatches = searchProducts(text, dataResult.mrpTextRaw, dataResult.listTextRaw);
    const invMatches = searchInvoices(text, dataResult.invoiceMap);

    const isRateQuery = ['rate', 'kya hai', 'kitna', 'price', 'mrp', 'dlp', 'kitne ka', 'dam', 'rupay', 'batao'].some(w => lower.includes(w));
    
    if (isRateQuery || (prodMatches.length > 0 && invMatches.length === 0)) {
        if (prodMatches.length === 1) {
            const p = prodMatches[0];
            const context = `[MRP DATA]\n${p.mrpChunk}\n\n[DLP DATA]\n${p.dlpChunk}`;
            const aiReply = await getAIReply(`User Query: ${text}\nGive exact MRP and DLP for the specified size.`, context, sysPrompt);
            await sendText(from, aiReply);
            return res.status(200).json({ status: 'ok' });
        } else if (prodMatches.length > 1) {
            let msg = '*Kaunsa product check karna hai? Number reply karein:*\n\n';
            for (let i = 0; i < prodMatches.length; i++) { msg += `${i + 1}. ${prodMatches[i].name}\n`; }
            
            if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() }); } catch (e) {} }
            memoryPending[safeFrom] = { type: 'product', matches: prodMatches, originalQuery: text, ts: Date.now() };
            
            await sendText(from, msg);
            return res.status(200).json({ status: 'ok' });
        } else {
            await sendText(from, 'Ye product list mein nahi mila. Spelling check karke dobara try karein.');
            return res.status(200).json({ status: 'ok' });
        }
    }

    if (invMatches.length === 1) {
      const m = invMatches[0]; const f = m.rows[0];
      const prods = m.rows.map(r => `${r['Product Name']}(${r['Product Volume']}L)`).join(' + ');
      const tG = m.rows.reduce((s, r) => s + (parseFloat(r['Total Value incl VAT/GST']) || 0), 0);
      await sendText(from, `*Invoice:* ${m.invNo}\n*Customer:* ${f['Customer Name']}\n*Products:* ${prods}\n*Total:* Rs.${tG.toFixed(2)}\n*Date:* ${cleanDate(f['Invoice Date'])}\n*Payment:* ${f['Mode Of Payement']}`);
      return res.status(200).json({ status: 'ok' });
    } else if (invMatches.length > 1) {
      let msg = '*Multiple invoices found. Number reply karein:*\n\n';
      for (let i = 0; i < invMatches.length; i++) { msg += `${i + 1}. ${invMatches[i].customer} (Inv: ${invMatches[i].invNo})\n`; }
      
      if (database) { try { await database.ref('pending/' + safeFrom).set({ type: 'invoice', matches: invMatches, ts: Date.now() }); } catch (e) {} }
      memoryPending[safeFrom] = { type: 'invoice', matches: invMatches, ts: Date.now() };
      
      await sendText(from, msg);
      return res.status(200).json({ status: 'ok' });
    } else if (invMatches.length === 0 && (text.match(/^\d+$/) || text.toLowerCase().includes('inv'))) {
      await sendText(from, 'Invoice nahi mila. Sahi details daalein.');
      return res.status(200).json({ status: 'ok' });
    }

    await sendText(from, 'Main sirf Invoices aur Product Rates (MRP/DLP) batane ke liye bani hoon. Sahi sawal puchein.');
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('[WH] Fatal:', e.message, e.stack);
    
