const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function askGPT(messages) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4',
      messages,
      max_tokens: 300
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return response.data.choices[0].message.content.trim();
}

async function classifyMessage(text) {
  const result = await askGPT([
    {
      role: 'system',
      content: 'You classify WhatsApp messages. Reply with exactly one word — SCHEDULE if the message is asking to set up a recurring scheduled message at a specific time, or CHAT if it is a question, conversation, or anything else.'
    },
    { role: 'user', content: text }
  ]);
  return result.toUpperCase().includes('SCHEDULE') ? 'SCHEDULE' : 'CHAT';
}

async function sendScheduledMessage(phone, prompt) {
  const message = await askGPT([
    {
      role: 'system',
      content: `You are Sunny, a warm friendly WhatsApp assistant. Write naturally like a friend texting — short, conversational, no bullet points, no formal language. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
    },
    { role: 'user', content: prompt }
  ]);

  await twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:${phone}`,
    body: message
  });
}

function parseTime(text) {
  const match = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  let hour = parseInt(match[1]);
  const min = parseInt(match[2] || '0');
  const period = match[3].toLowerCase();
  if (period === 'pm' && hour !== 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return { hour, min };
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();
  const lower = text.toLowerCase();

  let reply = '';

  if (lower.includes('stop') || lower.includes('cancel')) {
    userSchedules[phone] = [];
    reply = "All your schedules have been cancelled! Text me anytime to set new ones.";

  } else if (lower.includes('list') || lower.includes('my schedule')) {
    if (!userSchedules[phone] || userSchedules[phone].length === 0) {
      reply = "You have no schedules set up yet! Try something like 'send me motivation at 7am' or 'trivia at 6:30am'.";
    } else {
      const list = userSchedules[phone].map(s => {
        const h = s.hour % 12 || 12;
        const ampm = s.hour >= 12 ? 'pm' : 'am';
        const m = String(s.min).padStart(2, '0');
        return `- ${s.label} at ${h}:${m}${ampm}`;
      }).join('\n');
      reply = `Your schedules:\n${list}\n\nText 'stop' to cancel all.`;
    }

  } else {
    const type = await classifyMessage(text);

    if (type === 'SCHEDULE') {
      const time = parseTime(lower);
      if (time) {
        if (!userSchedules[phone]) userSchedules[phone] = [];
        userSchedules[phone].push({ prompt: text, label: text, hour: time.hour, min: time.min });
        const h = time.hour % 12 || 12;
        const ampm = time.hour >= 12 ? 'pm' : 'am';
        const m = String(time.min).padStart(2, '0');
        reply = `Done! I'll send that every day at ${h}:${m}${ampm}. Text 'list' to see all schedules or 'stop' to cancel.`;
      } else {
        reply = "I got that you want to schedule something but couldn't find a time. Try something like 'motivation at 7am' or 'trivia at 6:30am'.";
      }

    } else {
      reply = await askGPT([
        {
          role: 'system',
          content: `You are Sunny, a warm friendly WhatsApp assistant. Reply naturally like a friend texting — conversational, helpful, short. No bullet points, no formal tone. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
        },
        { role: 'user', content: text }
      ]);
    }
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

cron.schedule('* * * * *', async () => {
  const now = new Date();
  for (const [phone, schedules] of Object.entries(userSchedules)) {
    for (const schedule of schedules) {
      if (schedule.hour === now.getHours() && schedule.min === now.getMinutes()) {
        await sendScheduledMessage(phone, schedule.prompt);
      }
    }
  }
});

app.listen(3000, () => console.log('Sunny bot running!'));
