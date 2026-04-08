const { GoogleGenerativeAI } = require('@google/generative-ai');

// AI reply function
async function getAIReply(userMessage, filteredData, userName, role, customInstructions) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // ── DATA SUMMARY ──
    // Agar data bahut zyada hai toh AI confuse ho sakta hai, isliye sirf zaroori rows bhej rahe hain
    const limitedData = filteredData.slice(0, 50); 
    const dataString = JSON.stringify(limitedData, null, 2);

    const systemPrompt = `${customInstructions}
    
---
USER CONTEXT:
- Name: ${userName}
- Role: ${role}

---
SALES DATA (JSON Format):
${dataString}

---
INSTRUCTIONS:
1. Answer strictly based on the provided JSON data.
2. If the user asks for a party name, search the 'Customer Name' column.
3. If no data found, say: "Maaf kijiye, iska data available nahi hai."
4. Use Hinglish and keep it short. Use ₹ for amounts.`;

    console.log(`🤖 AI is processing message: "${userMessage}" with ${limitedData.length} rows.`);

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: `User (${userName}) asks: ${userMessage}` }
    ]);

    const response = result.response.text();
    return response || '⚠️ AI reply generate nahi kar paya.';

  } catch (err) {
    console.error('❌ Gemini AI error:', err);
    if (err.message?.includes('API key not valid')) {
      return '⚠️ API Key invalid hai. Please GitHub Secrets check karein.';
    }
    return '⚠️ AI processing mein error aa raha hai. Please try again.';
  }
}

module.exports = { getAIReply };
