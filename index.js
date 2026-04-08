const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. --- FIREBASE CONFIGURATION ---
// Using the URL you provided with the required https:// prefix
const FIREBASE_DB_URL = "https://studio-4138315434-eeea2-default-rtdb.firebaseio.com/"; 

try {
    const serviceAccount = require("./firebase-key.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DB_URL
    });
    console.log("✅ Firebase Initialized successfully.");
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
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

// 2. --- QR CODE EVENT ---
client.on('qr', (qr) => {
    console.log('✅ QR RECEIVED! SCAN THIS CODE NOW:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('🚀 Shri Laxmi Agent is ONLINE and READY!');
});

// 3. --- MESSAGE HANDLING ---
client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    // A. GATEKEEPER: Check Whitelist
    const snapshot = await db.ref('allowed_users/' + sender).once('value');
    if (!snapshot.exists()) return;

    const query = msg.body.toLowerCase();

    // B. EXCEL SEARCH: Daily Invoice Data
    if (fs.existsSync('./sales_data.xlsx')) {
        const workbook = XLSX.readFile('./sales_data.xlsx');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const found = data.find(row => 
            query.includes(String(row['Customer Name']).toLowerCase()) || 
            query.includes(String(row['Customer Code']).toLowerCase())
        );

        if (found) {
            return msg.reply(`📊 *Sales Info Found:*\n\nCustomer: ${found['Customer Name']}\nInvoice No: ${found['Invoice No']}\nDate: ${found['Invoice Date']}\nTotal: ₹${found['Total Value incl VAT/GST']}\nExecutive: ${found['Sales Executive Name']}`);
        }
    }

    // C. PDF MATCHING: Schemes
    if (fs.existsSync('./schemes/')) {
        const files = fs.readdirSync('./schemes/');
        const match = files.find(f => query.includes(f.toLowerCase().replace('.pdf', '')));
        
        if (match) {
            const media = MessageMedia.fromFilePath(`./schemes/${match}`);
            return client.sendMessage(msg.from, media, { caption: `Scheme Letter: ${match}` });
        }
    }
});

client.initialize();
