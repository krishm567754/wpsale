const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return "⚠️ Gemini API Key missing hai. GitHub Secrets check karein.";
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    // Aapke curl ke hisaab se "gemini-1.5-flash" sabse best chalega
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 

    // Data ko clean karke bhej rahe hain
    const limitedData = filteredData.slice(0, 100); 
    const dataString = JSON.stringify(limitedData);

    const systemPrompt = `
    ${customInstructions}
    
    CONTEXT:
    - Business: Shri Laxmi Auto Store, Bikaner (Castrol Distributor).
    - Data: Sales records including Customer Name, Invoice No, and Total Value incl VAT/GST.
    
    SALES DATA: 
    ${dataString}

    USER QUESTION: 
    ${userMessage}

    INSTRUCTIONS:
    - Answer in Hinglish based ONLY on the provided data.
    - Use ₹ for currency.
    - If no data found, say: "Record nahi mila."
    `;

    console.log(`🤖 AI Processing: Requesting Gemini with ${limitedData.length} rows.`);

    // Naya request format jo standard SDK follow karta hai
    const result = await model.generateContent(systemPrompt);
    const response = result.response;
    const text = response.text();

    return text || '⚠️ AI reply generate nahi kar paya.';

  } catch (err) {
    console.error('❌ AI ERROR:', err);
    // Agar flash fir bhi na chale toh gemini-pro try karein automatically
    return `⚠️ AI Error: ${err.message}. Ek baar GitHub workflow restart karke dekhein.`;
  }
}

module.exports = { getAIReply };
