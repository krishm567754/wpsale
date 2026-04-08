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

function loadLocalSalesData() {
  try {
    const filePath = './sales.xlsx'; 
    if (fs.existsSync(filePath)) {
      const workbook = XLSX.readFile(filePath);
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      console.log(`📊 Total ${data.length} rows loaded from sales.xlsx`);
      return data;
    }
    return [];
  } catch (err) { return []; }
}

async function startBot() {
  console.log('🚀 Starting Bot with Gemini 1.5 Pro support...');
  await initFirebase();
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
    browser: ['Castrol-Sales-Bot', 'Chrome', '1.0']
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

      console.log(`📩 Received: ${text}`);

      try {
        await sock.sendPresenceUpdate('composing', sender);
        
        if (text.toLowerCase() === 'hi') {
          await sock.sendMessage(sender, { text: "Hello! 👋 Main Shri Laxmi Auto Store ka bot hoon. Poochiye kis party ka data chahiye?" });
          continue;
        }

        let instructions = "You are a sales assistant. Answer in Hinglish.";
        try {
          instructions = await Promise.race([
            getInstructions(),
            new Promise((_, r) => setTimeout(() => r(), 2500))
          ]);
        } catch (e) { console.log("Using default prompt."); }

        const reply = await getAIReply(text, salesData, "Admin", "admin", instructions);
        await sock.sendMessage(sender, { text: reply });

      } catch (err) { console.error('❌ Msg Error:', err); }
    }
  });
}

startBot().catch(err => console.error('❌ Fatal:', err));
