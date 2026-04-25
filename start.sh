#!/bin/bash
# start.sh - Start OmniMind Locally

echo "======================================"
echo "    Starting OmniMind Services...     "
echo "======================================"

# Cleanup processes when this script exits
trap 'echo "Stopping services..."; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit' EXIT INT TERM

# Start Backend
echo "[1/2] Starting Backend API..."
cd backend
if [ -d ".venv" ]; then
    source .venv/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
fi
uvicorn main:app --reload --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ..

# Start Frontend
echo "[2/2] Starting Frontend UI..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

echo "======================================"
echo "  OmniMind is running!                "
echo "  Backend:  http://localhost:8000     "
echo "  Frontend: http://localhost:3000     "
echo "  Press Ctrl+C to stop both services. "
echo "======================================"

wait
