import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from dotenv import load_dotenv
from fastapi.staticfiles import StaticFiles
from db.database import engine, Base
from db.migrations import ensure_schema_compatibility

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB (in production, use alembic)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await ensure_schema_compatibility(engine)
    yield

from api.chat import router as chat_router
from api.conversations import router as conv_router
from api.memory import router as mem_router
from api.artifacts import router as artifact_router
from api.mcp import router as mcp_router
from api.tasks import router as task_router

app = FastAPI(title="OmniMind API", lifespan=lifespan)

# Include routers
app.include_router(chat_router)
app.include_router(conv_router)
app.include_router(mem_router)
app.include_router(artifact_router)
app.include_router(mcp_router)
app.include_router(task_router)

# Allow React frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

artifacts_dir = os.path.join(os.path.dirname(__file__), "generated_artifacts")
os.makedirs(artifacts_dir, exist_ok=True)
app.mount("/artifacts", StaticFiles(directory=artifacts_dir), name="artifacts")

@app.get("/")
def read_root():
    return {"message": "Welcome to OmniMind API"}
