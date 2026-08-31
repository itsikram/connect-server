#!/bin/bash
# Start the CPU load balancer plus API backends.
# Usage: ./start-load-balanced.sh [number_of_backends]
# Clients keep calling http://localhost:4000

cd "$(dirname "$0")"
node load-balancer/start-cluster.js "${1:-3}"
