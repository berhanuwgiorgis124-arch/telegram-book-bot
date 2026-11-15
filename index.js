const express = require('express');
const { Telegraf, Markup } = require('telegraf');

const requiredEnv = [
  'TELEGRAM_BOT_TOKEN',
  'CHAPA_SECRET_KEY',
  'PUBLIC_BASE_URL'
];

require('dotenv').config();

const crypto = require('node:crypto');

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// የቀረው የቦቱ ኮድ እዚህ ይቀጥላል...
