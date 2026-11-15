require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

process.env.CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || 'CHASECK-2pBuoa0dU4xdQENMAyRiFuw6ATo6oRq4';

const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'CHAPA_SECRET_KEY', 'PUBLIC_BASE_URL'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
const CHAPA_API_URL = 'https://api.chapa.global/v2/payments/hosted';
const CHAPA_VERIFY_URL = 'https://api.chapa.global/v2/payments/verify';

const bookTitle = "የዲጂታል መጽሐፍ (The Digital Edition)";
const bookPrice = 490; // በብር

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const pendingCustomers = new Map();
const orders = new Map();

app.use(express.json({ limit: '100kb' }));

async function createChapaCheckout(email, userId, txRef) {
  const response = await fetch(CHAPA_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: bookPrice,
      currency: 'ETB',
      email: email,
      first_name: `User${userId}`,
      last_name: 'Telegram',
      tx_ref: txRef,
      callback_url: `${BASE_URL}/api/chapa-webhook`,
      return_url: `${BASE_URL}/success?tx_ref=${txRef}`,
      customization: {
        title: 'መጽሐፍ ግዢ (Book Purchase)',
        description: 'የመጽሐፍ ክፍያ በ Chapa',
      },
    }),
  });

  const data = await response.json();
  if (!response.ok || data.status !== 'success') {
    throw new Error(data.message || 'Failed to initialize Chapa payment');
  }
  return data.data.checkout_url;
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  pendingCustomers.set(userId, { step: 'awaiting_email' });

  await ctx.reply(
    `እንኳን ደህና መጡ! 📚\n\n${bookTitle}\nዋጋ፦ **${bookPrice} ብር**\n\nመጽሐፉን ለመግዛት እባክዎ የኢሜይል አድራሻዎን (Email) ይጻፉልን (ለምሳሌ: user@gmail.com):`
  );
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (text.startsWith('/')) return;

  const customer = pendingCustomers.get(userId);
  if (customer && customer.step === 'awaiting_email') {
    if (!text.includes('@') || !text.includes('.')) {
      return ctx.reply('እባክዎ ትክክለኛ የኢሜይል አድራሻ ይጻፉ (ለምሳሌ: example@gmail.com):');
    }

    const email = text;
    const txRef = `tx-book-${userId}-${Date.now()}`;

    try {
      const checkoutUrl = await createChapaCheckout(email, userId, txRef);
      pendingCustomers.delete(userId);
      orders.set(txRef, { userId, email });

      await ctx.reply(
        `የ ${bookPrice} ብር ክፍያ ለመፈጸም ከታች ያለውን ሊንክ ይጫኑ 💳`,
        Markup.inlineKeyboard([
          [Markup.button.url('💳 490 ብር በ Chapa ክፈል', checkoutUrl)],
        ])
      );
    } catch (err) {
      console.error(err);
      await ctx.reply('የክፍያ ሊንክ ማመንጨት አልተቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።');
    }
  }
});

app.post('/api/chapa-webhook', async (req, res) => {
  const event = req.body;
  const txRef = event.tx_ref;

  if (event.status === 'success' && txRef && orders.has(txRef)) {
    const order = orders.get(txRef);
    try {
      const verifyRes = await fetch(`${CHAPA_VERIFY_URL}/verify/${txRef}`, {
        headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
      });
      const verifyData = await verifyRes.json();

      if (verifyRes.ok && verifyData.status === 'success') {
        await bot.telegram.sendDocument(order.userId, {
          source: './content/book.pdf',
          filename: 'book.pdf',
        }, {
          caption: 'እንኳን ደስ አሎት! ክፍያዎ ተሳክቷል። መጽሐፉን ከላይ ማግኘት ይችላሉ። 📖',
        });
        orders.delete(txRef);
      }
    } catch (err) {
      console.error('Verification error:', err);
    }
  }
  res.sendStatus(200);
});

app.get('/success', async (req, res) => {
  const txRef = req.query.tx_ref;
  if (txRef && orders.has(txRef)) {
    const order = orders.get(txRef);
    try {
      await bot.telegram.sendDocument(order.userId, {
        source: './content/book.pdf',
        filename: 'book.pdf',
      }, {
        caption: 'ክፍያዎ ተረጋግጧል! መጽሐፉን ከቦቱ አግኝተዋል። 📖',
      });
      orders.delete(txRef);
    } catch (err) {
      console.error(err);
    }
  }
  res.send('<h3>ክፍያዎ በተሳካ ሁኔታ ተጠናቋል። ወደ ቴሌግራም ቦት በመመለስ መጽሐፍዎን ማውረድ ይችላሉ!</h3>');
});

app.get('/', (req, res) => {
  res.send('Telegram Book Bot is running!');
});

// ድንገተኛ የኮንፍሊክት ችግሮችን ለመከላከል የድሮውን ዌብሁክ ቆሻሻ እናጸዳለን
bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(() => {
  bot.launch().then(() => {
    console.log('Bot started successfully without conflicts!');
  });
}).catch((err) => {
  console.error('Webhook reset error:', err);
  bot.launch();
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
