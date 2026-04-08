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
    console.log("✅ Firebase Initialized.");
} catch (error) {
    console.error("❌ Firebase Error:", error.message);
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

// 2. --- PAIRING CODE LOGIC WITH DELAY ---
let pairingCodeRequested = false;

client.on('qr', async (qr) => {
    if (!pairingCodeRequested) {
        pairingCodeRequested = true;
        console.log("⏳ Waiting 10 seconds for page to stabilize...");
        
        // Wait 10 seconds before requesting the code
        await new Promise(resolve => setTimeout(resolve, 10000));

        try {
            console.log("📲 Requesting Pairing Code for:", BOT_NUMBER);
            const pairingCode = await client.requestPairingCode(BOT_NUMBER);
            console.log("----------------------------------------------");
            console.log(`🚀 YOUR PAIRING CODE: ${pairingCode}`);
            console.log("----------------------------------------------");
            console.log("STEPS: WhatsApp > Linked Devices > Link a Device > Link with phone number instead");
        } catch (err) {
            console.log("❌ Error requesting pairing code:", err.message);
            pairingCodeRequested = false; // Reset to try again if it fails
        }
    }
});

client.on('ready', () => {
    console.log('🚀 Shri Laxmi Agent is ONLINE!');
});

// 3. --- MESSAGE HANDLING ---
client.on('message', async msg => {
    const contact = await msg.getContact();
    const sender = contact.number;

    const snapshot = await db.ref('allowed_users/' + sender).once('value');
    if (!snapshot.exists()) return;

    const query = msg.body.toLowerCase();

    if (fs.existsSync('./sales_data.xlsx')) {
        const workbook = XLSX.readFile('./sales_data.xlsx');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        const found = data.find(row => 
            query.includes(String(row['Customer Name']).toLowerCase()) || 
            query.includes(String(row['Customer Code']).toLowerCase())
        );

        if (found) {
            return msg.reply(`📊 *Sales Detail Found*\nCustomer: ${found['Customer Name']}\nTotal Value: ₹${found['Total Value incl VAT/GST']}\nDate: ${found['Invoice Date']}`);
        }
    }

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
