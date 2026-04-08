const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return "⚠️ Gemini API Key missing hai.";

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Model name fix for Google AI Studio keys
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
    });

    const limitedData = filteredData.slice(0, 100);
    const dataString = JSON.stringify(limitedData);

    const prompt = `
    ${customInstructions}
    
    BUSINESS CONTEXT:
    - Distributor: Shri Laxmi Auto Store, Bikaner.
    - Data Content: Sales records with Customer Name, Invoice No, Total Value incl VAT/GST.

    SALES DATA:
    ${dataString}

    USER QUESTION:
    ${userMessage}

    INSTRUCTIONS:
    - Search strictly in 'Customer Name' or 'Party Name'.
    - If found, give total value and invoice date.
    - Reply in Hinglish and use ₹ for amounts.
    `;

    console.log(`🤖 AI Processing with Gemini 1.5 Flash...`);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return text || "⚠️ AI ne khali jawab diya.";

  } catch (err) {
    console.error('❌ AI ERROR:', err);
    return `⚠️ AI Error: ${err.message}. Ek baar GitHub Actions restart karein.`;
  }
}

module.exports = { getAIReply };
