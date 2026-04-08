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
const { initFirebase, getInstructions } = require('./firebaseManager');
const { getAIReply } = require('./aiHandler');

let sock = null;
let salesData = [];

// Local Excel Loader from GitHub Root
function loadLocalSalesData() {
  try {
    const filePath = './sales.xlsx'; 
    if (fs.existsSync(filePath)) {
      const workbook = XLSX.readFile(filePath);
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      console.log(`📊 Data Loaded: ${data.length} rows found in sales.xlsx`);
      return data;
    }
    return [];
  } catch (err) { 
    console.error('❌ Excel Read Error:', err);
    return []; 
  }
}

async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot (Gemini 2.0 Mode)...');
  
  try { await initFirebase(); } catch(e) { console.log("Firebase warning bypassed."); }
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
    browser: ['Shri-Laxmi-Bot', 'Chrome', '1.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('✅ Bot is ONLINE!');
    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const sender = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) continue;

      console.log(`📩 Received Message: ${text}`);

      try {
        await sock.sendPresenceUpdate('composing', sender);
        
        // Commands
        if (['hi','hello','hey'].includes(text.toLowerCase())) {
          await sock.sendMessage(sender, { text: "Hello! 👋 Main Shri Laxmi Auto Store ka bot hoon. Poochiye kis party ka data chahiye?" });
          continue;
        }

        if (text === '!reload') {
          salesData = loadLocalSalesData();
          await sock.sendMessage(sender, { text: `🔄 Data Reloaded! Total: ${salesData.length} rows.` });
          continue;
        }

        // Fetch instructions with timeout
        let instructions = "You are a sales assistant for Shri Laxmi Auto Store. Answer in Hinglish.";
        try {
          instructions = await Promise.race([
            getInstructions(),
            new Promise((_, r) => setTimeout(() => r(), 2500))
          ]);
        } catch (e) { console.log("Default instructions used."); }

        // Get AI Response
        const reply = await getAIReply(text, salesData, "Admin", "admin", instructions);
        await sock.sendMessage(sender, { text: reply });

      } catch (err) { console.error('❌ Error handling message:', err); }
    }
  });
}

startBot().catch(err => console.error('❌ Fatal Error:', err));
