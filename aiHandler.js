const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "⚠️ Gemini API Key missing hai.";

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // Latest Stable/Lite Model
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-preview-02-05" });

  const limitedData = filteredData.slice(0, 100);
  const dataString = JSON.stringify(limitedData);

  const prompt = `
  Instructions: ${customInstructions}
  Business: Shri Laxmi Auto Store, Bikaner.
  Data Context: ${dataString}
  User Question: ${userMessage}
  
  Rules:
  - Search strictly in 'Customer Name' column.
  - Reply in Hinglish clearly.
  - Use ₹ for amounts.
  `;

  // --- Smart Retry Logic ---
  const maxRetries = 2;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      console.log(`🤖 AI Attempt ${i + 1} with Gemini 2.0 Lite...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (err) {
      if (err.message.includes('429') && i < maxRetries) {
        console.log(`⚠️ Quota hit. Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      console.error('❌ AI Error:', err.message);
      return `⚠️ AI Error: Google server abhi busy hai (Limit: 0). Please 1 minute baad try karein.`;
    }
  }
}

module.exports = { getAIReply };
