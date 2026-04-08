const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const XLSX = require('xlsx');

// Firebase aur Handlers
const { initFirebase, getInstructions } = require('./firebaseManager');
const { getAIReply } = require('./aiHandler');
const { sendSchemePDF } = require('./schemeHandler');

let sock = null;
let salesData = [];

// ── 1. LOCAL DATA LOADER ─────────────────────────────────────────────────────
function loadLocalSalesData() {
  try {
    const filePath = './sales.xlsx'; 
    if (fs.existsSync(filePath)) {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet);
      console.log(`📊 Local File Loaded: ${data.length} rows found.`);
      return data;
    } else {
      console.log('⚠️ sales.xlsx file repository mein nahi mili!');
      return [];
    }
  } catch (err) {
    console.error('❌ File reading error:', err);
    return [];
  }
}

// ── 2. STARTUP SEQUENCE ───────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot...');

  // Firebase initialize
  await initFirebase();
  
  // Data Load
  salesData = loadLocalSalesData();

  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    browser: ['Castrol-Bot', 'Chrome', '1.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── 3. CONNECTION HANDLER ──────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📱 SCAN THE QR CODE BELOW TO LOGIN:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ Bot is ONLINE and connected to WhatsApp!');
    }
    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting in 5 seconds...');
        setTimeout(startBot, 5000);
      } else {
        console.log('❌ Logged out. Scan QR again.');
      }
    }
  });

  // ── 4. MESSAGE HANDLER ─────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) continue;

      console.log(`📩 Message Received: "${text}" from ${sender}`);

      try {
        await sock.sendPresenceUpdate('composing', sender);

        // Instant Greeting
        const greetings = ['hi', 'hello', 'hey', 'hlo', 'namaste'];
        if (greetings.includes(text.toLowerCase())) {
            await sock.sendMessage(sender, { text: `Hello! 👋 Main Shri Laxmi Auto Store ka sales bot hoon. Aap kisi bhi party ya invoice ki detail pooch sakte hain.` });
            continue;
        }

        // Manual Reload
        if (text === '!reload') {
            salesData = loadLocalSalesData();
            await sock.sendMessage(sender, { text: `🔄 Data reloaded! Total rows: ${salesData.length}` });
            continue;
        }

        // --- FIXED: Firebase Timeout Logic ---
        let instructions;
        try {
            // Firebase agar 3 sec mein reply na de toh bypass karein
            instructions = await Promise.race([
                getInstructions(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]);
        } catch (e) {
            console.log('⚠️ Firebase slow/warning bypass: Using default instructions.');
            instructions = "You are a professional sales assistant for Shri Laxmi Auto Store, Bikaner. Answer based on data. Use Hinglish.";
        }

        // AI processing
        console.log(`🤖 AI Processing message with ${salesData.length} data rows...`);
        const reply = await getAIReply(text, salesData, "Admin", "admin", instructions);
        
        console.log(`✅ AI Replied successfully.`);
        await sock.sendMessage(sender, { text: reply });

      } catch (err) {
        console.error('❌ Message handling error:', err);
        await sock.sendMessage(sender, { text: "⚠️ Thoda technical issue hai, please ek baar phir se message karein." });
      }
    }
  });
}

startBot().catch(err => console.error('❌ Fatal error:', err));
