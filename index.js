const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};
const userMessageCount = {};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function callGPT(messages, maxTokens = 150) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages,
      max_tokens: maxTokens
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return response.data.choices[0].message.content;
}

async function sendAIMessage(phone, prompt) {
  const message = await callGPT([
    {
      role: 'system',
      content: `You are Sunny, a smart and efficient WhatsApp assistant.
      
      Your rules:
      - If sending a reminder or simple message, send it cleanly and simply. Nothing more.
      - For reminders like "tell me my mother is home" just say exactly that naturally with one emoji. Example: "Your mother is back home 🏠"
      - Never add unnecessary commentary, questions, or emotional responses unless specifically asked
      - Keep messages short, clean and to the point
      - Only add warmth when genuinely appropriate like motivational messages
      - Never ask follow up questions in reminder messages
      - For motivational or creative content be warm and engaging
      - Today is ${new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'})}`
    },
    { role: 'user', content: prompt }
  ], 200);

  if (!userMessageCount[phone]) userMessageCount[phone] = 0;
  userMessageCount[phone]++;

  let finalMessage = message;
  if (userMessageCount[phone] % 5 === 0) {
    finalMessage += '\n\n_Anything else I can help you with? 😊_';
  }

  await twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:${phone}`,
    body: finalMessage
  });
}

function parseTime(text) {
  // handles 8:49am, 8.49am, 8am, 8 am etc
  const match = text.match(/(\d{1,2})(?:[:\.](\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  let hour = parseInt(match[1]);
  const min = parseInt(match[2] || '0');
  const period = match[3].toLowerCase();
  if (period === 'pm' && hour !== 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return { hour, min };
}

function extractMessage(text) {
  return text
    .replace(/at \d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)/gi, '')
    .replace(/today|tomorrow|every day|daily/gi, '')
    .replace(/send me a message that|send me a message saying|remind me that|remind me to|send me/gi, '')
    .trim();
}

async function buildPrompt(text) {
  const result = await callGPT([
    {
      role: 'system',
      content: `You are a prompt builder for a WhatsApp bot called Sunny.
      
      Given a user's schedule request, return a JSON object with:
      - "label": short name for this schedule (e.g. "Motivation", "Trivia", "Reminder")
      - "prompt": the exact instruction to send to the AI when this message fires
      
      Rules for the prompt:
      - For reminders/messages: tell the AI to send it cleanly with one emoji, nothing extra
      - For motivation: ask for short warm uplifting message, max 2 sentences
      - For trivia/quiz/games: ask for a fun question with 3 options A B C
      - For news: ask for 2 sentence friendly news summary
      - For fun facts: ask for one fascinating fact, one sentence
      - For jokes: ask for one short punchy funny joke
      - For anything else: use GPT's intelligence to figure out the best prompt
      
      Return ONLY valid JSON like: {"label": "Reminder", "prompt": "..."}`
    },
    { role: 'user', content: text }
  ], 200);

  try {
    const clean = result.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return {
      label: 'Message',
      prompt: `Send this as a clean simple WhatsApp message with one relevant emoji. Just the message, nothing extra: "${extractMessage(text)}"`
    };
  }
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();
  const lowerText = text.toLowerCase();

  let reply = '';

  if (lowerText.includes('stop') || lowerText === 'cancel all') {
    userSchedules[phone] = [];
    reply = "All schedules cancelled ✓ Text me anytime to set up new ones.";

  } else if (lowerText === 'list' || lowerText.includes('my schedules') || lowerText.includes('what have i set')) {
    if (!userSchedules[phone] || userSchedules[phone].length === 0) {
      reply = "You have no active schedules yet!\n\nTry:\n'Motivation at 7am'\n'Trivia at 6:30am'\n'Remind me to call mum at 5pm'";
    } else {
      const list = userSchedules[phone].map((s, i) => {
        const hour12 = s.hour % 12 || 12;
        const ampm = s.hour >= 12 ? 'pm' : 'am';
        const min = String(s.min).padStart(2, '0');
        const freq = s.oneTime ? 'one time' : 'daily';
        return `${i + 1}. ${s.label} at ${hour12}:${min}${ampm} (${freq})`;
      }).join('\n');
      reply = `Your schedules:\n${list}\n\nText 'stop' to cancel all.`;
    }

  } else if (lowerText === 'help') {
    reply = `Here's what I can do:\n\n⏰ *Schedule anything*\n"Motivation at 7am"\n"Trivia at 6:30am"\n"Remind me to call mum at 5pm"\n"Daily Spanish word at 8am"\n"Joke at 9am"\n"Remind me today at 3pm to drink water"\n\n📋 *Manage schedules*\n"List" — see your schedules\n"Stop" — cancel all\n\nJust tell me what you want and when! 😊`;

  } else {
    const time = parseTime(lowerText);

    if (time) {
      if (!userSchedules[phone]) userSchedules[phone] = [];

      const isOneTime = lowerText.includes('today');
      const { label, prompt } = await buildPrompt(text);

      userSchedules[phone].push({ 
        prompt, 
        label, 
        hour: time.hour, 
        min: time.min,
        oneTime: isOneTime,
        fired: false
      });

      const hour12 = time.hour % 12 || 12;
      const ampm = time.hour >= 12 ? 'pm' : 'am';
      const min = String(time.min).padStart(2, '0');

      reply = `✓ Got it! I'll send your ${label.toLowerCase()} ${isOneTime ? 'today' : 'every day'} at ${hour12}:${min}${ampm}.\n\nText 'list' to see all your schedules.`;

    } else {
      try {
        reply = await callGPT([
          {
            role: 'system',
            content: `You are Sunny, a helpful WhatsApp assistant. 
            Answer helpfully and concisely in max 3 sentences. 
            If the user seems to want to schedule something but forgot a time, suggest they add a time like "at 7am".
            Never be overly chatty or emotional. Be clean, smart and helpful.`
          },
          { role: 'user', content: text }
        ], 150);
      } catch(e) {
        reply = "Hey! To schedule a message just include a time — for example:\n'Motivation at 7am'\n'Remind me to call mum at 5pm'";
      }
    }
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();

  for (const [phone, schedules] of Object.entries(userSchedules)) {
    if (!schedules) continue;
    for (let i = schedules.length - 1; i >= 0; i--) {
      const schedule = schedules[i];
      if (schedule.hour === currentHour && schedule.min === currentMin) {
        if (schedule.oneTime && schedule.fired) continue;
        try {
          await sendAIMessage(phone, schedule.prompt);
          if (schedule.oneTime) {
            schedules.splice(i, 1);
          }
        } catch(e) {
          console.error('Error sending scheduled message:', e);
        }
      }
    }
  }
});

app.listen(3000, () => console.log('Sunny bot running!'));
