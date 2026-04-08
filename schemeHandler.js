const { getSchemeFileURL, listSchemeFiles } = require('./firebaseManager');
const https = require('https');
const http = require('http');

// Known scheme codes from the Excel data
const SCHEME_KEYWORDS = {
  'PCOQ12601': ['pcoq12601', 'pco scheme', 'pco q'],
  'RETQ12601': ['retq12601', 'ret scheme', 'retail scheme'],
  'NEWQ12604': ['newq12604', 'new scheme'],
  'RTLQ12602': ['rtlq12602', 'rtl scheme'],
  'RETQ42501': ['retq42501'],
  'MCOQ12601': ['mcoq12601', 'mco scheme'],
  'RETQ12603': ['retq12603'],
  'NEWQ12607': ['newq12607'],
  'RETQ32501': ['retq32501'],
  'WORKSHOP_DISCOUNT': ['workshop discount', 'workshop scheme'],
  'GTX_DIESEL': ['gtx diesel', 'gtx ci4'],
};

// ── DETECT SCHEME FROM MESSAGE ────────────────────────────────────────────────
function detectSchemeCode(text) {
  const lowerText = text.toLowerCase();

  // Direct code match
  for (const [code, keywords] of Object.entries(SCHEME_KEYWORDS)) {
    if (keywords.some(k => lowerText.includes(k))) {
      return code;
    }
  }

  // Try to extract code pattern directly from message
  const codePattern = /\b([A-Z0-9]{6,15})\b/gi;
  const matches = text.match(codePattern);
  if (matches) {
    for (const match of matches) {
      if (SCHEME_KEYWORDS[match.toUpperCase()]) {
        return match.toUpperCase();
      }
    }
  }

  return null;
}

// ── DOWNLOAD FILE FROM URL ────────────────────────────────────────────────────
async function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

// ── SEND SCHEME PDF ───────────────────────────────────────────────────────────
async function sendSchemePDF(sock, sender, text) {
  try {
    // Check if asking for list of schemes
    if (text.toLowerCase().includes('scheme list') ||
        text.toLowerCase().includes('all schemes') ||
        text.toLowerCase().includes('schemes available')) {
      const files = await listSchemeFiles();
      if (files.length === 0) {
        await sock.sendMessage(sender, {
          text: '📋 No scheme PDFs uploaded yet. Please contact admin to upload scheme letters.'
        });
      } else {
        let reply = '📋 *Available Scheme Letters:*\n\n';
        files.forEach(f => { reply += `• ${f}\n`; });
        reply += '\nKisi bhi scheme ka PDF lene ke liye, scheme ka naam likhein.';
        await sock.sendMessage(sender, { text: reply });
      }
      return true;
    }

    // Detect specific scheme
    const schemeCode = detectSchemeCode(text);
    if (!schemeCode) return false;

    // Get signed URL from Firebase Storage
    const fileInfo = await getSchemeFileURL(schemeCode);

    if (!fileInfo) {
      await sock.sendMessage(sender, {
        text: `⚠️ *${schemeCode}* scheme ka PDF abhi available nahi hai.\n\nAdmin se request karein ki PDF upload karein.\n\nScheme ki details ke liye simply scheme ke baare mein poochein!`
      });
      return true;
    }

    // Download and send PDF
    await sock.sendMessage(sender, {
      text: `📄 *${schemeCode}* scheme letter bhej raha hoon...`
    });

    const pdfBuffer = await downloadFile(fileInfo.url);

    await sock.sendMessage(sender, {
      document: pdfBuffer,
      mimetype: 'application/pdf',
      fileName: fileInfo.filename,
      caption: `📋 *${schemeCode} Scheme Letter*\nCastrol Distributor - Bikaner & Churu`
    });

    console.log(`✅ Sent PDF: ${fileInfo.filename} to ${sender}`);
    return true;

  } catch (err) {
    console.error('Error sending scheme PDF:', err);
    return false;
  }
}

module.exports = { sendSchemePDF };
