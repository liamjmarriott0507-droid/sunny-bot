const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));

const schedules = {};

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendAIMessage(phone, prompt) {
  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
  );

  const message = response.data.choices[0].message.content;

  await twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:${phone}`,
    body: message
  });
}

app.post('/webhook', async (req, res) => {
  const phone = req.body.From.replace('whatsapp:', '');
  const text = req.body.Body.toLowerCase().trim();

  let reply = '';

  if (text.includes('motivation') || text.includes('motivat')) {
    schedules[phone] = 'Send me a short motivational message to start the day';
    reply = "Done! I'll send you a motivational message every morning at 7am. Text 'stop' anytime to cancel.";
  } else if (text.includes('fun fact')) {
    schedules[phone] = 'Send me an interesting fun fact I probably did not know';
    reply = "Done! I'll send you a fun fact every morning at 7am.";
  } else if (text.includes('news')) {
    schedules[phone] = 'Give me a brief summary of general world news today';
    reply = "Done! I'll send you a news briefing every morning at 7am.";
  } else if (text.includes('stop') || text.includes('pause')) {
    delete schedules[phone];
    reply = "Stopped! Text me anytime to start again.";
  } else {
    schedules[phone] = req.body.Body;
    reply = `Got it! I'll send you "${req.body.Body}" every morning at 7am.`;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<Response><Message>${reply}</Message></Response>`);
});

cron.schedule('0 7 * * *', async () => {
  for (const [phone, prompt] of Object.entries(schedules)) {
    await sendAIMessage(phone, prompt);
  }
});

app.listen(3000, () => console.log('Sunny bot running!'));
