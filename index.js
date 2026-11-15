require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'CHAPA_SECRET_KEY', 'PUBLIC_BASE_URL'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
const CHAPA_API_URL = 'https://api.chapa.global/v2/payments/hosted';
const CHAPA_VERIFY_URL = 'https://api.chapa.global/v2/payments';

const defaultBooks = [
  { id: 'sample-book', title: 'Sample Book', price: 250, description: 'Replace this sample with your book.' },
];

let books = defaultBooks;
if (process.env.BOOKS_JSON) {
  try {
    const parsedBooks = JSON.parse(process.env.BOOKS_JSON);
    if (!Array.isArray(parsedBooks) || parsedBooks.length === 0) {
      throw new Error('BOOKS_JSON must be a non-empty JSON array.');
    }
    books = parsedBooks.map((book, index) => {
      if (!book.title || !Number.isFinite(Number(book.price)) || Number(book.price) <= 0) {
        throw new Error(`Book at index ${index} needs a title and positive price.`);
      }
      return {
        id: String(book.id || `book-${index + 1}`),
        title: String(book.title),
        price: Number(book.price),
        description: String(book.description || ''),
      };
    });
  } catch (error) {
    console.error(`Invalid BOOKS_JSON: ${error.message}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const pendingCustomers = new Map();
// In-memory only: use a persistent database before deploying at scale or restarting the process.
const orders = new Map();

app.use(express.json({ limit: '100kb' }));

function formatPrice(price) {
  return `${price.toLocaleString('en-US')} ETB`;
}

function getCheckoutUrl(payload) {
  return payload?.data?.checkout_url || payload?.checkout_url || payload?.data?.checkoutUrl;
}

function getTransactionReference(payload) {
  return payload?.tx_ref || payload?.reference || payload?.data?.tx_ref || payload?.data?.reference;
}

async function verifyPayment(txRef) {
  const response = await fetch(`${CHAPA_VERIFY_URL}/${encodeURIComponent(txRef)}/verify`, {
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chapa verification failed with HTTP ${response.status}`);
  }
  return result;
}

function isSuccessfulPayment(result) {
  const status = String(result?.data?.status || result?.status || '').toLowerCase();
  return status === 'success' || status === 'successful';
}

async function notifyOrderPaid(txRef, verification) {
  const order = orders.get(txRef);
  if (!order || order.notified || !isSuccessfulPayment(verification)) return;

  order.notified = true;
  order.status = 'paid';
  await bot.telegram.sendMessage(
    order.chatId,
    `Payment confirmed for *${order.book.title}* (${formatPrice(order.book.price)}). Thank you for your purchase!`,
    { parse_mode: 'Markdown' },
  );
}

bot.start(async (ctx) => {
  await ctx.reply(
    'Welcome! Browse the available books and choose one to purchase.',
    Markup.inlineKeyboard([[Markup.button.callback('Browse books', 'show_books')]]),
  );
});

bot.command('books', async (ctx) => {
  await showBooks(ctx);
});

async function showBooks(ctx) {
  const buttons = books.map((book) => [
    Markup.button.callback(`${book.title} — ${formatPrice(book.price)}`, `buy:${book.id}`),
  ]);
  await ctx.reply('Available books:', Markup.inlineKeyboard(buttons));
}

bot.action('show_books', async (ctx) => {
  await ctx.answerCbQuery();
  await showBooks(ctx);
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const book = books.find((item) => item.id === ctx.match[1]);
  if (!book) return ctx.reply('Sorry, that book is no longer available. Send /books to see the catalog.');

  pendingCustomers.set(ctx.from.id, { book, chatId: ctx.chat.id });
  await ctx.reply(`You selected *${book.title}* for ${formatPrice(book.price)}.\n\nPlease send your email address to continue.`, {
    parse_mode: 'Markdown',
  });
});

bot.on('text', async (ctx) => {
  const pending = pendingCustomers.get(ctx.from.id);
  if (!pending) return;

  const email = ctx.message.text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return ctx.reply('That does not look like a valid email address. Please try again.');
  }

  pendingCustomers.delete(ctx.from.id);
  const txRef = `book-${crypto.randomUUID()}`;
  const nameParts = (ctx.from.first_name || 'Customer').trim().split(/\s+/);
  const firstName = nameParts.shift() || 'Customer';
  const lastName = nameParts.join(' ') || (ctx.from.last_name || 'Buyer');
  const order = { ...pending, email, txRef, status: 'pending', notified: false };
  orders.set(txRef, order);

  try {
    const response = await fetch(CHAPA_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: String(pending.book.price),
        currency: process.env.CHAPA_CURRENCY || 'ETB',
        tx_ref: txRef,
        callback_url: `${BASE_URL}/chapa/webhook`,
        return_url: `${BASE_URL}/payment/return`,
        customer: {
          email,
          first_name: firstName,
          last_name: lastName,
        },
        meta: { book_id: pending.book.id, book_title: pending.book.title },
      }),
    });
    const result = await response.json().catch(() => ({}));
    const checkoutUrl = getCheckoutUrl(result);
    if (!response.ok || !checkoutUrl) {
      orders.delete(txRef);
      console.error('Chapa initialization failed:', result);
      return ctx.reply('Sorry, I could not start the payment. Please try again later.');
    }

    await ctx.reply(
      `Your order for *${pending.book.title}* is ready. Complete payment using the secure Chapa link below. I will message you after payment is verified.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url('Pay with Chapa', checkoutUrl)]]),
      },
    );
  } catch (error) {
    orders.delete(txRef);
    console.error('Could not create Chapa checkout:', error.message);
    await ctx.reply('Sorry, payment is temporarily unavailable. Please try again later.');
  }
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/chapa/webhook', async (req, res) => {
  const txRef = getTransactionReference(req.body);
  if (!txRef) return res.status(400).json({ error: 'Missing transaction reference.' });

  try {
    // Never trust a callback alone; confirm status directly with Chapa.
    const verification = await verifyPayment(txRef);
    if (isSuccessfulPayment(verification)) await notifyOrderPaid(txRef, verification);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error(`Webhook verification failed for ${txRef}:`, error.message);
    return res.status(502).json({ error: 'Could not verify payment.' });
  }
});

app.get('/payment/return', (_req, res) => {
  res.type('html').send('<!doctype html><html><body><p>Thank you. Return to Telegram to check your order status.</p></body></html>');
});

bot.catch((error) => console.error('Telegram bot error:', error));

async function start() {
  const server = app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
  try {
    await bot.launch();
    console.log('Telegram book bot is running.');
  } catch (error) {
    server.close();
    throw error;
  }
}

start().catch((error) => {
  console.error('Could not start the bot:', error.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
