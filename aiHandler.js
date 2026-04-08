const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "⚠️ API Key missing hai. GitHub Secrets check karein.";

  const genAI = new GoogleGenerativeAI(apiKey);
  
  // Model priorities
  const models = ["gemini-1.5-pro", "gemini-1.0-pro"];
  
  const limitedData = filteredData.slice(0, 70); // Pro models heavy hote hain, isliye data limit thodi kam rakhi hai
  const dataString = JSON.stringify(limitedData);

  const prompt = `
  Instructions: ${customInstructions}
  Business: Shri Laxmi Auto Store, Bikaner (Castrol Distributor).
  Data Context: ${dataString}
  User Question: ${userMessage}
  
  Rules:
  - Answer in Hinglish clearly.
  - Search strictly in 'Customer Name' column.
  - Use ₹ symbol for amounts.
  - If data not found, say: "Record nahi mila."
  `;

  // Try each model if one fails due to quota
  for (const modelName of models) {
    try {
      console.log(`🤖 Attempting AI Reply with: ${modelName}`);
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      if (text) return text;
    } catch (err) {
      console.error(`⚠️ ${modelName} Error:`, err.message);
      if (err.message.includes('429')) {
        console.log(`🔄 Quota hit for ${modelName}, switching to next model...`);
        continue; // Agla model try karein
      }
      return `⚠️ AI Error: ${err.message}`;
    }
  }

  return "⚠️ Saare models ki free limit abhi full hai. Please 5 minute baad koshish karein.";
}

module.exports = { getAIReply };
