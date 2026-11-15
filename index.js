require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8631290638:AAEXYExCUDhEedg2ifqtWycmyyx210uVMrw';
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

const bookTitle = "እልፍ በል";
const bookAuthor = "ብርሃኑ ወ/ጊዮርጊስ";
const bookPrice = 490;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const orders = new Map();

app.use(express.json({ limit: '100kb' }));

async function createChapaCheckout(email, userId, txRef) {
  const secretKey = process.env.CHAPA_SECRET_KEY.trim();
  
  const payload = {
    amount: String(bookPrice),
    currency: 'ETB',
    email: email,
    first_name: `User${userId}`,
    last_name: 'Customer',
    tx_ref: txRef,
    callback_url: `${BASE_URL}/api/chapa-webhook`,
    return_url: `${BASE_URL}/success?tx_ref=${txRef}`,
    customization: {
      title: bookTitle,
      description: `የመጽሐፍ ግዢ - ${bookTitle}`,
    },
  };

  const response = await fetch(CHAPA_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  console.log('Chapa Full Response:', JSON.stringify(data));

  if (!response.ok || data.status !== 'success') {
    throw new Error(data.message || 'Failed to initialize Chapa payment');
  }
  return data.data.checkout_url;
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const txRef = `tx-${userId}-${Date.now()}`;
  const dummyEmail = `user${userId}@gmail.com`;

  try {
    const checkoutUrl = await createChapaCheckout(dummyEmail, userId, txRef);
    orders.set(txRef, { userId, email: dummyEmail });

    await ctx.reply(
      `እንኳን ደህና መጡ! 📚\n\n📖 **ርዕስ:** ${bookTitle}\n✍️ **ደራሲ:** ${bookAuthor}\n💰 **ዋጋ:** ${bookPrice} ብር\n\nመጽሐፉን ለመግዛት ከታች ያለውን ሊንክ ይጫኑ 💳`,
      Markup.inlineKeyboard([
        [Markup.button.url('💳 490 ብር በ Chapa ክፈል', checkoutUrl)],
      ])
    );
  } catch (err) {
    console.error('Chapa creation error:', err);
    await ctx.reply('የክፍያ ሊንክ ማመንጨት አልተቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።');
  }
});

app.post('/api/chapa-webhook', async (req, res) => {
  const event = req.body;
  const txRef = event.tx_ref;

  if (event.status === 'success' && txRef && orders.has(txRef)) {
    const order = orders.get(txRef);
    try {
      const verifyRes = await fetch(`${CHAPA_VERIFY_URL}/${txRef}`, {
        headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY.trim()}` },
      });
      const verifyData = await verifyRes.json();

      if (verifyRes.ok && verifyData.status === 'success') {
        await bot.telegram.sendDocument(order.userId, {
          source: './content/book.pdf',
          filename: 'book.pdf',
        }, {
          caption: `እንኳን ደስ አሎት! የ "${bookTitle}" ክፍያዎ ተሳክቷል። መጽሐፉን ከላይ ማግኘት ይችላሉ። 📖`,
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
        caption: `ክፍያዎ ተረጋግጧል! የ "${bookTitle}" መጽሐፍ ከቦቱ አግኝተዋል። 📖`,
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

// የ 409 Conflict ግጭትን ሙሉ በሙሉ ለመከላከል ዌብሁክን ማጽዳት እና ማስጀመር
bot.telegram.deleteWebhook({ drop_pending_updates: true }).then(() => {
  bot.launch({ drop_pending_updates: true }).then(() => {
    console.log('Bot started successfully without conflicts!');
  });
}).catch((err) => {
  console.error('Webhook reset error:', err);
  bot.launch({ drop_pending_updates: true });
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
