# API Documentation

This document describes the API endpoints available in the lnp2pBot Health Monitor.

## Base URL

```
https://your-monitor-domain.com
```

For local development:
```
http://localhost:3000
```

## Authentication

Some endpoints require authentication via Bearer token in the Authorization header:

```
Authorization: Bearer <your-auth-token>
```

The auth token is configured via the `AUTH_TOKEN` environment variable.

## Endpoints

### GET /health

Health check endpoint for this monitoring service itself.

**Purpose:** Used by external monitors (like UptimeRobot) to check if this monitoring service is running.

**Authentication:** None required

**Response:**
```json
{
  "status": "ok",
  "monitoring": "active",
  "timestamp": "2026-02-21T14:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.0"
}
```

**Status Codes:**
- `200 OK` - Service is healthy
- `500 Internal Server Error` - Service has issues

---

### POST /api/heartbeat

Receives health data from lnp2pBot instances.

**Purpose:** Main endpoint where bots send their health metrics.

**Authentication:** Bearer token required if `AUTH_TOKEN` is configured

**Request Headers:**
```
Content-Type: application/json
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "bot": "lnp2pBot",
  "timestamp": 1708516800000,
  "uptime": 3600,
  "memory": {
    "rss": 134217728,
    "heapUsed": 67108864,
    "heapTotal": 134217728,
    "external": 1234567
  },
  "processId": 1234,
  "nodeEnv": "production",
  "dbConnected": true,
  "dbState": "connected",
  "lightningConnected": true,
  "lightningInfo": {
    "alias": "my-lightning-node",
    "public_key": "02...",
    "chains": ["bitcoin"],
    "version": "0.16.0-beta",
    "block_height": 800000,
    "synced_to_chain": true,
    "synced_to_graph": true,
    "peers_count": 10,
    "active_channels_count": 5,
    "pending_channels_count": 0
  },
  "lastError": "Optional error message if Lightning node had issues"
}
```

**Field Descriptions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bot` | string | Yes | Bot identifier (should be "lnp2pBot") |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |
| `uptime` | number | Yes | Process uptime in seconds |
| `memory` | object | Yes | Node.js memory usage statistics |
| `processId` | number | Yes | Process ID |
| `nodeEnv` | string | No | Node.js environment (production, development) |
| `dbConnected` | boolean | Yes | MongoDB connection status |
| `dbState` | string | No | MongoDB connection state |
| `lightningConnected` | boolean | Yes | Lightning node connection status |
| `lightningInfo` | object | No | Lightning node details (if connected) |
| `lastError` | string | No | Last error message (if any) |

**Response:**
```json
{
  "status": "received",
  "timestamp": "2026-02-21T14:30:00.000Z"
}
```

**Status Codes:**
- `200 OK` - Heartbeat processed successfully
- `400 Bad Request` - Invalid data format or missing required fields
- `401 Unauthorized` - Missing authentication token
- `403 Forbidden` - Invalid authentication token
- `429 Too Many Requests` - Rate limit exceeded
- `500 Internal Server Error` - Server error processing heartbeat

---

### GET /

Status dashboard (HTML).

**Purpose:** Human-readable dashboard showing bot health status.

**Authentication:** None required

**Response:** HTML page with visual dashboard

**Features:**
- Real-time status overview
- Process information
- Database status
- Lightning Network status
- Monitoring system metrics
- Auto-refresh every 30 seconds

---

### GET /api/status

Detailed status information (JSON).

**Purpose:** Programmatic access to detailed bot status.

**Authentication:** None required

**Response:**
```json
{
  "status": "✅ Healthy",
  "isHealthy": true,
  "lastSeen": "2026-02-21T14:25:00.000Z",
  "lastSeenRelative": "5 minutes ago",
  "uptime": "1d 2h 30m",
  "memory": "128MB",
  "database": {
    "connected": true,
    "state": "connected",
    "status": "✅ Connected"
  },
  "lightning": {
    "connected": true,
    "status": "✅ Connected",
    "alias": "my-lightning-node",
    "channels": 5,
    "peers": 10,
    "synced_chain": "✅",
    "synced_graph": "✅",
    "block_height": 800000,
    "version": "0.16.0-beta"
  },
  "process": {
    "pid": 1234,
    "nodeEnv": "production",
    "nodeVersion": "v18.17.0",
    "platform": "linux",
    "arch": "x64"
  },
  "monitoring": {
    "consecutiveFailures": 0,
    "missingHeartbeatThreshold": "6 minutes",
    "isMonitorHealthy": true,
    "monitorUptime": "5d 2h",
    "alertsThrottled": 3
  }
}
```

**Status when unhealthy:**
```json
{
  "status": "🚨 Issues detected",
  "isHealthy": false,
  "lastSeen": "2026-02-21T14:20:00.000Z",
  "lastSeenRelative": "10 minutes ago",
  "database": {
    "connected": false,
    "state": "disconnected",
    "status": "❌ Disconnected"
  },
  "lightning": {
    "connected": false,
    "status": "❌ Disconnected",
    "error": "Connection timeout"
  },
  "monitoring": {
    "consecutiveFailures": 2,
    "isMonitorHealthy": true
  }
}
```

**Status Codes:**
- `200 OK` - Status retrieved successfully
- `500 Internal Server Error` - Error getting status

---

## Rate Limiting

The API implements rate limiting to prevent abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| All endpoints | 100 requests | 15 minutes |
| `/api/heartbeat` | 10 requests | 1 minute |

When rate limits are exceeded, the API returns:

```json
{
  "error": "Too many requests from this IP, please try again later."
}
```

**Status Code:** `429 Too Many Requests`

## Error Responses

All endpoints return consistent error responses:

```json
{
  "error": "Error description"
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `400` | Bad Request - Invalid input data |
| `401` | Unauthorized - Missing authentication |
| `403` | Forbidden - Invalid authentication |
| `404` | Not Found - Endpoint doesn't exist |
| `429` | Too Many Requests - Rate limit exceeded |
| `500` | Internal Server Error - Server error |

## Example Usage

### Sending a heartbeat (from lnp2pBot)

```javascript
const healthData = {
  bot: 'lnp2pBot',
  timestamp: Date.now(),
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  processId: process.pid,
  nodeEnv: process.env.NODE_ENV || 'unknown',
  dbConnected: true,
  dbState: 'connected',
  lightningConnected: true,
  lightningInfo: {
    alias: 'my-node',
    active_channels_count: 5,
    synced_to_chain: true,
    synced_to_graph: true
  }
};

const response = await fetch('https://monitor.example.com/api/heartbeat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-secret-token'
  },
  body: JSON.stringify(healthData)
});

const result = await response.json();
console.log('Heartbeat sent:', result);
```

### Checking status programmatically

```javascript
const response = await fetch('https://monitor.example.com/api/status');
const status = await response.json();

if (status.isHealthy) {
  console.log('✅ Bot is healthy');
} else {
  console.log('🚨 Bot has issues:', status.status);
}
```

### Using curl

```bash
# Send heartbeat
curl -X POST https://monitor.example.com/api/heartbeat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "bot": "lnp2pBot",
    "timestamp": 1708516800000,
    "uptime": 3600,
    "memory": {"rss": 134217728},
    "processId": 1234,
    "dbConnected": true,
    "lightningConnected": true
  }'

# Check status
curl https://monitor.example.com/api/status

# Health check
curl https://monitor.example.com/health
```

## Webhook Integration

For advanced use cases, you can integrate the status endpoint with other monitoring systems:

### UptimeRobot

1. Create HTTP(s) monitor
2. URL: `https://your-monitor-url/health`
3. Interval: 5 minutes
4. Expected keyword: `"status":"ok"`

### Prometheus/Grafana

```yaml
# prometheus.yml
- job_name: 'lnp2pbot-monitor'
  static_configs:
    - targets: ['your-monitor-url:443']
  metrics_path: '/api/status'
  scheme: https
```

### Custom Webhooks

You can poll the `/api/status` endpoint and forward alerts to your own systems based on the `isHealthy` field and specific component statuses.

## Security Notes

1. **Always use HTTPS** in production
2. **Use strong authentication tokens** - generate random 32+ character tokens
3. **Monitor rate limiting** - implement proper backoff in your bot
4. **Keep tokens secure** - never commit them to version control
5. **Rotate tokens regularly** - especially if you suspect compromise

## Troubleshooting

### Common Issues

1. **401 Unauthorized**
   - Check that `AUTH_TOKEN` is set in monitor environment
   - Verify bot is sending correct token in `Authorization` header

2. **429 Rate Limited**
   - Reduce heartbeat frequency
   - Check for multiple bot instances sending to same endpoint

3. **400 Bad Request**
   - Verify all required fields are present
   - Check timestamp format (should be Unix milliseconds)
   - Validate memory object structure

4. **Heartbeats not being processed**
   - Check monitor service logs
   - Verify network connectivity between bot and monitor
   - Test with curl to isolate issues