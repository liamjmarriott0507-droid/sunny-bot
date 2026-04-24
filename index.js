const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');
const xml2js = require('xml2js');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};
const userConversations = {};
const userProfiles = {};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── RSS FEEDS ───────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'CNA Singapore',  url: 'https://www.channelnewsasia.com/rss/8395986' },
  { name: 'BBC World',      url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Reuters',        url: 'https://feeds.reuters.com/reuters/topNews' },
];

async function fetchRSSFeed(feed) {
  try {
    const res = await axios.get(feed.url, { timeout: 8000 });
    const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
    const items = parsed.rss.channel.item;
    const headlines = (Array.isArray(items) ? items : [items])
      .slice(0, 5)
      .map(item => `- ${item.title}`);
    return `*${feed.name}*\n${headlines.join('\n')}`;
  } catch (e) {
    console.error(`RSS fetch failed for ${feed.name}:`, e.message);
    return null;
  }
}

async function fetchAllNews() {
  const results = await Promise.all(RSS_FEEDS.map(fetchRSSFeed));
  return results.filter(Boolean).join('\n\n');
}

async function buildNewsSummary() {
  const rawHeadlines = await fetchAllNews();
  if (!rawHeadlines) return "Sorry, I couldn't fetch the news right now — try again later! 🙏";

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Singapore'
  });

  const summary = await callGPT([
    {
      role: 'system',
      content: `You are Sunny, a WhatsApp news assistant. Today is ${dateStr} (Singapore).
You have been given today's headlines from multiple sources. Find and present exactly 5 positive, uplifting or constructive stories.

What counts as positive: breakthroughs, achievements, inspiring stories, progress, innovations, acts of kindness, scientific discoveries, economic wins.
Skip: war, crime, disasters, political conflict, tragedies, anything depressing.

Format rules:
- Start with: "*Good News Daily* 🌟 ${dateStr}"
- List exactly 5 stories, each separated by a blank line
- For each: one *bold* headline rewritten warmly, then 1-2 sentences of intelligent context
- End with a short uplifting sign-off
- Use *bold*, _italic_, and a relevant emoji per story
- Never use dashes or markdown bullet points
- Keep total under 1600 characters

Use your full intelligence — reframe positively where warranted, add genuine insight.`
    },
    { role: 'user', content: rawHeadlines }
  ], 900);

  return summary;
}

// ─── GPT ─────────────────────────────────────────────────────────────────────
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
    const type = s.isNews ? '📰 news digest' : (s.oneTime ? 'one-time' : 'daily');
    return `${i}: ${s.label} at ${h12}:${min}${ampm} (${type})`;
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
- Use emojis as visual anchors — ⏰ for time, ✅ for confirmations, ❌ for cancellations, 📋 for lists, 💡 for tips, 📰 for news
- Break messages into short paragraphs, never walls of text
- For lists, put each item on its own line

Choose one action:

"schedule" — user wants to set up a message
{
  "action": "schedule",
  "label": string,
  "prompt": string — YOU write this with full intelligence. For news requests set isNews: true instead and leave prompt empty.
  "hour": number (0-23 SGT),
  "min": number (0-59),
  "oneTime": boolean,
  "skipToday": boolean — true only if user said "tomorrow",
  "isNews": boolean — true if user wants a news digest/overview/headlines,
  "reply": string — confirm with the exact time in bold
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
  "reply": string — format beautifully for WhatsApp. Use 📋 header, bold each label, show time clearly. If empty, suggest examples. Raw data: ${scheduleList}
}

"news_now" — user wants news, headlines, or real-time information RIGHT NOW (not scheduled). Trigger this for: "news", "news now", "what's happening", "latest news", "give me news", "show me news", "today's news", or any request for current headlines/updates. This takes priority over "chat" whenever news or current events are mentioned.
{
  "action": "news_now",
  "reply": string — brief acknowledgement like "Fetching today's news for you 📰"
}

"chat" — anything else
{
  "action": "chat",
  "reply": string — respond with full intelligence. No length limit.
}

You have complete autonomy over tone, style, and content. Always be warm but efficient.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText }
  ];

  const raw = await callGPT(messages, 600);
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── WHATSAPP ─────────────────────────────────────────────────────────────────
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

  let message;

  if (schedule.isNews) {
    message = await buildNewsSummary();
  } else {
    message = await callGPT([
      {
        role: 'system',
        content: `You are Sunny, a WhatsApp assistant for DailyDrop. Current time: ${timeStr} (Singapore).
You are delivering a scheduled message. Use your full intelligence — tone, length, format, creativity are all your call. Make it excellent.
WhatsApp formatting: *bold*, _italic_, emojis. Never use markdown headers or dash bullet points.
Do not mention it is scheduled. Do not add meta-commentary.`
      },
      { role: 'user', content: schedule.prompt }
    ], 500);
  }

  await sendWhatsApp(phone, message);
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function getOnboardingMessage() {
  return `👋 *Hey, I'm Sunny!* Your personal WhatsApp assistant from DailyDrop.

Here's what I can do:

⏰ *Schedule anything*
_"Motivation at 7am"_
_"Remind me to call mum at 5pm"_
_"Daily trivia at 6:30am"_
_"News digest at 8pm"_

📋 *Manage your schedules*
_"List"_ — see all your schedules
_"Cancel [name]"_ — remove one
_"Cancel all"_ — start fresh

📰 *News*
_"News now"_ — get today's digest instantly
_"Daily news at 8pm"_ — schedule it every evening

💬 *Just chat*
Ask me anything — I'll do my best to help.

What would you like to set up? 😊`;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();

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
        prompt: intent.prompt || '',
        label: intent.label,
        hour: intent.hour,
        min: intent.min,
        oneTime: intent.oneTime || false,
        skipToday: intent.skipToday || false,
        isNews: intent.isNews || false,
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

    } else if (intent.action === 'news_now') {
      // Respond immediately then fetch async so WhatsApp doesn't time out
      res.set('Content-Type', 'text/xml');
      res.send(`<Response><Message>${intent.reply}</Message></Response>`);
      buildNewsSummary().then(digest => sendWhatsApp(phone, digest)).catch(console.error);
      return;

    } else if (intent.action === 'list' || intent.action === 'chat') {
      reply = intent.reply;
    }

  } catch (e) {
    console.error('Intent parse error:', e);
    try {
      reply = await callGPT([
        {
          role: 'system',
          content: `You are Sunny, a highly intelligent WhatsApp assistant for DailyDrop. Respond naturally and helpfully. Use *bold* and emojis where appropriate.`
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

// ─── CRON ─────────────────────────────────────────────────────────────────────
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
      if (s.skipToday) { s.skipToday = false; continue; }
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
