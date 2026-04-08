const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const XLSX = require('xlsx');
const fs = require('fs');
const Fuse = require('fuse.js'); // For fuzzy matching PDF names

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
});

// 1. GATEKEEPER: Whitelist Check
async function isAllowed(number) {
    // Logic to check Firebase 'allowed_users' table
    // Returns true if number is whitelisted via your Admin Page
}

client.on('message', async msg => {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    
    if (!(await isAllowed(contact.number))) return;

    const query = msg.body.toLowerCase();

    // 2. EXCEL SEARCH: Daily Sales Data
    if (query.includes('sale') || query.includes('billing')) {
        const workbook = XLSX.readFile('./sales_data.xlsx');
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet);

        // Find data matching the customer name or code
        const result = data.find(row => 
            query.includes(row['Customer Name'].toLowerCase()) || 
            query.includes(row['Customer Code'].toLowerCase())
        );

        if (result) {
            msg.reply(`📊 *Sales Info found:*\nCustomer: ${result['Customer Name']}\nTotal Value: ₹${result['Total Value incl VAT/GST']}\nExecutive: ${result['Sales Executive Name']}`);
        }
    }

    // 3. PDF SCHEME MATCHING
    const schemeFiles = fs.readdirSync('./schemes/');
    const fuse = new Fuse(schemeFiles, { threshold: 0.3 });
    const match = fuse.search(query);

    if (match.length > 0) {
        const fileName = match[0].item;
        const media = MessageMedia.fromFilePath(`./schemes/${fileName}`);
        client.sendMessage(msg.from, media, { caption: `Here is the ${fileName} scheme letter.` });
    }
});

client.initialize();
