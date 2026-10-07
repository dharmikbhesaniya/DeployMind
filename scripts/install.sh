#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "    DeployMind VPS Installer (Open-Source)        "
echo "=================================================="

# Check Docker installation
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

# Create persistent storage directories
mkdir -p /var/lib/deploymind/caddy

echo "Pulling and launching DeployMind..."

docker network create deploymind-net 2>/dev/null || true

# Run Caddy Ingress Container
docker run -d \
  --name deploymind-caddy \
  --restart unless-stopped \
  --network deploymind-net \
  -p 80:80 \
  -p 443:443 \
  -p 127.0.0.1:2019:2019 \
  -v /var/lib/deploymind/caddy:/data \
  caddy:2-alpine

# Run DeployMind Monolith Container
docker run -d \
  --name deploymind \
  --restart unless-stopped \
  --network deploymind-net \
  -p 3000:3000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/lib/deploymind:/var/lib/deploymind \
  -e PORT=3000 \
  -e PROXY_PROVIDER=caddy \
  -e CADDY_API_URL=http://deploymind-caddy:2019 \
  deploymind/deploymind:latest

echo ""
echo "DeployMind is running at http://$(curl -s ifconfig.me):3000"
echo "Open the dashboard to deploy your first repository!"
