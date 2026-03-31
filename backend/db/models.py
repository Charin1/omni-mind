import datetime
from sqlalchemy import Column, String, Text, Integer, Float, DateTime, Boolean, JSON
from .database import Base

class Conversation(Base):
    __tablename__ = "conversations"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    title = Column(String, nullable=True)
    provider = Column(String, nullable=True)
    model = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Message(Base):
    __tablename__ = "messages"
    id = Column(String, primary_key=True, index=True)
    conversation_id = Column(String, index=True)
    role = Column(String)  # user, assistant, system, tool
    content = Column(Text)
    token_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class Memory(Base):
    __tablename__ = "memories"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    conversation_id = Column(String, index=True, nullable=True)
    type = Column(String)  # preference, decision, event, fact
    content = Column(Text)
    tags = Column(JSON, nullable=True)
    importance = Column(Float, default=0.5)
    embedding_id = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Episode(Base):
    __tablename__ = "episodes"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    conversation_id = Column(String, index=True)
    summary = Column(Text)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class ConversationSummary(Base):
    __tablename__ = "conversation_summaries"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    conversation_id = Column(String, index=True, unique=True)
    summary = Column(Text)
    summarized_message_count = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Artifact(Base):
    __tablename__ = "artifacts"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    conversation_id = Column(String, index=True, nullable=True)
    kind = Column(String)
    name = Column(String)
    path = Column(String)
    mime_type = Column(String)
    status = Column(String, default="completed")
    metadata_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

class TaskRun(Base):
    __tablename__ = "task_runs"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(String, index=True, default="local-user")
    conversation_id = Column(String, index=True, nullable=True)
    kind = Column(String, default="research")
    title = Column(String)
    status = Column(String, default="planned")
    input_prompt = Column(Text)
    summary = Column(Text, nullable=True)
    metadata_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class TaskStep(Base):
    __tablename__ = "task_steps"
    id = Column(String, primary_key=True, index=True)
    task_id = Column(String, index=True)
    position = Column(Integer)
    title = Column(String)
    description = Column(Text)
    status = Column(String, default="pending")
    output_text = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True, index=True)
    value = Column(JSON)

class MCPServer(Base):
    __tablename__ = "mcp_servers"
    id = Column(String, primary_key=True, index=True)
    name = Column(String, unique=True, index=True)
    transport = Column(String) # stdio, sse
    config_json = Column(JSON)
    is_active = Column(Boolean, default=True)
