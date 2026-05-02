const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const xml2js = require('xml2js');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const userSchedules = {};
const userConversations = {};
const userProfiles = {};

// ─── RSS FEEDS ───────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { name: 'CNA Singapore', url: 'https://www.channelnewsasia.com/rss/8395986' },
  { name: 'BBC World',     url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Reuters',       url: 'https://feeds.reuters.com/reuters/topNews' },
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
      content: `You are Sunny, a Telegram news assistant. Today is ${dateStr} (Singapore).
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

async function parseIntent(userText, chatId) {
  const now = new Date();
  const timeStr = now.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Singapore'
  });

  const scheduleList = (userSchedules[chatId] || []).map((s, i) => {
    const h12 = s.hour % 12 || 12;
    const ampm = s.hour >= 12 ? 'pm' : 'am';
    const min = String(s.min).padStart(2, '0');
    const type = s.isNews ? '📰 news digest' : (s.oneTime ? 'one-time' : 'daily');
    return `${i}: ${s.label} at ${h12}:${min}${ampm} (${type})`;
  }).join('\n') || 'none';

  const history = userConversations[chatId] || [];

  const systemPrompt = `You are Sunny — a highly intelligent, autonomous Telegram assistant for DailyDrop. You have the same reasoning ability as ChatGPT. Use it fully.

Current time: ${timeStr} (Singapore SGT = UTC+8)
User's active schedules (by index):
${scheduleList}

Your job: understand what the user wants and return a single JSON object. No markdown, no extra text — just raw JSON.

FORMATTING RULES for all replies (Telegram supports these):
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
  "reply": string — format beautifully. Use 📋 header, bold each label, show time clearly. If empty, suggest examples. Raw data: ${scheduleList}
}

"news_now" — user wants news right now
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

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function fireScheduledMessage(chatId, schedule) {
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
        content: `You are Sunny, a Telegram assistant for DailyDrop. Current time: ${timeStr} (Singapore).
You are delivering a scheduled message. Use your full intelligence — tone, length, format, creativity are all your call. Make it excellent.
Telegram formatting: *bold*, _italic_, emojis.
Do not mention it is scheduled. Do not add meta-commentary.`
      },
      { role: 'user', content: schedule.prompt }
    ], 500);
  }

  await sendTelegram(chatId, message);
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function getOnboardingMessage() {
  return `👋 *Hey, I'm Sunny!* Your personal Telegram assistant from DailyDrop.

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

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  if (!text) return;

  // New user onboarding
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { joinedAt: new Date().toISOString() };
    userConversations[chatId] = [];
    userSchedules[chatId] = [];
    await sendTelegram(chatId, getOnboardingMessage());
    return;
  }

  if (!userConversations[chatId]) userConversations[chatId] = [];
  userConversations[chatId].push({ role: 'user', content: text });
  if (userConversations[chatId].length > 10) userConversations[chatId].shift();

  let reply = '';

  try {
    const intent = await parseIntent(text, chatId);

    if (intent.action === 'schedule') {
      if (!userSchedules[chatId]) userSchedules[chatId] = [];
      userSchedules[chatId].push({
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
        userSchedules[chatId] = [];
      } else if (Array.isArray(intent.indices)) {
        const toRemove = new Set(intent.indices);
        userSchedules[chatId] = (userSchedules[chatId] || []).filter((_, i) => !toRemove.has(i));
      }
      reply = intent.reply;

    } else if (intent.action === 'news_now') {
      await sendTelegram(chatId, intent.reply);
      buildNewsSummary().then(digest => sendTelegram(chatId, digest)).catch(console.error);
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
          content: `You are Sunny, a highly intelligent Telegram assistant for DailyDrop. Respond naturally and helpfully. Use *bold* and emojis where appropriate.`
        },
        ...(userConversations[chatId] || []),
        { role: 'user', content: text }
      ], 400);
    } catch {
      reply = "Something went wrong on my end — try again in a moment! 🙏";
    }
  }

  userConversations[chatId].push({ role: 'assistant', content: reply });
  if (userConversations[chatId].length > 10) userConversations[chatId].shift();

  await sendTelegram(chatId, reply);
});

// ─── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const sgtOffset = 8 * 60;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const sgtTotalMin = (utcMin + sgtOffset) % (24 * 60);
  const currentHour = Math.floor(sgtTotalMin / 60);
  const currentMin = sgtTotalMin % 60;

  for (const [chatId, schedules] of Object.entries(userSchedules)) {
    if (!schedules) continue;
    for (let i = schedules.length - 1; i >= 0; i--) {
      const s = schedules[i];
      if (s.hour !== currentHour || s.min !== currentMin) continue;
      if (s.skipToday) { s.skipToday = false; continue; }
      if (s.oneTime && s.fired) continue;

      try {
        await fireScheduledMessage(chatId, s);
        if (s.oneTime) {
          schedules.splice(i, 1);
        } else {
          s.fired = true;
          setTimeout(() => { if (s) s.fired = false; }, 61000);
        }
      } catch (e) {
        console.error(`Error firing schedule for ${chatId}:`, e);
      }
    }
  }
});

console.log('Sunny bot running on Telegram...');
