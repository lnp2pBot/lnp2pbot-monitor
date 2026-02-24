const TelegramBot = require('node-telegram-bot-api');
const { logger, formatUptime, formatMemory, formatRelativeTime, validateHealthData, retryWithBackoff } = require('./utils');

class BotMonitor {
  constructor(config) {
    this.config = config;
    this.alertBot = new TelegramBot(config.TELEGRAM_BOT_TOKEN);
    this.lastHeartbeat = null;
    this.consecutiveFailures = 0;
    this.botMetrics = null;
    this.alertHistory = new Map(); // Prevent alert spam
    this.isStarted = false;
    
    logger.info('BotMonitor initialized', {
      authRequired: !!config.AUTH_TOKEN,
      missingHeartbeatThreshold: config.MISSING_HEARTBEAT_THRESHOLD + ' minutes',
      criticalAlertThrottle: config.CRITICAL_ALERT_THROTTLE + ' minutes',
      warningAlertThrottle: config.WARNING_ALERT_THROTTLE + ' minutes',
    });
  }

  /**
   * Record a heartbeat from the bot
   * @param {object} healthData - Health data from bot
   */
  recordHeartbeat(healthData) {
    try {
      // Validate health data
      const validation = validateHealthData(healthData);
      if (!validation.isValid) {
        logger.warn('Invalid health data received', {
          errors: validation.errors,
          healthData: JSON.stringify(healthData).substring(0, 500),
        });
        return;
      }

      this.lastHeartbeat = Date.now();
      this.botMetrics = healthData;
      this.consecutiveFailures = 0;
      
      logger.debug('Heartbeat recorded successfully', {
        bot: healthData.bot,
        dbState: healthData.dbState,
        lightningConnected: healthData.lightningConnected,
        memory: formatMemory(healthData.memory?.rss || 0),
        uptime: formatUptime(healthData.uptime || 0),
      });
      
      // Check for critical issues in real-time
      this.checkCriticalIssues(healthData);
    } catch (error) {
      logger.error('Error processing heartbeat', {
        error: error.message,
        stack: error.stack,
        healthData: JSON.stringify(healthData).substring(0, 500),
      });
    }
  }

  /**
   * Check for critical issues in received health data
   * @param {object} metrics - Health metrics
   */
  async checkCriticalIssues(metrics) {
    const alerts = [];
    
    // Database issues
    if (!metrics.dbConnected) {
      alerts.push({
        level: 'critical',
        message: '🚨 CRITICAL: MongoDB disconnected!',
        key: 'db_disconnected'
      });
    }
    
    // Lightning node issues
    if (!metrics.lightningConnected) {
      const errorInfo = metrics.lastError ? `\nError: ${metrics.lastError}` : '';
      alerts.push({
        level: 'critical',
        message: `🚨 CRITICAL: Lightning node disconnected!${errorInfo}`,
        key: 'ln_disconnected'
      });
    } else if (metrics.lightningInfo) {
      // Lightning node connected but with issues
      if (!metrics.lightningInfo.synced_to_chain) {
        alerts.push({
          level: 'warning',
          message: '⚠️ Lightning node not synced to chain',
          key: 'ln_not_synced_chain'
        });
      }
      
      if (!metrics.lightningInfo.synced_to_graph) {
        alerts.push({
          level: 'warning',
          message: '⚠️ Lightning node not synced to graph',
          key: 'ln_not_synced_graph'
        });
      }
      
      if (metrics.lightningInfo.active_channels_count === 0) {
        alerts.push({
          level: 'warning',
          message: '⚠️ No active Lightning channels!',
          key: 'ln_no_channels'
        });
      }
    }
    
    // Memory issues
    const memoryMB = metrics.memory?.rss ? Math.round(metrics.memory.rss / 1024 / 1024) : 0;
    if (memoryMB > this.config.VERY_HIGH_MEMORY_THRESHOLD) {
      alerts.push({
        level: 'critical',
        message: `🚨 CRITICAL: Very high memory usage: ${memoryMB}MB`,
        key: 'very_high_memory'
      });
    } else if (memoryMB > this.config.HIGH_MEMORY_THRESHOLD) {
      alerts.push({
        level: 'warning',
        message: `⚠️ High memory usage: ${memoryMB}MB`,
        key: 'high_memory'
      });
    }
    
    // Very long uptime (might need restart)
    const uptimeDays = metrics.uptime ? Math.floor(metrics.uptime / 86400) : 0;
    if (uptimeDays > this.config.LONG_UPTIME_THRESHOLD) {
      alerts.push({
        level: 'info',
        message: `📝 Long uptime: ${uptimeDays} days - consider restart for maintenance`,
        key: 'long_uptime'
      });
    }
    
    // Aggregate alerts that pass throttling into a single message
    const alertsToSend = [];
    for (const alert of alerts) {
      if (this.shouldSendAlert(alert)) {
        alertsToSend.push(alert);
      }
    }

    if (alertsToSend.length > 0) {
      const aggregatedMessage = alertsToSend.map(a => a.message).join('\n\n');
      const success = await this.sendAlert(aggregatedMessage);
      if (success) {
        const now = Date.now();
        for (const alert of alertsToSend) {
          this.alertHistory.set(alert.key, now);
        }
      }
    }
  }

  /**
   * Check if an alert should be sent based on throttling rules
   * @param {object} alert - Alert object with level, message, and key
   * @returns {boolean} Whether the alert should be sent
   */
  shouldSendAlert(alert) {
    const now = Date.now();
    const lastSent = this.alertHistory.get(alert.key) || 0;
    
    // Different throttling for different alert levels
    let throttleTime;
    switch (alert.level) {
      case 'critical':
        throttleTime = this.config.CRITICAL_ALERT_THROTTLE * 60 * 1000;
        break;
      case 'warning':
        throttleTime = this.config.WARNING_ALERT_THROTTLE * 60 * 1000;
        break;
      case 'info':
        throttleTime = 60 * 60 * 1000; // 1 hour for info messages
        break;
      default:
        throttleTime = this.config.WARNING_ALERT_THROTTLE * 60 * 1000;
    }
    
    if (now - lastSent > throttleTime) {
      return true;
    }
    
    const nextAllowedTime = new Date(lastSent + throttleTime);
    logger.debug('Alert throttled', {
      key: alert.key,
      level: alert.level,
      nextAllowedTime: nextAllowedTime.toISOString(),
    });
    return false;
  }

  /**
   * Send an alert with throttling to prevent spam (legacy wrapper)
   * @param {object} alert - Alert object with level, message, and key
   */
  async sendAlertWithThrottling(alert) {
    if (this.shouldSendAlert(alert)) {
      const success = await this.sendAlert(alert.message);
      if (success) {
        this.alertHistory.set(alert.key, Date.now());
      }
    }
  }

  /**
   * Send alert to all configured Telegram chat IDs
   * @param {string} message - Alert message
   * @returns {boolean} Success status (true if at least one delivery succeeded)
   */
  async sendAlert(message) {
    const chatIds = this.config.ADMIN_CHAT_IDS;
    let anySuccess = false;

    for (const chatId of chatIds) {
      try {
        await retryWithBackoff(async () => {
          await this.alertBot.sendMessage(chatId, message);
        }, 3, 1000);
        
        logger.info('Alert sent successfully', {
          message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
          chatId,
        });
        anySuccess = true;
      } catch (error) {
        logger.error('Failed to send alert', {
          error: error.message,
          message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
          chatId,
          stack: error.stack,
        });
      }
    }
    
    return anySuccess;
  }

  /**
   * Check for missing heartbeats (runs periodically)
   */
  async checkMissingHeartbeat() {
    if (!this.lastHeartbeat) {
      logger.debug('No heartbeats received yet');
      return;
    }
    
    const now = Date.now();
    const timeSinceLastHeartbeat = now - this.lastHeartbeat;
    const threshold = this.config.MISSING_HEARTBEAT_THRESHOLD * 60 * 1000; // Convert to ms
    
    if (timeSinceLastHeartbeat > threshold) {
      this.consecutiveFailures++;
      const minutesAgo = Math.floor(timeSinceLastHeartbeat / 60000);
      
      logger.warn('Missing heartbeat detected', {
        minutesAgo,
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.config.MISSING_HEARTBEAT_THRESHOLD + ' minutes',
      });
      
      if (this.consecutiveFailures === 1) {
        await this.sendAlertWithThrottling({
          level: 'warning',
          message: `⚠️ @lnp2pBot heartbeat missing (${minutesAgo} min ago)`,
          key: 'missing_heartbeat'
        });
      } else if (this.consecutiveFailures >= 2) {
        await this.sendAlertWithThrottling({
          level: 'critical',
          message: `🚨 CRITICAL: @lnp2pBot silent for ${minutesAgo} minutes!`,
          key: 'bot_silent'
        });
      }
    } else {
      // Reset consecutive failures if heartbeat is recent
      if (this.consecutiveFailures > 0) {
        logger.info('Bot heartbeat recovered', {
          consecutiveFailures: this.consecutiveFailures,
          minutesSinceLastHeartbeat: Math.floor(timeSinceLastHeartbeat / 60000),
        });
        
        this.consecutiveFailures = 0;
        
        // Send recovery notification for critical situations
        if (this.consecutiveFailures > 1) {
          await this.sendAlert('✅ Bot heartbeat recovered - all systems operational');
        }
      }
    }
  }

  /**
   * Get detailed status for API endpoint
   * @returns {object} Detailed status object
   */
  getDetailedStatus() {
    if (!this.botMetrics) {
      return {
        status: 'No data received yet',
        isHealthy: false,
        lastSeen: null,
        consecutiveFailures: this.consecutiveFailures,
        message: 'Waiting for first heartbeat from bot...'
      };
    }
    
    const m = this.botMetrics;
    const isHealthy = this.consecutiveFailures === 0 && m.dbConnected && m.lightningConnected;
    
    return {
      status: isHealthy ? '✅ Healthy' : '🚨 Issues detected',
      isHealthy,
      lastSeen: new Date(this.lastHeartbeat).toISOString(),
      lastSeenRelative: formatRelativeTime(this.lastHeartbeat),
      uptime: formatUptime(m.uptime || 0),
      memory: formatMemory(m.memory?.rss || 0),
      database: {
        connected: m.dbConnected,
        state: m.dbState || 'unknown',
        status: m.dbConnected ? '✅ Connected' : '❌ Disconnected'
      },
      lightning: m.lightningConnected ? {
        connected: true,
        status: '✅ Connected',
        alias: m.lightningInfo?.alias || 'Unknown',
        channels: m.lightningInfo?.active_channels_count || 0,
        peers: m.lightningInfo?.peers_count || 0,
        synced_chain: m.lightningInfo?.synced_to_chain ? '✅' : '❌',
        synced_graph: m.lightningInfo?.synced_to_graph ? '✅' : '❌',
        block_height: m.lightningInfo?.block_height || 0,
        version: m.lightningInfo?.version || 'Unknown'
      } : {
        connected: false,
        status: '❌ Disconnected',
        error: m.lastError || 'Connection failed'
      },
      process: {
        pid: m.processId,
        nodeEnv: m.nodeEnv || 'unknown',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      },
      monitoring: {
        consecutiveFailures: this.consecutiveFailures,
        missingHeartbeatThreshold: this.config.MISSING_HEARTBEAT_THRESHOLD + ' minutes',
        isMonitorHealthy: this.isStarted,
        monitorUptime: formatUptime(process.uptime()),
        alertsThrottled: this.alertHistory.size
      }
    };
  }

  /**
   * Start the monitoring system
   */
  start() {
    if (this.isStarted) {
      logger.warn('Monitor already started');
      return;
    }
    
    // Check for missing heartbeats every minute
    const checkInterval = setInterval(() => {
      this.checkMissingHeartbeat().catch(error => {
        logger.error('Error checking missing heartbeat', {
          error: error.message,
          stack: error.stack,
        });
      });
    }, 60 * 1000);
    
    // Cleanup interval on process exit
    process.on('SIGTERM', () => clearInterval(checkInterval));
    process.on('SIGINT', () => clearInterval(checkInterval));
    
    this.isStarted = true;
    logger.info('Bot health monitoring started', {
      missingHeartbeatThreshold: this.config.MISSING_HEARTBEAT_THRESHOLD + ' minutes',
      checkInterval: '1 minute',
    });
  }

  /**
   * Test Telegram bot connection
   */
  async testTelegramConnection() {
    try {
      const botInfo = await this.alertBot.getMe();
      logger.info('Telegram bot connection test successful', {
        botName: botInfo.username,
        botId: botInfo.id,
      });
      
      // Send a test message
      await this.sendAlert('🧪 Test alert - lnp2pBot monitor is starting up');
      return true;
    } catch (error) {
      logger.error('Telegram bot connection test failed', {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }
}

module.exports = BotMonitor;