#!/bin/bash

# Script to start multiple Connect server instances for load balancing
# Usage: ./start-load-balanced.sh [number_of_instances]

NUM_INSTANCES=${1:-4}
START_PORT=4000

echo "Starting $NUM_INSTANCES Connect server instances..."

# Check if PM2 is installed
if command -v pm2 &> /dev/null; then
    echo "Using PM2 to manage instances..."
    
    # Stop any existing instances
    pm2 delete all 2>/dev/null
    
    # Start instances
    for ((i=0; i<NUM_INSTANCES; i++)); do
        PORT=$((START_PORT + i))
        echo "Starting instance on port $PORT..."
        PORT=$PORT pm2 start index.js --name "connect-$PORT" --no-daemon &
    done
    
    echo "All instances started. Use 'pm2 list' to check status."
    echo "Use 'pm2 logs' to view logs."
    echo "Use 'pm2 stop all' to stop all instances."
else
    echo "PM2 not found. Starting instances in background..."
    echo "Note: Install PM2 for better process management: npm install -g pm2"
    
    # Create logs directory
    mkdir -p logs
    
    # Start instances
    for ((i=0; i<NUM_INSTANCES; i++)); do
        PORT=$((START_PORT + i))
        echo "Starting instance on port $PORT..."
        PORT=$PORT node index.js > "logs/server-$PORT.log" 2>&1 &
        echo $! > "logs/server-$PORT.pid"
    done
    
    echo "All instances started in background."
    echo "Check logs in the 'logs' directory."
    echo "To stop: kill \$(cat logs/server-*.pid)"
fi
