const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return "⚠️ API Key missing hai. GitHub Secrets check karein.";

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // StackOverflow solution: Switch to Gemini 2.0 Flash for stability
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Performance ke liye data limit (100 rows)
    const limitedData = filteredData.slice(0, 100);
    const dataString = JSON.stringify(limitedData);

    const prompt = `
    ${customInstructions}
    
    BUSINESS: Shri Laxmi Auto Store, Bikaner (Castrol Distributor).
    DATA: ${dataString}

    USER QUESTION: ${userMessage}

    RULES:
    1. Search strictly in 'Customer Name' column.
    2. Answer in Hinglish clearly.
    3. Use ₹ symbol for amounts.
    4. Provide Invoice No and Date if available.
    `;

    console.log(`🤖 AI Processing with Gemini 2.0 Flash...`);

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
