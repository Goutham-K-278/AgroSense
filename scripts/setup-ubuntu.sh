#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a normal user (no sudo)."
  exit 1
fi

echo "[1/7] Installing Ubuntu packages..."
sudo apt-get update
sudo apt-get install -y \
  git \
  curl \
  build-essential \
  python3 \
  python3-venv \
  python3-pip \
  python-is-python3 \
  nodejs \
  npm

echo "[2/7] Verifying versions..."
node -v
npm -v
python --version

echo "[3/7] Creating Python virtual environment..."
if [[ ! -d ".venv" ]]; then
  python -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "[4/7] Installing Python dependencies..."
python -m pip install --upgrade pip
python -m pip install -r backend/requirements.txt

echo "[5/7] Installing Node dependencies..."
npm install
npm install --prefix backend
npm install --prefix frontend

echo "[6/7] Creating env files from templates (if missing)..."
[[ -f backend/.env ]] || cp backend/.env.example backend/.env
[[ -f frontend/.env ]] || cp frontend/.env.example frontend/.env

echo "[7/7] Build check..."
npm run --prefix frontend build
node --check backend/server.js

echo "Setup complete."
echo "Next: edit backend/.env and frontend/.env, then run: npm run dev"
