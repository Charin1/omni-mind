import tiktoken
from typing import List
from providers.base import Message

def count_tokens(messages: List[Message], model: str = "gpt-5-mini") -> int:
    try:
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        encoding = tiktoken.get_encoding("cl100k_base")

    tokens_per_message = 3
    tokens_per_name = 1
    
    num_tokens = 0
    for message in messages:
        num_tokens += tokens_per_message
        num_tokens += len(encoding.encode(message.content))
        if message.name:
            num_tokens += tokens_per_name
    num_tokens += 3  # every reply is primed with <|start|>assistant<|message|>
    return num_tokens

def truncate_to_limit(messages: List[Message], limit: int, model: str = "gpt-5-mini") -> List[Message]:
    """Truncate old messages until token count is below limit."""
    while count_tokens(messages, model) > limit and len(messages) > 1:
        messages.pop(0)
    return messages
