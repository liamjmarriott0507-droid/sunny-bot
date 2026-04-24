const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};
const userConversations = {};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function callGPT(messages, maxTokens = 500) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o', messages, max_tokens: maxTokens },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return response.data.choices[0].message.content;
}

async function parseIntent(userText, phone) {
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Singapore'
  });

  const scheduleList = (userSchedules[phone] || []).map((s, i) => {
    const h12 = s.hour % 12 || 12;
    const ampm = s.hour >= 12 ? 'pm' : 'am';
    const min = String(s.min).padStart(2, '0');
    return `${i}: ${s.label} at ${h12}:${min}${ampm} (${s.oneTime ? 'one-time' : 'daily'})`;
  }).join('\n') || 'none';

  const history = userConversations[phone] || [];

  const systemPrompt = `You are Sunny — a highly intelligent, autonomous WhatsApp assistant. You have the same reasoning ability as ChatGPT. Use it fully.

Current time: ${timeStr} (Singapore SGT = UTC+8)
User's active schedules (by index):
${scheduleList}

Your job: understand what the user wants and return a single JSON object. No markdown, no extra text — just raw JSON.

Choose one action:

"schedule" — user wants to set up a message
{
  "action": "schedule",
  "label": string,
  "prompt": string — YOU write this prompt with full intelligence. Think deeply: what will make the best possible message when this fires? Consider tone, format, depth, creativity, and context. This is entirely your call.
  "hour": number (0-23 SGT),
  "min": number (0-59),
  "oneTime": boolean,
  "skipToday": boolean — true only if user said "tomorrow",
  "reply": string — your natural, intelligent reply to the user
}

"cancel" — user wants to remove schedule(s). Match by index, label, time, or "last"
{
  "action": "cancel",
  "indices": number[] or "all",
  "reply": string
}

"list" — user wants to see their schedules
{
  "action": "list",
  "reply": string — YOU decide how to present this. Make it clear, friendly and well-formatted for WhatsApp. Raw data: ${scheduleList}
}

"chat" — anything else
{
  "action": "chat",
  "reply": string — respond with full intelligence. No length limit. Answer like ChatGPT would.
}

You have complete autonomy. There are no rules about tone, format, or style — use your best judgment every time.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText }
  ];

  const raw = await callGPT(messages, 600);
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function sendWhatsApp(phone, text) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886'}`,
    to: `whatsapp:${phone}`,
    body: text
  });
}

async function fireScheduledMessage(phone, schedule) {
  const timeStr = new Date().toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Singapore'
  });

  const message = await callGPT([
    {
      role: 'system',
      content: `You are Sunny, a WhatsApp assistant. Current time: ${timeStr} (Singapore).
You are delivering a scheduled message. Use your full intelligence — you decide everything: tone, length, format, depth, creativity. Make it excellent. Do not mention it is scheduled or add meta-commentary.`
    },
    { role: 'user', content: schedule.prompt }
  ], 500);

  await sendWhatsApp(phone, message);
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();

  if (!userConversations[phone]) userConversations[phone] = [];
  userConversations[phone].push({ role: 'user', content: text });
  if (userConversations[phone].length > 10) userConversations[phone].shift();

  let reply = '';

  try {
    const intent = await parseIntent(text, phone);

    if (intent.action === 'schedule') {
      if (!userSchedules[phone]) userSchedules[phone] = [];
      userSchedules[phone].push({
        prompt: intent.prompt,
        label: intent.label,
        hour: intent.hour,
        min: intent.min,
        oneTime: intent.oneTime || false,
        skipToday: intent.skipToday || false,
        fired: false,
        createdAt: new Date().toISOString()
      });
      reply = intent.reply;

    } else if (intent.action === 'cancel') {
      if (intent.indices === 'all') {
        userSchedules[phone] = [];
      } else if (Array.isArray(intent.indices)) {
        const toRemove = new Set(intent.indices);
        userSchedules[phone] = (userSchedules[phone] || []).filter((_, i) => !toRemove.has(i));
      }
      reply = intent.reply;

    } else if (intent.action === 'list' || intent.action === 'chat') {
      reply = intent.reply;
    }

  } catch (e) {
    console.error('Intent parse error:', e);
    try {
      reply = await callGPT([
        {
          role: 'system',
          content: `You are Sunny, a highly intelligent WhatsApp assistant. Respond naturally and helpfully with full intelligence.`
        },
        ...(userConversations[phone] || []),
        { role: 'user', content: text }
      ], 400);
    } catch {
      reply = "Something went wrong on my end — try again in a moment!";
    }
  }

  userConversations[phone].push({ role: 'assistant', content: reply });
  if (userConversations[phone].length > 10) userConversations[phone].shift();

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const sgtOffset = 8 * 60;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const sgtTotalMin = (utcMin + sgtOffset) % (24 * 60);
  const currentHour = Math.floor(sgtTotalMin / 60);
  const currentMin = sgtTotalMin % 60;

  for (const [phone, schedules] of Object.entries(userSchedules)) {
    if (!schedules) continue;
    for (let i = schedules.length - 1; i >= 0; i--) {
      const s = schedules[i];
      if (s.hour !== currentHour || s.min !== currentMin) continue;

      if (s.skipToday) {
        s.skipToday = false;
        continue;
      }

      if (s.oneTime && s.fired) continue;

      try {
        await fireScheduledMessage(phone, s);
        if (s.oneTime) {
          schedules.splice(i, 1);
        } else {
          s.fired = true;
          setTimeout(() => { if (s) s.fired = false; }, 61000);
        }
      } catch (e) {
        console.error(`Error firing schedule for ${phone}:`, e);
      }
    }
  }
});

app.listen(3000, () => console.log('Sunny bot running on port 3000'));
