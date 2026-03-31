export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ArtifactItem {
  id: string;
  conversation_id?: string;
  kind: string;
  name: string;
  path: string;
  mime_type: string;
  status: string;
  created_at: string;
}

export interface TaskItem {
  id: string;
  conversation_id?: string;
  kind: string;
  title: string;
  status: string;
  input_prompt: string;
  created_at: string;
  updated_at: string;
}

export interface McpServer {
  id: string;
  name: string;
  status: string;
  config_json?: Record<string, any>;
}

export interface McpTool {
  id: string;
  server_id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ChatStreamOptions {
  conversationId: string;
  userId: string;
  message: string;
  provider: string;
  model: string;
  history: Message[];
  settings?: Record<string, unknown>;
  onChunk: (content: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export async function chatStream(options: ChatStreamOptions) {
  const { conversationId, userId, message, provider, model, history, settings, onChunk, onDone, onError } = options;

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        user_id: userId,
        message,
        provider,
        model,
        history,
        settings,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is null');

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value, { stream: true });
      buffer += text;

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);

        if (raw.startsWith('data:')) {
          const dataStr = raw.replace(/^data:\s*/, '');
          if (dataStr === '[DONE]') {
            onDone();
            return;
          }
          try {
            const data = JSON.parse(dataStr);
            if (data.error) {
              onError(data.error);
            } else if (data.content) {
              onChunk(data.content);
            }
          } catch (e) {
            console.error('Failed to parse SSE data', e);
          }
        }

        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (err: unknown) {
    onError(err instanceof Error ? err.message : 'Unknown chat error');
  }
}

export async function listProviders() {
  const response = await fetch(`${API_BASE_URL}/api/chat/providers`);
  return response.json();
}

export async function listArtifacts(userId: string, conversationId?: string) {
  const url = new URL(`${API_BASE_URL}/api/artifacts`);
  url.searchParams.set('user_id', userId);
  if (conversationId) {
    url.searchParams.set('conversation_id', conversationId);
  }
  const response = await fetch(url.toString());
  return response.json() as Promise<ArtifactItem[]>;
}

export async function listTasks(userId: string) {
  const url = new URL(`${API_BASE_URL}/api/tasks`);
  url.searchParams.set('user_id', userId);
  const response = await fetch(url.toString());
  return response.json() as Promise<TaskItem[]>;
}

export async function deleteConversation(id: string) {
  const response = await fetch(`${API_BASE_URL}/api/conversations/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete chat');
  return response.json();
}

export async function updateConversation(id: string, title: string) {
  const response = await fetch(`${API_BASE_URL}/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error('Failed to update chat');
  return response.json();
}


export async function listMcpServers() {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers`);
  return response.json() as Promise<McpServer[]>;
}

export async function listMcpTools() {
  const response = await fetch(`${API_BASE_URL}/api/mcp/tools`);
  return response.json() as Promise<McpTool[]>;
}

export async function createMcpServer(data: Omit<McpServer, 'status'> & { transport: string, config_json: Record<string, any> }) {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.detail || 'Failed to create MCP server');
  }
  return response.json();
}

export async function connectMcpServer(serverId: string) {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers/${serverId}/connect`, {
    method: 'POST',
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.detail || 'Failed to connect MCP server');
  }
  return response.json();
}
