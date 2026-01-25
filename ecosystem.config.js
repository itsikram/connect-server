// PM2 Ecosystem File for Load Balancing with Cluster Mode
// This uses Node.js cluster module for load balancing across CPU cores

module.exports = {
  apps: [{
    name: 'connect-server',
    script: './index.js',
    instances: 'max', // Use all available CPU cores, or specify a number like 4
    exec_mode: 'cluster', // Enable cluster mode for load balancing
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Auto restart on crash
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Advanced settings
    instance_var: 'INSTANCE_ID',
    increment_var: 'PORT',
    
    // Health check
    health_check_grace_period: 3000,
    
    // Socket.IO sticky session support
    // Note: When using PM2 cluster mode with Socket.IO, you may need Redis adapter
    // See: https://socket.io/docs/v4/using-multiple-nodes/
  }]
};
