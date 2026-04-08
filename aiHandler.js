const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    // CHANGED: Try "gemini-1.5-flash-latest" or "gemini-pro" if flash is failing
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 

    const limitedData = filteredData.slice(0, 100); 
    const dataString = JSON.stringify(limitedData);

    const systemPrompt = `
    ${customInstructions}
    STRICT DATA RULES:
    1. Aap ek Sales Assistant ho Shri Laxmi Auto Store ke liye.
    2. Data mein 'Customer Name', 'Invoice No', aur 'Total Value incl VAT/GST' check karo.
    3. Amount ke liye hamesha ₹ use karo.
    
    DATA (JSON): ${dataString}
    `;

    console.log(`🤖 AI Processing for: ${userName} | Rows: ${limitedData.length}`);

    // AI Call
    const result = await model.generateContent(systemPrompt + "\n\nUser asks: " + userMessage);
    const response = await result.response;
    const text = response.text();

    return text || '⚠️ Main abhi iska jawab nahi de pa raha hoon.';

  } catch (err) {
    console.error('❌ AI ERROR:', err);
    // fallback logic agar flash model nahi mil raha
    return '⚠️ AI Model connect nahi ho pa raha. Please check API settings.';
  }
}

module.exports = { getAIReply };
