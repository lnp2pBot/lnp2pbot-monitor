<p align="center">
  <img src="assets/logo.png" alt="lnp2pBot Monitor" width="400">
</p>

# lnp2pBot Health Monitor

**External health monitoring service for lnp2pBot** - Receives push-based heartbeats and sends intelligent alerts when the bot experiences issues.

![Health Monitoring](https://img.shields.io/badge/monitoring-active-green.svg)
![Node.js](https://img.shields.io/badge/node.js-%3E%3D18.0.0-brightgreen.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Overview

This service is part of the **lnp2pBot Health Monitoring System** described in [issue #749](https://github.com/lnp2pBot/bot/issues/749). It provides:

- 🏥 **Real-time health monitoring** for lnp2pBot instances
- 🚨 **Intelligent alerting** with spam protection and escalation
- 📊 **Status dashboard** with detailed health metrics
- ⚙️ **Easy deployment** on Digital Ocean App Platform

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   lnp2pBot      │───▶│  Monitor Service │───▶│  Telegram Alert │
│ (sends metrics) │    │ (this project)   │    │    to Admins    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
        │                       │
        ▼                       ▼
┌─────────────────┐    ┌──────────────────┐
│   UptimeRobot   │    │   UptimeRobot    │
│ (optional)      │    │ (monitor health) │
└─────────────────┘    └──────────────────┘
```

## Quick Start

### Prerequisites

- Node.js ≥ 18.0.0
- npm or yarn
- Telegram bot token (for alerts)

### Local Development

1. **Clone the repository:**
   ```bash
   git clone https://github.com/lnp2pBot/lnp2pbot-monitor.git
   cd lnp2pbot-monitor
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Start the service:**
   ```bash
   npm start
   ```

5. **Configure your bot:**
   Add to your lnp2pBot `.env`:
   ```bash
   MONITOR_HEARTBEAT_URL='http://localhost:3000'
   MONITOR_TOKEN='your-secret-token'
   ```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `TELEGRAM_BOT_TOKEN` | Yes | - | Bot token for sending alerts |
| `ADMIN_CHAT_ID` | Yes | - | Comma-separated list of Telegram chat IDs for alerts |
| `AUTH_TOKEN` | No | - | Optional authentication token |
| `MISSING_HEARTBEAT_THRESHOLD` | No | `6` | Minutes before missing heartbeat alert |
| `CRITICAL_ALERT_THROTTLE` | No | `5` | Minutes between critical alerts |
| `WARNING_ALERT_THROTTLE` | No | `30` | Minutes between warning alerts |
| `LOG_LEVEL` | No | `info` | Logging level (error, warn, info, debug) |

### Example Configuration

```bash
# Required
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
ADMIN_CHAT_ID=-1001234567890,477262720

# Optional
AUTH_TOKEN=super-secret-token-here
MISSING_HEARTBEAT_THRESHOLD=6
LOG_LEVEL=info
```

## Features

### Health Monitoring

The service receives and analyzes comprehensive health data from lnp2pBot:

```json
{
  "bot": "lnp2pBot",
  "timestamp": 1708516800000,
  "uptime": 3600,
  "memory": {
    "rss": 134217728,
    "heapUsed": 67108864,
    "heapTotal": 134217728
  },
  "processId": 1234,
  "nodeEnv": "production",
  "dbConnected": true,
  "dbState": "connected",
  "lightningConnected": true,
  "lightningInfo": {
    "alias": "my-lightning-node",
    "synced_to_chain": true,
    "synced_to_graph": true,
    "active_channels_count": 5,
    "peers_count": 10
  }
}
```

### Intelligent Alerting

#### Critical Alerts (5min throttling)
- 🚨 **MongoDB disconnected**
- 🚨 **Lightning node disconnected**
- 🚨 **Bot missing heartbeats (6+ minutes)**

#### Warning Alerts (30min throttling)
- ⚠️ **Lightning node not synced to chain**
- ⚠️ **Lightning node not synced to graph**
- ⚠️ **No active Lightning channels**
- ⚠️ **High memory usage (>1GB)**
- ⚠️ **Very long uptime (>30 days)**

### Status Dashboard

Access the status dashboard at: `http://your-monitor-url/`

Example response:
```json
{
  "status": "✅ Healthy",
  "lastSeen": "2026-02-21T14:10:00.000Z",
  "uptime": "15d 3h",
  "memory": "245MB",
  "database": "✅ Connected",
  "lightning": {
    "status": "✅ Connected",
    "alias": "my-lightning-node",
    "channels": 5,
    "synced_chain": "✅",
    "synced_graph": "✅"
  }
}
```

## API Endpoints

### POST `/api/heartbeat`

Receives health data from lnp2pBot.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if `AUTH_TOKEN` is configured)

**Request body:** Health metrics JSON (see example above)

**Response:** `200 OK` with `{"status": "received"}`

### GET `/`

Status dashboard with current bot health.

**Response:** JSON object with health summary

### GET `/health`

Health check for this monitor service (for UptimeRobot).

**Response:** `200 OK` with `{"status": "ok", "monitoring": "active"}`

## Deployment

### Digital Ocean App Platform

This service is designed for easy deployment on Digital Ocean App Platform.

1. **Fork this repository** to your GitHub account

2. **Create a new App** in Digital Ocean:
   - Connect your GitHub repository
   - Select "Web Service" component
   - Set environment variables (see Configuration section)

3. **Environment Variables** in DO App Platform:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   ADMIN_CHAT_ID=chat_id1,chat_id2
   AUTH_TOKEN=your_secret_token
   ```

4. **App Specification** (auto-generated):
   ```yaml
   name: lnp2pbot-monitor
   services:
   - name: web
     source_dir: /
     github:
       repo: your-username/lnp2pbot-monitor
       branch: main
     run_command: npm start
     environment_slug: node-js
     instance_count: 1
     instance_size_slug: basic-xxs
   ```

**Cost:** ~$5/month for basic monitoring

### Alternative Deployments

#### Docker

```bash
# Build
docker build -t lnp2pbot-monitor .

# Run
docker run -d \
  -p 3000:3000 \
  -e TELEGRAM_BOT_TOKEN=your_token \
  -e ADMIN_CHAT_ID=chat_id1,chat_id2 \
  lnp2pbot-monitor
```

#### Heroku

```bash
# Deploy
git push heroku main

# Set environment variables
heroku config:set TELEGRAM_BOT_TOKEN=your_token
heroku config:set ADMIN_CHAT_ID=chat_id1,chat_id2
```

## Development

### Project Structure

```
lnp2pbot-monitor/
├── src/
│   ├── monitor.js          # Core monitoring logic
│   ├── alerts.js           # Alert management
│   ├── dashboard.js        # Status dashboard
│   └── utils.js           # Utility functions
├── config/
│   └── index.js           # Configuration management
├── tests/
│   ├── monitor.test.js    # Unit tests
│   └── integration.test.js # Integration tests
├── docs/
│   ├── api.md            # API documentation
│   └── deployment.md     # Deployment guide
├── .env.example          # Example environment file
├── .gitignore
├── Dockerfile
├── package.json
├── server.js             # Entry point
└── README.md
```

### Scripts

```bash
npm start         # Start the service
npm run dev       # Start with auto-reload (nodemon)
npm test          # Run tests
npm run lint      # Lint code
npm run format    # Format code
```

### Testing

```bash
# Unit tests
npm test

# Integration tests (requires bot running)
npm run test:integration

# Test with curl
curl -X POST http://localhost:3000/api/heartbeat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"bot":"test","timestamp":1708516800000}'
```

## Monitoring the Monitor

### UptimeRobot Integration

Monitor this service with UptimeRobot:

1. **Create HTTP(s) monitor** in UptimeRobot
2. **URL:** `https://your-monitor-url/health`
3. **Interval:** 5 minutes
4. **Alert when:** Status code ≠ 200

### Health Check Endpoint

The `/health` endpoint provides service health:

```bash
curl https://your-monitor-url/health
# Response: {"status": "ok", "monitoring": "active"}
```

## Troubleshooting

### Common Issues

#### Bot not sending heartbeats

1. Check bot configuration:
   ```bash
   # In bot .env
   MONITOR_HEARTBEAT_URL=https://your-monitor-url
   MONITOR_TOKEN=your-secret-token
   ```

2. Check bot logs for heartbeat errors

3. Verify monitor service is accessible

#### Alerts not working

1. Verify Telegram bot token and chat ID
2. Check monitor service logs
3. Test Telegram bot manually:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=Test"
   ```

#### High memory usage alerts

Increase memory threshold in `src/monitor.js`:
```javascript
if (metrics.memory.rss > 2048 * 1024 * 1024) { // 2GB instead of 1GB
```

### Logs

Service logs include:

```bash
[INFO] Health monitoring started - waiting for heartbeats...
[DEBUG] Heartbeat received from lnp2pBot - all systems healthy
[WARN] Lightning node not synced to chain
[ERROR] Critical: Bot missing heartbeats for 8 minutes
```

Set `LOG_LEVEL=debug` for verbose logging.

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Add tests for new functionality
5. Ensure tests pass: `npm test`
6. Commit: `git commit -m 'Add amazing feature'`
7. Push: `git push origin feature/amazing-feature`
8. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) file.

## Related Projects

- **[lnp2pBot/bot](https://github.com/lnp2pBot/bot)** - The main lnp2pBot Telegram bot
- **[lnp2pBot/mostro-watchdog](https://github.com/lnp2pBot/mostro-watchdog)** - Telegram bot for Mostro dispute notifications

## Support

- **Issues:** [GitHub Issues](https://github.com/lnp2pBot/lnp2pbot-monitor/issues)
- **Telegram:** [lnp2pBot Help Group](https://t.me/lnp2pbotHelp)
- **Email:** Contact via GitHub issues

---

**Made with ❤️ for the Bitcoin Lightning Network community**
