const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { initFirebase, getWhitelist, getInstructions } = require('./firebaseManager');
const { loadSalesData } = require('./dataLoader');
const { getAIReply } = require('./aiHandler');
const { sendSchemePDF } = require('./schemeHandler');

let sock = null;
let salesData = null;
let salesDataLoaded = false;

// ── STARTUP SEQUENCE ──────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot...');

  // Initialize Firebase with Secrets
  await initFirebase();

  // Load sales data from Firebase Storage
  console.log('📊 Loading sales data...');
  try {
    salesData = await loadSalesData();
    salesDataLoaded = true;
    console.log(`✅ Sales data loaded: ${salesData ? salesData.length : 0} rows`);
  } catch (err) {
    console.log('⚠️ Sales data could not be loaded from Storage.');
  }

  // Session handling
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

  // ── CONNECTION HANDLER (QR CODE) ────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Display QR in Terminal manually
    if (qr) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📱 SCAN THE QR CODE BELOW TO LOGIN:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      qrcode.generate(qr, { small: true });
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }

    if (connection === 'open') {
      console.log('✅ Bot is ONLINE and connected to WhatsApp!');
    }

    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        setTimeout(startBot, 5000);
      } else {
        console.log('❌ Logged out. Please delete session_data and scan again.');
      }
    }
  });

  // ── MESSAGE HANDLER ───────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = msg.key.remoteJid;
      const senderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

      if (!text) continue;

      try {
        // Whitelist validation from Firebase
        const whitelist = await getWhitelist();
        const userEntry = whitelist[senderNumber];

        if (!userEntry || !userEntry.active) {
            console.log(`🚫 Blocked: ${senderNumber}`);
            continue;
        }

        const role = userEntry.role;
        const userName = userEntry.name;
        const execFilter = userEntry.exec_filter || null;

        await sock.sendPresenceUpdate('composing', sender);

        // 1. GREETING HANDLER (Instant Reply for Hi/Hello)
        const greetings = ['hi', 'hello', 'hey', 'namaste', 'hlo', 'hii', 'shri laxmi'];
        if (greetings.includes(text.toLowerCase())) {
            const welcomeMsg = `Hello ${userName}! 👋\n\nMain Shri Laxmi Auto Store ka sales assistant hoon.\nAap mujhse sales data ya schemes ke baare mein pooch sakte hain.\n\nMain aapki kya madad kar sakta hoon?`;
            await sock.sendMessage(sender, { text: welcomeMsg });
            console.log(`✅ Greeting sent to ${userName}`);
            continue;
        }

        // 2. ADMIN COMMANDS
        if (role === 'admin') {
            if (text.toLowerCase() === '!reload') {
                salesData = await loadSalesData();
                await sock.sendMessage(sender, { text: `✅ Data reloaded: ${salesData.length} rows.` });
                continue;
            }
        }

        // 3. SCHEME PDF HANDLER
        const isSchemeRequest = ['scheme', 'letter', 'pdf'].some(k => text.toLowerCase().includes(k));
        if (isSchemeRequest) {
          const sent = await sendSchemePDF(sock, sender, text);
          if (sent) continue;
        }

        // 4. DATA FILTER & AI REPLY
        let filteredData = salesData || [];
        if (role === 'executive' && execFilter) {
          filteredData = salesData.filter(row => row['Sales Executive Name']?.toString().toLowerCase() === execFilter.toLowerCase());
        }

        const instructions = await getInstructions();
        const reply = await getAIReply(text, filteredData, userName, role, instructions);

        await sock.sendMessage(sender, { text: reply });
        console.log(`✅ Replied to ${userName}`);

      } catch (err) {
        console.error('⚠️ Message Error:', err);
      }
    }
  });
}

startBot().catch(err => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});
