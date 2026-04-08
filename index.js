const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const admin = require('firebase-admin');

// 1. Initialize Firebase
const serviceAccount = require("./firebase-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "YOUR_FIREBASE_URL" // Replace with your Firebase URL
});
const db = admin.database();

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    }
});

client.on('qr', qr => qrcode.generate(qr, {small: true}));
client.on('ready', () => console.log('Bot is online for Shri Laxmi Auto Store!'));

client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    // 2. Gatekeeper: Check Admin Whitelist
    const snapshot = await db.ref('allowed_users/' + sender).once('value');
    if (!snapshot.exists()) return;

    const query = msg.body.toLowerCase();

    // 3. Search Daily Excel Data
    if (fs.existsSync('./sales_data.xlsx')) {
        const workbook = XLSX.readFile('./sales_data.xlsx');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const found = data.find(row => 
            query.includes(String(row['Customer Name']).toLowerCase()) || 
            query.includes(String(row['Customer Code']).toLowerCase())
        );

        if (found) {
            return msg.reply(`📊 *Sales Record:*\nCustomer: ${found['Customer Name']}\nInvoice: ${found['Invoice No']}\nTotal: ₹${found['Total Value incl VAT/GST']}\nExecutive: ${found['Sales Executive Name']}`);
        }
    }

    // 4. Send PDF Schemes (Matches PDF name to message)
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
