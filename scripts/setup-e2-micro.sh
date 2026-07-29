#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run as normal user, not root."
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required."
  exit 1
fi

echo "[1/4] Creating 2GB swap file (safe to re-run)..."
if ! sudo swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
fi

if ! grep -q '^/swapfile ' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "[2/4] Tuning kernel memory behavior..."
echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-agrosense.conf >/dev/null
sudo sysctl -p /etc/sysctl.d/99-agrosense.conf >/dev/null

echo "[3/4] Verifying Docker and Compose..."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required (docker compose)."
  exit 1
fi

echo "[4/4] Done. Use this to run optimized profile:"
echo "docker compose -f docker-compose.yml -f docker-compose.e2-micro.yml up -d --build"
