// Jest setup: provide safe defaults so requiring config/ (which validates and
// exits on missing vars) works in tests without a real environment.
process.env.TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || '123456789:TEST_TOKEN';
process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '123456789';
