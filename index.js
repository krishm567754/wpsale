const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { initFirebase, getInstructions } = require('./firebaseManager');
const { loadSalesData } = require('./dataLoader');
const { getAIReply } = require('./aiHandler');
const { sendSchemePDF } = require('./schemeHandler');

let sock = null;
let salesData = null;
let salesDataLoaded = false;

// ── STARTUP SEQUENCE ──────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Bot without Whitelist for testing...');

  await initFirebase();

  // Load sales data
  try {
    salesData = await loadSalesData();
    salesDataLoaded = true;
    console.log(`✅ Sales data loaded: ${salesData ? salesData.length : 0} rows`);
  } catch (err) {
    console.log('⚠️ Sales data load failed, but bot will continue.');
  }

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

  // ── CONNECTION HANDLER ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📱 SCAN THE QR CODE BELOW TO LOGIN:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      qrcode.generate(qr, { small: true });
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    if (connection === 'open') {
      console.log('✅ Bot is ONLINE! Whitelist is currently DISABLED.');
    }

    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        setTimeout(startBot, 5000);
      } else {
        console.log('❌ Logged out.');
      }
    }
  });

  // ── MESSAGE HANDLER (WHITELIST REMOVED) ───────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      const senderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

      if (!text) continue;

      // DIAGNOSTIC LOG
      console.log(`📩 Message from ${senderNumber}: ${text}`);

      try {
        await sock.sendPresenceUpdate('composing', sender);

        // 1. GREETING HANDLER
        const greetings = ['hi', 'hello', 'hey', 'namaste', 'hlo'];
        if (greetings.includes(text.toLowerCase())) {
            await sock.sendMessage(sender, { text: `Hello! 👋 Whitelist disabled hai. Main aapka message dekh raha hoon: "${text}"` });
            continue;
        }

        // 2. SCHEME PDF HANDLER
        const isSchemeRequest = ['scheme', 'letter', 'pdf'].some(k => text.toLowerCase().includes(k));
        if (isSchemeRequest) {
          const sent = await sendSchemePDF(sock, sender, text);
          if (sent) continue;
        }

        // 3. AI REPLY (Using full data because whitelist is off)
        const instructions = await getInstructions();
        const reply = await getAIReply(text, salesData || [], "Tester", "admin", instructions);

        await sock.sendMessage(sender, { text: reply });
        console.log(`✅ Replied to ${senderNumber}`);

      } catch (err) {
        console.error('⚠️ Error:', err);
      }
    }
  });
}

startBot().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
