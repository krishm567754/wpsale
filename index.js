const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. --- CONFIGURATION ---
const FIREBASE_DB_URL = "https://studio-4138315434-eeea2-default-rtdb.firebaseio.com/";

try {
    const serviceAccount = require("./firebase-key.json");
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_DB_URL
        });
    }
    console.log("✅ Firebase Handshake Successful");
} catch (e) {
    console.error("❌ Firebase Key Error: Check if firebase-key.json exists in main folder.");
    process.exit(1);
}

const db = admin.database();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] 
    }
});

// 2. --- QR LOGIC ---
client.on('qr', (qr) => {
    console.log('✅ NEW QR GENERATED:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('🚀 SYSTEM ONLINE: Shri Laxmi Bot is ready.');
});

// 3. --- CORE BRAIN (SEARCH ACROSS ALL FILES) ---
client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    // Security Gatekeeper
    const snap = await db.ref('allowed_users/' + sender).once('value');
    if (!snap.exists()) return;

    const query = msg.body.toLowerCase();
    let allResults = [];

    // Search ALL Excel/CSV files in the repository
    const files = fs.readdirSync('./').filter(f => f.endsWith('.xlsx') || f.endsWith('.csv'));

    files.forEach(file => {
        try {
            const wb = XLSX.readFile(file);
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
            
            const matches = data.filter(row => 
                query.includes(String(row['Customer Name']).toLowerCase()) || 
                query.includes(String(row['Customer Code']).toLowerCase())
            );
            
            matches.forEach(m => {
                m.originFile = file;
                allResults.push(m);
            });
        } catch (err) { /* Skip corrupted files */ }
    });

    if (allResults.length > 0) {
        const res = allResults[allResults.length - 1]; // Get latest entry
        let reply = `📊 *Data Found in ${res.originFile}:*\n\n`;
        reply += `👤 *Customer:* ${res['Customer Name']}\n`;
        reply += `🆔 *Code:* ${res['Customer Code']}\n`;
        reply += `🧾 *Inv:* ${res['Invoice No']} (${res['Invoice Date']})\n`;
        reply += `💰 *Total Value:* ₹${res['Total Value incl VAT/GST']}\n`;
        reply += `📞 *Salesman:* ${res['Sales Executive Name']}`;
        return msg.reply(reply);
    }

    // PDF matching for Schemes (inside 'schemes' folder)
    if (fs.existsSync('./schemes/')) {
        const match = fs.readdirSync('./schemes/').find(f => query.includes(f.toLowerCase().replace('.pdf', '')));
        if (match) {
            const media = MessageMedia.fromFilePath(`./schemes/${match}`);
            return client.sendMessage(msg.from, media, { caption: `Castrol Scheme: ${match}` });
        }
    }
});

client.initialize();
