const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "⚠️ Gemini API Key missing hai. GitHub Secrets check karein.";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const limitedData = filteredData.slice(0, 100);
  const dataString = JSON.stringify(limitedData);

  const prompt = `
  Instructions: ${customInstructions}
  Business: Shri Laxmi Auto Store, Bikaner.
  Data Context: ${dataString}
  User Question: ${userMessage}
  
  Note: Answer in Hinglish clearly. Search strictly in 'Customer Name' column. Use ₹ for amounts.
  `;

  // --- Multi-Retry Logic for Quota Errors ---
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`🤖 AI Attempt ${i + 1} with Gemini 2.0 Flash...`);
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (err) {
      if (err.message.includes('429') && i < maxRetries - 1) {
        console.log(`⚠️ Quota hit. Retrying in 5 seconds (Attempt ${i + 1}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      console.error('❌ AI Error:', err.message);
      return `⚠️ AI Error: Google server abhi busy hai. Please 1-2 minute baad try karein.`;
    }
  }
}

module.exports = { getAIReply };
