from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.database import get_db
from db.models import Setting

router = APIRouter(prefix="/api/settings", tags=["settings"])

# Keys the API will accept - avoids the settings table becoming a junk drawer.
ALLOWED_KEYS = {"system_instructions"}


class SettingPayload(BaseModel):
    value: Any = None


@router.get("/{key}")
async def get_setting(key: str, db: AsyncSession = Depends(get_db)):
    setting = await db.get(Setting, key)
    return {"key": key, "value": setting.value if setting else None}


@router.put("/{key}")
async def put_setting(key: str, payload: SettingPayload, db: AsyncSession = Depends(get_db)):
    if key not in ALLOWED_KEYS:
        return {"key": key, "value": None, "error": f"Unknown setting '{key}'"}

    setting = await db.get(Setting, key)
    if setting:
        setting.value = payload.value
    else:
        setting = Setting(key=key, value=payload.value)
        db.add(setting)
    await db.commit()
    return {"key": key, "value": payload.value}


async def get_setting_value(db: AsyncSession, key: str) -> Optional[Any]:
    """Helper for other modules (e.g. chat) to read a setting server-side."""
    setting = await db.get(Setting, key)
    return setting.value if setting else None
