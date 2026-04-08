const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. --- CONFIGURATION ---
const FIREBASE_DB_URL = "https://studio-4138315434-eeea2-default-rtdb.firebaseio.com/"; 

// YOUR SPECIFIC INSTRUCTIONS (Modify these to change how the bot answers)
const BOT_RULES = `
- You are the Shri Laxmi Auto Store Assistant.
- Search across all uploaded monthly Excel/CSV files.
- If multiple invoices found, show the most recent one.
- Always include Invoice No, Date, and Total Value with GST.
- If a scheme is requested, check the 'schemes' folder for a matching PDF.
`;

try {
    const serviceAccount = require("./firebase-key.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DB_URL
    });
    console.log("✅ Firebase Connected");
} catch (e) { console.log("Firebase Error: " + e.message); }

const db = admin.database();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    }
});

// 2. --- QR LOGIC ---
client.on('qr', (qr) => {
    console.log('✅ QR GENERATED! SCAN NOW:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('🚀 Shri Laxmi Bot is Online!');
});

// 3. --- SEARCH & REPLY LOGIC ---
client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    // Whitelist Check
    const snap = await db.ref('allowed_users/' + sender).once('value');
    if (!snap.exists()) return;

    const query = msg.body.toLowerCase();

    // A. SEARCH ALL EXCEL/CSV FILES
    let allMatches = [];
    const files = fs.readdirSync('./').filter(f => f.endsWith('.xlsx') || f.endsWith('.csv'));

    files.forEach(file => {
        try {
            const workbook = XLSX.readFile(file);
            const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
            
            const matches = data.filter(row => 
                query.includes(String(row['Customer Name']).toLowerCase()) || 
                query.includes(String(row['Customer Code']).toLowerCase())
            );
            
            matches.forEach(m => {
                m.foundInFile = file;
                allMatches.push(m);
            });
        } catch (err) { console.log(`Error reading ${file}`); }
    });

    if (allMatches.length > 0) {
        // Sort to get the most recent (assuming last in list is latest)
        const latest = allMatches[allMatches.length - 1];
        let reply = `✅ *Data Found (${latest.foundInFile})*\n\n`;
        reply += `👤 Customer: ${latest['Customer Name']}\n`;
        reply += `🧾 Inv: ${latest['Invoice No']} (${latest['Invoice Date']})\n`;
        reply += `💰 Total: ₹${latest['Total Value incl VAT/GST']}\n`;
        reply += `📞 Salesman: ${latest['Sales Executive Name']}`;
        return msg.reply(reply);
    }

    // B. PDF SCHEME MATCHING
    if (fs.existsSync('./schemes/')) {
        const schemes = fs.readdirSync('./schemes/');
        const match = schemes.find(f => query.includes(f.toLowerCase().replace('.pdf', '')));
        if (match) {
            const media = MessageMedia.fromFilePath(`./schemes/${match}`);
            return client.sendMessage(msg.from, media, { caption: `Castrol Scheme: ${match}` });
        }
    }
});

client.initialize();
