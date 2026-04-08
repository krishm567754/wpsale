const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return "⚠️ API Key missing hai. GitHub Secrets check karein.";

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // Using Gemini 2.0 Flash-Lite (Latest Preview)
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-preview-02-05" });

    // Sales data mapping (Top 100 rows for context)
    const limitedData = filteredData.slice(0, 100);
    const dataString = JSON.stringify(limitedData);

    const prompt = `
    Instructions: ${customInstructions}
    
    Role: Sales Assistant for Shri Laxmi Auto Store, Bikaner.
    Context: You have sales data for Castrol products.
    
    DATA (JSON):
    ${dataString}

    USER QUESTION:
    ${userMessage}

    STRICT RULES:
    1. Reply in Hinglish.
    2. Search strictly in 'Customer Name' column.
    3. If found, tell 'Invoice No', 'Invoice Date', and 'Total Value incl VAT/GST'.
    4. Use ₹ for amounts.
    5. If data is not there, say: "Record nahi mila."
    `;

    console.log(`🤖 AI Processing with Gemini 2.0 Flash-Lite...`);

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return text || "⚠️ Jawab nahi generate ho paya.";

  } catch (err) {
    console.error('❌ AI ERROR:', err.message);
    if (err.message.includes('429')) {
      return "⚠️ Google ki free limit abhi full hai, please 1 minute baad koshish karein.";
    }
    return `⚠️ AI Error: ${err.message}. Ek baar workflow restart karein.`;
  }
}

module.exports = { getAIReply };
