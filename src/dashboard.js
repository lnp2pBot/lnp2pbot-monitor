const { logger } = require('./utils');

/**
 * Create dashboard middleware function
 * @param {BotMonitor} monitor - Monitor instance
 * @returns {function} Express middleware function
 */
const createDashboard = (monitor) => {
  return (req, res) => {
    try {
      const status = monitor.getDetailedStatus();
      
      // Check if client wants JSON response
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json(status);
      }
      
      // Generate HTML dashboard
      const html = generateDashboardHTML(status);
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      logger.error('Error generating dashboard', {
        error: error.message,
        stack: error.stack,
      });
      
      res.status(500).send('Error generating dashboard');
    }
  };
};

/**
 * Generate HTML dashboard
 * @param {object} status - Status object from monitor
 * @returns {string} HTML content
 */
const generateDashboardHTML = (status) => {
  const statusColor = status.isHealthy ? '#28a745' : '#dc3545';
  const statusIcon = status.isHealthy ? '✅' : '🚨';
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>lnp2pBot Health Monitor</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            backdrop-filter: blur(10px);
        }
        
        .header {
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }
        
        .header p {
            font-size: 1.2em;
            opacity: 0.9;
        }
        
        .status-overview {
            padding: 30px;
            text-align: center;
            background: ${status.isHealthy ? 'linear-gradient(135deg, #56ab2f 0%, #a8e6cf 100%)' : 'linear-gradient(135deg, #ff6b6b 0%, #ffa0a0 100%)'};
        }
        
        .status-badge {
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 50px;
            padding: 15px 30px;
            font-size: 1.8em;
            font-weight: bold;
            color: white;
            margin-bottom: 15px;
        }
        
        .last-seen {
            font-size: 1.1em;
            color: rgba(255, 255, 255, 0.9);
        }
        
        .content {
            padding: 30px;
        }
        
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            border-left: 5px solid #667eea;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        
        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
        }
        
        .card.critical {
            border-left-color: #dc3545;
        }
        
        .card.warning {
            border-left-color: #ffc107;
        }
        
        .card.success {
            border-left-color: #28a745;
        }
        
        .card h3 {
            font-size: 1.3em;
            margin-bottom: 15px;
            color: #333;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .card-content {
            color: #666;
            line-height: 1.6;
        }
        
        .metric {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }
        
        .metric:last-child {
            border-bottom: none;
        }
        
        .metric-label {
            font-weight: 500;
            color: #333;
        }
        
        .metric-value {
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
            font-weight: bold;
            color: #666;
        }
        
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 8px;
        }
        
        .status-indicator.healthy {
            background: #28a745;
            box-shadow: 0 0 10px rgba(40, 167, 69, 0.4);
        }
        
        .status-indicator.unhealthy {
            background: #dc3545;
            box-shadow: 0 0 10px rgba(220, 53, 69, 0.4);
        }
        
        .refresh-info {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            color: #666;
            font-size: 0.9em;
        }
        
        .refresh-button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 25px;
            font-size: 1em;
            cursor: pointer;
            transition: transform 0.2s ease;
            margin-left: 15px;
        }
        
        .refresh-button:hover {
            transform: scale(1.05);
        }
        
        .footer {
            text-align: center;
            padding: 20px;
            background: #f8f9fa;
            color: #666;
            font-size: 0.9em;
        }
        
        @media (max-width: 768px) {
            .grid {
                grid-template-columns: 1fr;
            }
            
            .header h1 {
                font-size: 2em;
            }
            
            .status-badge {
                font-size: 1.4em;
            }
        }
        
        .json-link {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(255, 255, 255, 0.9);
            padding: 10px 15px;
            border-radius: 25px;
            text-decoration: none;
            color: #667eea;
            font-weight: bold;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
        }
        
        .json-link:hover {
            background: #667eea;
            color: white;
            transform: translateY(-2px);
        }
    </style>
    <script>
        // Auto-refresh every 30 seconds
        setTimeout(() => {
            window.location.reload();
        }, 30000);
        
        // Manual refresh function
        function refreshNow() {
            window.location.reload();
        }
    </script>
</head>
<body>
    <a href="/api/status" class="json-link">📊 JSON API</a>
    
    <div class="container">
        <div class="header">
            <h1>⚡ lnp2pBot Health Monitor</h1>
            <p>Real-time health monitoring for your Lightning Network bot</p>
        </div>
        
        <div class="status-overview">
            <div class="status-badge">
                ${statusIcon} ${status.status}
            </div>
            <div class="last-seen">
                ${status.lastSeen ? `Last seen: ${status.lastSeenRelative}` : 'No data received yet'}
            </div>
        </div>
        
        <div class="content">
            ${generateCardsHTML(status)}
            
            <div class="refresh-info">
                🔄 Auto-refresh in <span id="countdown">30</span> seconds
                <button class="refresh-button" onclick="refreshNow()">Refresh Now</button>
            </div>
        </div>
        
        <div class="footer">
            Made with ❤️ for the Bitcoin Lightning Network community<br>
            <a href="https://github.com/lnp2pBot/lnp2pbot-monitor" target="_blank">🐙 View on GitHub</a>
        </div>
    </div>
    
    <script>
        // Countdown timer
        let countdown = 30;
        const countdownElement = document.getElementById('countdown');
        
        const updateCountdown = () => {
            countdown--;
            if (countdown <= 0) {
                window.location.reload();
            } else {
                countdownElement.textContent = countdown;
            }
        };
        
        setInterval(updateCountdown, 1000);
    </script>
</body>
</html>`;
};

/**
 * Generate cards HTML for the dashboard
 * @param {object} status - Status object
 * @returns {string} HTML for cards
 */
const generateCardsHTML = (status) => {
  let cardsHTML = '<div class="grid">';
  
  // Process Information Card
  cardsHTML += `
    <div class="card">
        <h3>🚀 Process Information</h3>
        <div class="card-content">
            <div class="metric">
                <span class="metric-label">Uptime</span>
                <span class="metric-value">${status.uptime || 'Unknown'}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Memory Usage</span>
                <span class="metric-value">${status.memory || 'Unknown'}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Process ID</span>
                <span class="metric-value">${status.process?.pid || 'Unknown'}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Environment</span>
                <span class="metric-value">${status.process?.nodeEnv || 'Unknown'}</span>
            </div>
        </div>
    </div>
  `;
  
  // Database Card
  const dbCardClass = status.database?.connected ? 'card success' : 'card critical';
  const dbIndicator = status.database?.connected ? 'healthy' : 'unhealthy';
  
  cardsHTML += `
    <div class="${dbCardClass}">
        <h3>🗄️ Database</h3>
        <div class="card-content">
            <div class="metric">
                <span class="metric-label">Status</span>
                <span class="metric-value">
                    <span class="status-indicator ${dbIndicator}"></span>
                    ${status.database?.status || 'Unknown'}
                </span>
            </div>
            <div class="metric">
                <span class="metric-label">State</span>
                <span class="metric-value">${status.database?.state || 'Unknown'}</span>
            </div>
        </div>
    </div>
  `;
  
  // Lightning Network Card
  const lnCardClass = status.lightning?.connected ? 'card success' : 'card critical';
  const lnIndicator = status.lightning?.connected ? 'healthy' : 'unhealthy';
  
  if (status.lightning?.connected) {
    cardsHTML += `
      <div class="${lnCardClass}">
          <h3>⚡ Lightning Network</h3>
          <div class="card-content">
              <div class="metric">
                  <span class="metric-label">Status</span>
                  <span class="metric-value">
                      <span class="status-indicator ${lnIndicator}"></span>
                      ${status.lightning.status}
                  </span>
              </div>
              <div class="metric">
                  <span class="metric-label">Alias</span>
                  <span class="metric-value">${status.lightning.alias}</span>
              </div>
              <div class="metric">
                  <span class="metric-label">Active Channels</span>
                  <span class="metric-value">${status.lightning.channels}</span>
              </div>
              <div class="metric">
                  <span class="metric-label">Peers</span>
                  <span class="metric-value">${status.lightning.peers}</span>
              </div>
              <div class="metric">
                  <span class="metric-label">Chain Sync</span>
                  <span class="metric-value">${status.lightning.synced_chain}</span>
              </div>
              <div class="metric">
                  <span class="metric-label">Graph Sync</span>
                  <span class="metric-value">${status.lightning.synced_graph}</span>
              </div>
          </div>
      </div>
    `;
  } else {
    cardsHTML += `
      <div class="${lnCardClass}">
          <h3>⚡ Lightning Network</h3>
          <div class="card-content">
              <div class="metric">
                  <span class="metric-label">Status</span>
                  <span class="metric-value">
                      <span class="status-indicator ${lnIndicator}"></span>
                      ${status.lightning?.status || '❌ Disconnected'}
                  </span>
              </div>
              ${status.lightning?.error ? `
              <div class="metric">
                  <span class="metric-label">Error</span>
                  <span class="metric-value">${status.lightning.error}</span>
              </div>
              ` : ''}
          </div>
      </div>
    `;
  }
  
  // Monitoring Card
  const monitorCardClass = status.monitoring?.isMonitorHealthy ? 'card success' : 'card warning';
  
  cardsHTML += `
    <div class="${monitorCardClass}">
        <h3>📊 Monitoring System</h3>
        <div class="card-content">
            <div class="metric">
                <span class="metric-label">Monitor Uptime</span>
                <span class="metric-value">${status.monitoring?.monitorUptime || 'Unknown'}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Consecutive Failures</span>
                <span class="metric-value">${status.monitoring?.consecutiveFailures || 0}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Heartbeat Threshold</span>
                <span class="metric-value">${status.monitoring?.missingHeartbeatThreshold || 'Unknown'}</span>
            </div>
            <div class="metric">
                <span class="metric-label">Active Alerts</span>
                <span class="metric-value">${status.monitoring?.alertsThrottled || 0}</span>
            </div>
        </div>
    </div>
  `;
  
  cardsHTML += '</div>';
  return cardsHTML;
};

module.exports = {
  createDashboard,
  generateDashboardHTML,
};