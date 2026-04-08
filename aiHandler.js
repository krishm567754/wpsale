const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Data ko chota karke bhej rahe hain taaki AI confuse na ho
    const limitedData = filteredData.slice(0, 100); 
    const dataString = JSON.stringify(limitedData);

    const systemPrompt = `
    ${customInstructions}

    STRICT DATA RULES:
    1. Aap ek Sales Assistant ho Shri Laxmi Auto Store (Bikaner) ke liye.
    2. Niche diye gaye JSON data ka use karke user ke sawal ka jawab do.
    3. Agar 'Customer Name' ya 'Party Name' pucha jaye, toh data mein 'Customer Name' column ko check karo.
    4. Amount ke liye 'Total Value incl VAT/GST' column ka use karo.
    5. Date ke liye 'Invoice Date' dekho.
    
    DATA (JSON):
    ${dataString}

    INSTRUCTIONS:
    - Reply in Hinglish.
    - Be concise (WhatsApp friendly).
    - Use ₹ symbol for amounts.
    - Agar data nahi milta, toh bolo: "Iska record mere paas nahi hai, please office call karein."
    `;

    console.log(`🤖 AI Processing for: ${userName} | Rows: ${limitedData.length}`);

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `User (${userName}) asks: ${userMessage}` }
    ]);

    const response = result.response.text();
    return response || '⚠️ Main abhi iska jawab nahi de pa raha hoon.';

  } catch (err) {
    console.error('❌ AI ERROR:', err);
    return '⚠️ AI Service busy hai, please thodi der baad koshish karein.';
  }
}

module.exports = { getAIReply };
