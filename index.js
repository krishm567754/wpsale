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

// Note: firebaseManager sirf instructions aur config ke liye use ho raha hai
const { initFirebase, getInstructions } = require('./firebaseManager');
const { getAIReply } = require('./aiHandler');
const { sendSchemePDF } = require('./schemeHandler');

let sock = null;
let salesData = null;

// ── 1. NAYA DATA LOADER (GitHub se file read karne ke liye) ──────────────────
function loadLocalSalesData() {
  try {
    const filePath = './sales.xlsx'; // GitHub Root par jo file upload ki hai
    if (fs.existsSync(filePath)) {
      const workbook = XLSX.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(sheet);
      console.log(`✅ GitHub se ${data.length} rows load ho gayi hain.`);
      return data;
    } else {
      console.log('⚠️ sales.xlsx file repository mein nahi mili!');
      return [];
    }
  } catch (err) {
    console.error('❌ File read error:', err);
    return [];
  }
}

// ── STARTUP SEQUENCE ──────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot (Local File Mode)...');

  await initFirebase();
  
  // Local file se data load karein
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
    browser: ['Castrol-Sales-Bot', 'Chrome', '1.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 QR CODE SCAN KAREIN:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('✅ Bot is ONLINE!');
    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) continue;

      console.log(`📩 Message: ${text}`);

      try {
        await sock.sendPresenceUpdate('composing', sender);

        // Hi/Hello Reply
        const greetings = ['hi', 'hello', 'hey', 'hlo'];
        if (greetings.includes(text.toLowerCase())) {
            await sock.sendMessage(sender, { text: `Hello! 👋 Main Shri Laxmi Auto Store ka sales bot hoon. Aap kisi bhi party ya invoice ka detail pooch sakte hain.` });
            continue;
        }

        // Reload Command (File refresh karne ke liye)
        if (text === '!reload') {
            salesData = loadLocalSalesData();
            await sock.sendMessage(sender, { text: `🔄 Data reloaded! Total rows: ${salesData.length}` });
            continue;
        }

        // AI Reply logic
        const instructions = await getInstructions();
        const reply = await getAIReply(text, salesData, "User", "admin", instructions);
        await sock.sendMessage(sender, { text: reply });

      } catch (err) {
        console.error('⚠️ Error:', err);
      }
    }
  });
}

startBot().catch(err => console.error('❌ Fatal error:', err));
