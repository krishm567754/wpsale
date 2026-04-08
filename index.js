const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. Firebase Setup
const serviceAccount = require("./firebase-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "YOUR_FIREBASE_URL" // REPLACE WITH YOUR REAL FIREBASE URL
});
const db = admin.database();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ] 
    }
});

// CRITICAL: LOGS TO CONFIRM QR GENERATION
client.on('qr', (qr) => {
    console.log('✅ SYSTEM: QR CODE GENERATED BELOW. SCAN NOW:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('🚀 SYSTEM: Bot is Online for Shri Laxmi Auto Store!');
});

client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    // 1. Whitelist Check
    const snapshot = await db.ref('allowed_users/' + sender).once('value');
    if (!snapshot.exists()) return;

    const query = msg.body.toLowerCase();

    // 2. Search Daily Sales Excel
    if (fs.existsSync('./sales_data.xlsx')) {
        const workbook = XLSX.readFile('./sales_data.xlsx');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const found = data.find(row => 
            query.includes(String(row['Customer Name']).toLowerCase()) || 
            query.includes(String(row['Customer Code']).toLowerCase())
        );

        if (found) {
            return msg.reply(`📊 *Sales Record Found*\nCustomer: ${found['Customer Name']}\nInvoice No: ${found['Invoice No']}\nTotal Value: ₹${found['Total Value incl VAT/GST']}\nExecutive: ${found['Sales Executive Name']}`);
        }
    }

    // 3. Search PDF Schemes
    if (fs.existsSync('./schemes/')) {
        const files = fs.readdirSync('./schemes/');
        const match = files.find(f => query.includes(f.toLowerCase().replace('.pdf', '')));
        
        if (match) {
            const media = MessageMedia.fromFilePath(`./schemes/${match}`);
            return client.sendMessage(msg.from, media, { caption: `Scheme Document: ${match}` });
        }
    }
});

client.initialize();
