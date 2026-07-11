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
  config_json?: Record<string, unknown>;
  connected?: boolean;
}

export interface McpTool {
  id: string;
  server_id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ToolApprovalRequest {
  type: 'tool_approval_request';
  approval_id: string;
  tool_name: string;
  tool_label: string;
  tool_icon: string;
  summary: string;
  detail: string;
  tool_args: Record<string, unknown>;
}

export interface ToolApprovalResolved {
  type: 'tool_approval_resolved';
  approval_id: string;
  approved: boolean;
}

export interface ChatStreamOptions {
  conversationId: string;
  userId: string;
  message: string;
  provider: string;
  model: string;
  history: Message[];
  settings?: Record<string, unknown>;
  projectId?: string | null;
  onChunk: (content: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  onToolApproval?: (request: ToolApprovalRequest) => void;
  onToolApprovalResolved?: (resolved: ToolApprovalResolved) => void;
  onThinkingStart?: () => void;
  onThinkingChunk?: (content: string) => void;
  onThinkingEnd?: () => void;
  onResearchProgress?: (progress: { message: string; percentage: number }) => void;
  onResponseReplace?: (content: string) => void;
  onToolStatus?: (status: { toolName: string; status: string }) => void;
  onToolSources?: (payload: { toolName: string; sources: Array<{ title: string; url: string }> }) => void;
}

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export async function chatStream(options: ChatStreamOptions) {
  const { conversationId, userId, message, provider, model, history, settings, projectId,
    onChunk, onDone, onError, onToolApproval, onToolApprovalResolved,
    onThinkingStart, onThinkingChunk, onThinkingEnd, onResearchProgress, onResponseReplace, onToolStatus, onToolSources } = options;

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
        project_id: projectId ?? null,
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
            } else if (data.type === 'thinking_start' && onThinkingStart) {
              onThinkingStart();
            } else if (data.type === 'thinking_chunk' && onThinkingChunk) {
              onThinkingChunk(data.content);
            } else if (data.type === 'thinking_end' && onThinkingEnd) {
              onThinkingEnd();
            } else if (data.type === 'tool_approval_request' && onToolApproval) {
              onToolApproval(data as ToolApprovalRequest);
            } else if (data.type === 'tool_approval_resolved' && onToolApprovalResolved) {
              onToolApprovalResolved(data as ToolApprovalResolved);
            } else if (data.type === 'research_progress' && onResearchProgress) {
              onResearchProgress({ message: data.message, percentage: data.percentage });
            } else if (data.type === 'tool_call_detected') {
              // Backend detected a text-based tool call and rolled it back.
              // Clear whatever we streamed (it was just the raw JSON blob).
              onChunk('\x00CLEAR');
            } else if (data.type === 'response_replace') {
              if (onResponseReplace) onResponseReplace(data.content || '');
              else {
                onChunk('\x00CLEAR');
                if (data.content) onChunk(data.content);
              }
            } else if (data.type === 'tool_status' && onToolStatus) {
              onToolStatus({ toolName: data.tool_name, status: data.status });
            } else if (data.type === 'tool_sources' && onToolSources) {
              onToolSources({ toolName: data.tool_name, sources: data.sources || [] });
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
  if (!response.ok) throw new Error(`Failed to fetch providers: ${response.status}`);
  return response.json();
}

export async function fetchProviderModels(providerName: string): Promise<string[]> {
  const response = await fetch(`${API_BASE_URL}/api/chat/providers/${providerName}/models`);
  if (!response.ok) throw new Error(`Failed to fetch models for ${providerName}`);
  const data = await response.json();
  return data.models as string[];
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

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  created_at: string;
  updated_at: string;
}

export async function listProjects(userId: string) {
  const url = new URL(`${API_BASE_URL}/api/projects`);
  url.searchParams.set('user_id', userId);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error('Failed to fetch projects');
  return response.json() as Promise<Project[]>;
}

export async function createProject(data: { name: string; description?: string; instructions?: string; user_id?: string }) {
  const response = await fetch(`${API_BASE_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to create project');
  return response.json() as Promise<Project>;
}

export async function updateProject(id: string, data: { name?: string; description?: string; instructions?: string }) {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error('Failed to update project');
  return response.json() as Promise<Project>;
}

export async function deleteProject(id: string) {
  const response = await fetch(`${API_BASE_URL}/api/projects/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete project');
  return response.json();
}

export async function getSetting(key: string) {
  const response = await fetch(`${API_BASE_URL}/api/settings/${key}`);
  if (!response.ok) throw new Error('Failed to fetch setting');
  return response.json() as Promise<{ key: string; value: unknown }>;
}

export async function putSetting(key: string, value: unknown) {
  const response = await fetch(`${API_BASE_URL}/api/settings/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) throw new Error('Failed to save setting');
  return response.json() as Promise<{ key: string; value: unknown }>;
}


export async function listMcpServers() {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers`);
  return response.json() as Promise<McpServer[]>;
}

export async function listMcpTools() {
  const response = await fetch(`${API_BASE_URL}/api/mcp/tools`);
  return response.json() as Promise<McpTool[]>;
}

export async function createMcpServer(data: Omit<McpServer, 'status'> & { transport: string, config_json: Record<string, unknown> }) {
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
  return response.json() as Promise<{ server: string; connected: boolean; transport: string; reason?: string; requires_oauth?: boolean }>;
}

export async function startMcpOAuth(serverId: string) {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers/${serverId}/oauth/start`, {
    method: 'POST',
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.detail || 'Failed to start OAuth authorization');
  }
  return response.json() as Promise<{ authorization_url: string }>;
}

export async function deleteMcpServer(serverId: string) {
  const response = await fetch(`${API_BASE_URL}/api/mcp/servers/${serverId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.detail || 'Failed to delete MCP server');
  }
  return response.json();
}

export async function submitToolApproval(
  approvalId: string,
  approved: boolean,
  rejectReason?: string
) {
  const response = await fetch(`${API_BASE_URL}/api/tool-approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      approval_id: approvalId,
      approved,
      reject_reason: rejectReason || undefined,
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ detail: 'Unknown error' }));
    throw new Error(err.detail || 'Failed to submit approval');
  }
  return response.json();
}
