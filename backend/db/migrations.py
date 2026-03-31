from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


async def ensure_schema_compatibility(engine: AsyncEngine) -> None:
    """
    Lightweight SQLite-friendly schema patching so local development can evolve
    without bringing in Alembic yet.
    """
    statements = [
        "ALTER TABLE conversations ADD COLUMN user_id VARCHAR DEFAULT 'local-user'",
        "ALTER TABLE memories ADD COLUMN user_id VARCHAR DEFAULT 'local-user'",
        "ALTER TABLE memories ADD COLUMN conversation_id VARCHAR",
        "ALTER TABLE episodes ADD COLUMN user_id VARCHAR DEFAULT 'local-user'",
    ]

    async with engine.begin() as conn:
        for statement in statements:
            try:
                await conn.execute(text(statement))
            except Exception:
                # Ignore if the column already exists or the table is missing.
                pass
