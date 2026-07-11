import datetime
import uuid
from typing import List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from context.summarizer import summarize_messages
from context.token_counter import count_tokens
from db.models import Conversation, ConversationSummary, Message as DBMessage
from providers.base import Message


class ChatSessionManager:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.summary_trigger_messages = 14
        self.summary_keep_recent = 8

    async def ensure_conversation(
        self,
        conversation_id: str,
        user_id: str,
        provider: str,
        model: str,
        title: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> Conversation:
        conversation = await self.db.get(Conversation, conversation_id)
        if conversation:
            conversation.user_id = user_id
            conversation.provider = provider
            conversation.model = model
            if project_id and not conversation.project_id:
                conversation.project_id = project_id
            conversation.updated_at = datetime.datetime.utcnow()
            await self.db.commit()
            return conversation

        conversation = Conversation(
            id=conversation_id,
            user_id=user_id,
            title=title or "New Chat",
            provider=provider,
            model=model,
            project_id=project_id,
        )
        self.db.add(conversation)
        await self.db.commit()
        return conversation

    async def append_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        token_count_value: Optional[int] = None,
    ) -> DBMessage:
        db_message = DBMessage(
            id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            role=role,
            content=content,
            token_count=token_count_value,
        )
        self.db.add(db_message)
        await self.db.commit()
        return db_message

    async def get_conversation_messages(self, conversation_id: str) -> List[DBMessage]:
        result = await self.db.execute(
            select(DBMessage)
            .where(DBMessage.conversation_id == conversation_id)
            .order_by(DBMessage.created_at.asc())
        )
        return list(result.scalars().all())

    async def get_summary(self, conversation_id: str) -> Optional[ConversationSummary]:
        result = await self.db.execute(
            select(ConversationSummary)
            .where(ConversationSummary.conversation_id == conversation_id)
        )
        return result.scalar_one_or_none()

    async def build_context_messages(
        self,
        conversation_id: str,
    ) -> Tuple[List[Message], Optional[str]]:
        db_messages = await self.get_conversation_messages(conversation_id)
        summary_row = await self.get_summary(conversation_id)

        start_index = summary_row.summarized_message_count if summary_row else 0
        recent_messages = db_messages[start_index:]
        result: List[Message] = [
            Message(role=m.role, content=m.content) for m in recent_messages
        ]
        return result, summary_row.summary if summary_row else None

    async def maybe_refresh_summary(
        self,
        conversation_id: str,
        user_id: str,
        provider: str,
        model: str,
    ) -> Optional[str]:
        db_messages = await self.get_conversation_messages(conversation_id)
        current_messages = [Message(role=m.role, content=m.content) for m in db_messages]

        if len(current_messages) < self.summary_trigger_messages:
            return None

        total_tokens = count_tokens(current_messages, model)
        if total_tokens < 3500 and len(current_messages) < self.summary_trigger_messages + 4:
            return None

        summarize_until = max(0, len(current_messages) - self.summary_keep_recent)
        to_summarize = current_messages[:summarize_until]
        if not to_summarize:
            return None

        summary_row = await self.get_summary(conversation_id)
        prior_summary = summary_row.summary if summary_row else ""
        if prior_summary:
            to_summarize = [Message(role="system", content=prior_summary)] + to_summarize

        if provider == "mock":
            summary = " ".join(
                f"{message.role}: {message.content[:120]}"
                for message in to_summarize[-6:]
            )[:1200]
        else:
            summary = await summarize_messages(to_summarize, provider, model)

        if summary_row:
            summary_row.summary = summary
            summary_row.user_id = user_id
            summary_row.summarized_message_count = summarize_until
            summary_row.updated_at = datetime.datetime.utcnow()
        else:
            summary_row = ConversationSummary(
                id=str(uuid.uuid4()),
                user_id=user_id,
                conversation_id=conversation_id,
                summary=summary,
                summarized_message_count=summarize_until,
            )
            self.db.add(summary_row)

        await self.db.commit()
        return summary
