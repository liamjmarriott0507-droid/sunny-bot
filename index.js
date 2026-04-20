const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const userSchedules = {};
const activeCrons = {};

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
      content: `You classify WhatsApp messages into one of three types. Reply with exactly one word:
SCHEDULE — user wants to set up a new recurring or one-time scheduled message
LIST — user wants to see their current schedules
CANCEL — user wants to cancel/stop schedules
CHAT — anything else, a question, conversation, or general request`
    },
    { role: 'user', content: text }
  ]);
  const upper = result.toUpperCase();
  if (upper.includes('SCHEDULE')) return 'SCHEDULE';
  if (upper.includes('LIST')) return 'LIST';
  if (upper.includes('CANCEL')) return 'CANCEL';
  return 'CHAT';
}

async function parseSchedule(text) {
  const result = await askGPT([
    {
      role: 'system',
      content: `You are a scheduling parser. Given a natural language scheduling request, extract:
1. A valid cron expression (in Asia/Singapore timezone) that represents when to send the message
2. The core message intent (stripped of all time/scheduling words)
3. Whether this is a one-time message or recurring (one_time or recurring)
4. A human readable description of the schedule (e.g. "every day at 7:00am", "this Monday at 3pm", "every weekday at 9am")

Reply ONLY with valid JSON in this exact format, nothing else:
{
  "cron": "30 6 * * *",
  "intent": "send a fun teuteuf game",
  "type": "recurring",
  "description": "every day at 6:30am"
}

Cron format is: minute hour day month weekday
Weekdays: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
Examples:
- "every day at 7am" → "0 7 * * *"
- "every weekday at 8am" → "0 8 * * 1-5"
- "every weekend at 9am" → "0 9 * * 0,6"
- "every Monday and Wednesday at 6pm" → "0 18 * * 1,3"
- "every hour" → "0 * * * *"
- "every 30 minutes" → "*/30 * * * *"
- "once a week on Thursday at 7pm" → "0 19 * * 4"
For one-time messages, still provide the cron but set type to "one_time".`
    },
    { role: 'user', content: text }
  ]);

  try {
    const clean = result.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

async function sendMessage(phone, prompt) {
  const message = await askGPT([
    {
      role: 'system',
      content: `You are Sunny, a warm friendly WhatsApp assistant. Write naturally like a friend texting — short, conversational, no bullet points, no formal language. Just respond directly to the prompt. Today is ${new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Singapore', weekday: 'long', month: 'long', day: 'numeric' })}.`
    },
    { role: 'user', content: prompt }
  ]);

  await twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:${phone}`,
    body: message
  });
}

function scheduleJob(phone, scheduleId, cronExp, prompt, type) {
  const job = cron.schedule(cronExp, async () => {
    await sendMessage(phone, prompt);
    if (type === 'one_time') {
      job.stop();
      if (userSchedules[phone]) {
        userSchedules[phone] = userSchedules[phone].filter(s => s.id !== scheduleId);
      }
      delete activeCrons[scheduleId];
    }
  }, { timezone: 'Asia/Singapore' });

  activeCrons[scheduleId] = job;
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.trim();

  let reply = '';

  const type = await classifyMessage(text);

  if (type === 'CANCEL') {
    if (userSchedules[phone]) {
      userSchedules[phone].forEach(s => {
        if (activeCrons[s.id]) {
          activeCrons[s.id].stop();
          delete activeCrons[s.id];
        }
      });
    }
    userSchedules[phone] = [];
    reply = "All your schedules have been cancelled! Text me anytime to set new ones.";

  } else if (type === 'LIST') {
    if (!userSchedules[phone] || userSchedules[phone].length === 0) {
      reply = "You have no schedules set up yet! Just tell me what you want and when — I'll handle the rest.";
    } else {
      const list = userSchedules[phone].map((s, i) => `${i + 1}. ${s.label} — ${s.description} (${s.type === 'one_time' ? 'one-time' : 'recurring'})`).join('\n');
      reply = `Your schedules:\n${list}\n\nText 'cancel all' to remove everything.`;
    }

  } else if (type === 'SCHEDULE') {
    const parsed = await parseSchedule(text);

    if (parsed && cron.validate(parsed.cron)) {
      if (!userSchedules[phone]) userSchedules[phone] = [];
      const scheduleId = `${phone}_${Date.now()}`;
      const schedule = {
        id: scheduleId,
        prompt: parsed.intent,
        label: parsed.intent,
        description: parsed.description,
        cron: parsed.cron,
        type: parsed.type
      };
      userSchedules[phone].push(schedule);
      scheduleJob(phone, scheduleId, parsed.cron, parsed.intent, parsed.type);
      reply = `Done! ${parsed.type === 'one_time' ? "I'll send that" : "I'll send that"} ${parsed.description}. Text 'list' to see all your schedules.`;
    } else {
      reply = "I couldn't quite figure out that schedule. Try something like 'send me motivation every day at 7am' or 'say hello this Friday at 3pm'.";
    }

  } else {
    reply = await askGPT([
      {
        role: 'system',
        content: `You are Sunny, a warm friendly WhatsApp assistant. Reply naturally like a friend texting — conversational, helpful, short. No bullet points, no formal tone. Today is ${new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Singapore', weekday: 'long', month: 'long', day: 'numeric' })}.`
      },
      { role: 'user', content: text }
    ]);
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

app.listen(3000, () => console.log('Sunny bot running!'));
