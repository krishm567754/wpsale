// ... (Your imports remain the same)
const qrcode = require('qrcode-terminal'); 

async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot...');

  await initFirebase();
  salesData = await loadSalesData();
  salesDataLoaded = true;

  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    // 1. REMOVE: printQRInTerminal: true (This stops the error message)
    logger: pino({ level: 'silent' }),
    browser: ['Castrol-Bot', 'Chrome', '1.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── CONNECTION HANDLER ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 2. FIXED: Manually handle and print the QR code
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

    // ... (Rest of your connection and message handling remains the same)
