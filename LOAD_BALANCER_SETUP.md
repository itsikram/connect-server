# Load Balancer Setup Guide for Connect Server

This guide explains how to set up load balancing for your Connect server using multiple approaches.

## Overview

The Connect server now supports load balancing through three methods:
1. **Nginx Load Balancer** (Recommended for production)
2. **Docker Compose with Multiple Instances**
3. **PM2 Cluster Mode** (Node.js built-in clustering)

## Prerequisites

- Node.js 18+ installed
- Nginx installed (for Nginx method)
- Docker and Docker Compose installed (for Docker method)
- PM2 installed globally (for PM2 method): `npm install -g pm2`

## Method 1: Nginx Load Balancer (Recommended)

### Setup Steps

1. **Install Nginx** (if not already installed):
   ```bash
   # Ubuntu/Debian
   sudo apt-get update
   sudo apt-get install nginx
   
   # macOS
   brew install nginx
   
   # Windows
   # Download from: http://nginx.org/en/download.html
   ```

2. **Copy the Nginx configuration**:
   ```bash
   # Linux/macOS
   sudo cp server/nginx.conf /etc/nginx/sites-available/connect
   sudo ln -s /etc/nginx/sites-available/connect /etc/nginx/sites-enabled/
   
   # Or on some systems:
   sudo cp server/nginx.conf /etc/nginx/conf.d/connect.conf
   ```

3. **Update the configuration**:
   - Edit `nginx.conf` and change `server_name localhost` to your domain name
   - Adjust the upstream server ports if needed (default: 4000, 4001, 4002, 4003)

4. **Start multiple server instances**:
   ```bash
   # Terminal 1
   PORT=4000 node server/index.js
   
   # Terminal 2
   PORT=4001 node server/index.js
   
   # Terminal 3
   PORT=4002 node server/index.js
   
   # Terminal 4
   PORT=4003 node server/index.js
   ```

   Or use PM2 to manage them:
   ```bash
   cd server
   PORT=4000 pm2 start index.js --name connect-4000
   PORT=4001 pm2 start index.js --name connect-4001
   PORT=4002 pm2 start index.js --name connect-4002
   PORT=4003 pm2 start index.js --name connect-4003
   ```

5. **Test Nginx configuration**:
   ```bash
   sudo nginx -t
   ```

6. **Start/Reload Nginx**:
   ```bash
   sudo systemctl start nginx
   # or
   sudo systemctl reload nginx
   ```

7. **Access your application**:
   - HTTP: `http://localhost` or `http://your-domain.com`
   - The load balancer will distribute requests across all server instances

### Important Notes for Socket.IO

- Socket.IO connections use `ip_hash` for sticky sessions
- This ensures WebSocket connections stay with the same server instance
- For true horizontal scaling with Socket.IO, consider using Redis adapter (see below)

## Method 2: Docker Compose

### Setup Steps

1. **Create a `.env` file** in the `server` directory:
   ```env
   PROD_MONGODB_URI=your_mongodb_connection_string
   DEV_MONGODB_URI=your_dev_mongodb_connection_string
   FIREBASE_SERVICE_ACCOUNT=your_firebase_service_account_json
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json
   ```

2. **Build and start all services**:
   ```bash
   cd server
   docker-compose up -d --build
   ```

3. **Check status**:
   ```bash
   docker-compose ps
   ```

4. **View logs**:
   ```bash
   docker-compose logs -f
   ```

5. **Stop services**:
   ```bash
   docker-compose down
   ```

### Scaling

To scale to more instances:
```bash
docker-compose up -d --scale server1=1 --scale server2=1 --scale server3=1 --scale server4=1
```

## Method 3: PM2 Cluster Mode

This uses Node.js built-in cluster module to create multiple worker processes.

### Setup Steps

1. **Install PM2 globally**:
   ```bash
   npm install -g pm2
   ```

2. **Create logs directory**:
   ```bash
   mkdir -p server/logs
   ```

3. **Start with PM2**:
   ```bash
   cd server
   pm2 start ecosystem.config.js
   ```

4. **Monitor**:
   ```bash
   pm2 monit
   ```

5. **Save PM2 configuration**:
   ```bash
   pm2 save
   pm2 startup  # Follow instructions to enable auto-start on boot
   ```

### Socket.IO with PM2 Cluster

When using PM2 cluster mode with Socket.IO, you should use Redis adapter for proper message distribution:

1. **Install Redis adapter**:
   ```bash
   cd server
   npm install @socket.io/redis-adapter redis
   ```

2. **Update socketHandler.js** to use Redis adapter (see Socket.IO documentation)

## Load Balancing Algorithms

### Nginx Methods

- **least_conn**: Distributes to server with least active connections (default for HTTP)
- **ip_hash**: Sticky sessions based on client IP (used for Socket.IO)
- **round_robin**: Default, distributes requests evenly
- **least_time**: Distributes to server with least average response time

### PM2 Cluster

- Uses round-robin by default
- Automatically balances across CPU cores

## Health Checks

All methods include health check endpoints at `/health`:
```bash
curl http://localhost:4000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 3600,
  "port": 4000
}
```

## Monitoring

### Nginx Status
```bash
# Check Nginx status
sudo systemctl status nginx

# View access logs
sudo tail -f /var/log/nginx/connect_access.log

# View error logs
sudo tail -f /var/log/nginx/connect_error.log
```

### PM2 Monitoring
```bash
pm2 list
pm2 logs
pm2 monit
```

### Docker Monitoring
```bash
docker-compose ps
docker stats
```

## Performance Tuning

### Nginx
- Adjust `keepalive` connections in `nginx.conf`
- Tune `worker_processes` in main nginx config (usually `auto`)
- Increase `worker_connections` if needed

### PM2
- Adjust `instances` in `ecosystem.config.js`
- Set `max_memory_restart` to prevent memory leaks
- Monitor with `pm2 monit`

## Troubleshooting

### Socket.IO Connection Issues
- Ensure sticky sessions are enabled (ip_hash in nginx)
- Consider using Redis adapter for true horizontal scaling
- Check WebSocket upgrade headers in Nginx config

### Server Not Responding
- Check if all server instances are running
- Verify health check endpoint: `curl http://localhost:4000/health`
- Check Nginx error logs: `sudo tail -f /var/log/nginx/connect_error.log`

### Port Conflicts
- Ensure ports 4000-4003 are available
- Change ports in configuration files if needed
- Update Nginx upstream configuration accordingly

## Production Recommendations

1. **Use Nginx with HTTPS**: Uncomment and configure SSL in `nginx.conf`
2. **Enable Redis for Socket.IO**: For true horizontal scaling
3. **Set up monitoring**: Use PM2 Plus, New Relic, or similar
4. **Configure firewall**: Only expose port 80/443
5. **Set up log rotation**: For Nginx and application logs
6. **Use environment variables**: Never hardcode secrets
7. **Enable rate limiting**: In Nginx to prevent abuse

## Additional Resources

- [Nginx Load Balancing Documentation](https://nginx.org/en/docs/http/load_balancing.html)
- [Socket.IO Multiple Nodes](https://socket.io/docs/v4/using-multiple-nodes/)
- [PM2 Documentation](https://pm2.keymetrics.io/docs/usage/cluster-mode/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
