// Jest setup: provide safe defaults so requiring config/ (which validates and
// exits on missing vars) works in tests without a real environment.
process.env.TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || '123456789:TEST_TOKEN';
process.env.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '123456789';

// Keep reconciliation disabled and complete-or-empty so config/ never exits
// because of a partial configuration inherited from the developer's shell.
delete process.env.MONGO_URI;
delete process.env.LND_GRPC_HOST;
delete process.env.LND_CERT_BASE64;
delete process.env.LND_MACAROON_BASE64;
