const AGNES_API_KEY = process.env.AGNES_API_KEY || process.env.OPENAI_API_KEY || 'sk-AYVNwoW1j0lqSVHU81peqCSHmtjxFZCM6ecqxzWvJEFLmE6t';
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-3.0-flash';

async function callAgnesCompletion(messages, maxTokens = 60, temperature = 0.8) {
  if (!AGNES_API_KEY) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(`${AGNES_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGNES_API_KEY}`
      },
      body: JSON.stringify({
        model: AGNES_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[Agnes AI] HTTP error ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn(`[Agnes AI] Request failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate witty in-character reaction when Agnes or bot makes a move
 */
async function generateMoveCommentary(botName, mode, action, comboLabel, isWinning = false) {
  const prompt = [
    {
      role: 'system',
      content: `Kamu adalah ${botName}, bot pemain kartu retro 16-bit di game ${mode}.
Karakter: Cerdas, santai, kompetitif, asik, humoris, pakai gaya bahasa gaul Indonesia santai (contoh: "waduh", "mantap", "nih rasain", "lewat dulu ya bos").
Tugas: Buat 1 kalimat sangat pendek (maksimal 7 kata) reaksi saat kamu ${action === 'pass' ? 'harus Pass / lewat' : `mengeluarkan kartu kombinasi: ${comboLabel || 'kartu'}`}${isWinning ? ' dan menang' : ''}.
JANGAN pakai tanda kutip.`
    },
    {
      role: 'user',
      content: `Reaksi singkat:`
    }
  ];

  return await callAgnesCompletion(prompt, 25, 0.9);
}

/**
 * Generate contextual in-game chat reply when a player chats in the room
 */
async function generateChatReply(botName, senderName, userMessage, gameContext = '') {
  const prompt = [
    {
      role: 'system',
      content: `Kamu adalah ${botName}, pemain kartu bot AI di ruangan Carena 16-Bit.
Karakter: Teman main kartu yang seru, pintar, suka bercanda, tidak kaku, bahasa gaul santai Indonesia.
Konteks game saat ini: ${gameContext || 'Sedang bertanding kartu seru'}.
Tugas: Tanggapi pesan chat dari pemain bernama "${senderName}".
Batasan: Maksimal 1-2 kalimat pendek dan natural. Jangan kaku seperti robot.`
    },
    {
      role: 'user',
      content: `"${senderName}": ${userMessage}`
    }
  ];

  return await callAgnesCompletion(prompt, 60, 0.85);
}

module.exports = {
  callAgnesCompletion,
  generateMoveCommentary,
  generateChatReply
};
