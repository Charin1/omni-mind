#!/bin/bash
# setup.sh - First-time setup for OmniMind

echo "======================================"
echo "    OmniMind First Time Setup         "
echo "======================================"

# 1. Environment variables
echo "-> Checking .env configuration..."
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "   Created .env from .env.example"
        echo "   NOTE: Please update .env with your API keys!"
    else
        echo "   Warning: .env.example not found."
    fi
else
    echo "   .env already exists."
fi

# 2. Backend Setup
echo "-> Setting up Backend (Python)..."
cd backend
if [ ! -d ".venv" ]; then
    echo "   Creating virtual environment .venv..."
    python3 -m venv .venv
fi
echo "   Activating venv and installing requirements..."
source .venv/bin/activate
pip install -r requirements.txt
cd ..

# 3. Frontend Setup
echo "-> Setting up Frontend (Node.js)..."
cd frontend
echo "   Running npm install..."
npm install
cd ..

# 4. Fetch initial models
echo "-> Fetching latest models from providers..."
python3 fetch_models.py

echo "======================================"
echo "  Setup Complete!                     "
echo "  1. Update your API keys in the .env file."
echo "  2. You can run `python3 fetch_models.py` at any time to update your model list."
echo "  3. Run `sh start.sh` to start the app."
echo "======================================"
