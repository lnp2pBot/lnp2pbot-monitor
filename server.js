const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const config = require('./config');
const logger = require('./src/utils').logger;
const BotMonitor = require('./src/monitor');
const PaymentReconciler = require('./src/reconciliation');
const { createDashboard } = require('./src/dashboard');

const app = express();
const monitor = new BotMonitor(config);
const reconciler = config.RECONCILIATION_ENABLED
  ? new PaymentReconciler(config, (message) => monitor.sendAlert(message))
  : null;

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

// Stricter rate limiting for heartbeat endpoint
const heartbeatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // max 10 heartbeats per minute per IP
  message: 'Too many heartbeats from this IP, please try again later.',
});

// Body parsing middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Authentication middleware
const authenticateToken = (req, res, next) => {
  if (!config.AUTH_TOKEN) {
    return next(); // No auth required if token not configured
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    logger.warn('Heartbeat attempted without authentication token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
    return res.status(401).json({ error: 'Authentication token required' });
  }

  if (token !== config.AUTH_TOKEN) {
    logger.warn('Heartbeat attempted with invalid authentication token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      token: token.substring(0, 10) + '...', // Log partial token for debugging
    });
    return res.status(403).json({ error: 'Invalid authentication token' });
  }

  next();
};

// Health check endpoint (for UptimeRobot and other external monitors)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    monitoring: 'active',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: require('./package.json').version,
  });
});

// Heartbeat endpoint - receives health data from lnp2pBot
app.post('/api/heartbeat', heartbeatLimiter, authenticateToken, (req, res) => {
  try {
    const healthData = req.body;

    // Validate required fields
    if (!healthData || typeof healthData !== 'object') {
      return res.status(400).json({ error: 'Invalid health data format' });
    }

    if (!healthData.bot || !healthData.timestamp) {
      return res.status(400).json({
        error: 'Missing required fields: bot, timestamp',
      });
    }

    // Validate timestamp is reasonable (not too old or in future)
    const now = Date.now();
    const timestampAge = now - healthData.timestamp;
    const maxAge = 10 * 60 * 1000; // 10 minutes
    const maxFuture = 5 * 60 * 1000; // 5 minutes

    if (timestampAge > maxAge) {
      logger.warn('Received heartbeat with old timestamp', {
        bot: healthData.bot,
        timestampAge: Math.floor(timestampAge / 60000) + ' minutes',
      });
      return res.status(400).json({
        error: 'Timestamp too old',
      });
    }

    if (timestampAge < -maxFuture) {
      logger.warn('Received heartbeat with future timestamp', {
        bot: healthData.bot,
        timestampAge: Math.floor(-timestampAge / 60000) + ' minutes in future',
      });
      return res.status(400).json({
        error: 'Timestamp too far in future',
      });
    }

    // Process the heartbeat
    monitor.recordHeartbeat(healthData);

    logger.debug('Heartbeat received and processed', {
      bot: healthData.bot,
      dbState: healthData.dbState,
      lightningConnected: healthData.lightningConnected,
      memory: healthData.memory
        ? Math.round(healthData.memory.rss / 1024 / 1024) + 'MB'
        : 'unknown',
    });

    res.json({
      status: 'received',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error processing heartbeat', {
      error: error.message,
      stack: error.stack,
      body: req.body,
    });

    res.status(500).json({
      error: 'Internal server error processing heartbeat',
    });
  }
});

// Status dashboard endpoint
app.get('/', createDashboard(monitor));

// API endpoint for detailed status (JSON)
app.get('/api/status', (req, res) => {
  try {
    const status = monitor.getDetailedStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error getting status', {
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      error: 'Internal server error getting status',
    });
  }
});

// Payment reconciliation status
app.get('/api/reconciliation', (req, res) => {
  if (!reconciler) {
    return res.json({ enabled: false });
  }
  res.json(reconciler.getStatus());
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /api/status',
      'POST /api/heartbeat',
    ],
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal server error',
  });
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason,
    promise: promise,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

// Start server
const PORT = config.PORT;
const server = app.listen(PORT, () => {
  logger.info(`lnp2pBot Monitor started on port ${PORT}`, {
    version: require('./package.json').version,
    nodeEnv: process.env.NODE_ENV || 'development',
    authRequired: !!config.AUTH_TOKEN,
  });

  // Initialize monitoring system
  monitor.start();

  // Start payment reconciliation when configured. A start failure (MongoDB or
  // LND unreachable) must not go silent: this feature watches money leaving
  // the node, so alert the admins and keep retrying until it comes up.
  if (reconciler) {
    const RECONCILIATION_START_RETRY_MS = 5 * 60 * 1000;
    const startReconciliation = () => {
      reconciler
        .start()
        .then(() => {
          reconciler.lastError = null;
        })
        .catch((error) => {
          reconciler.lastError = `Failed to start: ${error.message}`;
          logger.error('Failed to start payment reconciliation, will retry', {
            error: error.message,
            stack: error.stack,
            retryInMinutes: RECONCILIATION_START_RETRY_MS / 60000,
          });
          monitor
            .sendAlertWithThrottling({
              level: 'critical',
              message: `🚨 CRITICAL: payment reconciliation failed to start: ${error.message}. Outgoing payments are NOT being monitored. Retrying every ${RECONCILIATION_START_RETRY_MS / 60000} minutes.`,
              key: 'reconciliation_start_failed',
            })
            .catch(() => {});
          setTimeout(startReconciliation, RECONCILIATION_START_RETRY_MS);
        });
    };
    startReconciliation();
  } else {
    logger.info(
      'Payment reconciliation disabled (set MONGO_URI, LND_GRPC_HOST and LND_MACAROON_BASE64 to enable)'
    );
  }
});

module.exports = { app, server };
