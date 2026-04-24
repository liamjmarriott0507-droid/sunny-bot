const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};
const userConversations = {};
const userProfiles = {}; // tracks first-time users

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

  const systemPrompt = `You are Sunny — a highly intelligent, autonomous WhatsApp assistant for DailyDrop. You have the same reasoning ability as ChatGPT. Use it fully.

Current time: ${timeStr} (Singapore SGT = UTC+8)
User's active schedules (by index):
${scheduleList}

Your job: understand what the user wants and return a single JSON object. No markdown, no extra text — just raw JSON.

FORMATTING RULES for all replies (WhatsApp only supports these):
- Use *bold* for headers, labels, times and key info
- Use _italic_ for subtle notes or hints
- Use emojis as visual anchors — ⏰ for time, ✅ for confirmations, ❌ for cancellations, 📋 for lists, 💡 for tips
- Break messages into short paragraphs, never walls of text
- For lists, put each item on its own line

Choose one action:

"schedule" — user wants to set up a message
{
  "action": "schedule",
  "label": string,
  "prompt": string — YOU write this with full intelligence. Think about tone, format, depth, creativity. This is your canvas. Include WhatsApp formatting instructions in the prompt so the fired message is also well-formatted.
  "hour": number (0-23 SGT),
  "min": number (0-59),
  "oneTime": boolean,
  "skipToday": boolean — true only if user said "tomorrow",
  "reply": string — confirm with the exact time in bold e.g. "✅ Got it! I'll send your *Daily Motivation* every day at *7:00am* 🌅"
}

"cancel" — user wants to remove schedule(s). Match by index, label, time, or "last"
{
  "action": "cancel",
  "indices": number[] or "all",
  "reply": string — use ❌ and bold the cancelled schedule name
}

"list" — user wants to see their schedules
{
  "action": "list",
  "reply": string — format beautifully for WhatsApp. Use 📋 header, bold each label, show time clearly. If empty, suggest 3 example schedules they could set up. Raw data: ${scheduleList}
}

"chat" — anything else including ambiguous messages
{
  "action": "chat",
  "reply": string — respond with full intelligence. If the message is ambiguous, ask one clear clarifying question. If they want something Sunny can't do, acknowledge it warmly and suggest what Sunny can do instead. No length limit.
}

You have complete autonomy over tone, style, and content. Always be warm but efficient. Use your best judgment.`;

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
      content: `You are Sunny, a WhatsApp assistant for DailyDrop. Current time: ${timeStr} (Singapore).
You are delivering a scheduled message. Use your full intelligence — tone, length, format, creativity are all your call. Make it excellent.

WhatsApp formatting available: *bold*, _italic_, emojis. Use them to make the message clear and visually appealing. Never use markdown headers or bullet points with dashes.
Do not mention it is scheduled. Do not add meta-commentary.`
    },
    { role: 'user', content: schedule.prompt }
  ], 500);

  await sendWhatsApp(phone, message);
}

function getOnboardingMessage() {
  return `👋 *Hey, I'm Sunny!* Your personal WhatsApp assistant from DailyDrop.

Here's what I can do:

⏰ *Schedule anything*
_"Motivation at 7am"_
_"Remind me to call mum at 5pm"_
_"Daily trivia at 6:30am"_
_"Joke every day at 9am"_

📋 *Manage your schedules*
_"List"_ — see all your schedules
_"Cancel [name]"_ — remove one
_"Cancel all"_ — start fresh

💬 *Just chat*
Ask me anything — I'll do my best to help.

What would you like to set up? 😊`;
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();

  // First-time user onboarding
  if (!userProfiles[phone]) {
    userProfiles[phone] = { joinedAt: new Date().toISOString() };
    userConversations[phone] = [];
    userSchedules[phone] = [];

    res.set('Content-Type', 'text/xml');
    res.send(`<Response><Message>${getOnboardingMessage()}</Message></Response>`);
    return;
  }

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
          content: `You are Sunny, a highly intelligent WhatsApp assistant for DailyDrop. Respond naturally and helpfully. Use *bold* and emojis where appropriate for WhatsApp.`
        },
        ...(userConversations[phone] || []),
        { role: 'user', content: text }
      ], 400);
    } catch {
      reply = "Something went wrong on my end — try again in a moment! 🙏";
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
