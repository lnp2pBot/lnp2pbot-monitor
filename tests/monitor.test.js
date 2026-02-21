const BotMonitor = require('../src/monitor');

// Mock configuration
const mockConfig = {
  TELEGRAM_BOT_TOKEN: '123456789:TEST_TOKEN',
  ADMIN_CHAT_ID: '123456789',
  AUTH_TOKEN: 'test-token',
  MISSING_HEARTBEAT_THRESHOLD: 6,
  CRITICAL_ALERT_THROTTLE: 5,
  WARNING_ALERT_THROTTLE: 30,
  HIGH_MEMORY_THRESHOLD: 1024,
  VERY_HIGH_MEMORY_THRESHOLD: 2048,
  LONG_UPTIME_THRESHOLD: 30,
};

// Mock Telegram bot
jest.mock('node-telegram-bot-api', () => {
  return jest.fn().mockImplementation(() => ({
    sendMessage: jest.fn().mockResolvedValue({}),
    getMe: jest.fn().mockResolvedValue({ username: 'test_bot', id: 123456789 }),
  }));
});

describe('BotMonitor', () => {
  let monitor;

  beforeEach(() => {
    monitor = new BotMonitor(mockConfig);
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(monitor.config).toBe(mockConfig);
      expect(monitor.lastHeartbeat).toBeNull();
      expect(monitor.consecutiveFailures).toBe(0);
      expect(monitor.botMetrics).toBeNull();
      expect(monitor.alertHistory).toBeInstanceOf(Map);
      expect(monitor.isStarted).toBe(false);
    });
  });

  describe('recordHeartbeat', () => {
    test('should record valid heartbeat data', () => {
      const validHealthData = {
        bot: 'lnp2pBot',
        timestamp: Date.now(),
        uptime: 3600,
        memory: { rss: 134217728, heapUsed: 67108864, heapTotal: 134217728 },
        processId: 1234,
        nodeEnv: 'test',
        dbConnected: true,
        dbState: 'connected',
        lightningConnected: true,
        lightningInfo: {
          alias: 'test-node',
          synced_to_chain: true,
          synced_to_graph: true,
          active_channels_count: 5,
          peers_count: 10,
        },
      };

      monitor.recordHeartbeat(validHealthData);

      expect(monitor.lastHeartbeat).toBeGreaterThan(0);
      expect(monitor.botMetrics).toEqual(validHealthData);
      expect(monitor.consecutiveFailures).toBe(0);
    });

    test('should handle invalid heartbeat data', () => {
      const invalidHealthData = {
        // Missing required fields
        bot: 'lnp2pBot',
      };

      const originalLastHeartbeat = monitor.lastHeartbeat;
      monitor.recordHeartbeat(invalidHealthData);

      // Should not update lastHeartbeat or botMetrics for invalid data
      expect(monitor.lastHeartbeat).toBe(originalLastHeartbeat);
    });

    test('should reset consecutive failures on valid heartbeat', () => {
      monitor.consecutiveFailures = 3;

      const validHealthData = {
        bot: 'lnp2pBot',
        timestamp: Date.now(),
        uptime: 3600,
        memory: { rss: 134217728 },
        processId: 1234,
        dbConnected: true,
        lightningConnected: true,
      };

      monitor.recordHeartbeat(validHealthData);

      expect(monitor.consecutiveFailures).toBe(0);
    });
  });

  describe('getDetailedStatus', () => {
    test('should return "no data" status when no metrics available', () => {
      const status = monitor.getDetailedStatus();

      expect(status.status).toBe('No data received yet');
      expect(status.isHealthy).toBe(false);
      expect(status.lastSeen).toBeNull();
      expect(status.message).toBe('Waiting for first heartbeat from bot...');
    });

    test('should return healthy status with valid metrics', () => {
      const healthyMetrics = {
        bot: 'lnp2pBot',
        timestamp: Date.now(),
        uptime: 3600,
        memory: { rss: 134217728 },
        processId: 1234,
        nodeEnv: 'production',
        dbConnected: true,
        dbState: 'connected',
        lightningConnected: true,
        lightningInfo: {
          alias: 'my-node',
          active_channels_count: 5,
          peers_count: 10,
          synced_to_chain: true,
          synced_to_graph: true,
          block_height: 800000,
          version: '0.16.0',
        },
      };

      monitor.recordHeartbeat(healthyMetrics);
      const status = monitor.getDetailedStatus();

      expect(status.isHealthy).toBe(true);
      expect(status.status).toBe('✅ Healthy');
      expect(status.database.connected).toBe(true);
      expect(status.lightning.connected).toBe(true);
      expect(status.lightning.alias).toBe('my-node');
    });

    test('should return unhealthy status with issues', () => {
      const unhealthyMetrics = {
        bot: 'lnp2pBot',
        timestamp: Date.now(),
        uptime: 3600,
        memory: { rss: 134217728 },
        processId: 1234,
        dbConnected: false,
        dbState: 'disconnected',
        lightningConnected: false,
        lastError: 'Connection failed',
      };

      monitor.recordHeartbeat(unhealthyMetrics);
      const status = monitor.getDetailedStatus();

      expect(status.isHealthy).toBe(false);
      expect(status.status).toBe('🚨 Issues detected');
      expect(status.database.connected).toBe(false);
      expect(status.lightning.connected).toBe(false);
      expect(status.lightning.error).toBe('Connection failed');
    });
  });

  describe('start', () => {
    test('should start monitoring and set isStarted flag', () => {
      expect(monitor.isStarted).toBe(false);

      monitor.start();

      expect(monitor.isStarted).toBe(true);
    });

    test('should not start twice', () => {
      monitor.start();
      expect(monitor.isStarted).toBe(true);

      monitor.start();
      expect(monitor.isStarted).toBe(true);
    });
  });

  describe('checkMissingHeartbeat', () => {
    test('should not alert when no heartbeats received yet', async () => {
      const sendAlertSpy = jest.spyOn(monitor, 'sendAlert');

      await monitor.checkMissingHeartbeat();

      expect(sendAlertSpy).not.toHaveBeenCalled();
    });

    test('should not alert when heartbeat is recent', async () => {
      monitor.lastHeartbeat = Date.now() - 1000; // 1 second ago
      const sendAlertWithThrottlingSpy = jest.spyOn(monitor, 'sendAlertWithThrottling');

      await monitor.checkMissingHeartbeat();

      expect(sendAlertWithThrottlingSpy).not.toHaveBeenCalled();
    });

    test('should alert when heartbeat is missing', async () => {
      monitor.lastHeartbeat = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      const sendAlertWithThrottlingSpy = jest.spyOn(monitor, 'sendAlertWithThrottling')
        .mockResolvedValue();

      await monitor.checkMissingHeartbeat();

      expect(sendAlertWithThrottlingSpy).toHaveBeenCalledWith({
        level: 'warning',
        message: expect.stringContaining('heartbeat missing'),
        key: 'missing_heartbeat'
      });
      expect(monitor.consecutiveFailures).toBe(1);
    });

    test('should escalate alert after multiple failures', async () => {
      monitor.lastHeartbeat = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      monitor.consecutiveFailures = 1; // Already failed once
      
      const sendAlertWithThrottlingSpy = jest.spyOn(monitor, 'sendAlertWithThrottling')
        .mockResolvedValue();

      await monitor.checkMissingHeartbeat();

      expect(sendAlertWithThrottlingSpy).toHaveBeenCalledWith({
        level: 'critical',
        message: expect.stringContaining('CRITICAL'),
        key: 'bot_silent'
      });
      expect(monitor.consecutiveFailures).toBe(2);
    });
  });

  describe('sendAlert', () => {
    test('should send alert successfully', async () => {
      const mockSendMessage = jest.fn().mockResolvedValue({});
      monitor.alertBot.sendMessage = mockSendMessage;

      const result = await monitor.sendAlert('Test alert');

      expect(mockSendMessage).toHaveBeenCalledWith(
        mockConfig.ADMIN_CHAT_ID,
        'Test alert'
      );
      expect(result).toBe(true);
    });

    test('should handle send alert failure', async () => {
      const mockSendMessage = jest.fn().mockRejectedValue(new Error('Network error'));
      monitor.alertBot.sendMessage = mockSendMessage;

      const result = await monitor.sendAlert('Test alert');

      expect(result).toBe(false);
    });
  });

  describe('testTelegramConnection', () => {
    test('should test connection successfully', async () => {
      const mockGetMe = jest.fn().mockResolvedValue({ username: 'test_bot', id: 123456789 });
      const mockSendMessage = jest.fn().mockResolvedValue({});
      
      monitor.alertBot.getMe = mockGetMe;
      monitor.alertBot.sendMessage = mockSendMessage;

      const result = await monitor.testTelegramConnection();

      expect(mockGetMe).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(
        mockConfig.ADMIN_CHAT_ID,
        expect.stringContaining('Test alert')
      );
      expect(result).toBe(true);
    });

    test('should handle connection failure', async () => {
      const mockGetMe = jest.fn().mockRejectedValue(new Error('Invalid token'));
      monitor.alertBot.getMe = mockGetMe;

      const result = await monitor.testTelegramConnection();

      expect(result).toBe(false);
    });
  });
});