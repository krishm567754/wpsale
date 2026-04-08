const { GoogleGenerativeAI } = require('@google/generative-ai');
const { summarizeForAI } = require('./dataLoader');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── GET AI REPLY ──────────────────────────────────────────────────────────────
async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Build data summary
    const dataSummary = summarizeForAI(filteredData);

    // Build full prompt
    const systemPrompt = `${customInstructions}

---
CURRENT USER INFO:
- Name: ${userName}
- Role: ${role}
- Data access: ${role === 'executive' ? 'Only their own sales data' : role === 'asm' ? 'All executives under their territory' : 'Full access to all data'}

---
SALES DATA AVAILABLE TO THIS USER:
${dataSummary}
---

Answer the user's question based on the data above.
Keep response concise and WhatsApp-friendly (no markdown headers, use emojis sparingly).
For numbers, always use Indian number format with ₹ symbol.`;

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `User (${userName}) asks: ${userMessage}` }
    ]);

    const response = result.response.text();
    return response || 'Sorry, I could not generate a response. Please try again.';

  } catch (err) {
    console.error('Gemini AI error:', err);
    if (err.message?.includes('quota')) {
      return '⚠️ AI service is temporarily busy. Please try again in a minute.';
    }
    return '⚠️ Could not process your request. Please try again.';
  }
}

module.exports = { getAIReply };
