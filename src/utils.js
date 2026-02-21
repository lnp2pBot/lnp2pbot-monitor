const winston = require('winston');
const config = require('../config');

// Create logger instance
const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'lnp2pbot-monitor' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Add file transport in production
if (config.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    })
  );
  
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 3,
    })
  );
}

/**
 * Format uptime in human-readable format
 * @param {number} uptimeSeconds - Uptime in seconds
 * @returns {string} Formatted uptime (e.g., "2d 4h 30m")
 */
const formatUptime = (uptimeSeconds) => {
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.length > 0 ? parts.join(' ') : '0m';
};

/**
 * Format memory in human-readable format
 * @param {number} bytes - Memory in bytes
 * @returns {string} Formatted memory (e.g., "256MB")
 */
const formatMemory = (bytes) => {
  const mb = Math.round(bytes / 1024 / 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)}GB`;
  }
  return `${mb}MB`;
};

/**
 * Format timestamp as relative time
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Relative time (e.g., "2 minutes ago")
 */
const formatRelativeTime = (timestamp) => {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes === 1) return '1 minute ago';
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
};

/**
 * Safe string truncation
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
const truncateString = (str, maxLength = 100) => {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
};

/**
 * Check if a timestamp is considered recent
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {number} maxAgeMinutes - Maximum age in minutes
 * @returns {boolean} True if timestamp is recent
 */
const isRecent = (timestamp, maxAgeMinutes = 10) => {
  const now = Date.now();
  const ageMs = now - timestamp;
  const ageMinutes = ageMs / 60000;
  return ageMinutes <= maxAgeMinutes;
};

/**
 * Validate health data structure
 * @param {object} healthData - Health data from bot
 * @returns {object} Validation result with isValid and errors
 */
const validateHealthData = (healthData) => {
  const errors = [];
  
  if (!healthData || typeof healthData !== 'object') {
    return { isValid: false, errors: ['Health data must be an object'] };
  }
  
  // Required fields
  const requiredFields = ['bot', 'timestamp', 'uptime', 'memory', 'processId', 'dbConnected'];
  for (const field of requiredFields) {
    if (!(field in healthData)) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Type validations
  if (healthData.timestamp && typeof healthData.timestamp !== 'number') {
    errors.push('timestamp must be a number');
  }
  
  if (healthData.uptime && typeof healthData.uptime !== 'number') {
    errors.push('uptime must be a number');
  }
  
  if (healthData.processId && typeof healthData.processId !== 'number') {
    errors.push('processId must be a number');
  }
  
  if (healthData.dbConnected && typeof healthData.dbConnected !== 'boolean') {
    errors.push('dbConnected must be a boolean');
  }
  
  if (healthData.lightningConnected && typeof healthData.lightningConnected !== 'boolean') {
    errors.push('lightningConnected must be a boolean');
  }
  
  // Memory object validation
  if (healthData.memory) {
    if (typeof healthData.memory !== 'object') {
      errors.push('memory must be an object');
    } else {
      const memoryFields = ['rss', 'heapUsed', 'heapTotal'];
      for (const field of memoryFields) {
        if (field in healthData.memory && typeof healthData.memory[field] !== 'number') {
          errors.push(`memory.${field} must be a number`);
        }
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Create a delay promise
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} Promise that resolves after delay
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry an async function with exponential backoff
 * @param {function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelayMs - Base delay in milliseconds
 * @returns {Promise} Promise that resolves with function result or rejects
 */
const retryWithBackoff = async (fn, maxRetries = 3, baseDelayMs = 1000) => {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        break;
      }
      
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      logger.debug(`Retry attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delayMs}ms`, {
        error: error.message,
        attempt: attempt + 1,
        maxRetries: maxRetries + 1,
        delayMs
      });
      
      await delay(delayMs);
    }
  }
  
  throw lastError;
};

module.exports = {
  logger,
  formatUptime,
  formatMemory,
  formatRelativeTime,
  truncateString,
  isRecent,
  validateHealthData,
  delay,
  retryWithBackoff,
};