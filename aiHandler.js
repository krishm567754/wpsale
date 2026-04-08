const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return "⚠️ API Key missing hai. GitHub Secrets check karein.";

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Stable model for Google AI Studio Keys
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Data filtering for performance (taking 100 rows)
    const limitedData = filteredData.slice(0, 100);
    const dataString = JSON.stringify(limitedData);

    const prompt = `
    ${customInstructions}
    
    BUSINESS: Shri Laxmi Auto Store, Bikaner.
    DATA: ${dataString}

    USER QUESTION: ${userMessage}

    RULES:
    1. Answer in Hinglish.
    2. Search strictly in 'Customer Name' column.
    3. If data found, give 'Total Value incl VAT/GST' and 'Invoice Date'.
    4. Use ₹ for amounts.
    `;

    console.log(`🤖 AI Processing with Gemini 1.5 Flash...`);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return text || "⚠️ AI reply nahi de paya, please dubara try karein.";

  } catch (err) {
    console.error('❌ AI ERROR:', err);
    return `⚠️ AI Error: ${err.message}. GitHub workflow restart karke dekhein.`;
  }
}

module.exports = { getAIReply };
