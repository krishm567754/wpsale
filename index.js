const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. --- CONFIGURATION ---
const FIREBASE_DB_URL = "https://studio-4138315434-eeea2-default-rtdb.firebaseio.com/"; 
const BOT_NUMBER = "918764480852"; 

try {
    const serviceAccount = require("./firebase-key.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DB_URL
    });
} catch (e) { console.log("Firebase Init Error"); }

const db = admin.database();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    }
});

// 2. --- PAIRING CODE LOGIC ---
let pairingRequested = false;

client.on('qr', async () => {
    if (pairingRequested) return;
    pairingRequested = true;

    console.log("⏳ Page loaded. Waiting 30 seconds for WhatsApp Web to fully initialize...");
    await new Promise(resolve => setTimeout(resolve, 30000));

    try {
        console.log(`📲 Requesting Pairing Code for ${BOT_NUMBER}...`);
        const code = await client.requestPairingCode(BOT_NUMBER);
        console.log("\n**************************************");
        console.log(`🚀 YOUR PAIRING CODE: ${code}`);
        console.log("**************************************\n");
    } catch (err) {
        console.log("❌ Pairing failed (Error t). Will retry in next restart.");
        pairingRequested = false;
    }
});

client.on('ready', () => {
    console.log('🚀 ONLINE: Shri Laxmi Bot is active!');
});

// 3. --- BOT LOGIC ---
client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    const snap = await db.ref('allowed_users/' + sender).once('value');
    if (!snap.exists()) return;

    const query = msg.body.toLowerCase();

    if (fs.existsSync('./sales_data.xlsx')) {
        const wb = XLSX.readFile('./sales_data.xlsx');
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        const found = data.find(r => 
            query.includes(String(r['Customer Name']).toLowerCase()) || 
            query.includes(String(r['Customer Code']).toLowerCase())
        );
        if (found) {
            return msg.reply(`📊 *Sales Found:*\n${found['Customer Name']}\nTotal: ₹${found['Total Value incl VAT/GST']}`);
        }
    }

    if (fs.existsSync('./schemes/')) {
        const match = fs.readdirSync('./schemes/').find(f => query.includes(f.toLowerCase().replace('.pdf', '')));
        if (match) {
            const media = MessageMedia.fromFilePath(`./schemes/${match}`);
            return client.sendMessage(msg.from, media, { caption: `Scheme: ${match}` });
        }
    }
});

client.initialize();
