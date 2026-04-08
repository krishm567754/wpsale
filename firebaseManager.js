const admin = require('firebase-admin');

let db = null;
let bucket = null;
let initialized = false;

// ── INIT ──────────────────────────────────────────────────────────────────────
async function initFirebase() {
  if (initialized) return;

  const serviceAccount = {
    type: 'service_account',
    project_id: 'whatsappagent-6c8e8',
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://whatsappagent-6c8e8-default-rtdb.firebaseio.com',
    storageBucket: 'whatsappagent-6c8e8.appspot.com',
  });

  db = admin.database();
  bucket = admin.storage().bucket();
  initialized = true;
  console.log('✅ Firebase initialized');
}

// ── WHITELIST ─────────────────────────────────────────────────────────────────
async function getWhitelist() {
  const snap = await db.ref('whitelist').once('value');
  return snap.val() || {};
}

async function addToWhitelist(number, role, name, execFilter = null) {
  const entry = { role, name, active: true };
  if (execFilter) entry.exec_filter = execFilter;
  await db.ref(`whitelist/${number}`).set(entry);
}

async function removeFromWhitelist(number) {
  await db.ref(`whitelist/${number}`).update({ active: false });
}

// ── INSTRUCTIONS ──────────────────────────────────────────────────────────────
async function getInstructions() {
  const snap = await db.ref('config/instructions').once('value');
  return snap.val() || getDefaultInstructions();
}

async function updateInstructions(text) {
  await db.ref('config/instructions').set(text);
}

function getDefaultInstructions() {
  return `You are a professional sales assistant for a Castrol lubricant distributor 
covering Bikaner and Churu districts in Rajasthan, India.

LANGUAGE: Reply in Hinglish (mix of Hindi and English) by default. 
If user writes in pure English, reply in English.
If user writes in pure Hindi, reply in Hindi.

TONE: Professional, friendly, and concise. Keep replies short and clear.

DATA RULES:
- Only answer based on the sales data provided to you.
- Never share one executive's data with another executive.
- Never reveal customer GSTN numbers or private financial details.
- For payment or credit related questions, always say: "Please contact the office directly."

SCHEME RULES:
- If someone asks about a scheme, explain what it is from the data.
- If they want the scheme letter/PDF, say: "Scheme letter bhejta hoon abhi!"

FORMAT:
- Use bullet points for lists.
- Show amounts in Indian Rupee format (₹).
- For totals, show both with GST and without GST.
- If data not found: "Is query ka data available nahi hai. Please office se contact karein."

DO NOT:
- Do not discuss competitor products.
- Do not make up data not in the Excel file.
- Do not answer questions unrelated to sales, Castrol products, or schemes.`;
}

// ── SCHEME FILES ──────────────────────────────────────────────────────────────
async function getSchemeFileURL(schemeCode) {
  try {
    const cleanCode = schemeCode.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
    const file = bucket.file(`schemes/${cleanCode}.pdf`);
    const [exists] = await file.exists();
    if (!exists) return null;

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000, // 1 hour
    });
    return { url, filename: `${cleanCode}.pdf` };
  } catch (err) {
    console.error('Error getting scheme URL:', err);
    return null;
  }
}

async function listSchemeFiles() {
  try {
    const [files] = await bucket.getFiles({ prefix: 'schemes/' });
    return files.map(f => f.name.replace('schemes/', '').replace('.pdf', ''));
  } catch (err) {
    return [];
  }
}

// ── SALES DATA FILE ───────────────────────────────────────────────────────────
async function getSalesFileBuffer() {
  try {
    const file = bucket.file('data/sales.xlsx');
    const [exists] = await file.exists();
    if (!exists) {
      console.log('⚠️ No sales.xlsx found in Firebase Storage at data/sales.xlsx');
      return null;
    }
    const [buffer] = await file.download();
    return buffer;
  } catch (err) {
    console.error('Error downloading sales file:', err);
    return null;
  }
}

module.exports = {
  initFirebase,
  getWhitelist,
  addToWhitelist,
  removeFromWhitelist,
  getInstructions,
  updateInstructions,
  getSchemeFileURL,
  listSchemeFiles,
  getSalesFileBuffer,
};
