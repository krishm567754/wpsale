const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { initFirebase, getWhitelist, getInstructions, saveSession, loadSession } = require('./firebaseManager');
const { loadSalesData } = require('./dataLoader');
const { getAIReply } = require('./aiHandler');
const { sendSchemePDF } = require('./schemeHandler');

let sock = null;
let salesData = null;
let salesDataLoaded = false;

// ── STARTUP ──────────────────────────────────────────────────────────────────
async function startBot() {
  console.log('🚀 Starting Castrol Sales Bot...');

  await initFirebase();

  // Load sales data from Firebase Storage
  console.log('📊 Loading sales data...');
  salesData = await loadSalesData();
  salesDataLoaded = true;
  console.log(`✅ Sales data loaded: ${salesData.length} rows`);

  // Restore or create session
  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Castrol-Bot', 'Chrome', '1.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── CONNECTION HANDLER ────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;

    if (qr) {
      console.log('\n📱 QR Code received - requesting pairing code instead...');
    }

    if (connection === 'open') {
      console.log('✅ Bot is ONLINE and connected to WhatsApp!');
      // Request pairing code on first connect if not paired
      if (!state.creds?.registered) {
        try {
          const phone = process.env.BOT_PHONE_NUMBER?.replace(/[^0-9]/g, '');
          if (phone) {
            const code = await sock.requestPairingCode(phone);
            console.log(`\n🔑 PAIRING CODE: ${code}`);
            console.log('Enter this code in WhatsApp > Linked Devices > Link a Device\n');
          }
        } catch (e) {
          console.log('Pairing code already set or not needed:', e.message);
        }
      }
    }

    if (connection === 'close') {
      const reason = new (require('@hapi/boom').Boom)(lastDisconnect?.error)?.output?.statusCode;
      console.log('Connection closed. Reason:', reason);
      if (reason !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(startBot, 5000);
      } else {
        console.log('Logged out. Please re-authenticate.');
      }
    }
  });

  // ── MESSAGE HANDLER ───────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const sender = msg.key.remoteJid;
      const senderNumber = sender.replace('@s.whatsapp.net', '').replace('@c.us', '');

      // Get message text
      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        ''
      ).trim();

      if (!text) continue;

      console.log(`📩 From: ${senderNumber} | Message: ${text}`);

      try {
        // ── WHITELIST CHECK ─────────────────────────────────────────────────
        const whitelist = await getWhitelist();
        const userEntry = whitelist[senderNumber];

        if (!userEntry || !userEntry.active) {
          console.log(`🚫 Blocked: ${senderNumber}`);
          continue; // Silent ignore
        }

        const role = userEntry.role;       // admin / asm / executive
        const userName = userEntry.name;
        const execFilter = userEntry.exec_filter || null;

        console.log(`✅ Allowed: ${userName} (${role})`);

        // ── TYPING INDICATOR ────────────────────────────────────────────────
        await sock.sendPresenceUpdate('composing', sender);

        // ── ADMIN COMMANDS ──────────────────────────────────────────────────
        if (role === 'admin') {
          // Reload Excel data
          if (text.toLowerCase() === '!reload') {
            salesData = await loadSalesData();
            salesDataLoaded = true;
            await sock.sendMessage(sender, { text: `✅ Sales data reloaded! ${salesData.length} rows loaded.` });
            continue;
          }

          // Update instructions
          if (text.toLowerCase().startsWith('!instructions ')) {
            const newInstructions = text.substring(14).trim();
            const { updateInstructions } = require('./firebaseManager');
            await updateInstructions(newInstructions);
            await sock.sendMessage(sender, { text: '✅ Instructions updated successfully! Bot will use new instructions from next message.' });
            continue;
          }

          // Add whitelist number
          if (text.toLowerCase().startsWith('!add ')) {
            const { addToWhitelist } = require('./firebaseManager');
            const parts = text.substring(5).trim().split('|');
            if (parts.length >= 3) {
              const num = parts[0].trim().replace(/[^0-9]/g, '');
              const addRole = parts[1].trim();
              const addName = parts[2].trim();
              const execName = parts[3]?.trim() || null;
              await addToWhitelist(num, addRole, addName, execName);
              await sock.sendMessage(sender, { text: `✅ Added ${addName} (${num}) as ${addRole}` });
            } else {
              await sock.sendMessage(sender, { text: '❌ Format: !add [number]|[role]|[name]|[exec_filter]\nExample: !add 919876543210|executive|Mr. RAKESH KUMAR|MR. RAKESH KUMAR' });
            }
            continue;
          }

          // Remove whitelist number
          if (text.toLowerCase().startsWith('!remove ')) {
            const { removeFromWhitelist } = require('./firebaseManager');
            const num = text.substring(8).trim().replace(/[^0-9]/g, '');
            await removeFromWhitelist(num);
            await sock.sendMessage(sender, { text: `✅ Removed ${num} from whitelist` });
            continue;
          }

          // Show whitelist
          if (text.toLowerCase() === '!whitelist') {
            const wl = await getWhitelist();
            let reply = '📋 *Current Whitelist:*\n\n';
            Object.entries(wl).forEach(([num, data]) => {
              reply += `• ${data.name} (${num})\n  Role: ${data.role} | Active: ${data.active ? '✅' : '❌'}\n\n`;
            });
            await sock.sendMessage(sender, { text: reply });
            continue;
          }

          // Show help
          if (text.toLowerCase() === '!help') {
            await sock.sendMessage(sender, {
              text: `🤖 *Admin Commands:*\n\n` +
                `*!reload* — Reload sales Excel data\n` +
                `*!whitelist* — Show all whitelisted numbers\n` +
                `*!add [num]|[role]|[name]|[exec]* — Add number\n` +
                `*!remove [num]* — Remove number\n` +
                `*!instructions [text]* — Update bot instructions\n\n` +
                `*Roles:* admin / asm / executive\n\n` +
                `Ask any sales question normally too!`
            });
            continue;
          }
        }

        // ── SCHEME PDF REQUEST ───────────────────────────────────────────────
        const schemeKeywords = ['scheme', 'letter', 'pdf', 'circular', 'send scheme'];
        const isSchemeRequest = schemeKeywords.some(k => text.toLowerCase().includes(k));

        if (isSchemeRequest) {
          const sent = await sendSchemePDF(sock, sender, text);
          if (sent) continue; // PDF sent, skip AI
        }

        // ── FILTER DATA BY ROLE ─────────────────────────────────────────────
        let filteredData = salesData;
        if (role === 'executive' && execFilter) {
          filteredData = salesData.filter(row =>
            row['Sales Executive Name']?.toString().toLowerCase() === execFilter.toLowerCase()
          );
        }
        // ASM and admin see all data

        // ── GET AI REPLY ────────────────────────────────────────────────────
        const instructions = await getInstructions();
        const reply = await getAIReply(text, filteredData, userName, role, instructions);

        await sock.sendMessage(sender, { text: reply });
        console.log(`✅ Replied to ${userName}`);

      } catch (err) {
        console.error('Error handling message:', err);
        await sock.sendMessage(sender, { text: '⚠️ Something went wrong. Please try again.' });
      }
    }
  });
}

startBot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
