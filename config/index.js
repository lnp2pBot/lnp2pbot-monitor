require('dotenv').config();

const config = {
  // Server configuration
  PORT: parseInt(process.env.PORT) || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Telegram bot configuration (required)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
  
  // Authentication (optional)
  AUTH_TOKEN: process.env.AUTH_TOKEN,
  
  // Monitoring thresholds
  MISSING_HEARTBEAT_THRESHOLD: parseInt(process.env.MISSING_HEARTBEAT_THRESHOLD) || 6, // minutes
  CRITICAL_ALERT_THROTTLE: parseInt(process.env.CRITICAL_ALERT_THROTTLE) || 5, // minutes
  WARNING_ALERT_THROTTLE: parseInt(process.env.WARNING_ALERT_THROTTLE) || 30, // minutes
  
  // Memory thresholds
  HIGH_MEMORY_THRESHOLD: parseInt(process.env.HIGH_MEMORY_THRESHOLD) || 1024, // MB
  VERY_HIGH_MEMORY_THRESHOLD: parseInt(process.env.VERY_HIGH_MEMORY_THRESHOLD) || 2048, // MB
  
  // Uptime thresholds
  LONG_UPTIME_THRESHOLD: parseInt(process.env.LONG_UPTIME_THRESHOLD) || 30, // days
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info', // error, warn, info, debug
};

// Validation
const requiredConfig = ['TELEGRAM_BOT_TOKEN', 'ADMIN_CHAT_ID'];
const missingConfig = requiredConfig.filter(key => !config[key]);

if (missingConfig.length > 0) {
  console.error('❌ Missing required environment variables:', missingConfig.join(', '));
  console.error('');
  console.error('Required configuration:');
  console.error('  TELEGRAM_BOT_TOKEN - Telegram bot token for sending alerts');
  console.error('  ADMIN_CHAT_ID - Telegram chat ID to send alerts to');
  console.error('');
  console.error('Optional configuration:');
  console.error('  AUTH_TOKEN - Authentication token for heartbeat endpoint');
  console.error('  MISSING_HEARTBEAT_THRESHOLD - Minutes before missing heartbeat alert (default: 6)');
  console.error('  CRITICAL_ALERT_THROTTLE - Minutes between critical alerts (default: 5)');
  console.error('  WARNING_ALERT_THROTTLE - Minutes between warning alerts (default: 30)');
  console.error('  HIGH_MEMORY_THRESHOLD - Memory threshold in MB for alerts (default: 1024)');
  console.error('  LOG_LEVEL - Logging level: error, warn, info, debug (default: info)');
  console.error('');
  console.error('Example .env file:');
  console.error('  TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');
  console.error('  ADMIN_CHAT_ID=-1001234567890');
  console.error('  AUTH_TOKEN=super-secret-token');
  console.error('');
  process.exit(1);
}

// Validate numeric values
if (config.MISSING_HEARTBEAT_THRESHOLD < 1 || config.MISSING_HEARTBEAT_THRESHOLD > 60) {
  console.error('❌ MISSING_HEARTBEAT_THRESHOLD must be between 1 and 60 minutes');
  process.exit(1);
}

if (config.CRITICAL_ALERT_THROTTLE < 1 || config.CRITICAL_ALERT_THROTTLE > 60) {
  console.error('❌ CRITICAL_ALERT_THROTTLE must be between 1 and 60 minutes');
  process.exit(1);
}

if (config.WARNING_ALERT_THROTTLE < 1 || config.WARNING_ALERT_THROTTLE > 1440) {
  console.error('❌ WARNING_ALERT_THROTTLE must be between 1 and 1440 minutes (24 hours)');
  process.exit(1);
}

// Validate log level
const validLogLevels = ['error', 'warn', 'info', 'debug'];
if (!validLogLevels.includes(config.LOG_LEVEL)) {
  console.error(`❌ LOG_LEVEL must be one of: ${validLogLevels.join(', ')}`);
  process.exit(1);
}

// Validate Telegram configuration format
if (config.TELEGRAM_BOT_TOKEN && !config.TELEGRAM_BOT_TOKEN.match(/^\d+:[A-Za-z0-9_-]+$/)) {
  console.error('❌ TELEGRAM_BOT_TOKEN format appears invalid (should be: 123456789:ABCdefGHI...)');
  console.error('   Get your bot token from @BotFather on Telegram');
  process.exit(1);
}

if (config.ADMIN_CHAT_ID && !config.ADMIN_CHAT_ID.match(/^-?\d+$/)) {
  console.error('❌ ADMIN_CHAT_ID must be a number (e.g., -1001234567890 for groups, 1234567890 for private chats)');
  console.error('   Get your chat ID by messaging @userinfobot on Telegram');
  process.exit(1);
}

// Log configuration (excluding sensitive values)
if (config.NODE_ENV === 'development') {
  console.log('📋 Configuration loaded:');
  console.log('  PORT:', config.PORT);
  console.log('  NODE_ENV:', config.NODE_ENV);
  console.log('  TELEGRAM_BOT_TOKEN:', config.TELEGRAM_BOT_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('  ADMIN_CHAT_ID:', config.ADMIN_CHAT_ID ? '✅ Set' : '❌ Missing');
  console.log('  AUTH_TOKEN:', config.AUTH_TOKEN ? '✅ Set' : '⚠️ Not set (authentication disabled)');
  console.log('  MISSING_HEARTBEAT_THRESHOLD:', config.MISSING_HEARTBEAT_THRESHOLD, 'minutes');
  console.log('  CRITICAL_ALERT_THROTTLE:', config.CRITICAL_ALERT_THROTTLE, 'minutes');
  console.log('  WARNING_ALERT_THROTTLE:', config.WARNING_ALERT_THROTTLE, 'minutes');
  console.log('  HIGH_MEMORY_THRESHOLD:', config.HIGH_MEMORY_THRESHOLD, 'MB');
  console.log('  LOG_LEVEL:', config.LOG_LEVEL);
  console.log('');
}

module.exports = config;