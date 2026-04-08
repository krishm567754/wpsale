const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. --- FIREBASE SETUP ---
const FIREBASE_DB_URL = "https://studio-4138315434-eeea2-default-rtdb.firebaseio.com/";
try {
    const serviceAccount = require("./firebase-key.json");
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_DB_URL
        });
    }
} catch (e) { console.log("Firebase Init Error: " + e.message); }
const db = admin.database();

// 2. --- BOT LOGIC ---
async function startBot() {
    // This folder 'auth_info' will save your session
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: ["Shri Laxmi Auto", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log("✅ QR CODE GENERATED. SCAN WITH WHATSAPP:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('🚀 SHRI LAXMI BOT IS ONLINE!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const senderNumber = senderJid.replace('@s.whatsapp.net', '');
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        // A. Whitelist Check
        const snap = await db.ref('allowed_users/' + senderNumber).once('value');
        if (!snap.exists()) return;

        // B. Search Across All Excel/CSV Files
        const files = fs.readdirSync('./').filter(f => f.endsWith('.xlsx') || f.endsWith('.csv'));
        let foundData = [];

        files.forEach(file => {
            try {
                const wb = XLSX.readFile(file);
                const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                const matches = data.filter(row => 
                    text.includes(String(row['Customer Name']).toLowerCase()) || 
                    text.includes(String(row['Customer Code']).toLowerCase())
                );
                matches.forEach(m => { m.originFile = file; foundData.push(m); });
            } catch (e) { /* Skip errors */ }
        });

        if (foundData.length > 0) {
            const res = foundData[foundData.length - 1]; // Latest record
            const reply = `📊 *Data Found in ${res.originFile}:*\n\n` +
                          `👤 Customer: ${res['Customer Name']}\n` +
                          `🧾 Inv: ${res['Invoice No']} (${res['Invoice Date']})\n` +
                          `💰 Total: ₹${res['Total Value incl VAT/GST']}\n` +
                          `📞 Salesman: ${res['Sales Executive Name']}`;
            
            await sock.sendMessage(senderJid, { text: reply });
        }

        // C. Scheme PDF Matching
        if (fs.existsSync('./schemes/')) {
            const schemes = fs.readdirSync('./schemes/');
            const match = schemes.find(f => text.includes(f.toLowerCase().replace('.pdf', '')));
            if (match) {
                const content = fs.readFileSync(`./schemes/${match}`);
                await sock.sendMessage(senderJid, { 
                    document: content, 
                    mimetype: 'application/pdf', 
                    fileName: match,
                    caption: `Castrol Scheme: ${match}`
                });
            }
        }
    });
}

startBot();
