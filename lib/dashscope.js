const ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';

async function chat(messages, model) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.DEEPSEEK_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.code + ': ' + (json.error.message || JSON.stringify(json.error)));
  return json.choices[0].message.content;
}

async function callVision({ base64, mime = 'image/png', text }) {
  return chat([{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + base64 } },
      { type: 'text', text },
    ],
  }], process.env.VISION_MODEL || 'deepseek-v4-flash-vision-exp');
}

async function callText(messages) {
  return chat(messages, process.env.CHAT_MODEL || 'deepseek-chat');
}

module.exports = { callVision, callText };
