'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  ArtifactItem,
  chatStream,
  fetchProviderModels,
  listArtifacts,
  listProviders,
  listTasks,
  Message,
  TaskItem,
  McpServer,
  McpTool,
  ToolApprovalRequest,
  listMcpServers,
  listMcpTools,
  updateConversation,
  deleteConversation,
  Project,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  createMcpServer,
  connectMcpServer,
  deleteMcpServer,
  startMcpOAuth,
  getSetting,
  putSetting,
  submitToolApproval,
} from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Search, Clock, FileText, CheckCircle, Orbit, Server, Wrench, MessageSquare, Plus, Settings, Edit3, Trash2, X, UploadCloud, BrainCircuit, Share2, Loader2, Terminal, ShieldCheck, ShieldX, ChevronDown, ChevronUp, Copy, RotateCcw, Link2, Sun, Moon, Folder, FolderOpen } from 'lucide-react';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

interface Conversation {
  id: string;
  title: string;
  provider?: string;
  model?: string;
  project_id?: string | null;
  updated_at: string;
}

import fallbackModels from '@/lib/models.json';

const FALLBACK_PROVIDERS = fallbackModels as Record<string, string[]>;

function getOrCreateUserId() {
  if (typeof window === 'undefined') return 'local-user';
  const existing = window.localStorage.getItem('omnimind-user-id');
  if (existing) return existing;
  const created = window.crypto?.randomUUID?.() || `local-${Date.now()}`;
  window.localStorage.setItem('omnimind-user-id', created);
  return created;
}

interface LocalMessage extends Message {
  thinking?: string;
  thinkSecs?: number;
  activity?: ActivityEvent[];
}

interface ActivityEvent {
  id: string;
  label: string;
  detail?: string;
  kind: 'thinking' | 'tool' | 'research' | 'source' | 'status';
  sources?: Array<{ title: string; url: string }>;
}

function normalizeAssistantContent(content: string) {
  const raw = (content || '').trim();
  if (!raw) return '';

  let unfenced = raw
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Strip trailing special tokens/tags like <|tool_response>
  unfenced = unfenced.replace(/<\|[a-z0-9_\-\|\s]+(?:>)?\s*$/i, '').trim();

  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['answer', 'final', 'response', 'content', 'result']) {
        if (typeof record[key] === 'string' && record[key].trim()) {
          return record[key].trim();
        }
      }

      const readable: string[] = [];
      if (typeof record.summary === 'string') readable.push(record.summary.trim());
      if (typeof record.analysis === 'string') readable.push(record.analysis.trim());
      if (typeof record.plan === 'string') readable.push(record.plan.trim());
      if (typeof record.thought === 'string') readable.push(record.thought.trim());
      if (typeof record.reasoning === 'string') readable.push(record.reasoning.trim());
      if (readable.length > 0) return readable.join('\n\n');
    }
  } catch {
    // Plain markdown/text is the common path.
  }

  if (
    unfenced.startsWith('{"thought"') ||
    unfenced.startsWith('{"analysis"') ||
    unfenced.startsWith('{"plan"')
  ) {
    return 'The selected local model returned hidden reasoning instead of a final answer. Use rerun to ask again with the stricter local-model prompt.';
  }

  return content;
}

function ThinkingBlock({ content, isLive = false, elapsed }: { content: string; isLive?: boolean; elapsed?: number }) {
  const [expanded, setExpanded] = useState(isLive);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom while live
  useEffect(() => {
    if (isLive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, isLive]);

  return (
    <div
      className="mb-3 rounded-2xl overflow-hidden transition-all border"
      style={{ borderColor: 'var(--line)', background: 'var(--bg-2)' }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all om-hover-soft"
      >
        <div
          className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--bg-3)', border: '1px solid var(--line-2)' }}
        >
          <BrainCircuit className={`w-3 h-3 ${isLive ? 'spin' : ''}`} style={{ color: 'var(--fg-3)' }} />
        </div>
        <span className="text-[11px] font-semibold tracking-wider font-mono" style={{ color: 'var(--fg-2)' }}>
          {isLive ? 'Thinking...' : elapsed !== undefined ? `Thought for ${elapsed}s` : 'Reasoning'}
        </span>
        {isLive && (
          <span className="flex gap-0.5 ml-1">
            {[0, 150, 300].map(d => (
              <span
                key={d}
                className="w-1 h-1 rounded-full"
                style={{ background: 'var(--accent)', animation: 'om-pulse 1.2s ease-in-out infinite', animationDelay: `${d}ms` }}
              />
            ))}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] font-mono" style={{ color: 'var(--fg-4)' }}>{content.length} chars</span>
        {expanded
          ? <ChevronUp className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--fg-4)' }} />
          : <ChevronDown className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--fg-4)' }} />}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-52 overflow-y-auto custom-scrollbar border-t"
          style={{ borderColor: 'var(--line)' }}
        >
          <pre
            className="text-[11.5px] font-mono leading-relaxed whitespace-pre-wrap break-words px-4 py-3"
            style={{ color: 'var(--fg-3)' }}
          >
            {content || ' '}
          </pre>
        </div>
      )}
    </div>
  );
}

function ActivityPanel({
  events,
  isLive,
}: {
  events: ActivityEvent[];
  isLive: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const latest = events[events.length - 1];
  const sources = events.flatMap((event) => event.sources || []);
  const dotColor: Record<ActivityEvent['kind'], string> = {
    status: 'var(--fg-3)',
    thinking: 'var(--fg-3)',
    tool: 'var(--accent)',
    research: 'var(--accent)',
    source: 'var(--green)',
  };

  if (!latest) return null;

  return (
    <div
      className="mb-4 w-full max-w-3xl rounded-2xl overflow-hidden border"
      style={{ borderColor: 'var(--line)', background: 'var(--bg-2)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors om-hover-soft"
      >
        <div
          className="h-7 w-7 rounded-lg flex items-center justify-center border"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          {isLive ? <Loader2 className="h-4 w-4 spin" style={{ color: 'var(--accent)' }} /> : <CheckCircle className="h-4 w-4" style={{ color: 'var(--accent)' }} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.18em] font-bold font-mono" style={{ color: 'var(--fg-4)' }}>
            {isLive ? 'Working' : 'Activity'}
          </div>
          <div className="truncate text-sm" style={{ color: 'var(--fg-2)' }}>{latest.label}</div>
        </div>
        {sources.length > 0 && (
          <span className="rounded-full border px-2 py-1 text-[10px] font-mono" style={{ borderColor: 'var(--line)', color: 'var(--fg-3)' }}>
            {sources.length} sources
          </span>
        )}
        {expanded ? <ChevronUp className="h-4 w-4" style={{ color: 'var(--fg-4)' }} /> : <ChevronDown className="h-4 w-4" style={{ color: 'var(--fg-4)' }} />}
      </button>

      {expanded && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <div className="max-h-52 overflow-y-auto custom-scrollbar space-y-3 pr-1">
            {events.map((event) => (
              <div key={event.id} className="flex gap-3">
                <div className="mt-1 h-2 w-2 rounded-full flex-shrink-0" style={{ background: dotColor[event.kind] }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm" style={{ color: 'var(--fg-2)' }}>{event.label}</div>
                  {event.detail && <div className="mt-0.5 text-xs font-mono" style={{ color: 'var(--fg-4)' }}>{event.detail}</div>}
                  {event.sources && event.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {event.sources.map((source) => (
                        <a
                          key={source.url}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors"
                          style={{ borderColor: 'var(--line)', background: 'var(--bg-3)', color: 'var(--fg-3)' }}
                          title={source.url}
                        >
                          <Link2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{source.title || source.url}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ResearchProgressBar({ message, percentage }: { message: string; percentage: number }) {
  return (
    <div
      className="mb-6 rounded-3xl p-5 relative overflow-hidden border"
      style={{ borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center border"
            style={{ background: 'var(--bg)', borderColor: 'var(--accent-line)' }}
          >
            <Search className="w-4 h-4 spin-slow" style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] block mb-0.5 font-mono" style={{ color: 'var(--accent)' }}>Deep Research Status</span>
            <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{message}</span>
          </div>
        </div>
        <div className="text-right">
          <span className="text-lg font-bold tabular-nums font-mono" style={{ color: 'var(--accent)' }}>{percentage}%</span>
        </div>
      </div>
      <div className="relative h-[5px] w-full rounded-full overflow-hidden" style={{ background: 'var(--bg)' }}>
        <div
          className="absolute top-0 left-0 h-full transition-all duration-700 ease-out rounded-full"
          style={{ width: `${percentage}%`, background: 'var(--accent)' }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] font-medium font-mono" style={{ color: 'var(--fg-4)' }}>
         <span>Comprehensive analysis in progress...</span>
         <span className="flex gap-1">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-1 h-1 rounded-full" style={{ background: 'var(--accent)', animation: 'om-pulse 1.4s ease-in-out infinite', animationDelay: `${i * 200}ms` }} />
            ))}
         </span>
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = localStorage.getItem('omnimind-theme');
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved);
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      const initial = prefersLight ? 'light' : 'dark';
      setTheme(initial);
      document.documentElement.setAttribute('data-theme', initial);
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('omnimind-theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('omnimind-active-project');
    if (saved) setActiveProjectId(saved);
  }, []);
  const [userId] = useState(getOrCreateUserId);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [, setTasks] = useState<TaskItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [, setMcpTools] = useState<McpTool[]>([]);

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentResponse, setCurrentResponse] = useState('');
  const [currentThinking, setCurrentThinking] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [researchProgress, setResearchProgress] = useState<{ message: string; percentage: number } | null>(null);
  const [toolActivity, setToolActivity] = useState<{ toolName: string; status: string } | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const activityRef = useRef<ActivityEvent[]>([]);
  const thinkingRef = useRef('');
  const thinkStartRef = useRef<number>(0);

  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-5-mini');
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const [providerError, setProviderError] = useState('');
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);

  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const [projectModal, setProjectModal] = useState<{ mode: 'create' | 'edit'; project?: Project } | null>(null);
  const [projectForm, setProjectForm] = useState({ name: '', description: '', instructions: '' });
  const [projectError, setProjectError] = useState('');
  const [isSavingProject, setIsSavingProject] = useState(false);

  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpForm, setMcpForm] = useState({ transport: 'stdio' as 'stdio' | 'http' | 'sse', name: '', command: '', args: '', env: '', url: '', token: '' });
  const [mcpError, setMcpError] = useState('');
  const [isAddingMcp, setIsAddingMcp] = useState(false);
  const [authorizingServerId, setAuthorizingServerId] = useState<string | null>(null);

  const [showInstructionsModal, setShowInstructionsModal] = useState(false);
  const [globalInstructions, setGlobalInstructions] = useState('');
  const [isSavingInstructions, setIsSavingInstructions] = useState(false);
  const [instructionsError, setInstructionsError] = useState('');

  const [enabledTools, setEnabledTools] = useState<string[]>(['web_search']);
  const [showToolSelector, setShowToolSelector] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const [expandedApprovals, setExpandedApprovals] = useState<Set<string>>(new Set());
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const currentConversation = conversations.find((c) => c.id === activeConvId);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const pushActivity = (event: Omit<ActivityEvent, 'id'>) => {
    setActivityEvents((prev) => {
      const next = [
        ...prev,
        { ...event, id: `${Date.now()}-${prev.length}` },
      ].slice(-20);
      activityRef.current = next;
      return next;
    });
  };

  const scrollToBottom = () => {
    if (messages.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, currentResponse]);

  const loadBackendData = async () => {
    if (!userId) return;
    try {
      const cRes = await fetch(`${API_BASE_URL}/api/conversations?user_id=${encodeURIComponent(userId)}`);
      const cData = await cRes.json();
      setConversations(cData);
      setProjects(await listProjects(userId).catch(() => []));
      setTasks(await listTasks(userId));
      setArtifacts(await listArtifacts(userId));
      setMcpServers(await listMcpServers().catch(() => []));
      setMcpTools(await listMcpTools().catch(() => []));
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!userId) return;
    async function init() {
      try {
        const pData = await listProviders();
        const merged = { ...FALLBACK_PROVIDERS, ...(pData || {}) };
        setProviders(merged);
        const firstProvider = Object.keys(merged)[0];
        if (firstProvider) {
          setProvider(firstProvider);
          const firstModel = merged[firstProvider][0];
          if(firstModel) setModel(firstModel);
        }
        await loadBackendData();
      } catch (err) {
        console.error('Initialization failed', err);
        const merged = { ...FALLBACK_PROVIDERS };
        setProviders(merged);
        const firstProvider = Object.keys(merged)[0];
        setProvider(firstProvider);
        setModel(merged[firstProvider][0]);
        setProviderError('Could not load providers from backend. Using defaults.');
      }
    }
    init();
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    async function refreshSideData() {
      try {
        setTasks(await listTasks(userId));
        setArtifacts(await listArtifacts(userId, activeConvId || undefined));
      } catch (err) {
        console.error('Failed to refresh side data', err);
      }
    }
    refreshSideData();
  }, [userId, activeConvId]);

  const handleNewChat = async () => {
    if (!userId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Chat', user_id: userId, project_id: activeProjectId })
      });
      const newConv = await res.json();
      setConversations([newConv, ...conversations]);
      setActiveConvId(newConv.id);
      setMessages([]);
      setArtifacts([]);
    } catch (err) {
      console.error('Failed to create chat', err);
    }
  };

  const loadConversation = async (id: string) => {
    if (editingChatId) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/conversations/${id}`);
      const data = await res.json();
      setActiveConvId(id);
      setMessages((data.messages || []).map((message: LocalMessage) => (
        message.role === 'assistant'
          ? { ...message, content: normalizeAssistantContent(message.content) }
          : message
      )));
      if (data.conversation.provider) setProvider(data.conversation.provider);
      if (data.conversation.model) setModel(data.conversation.model);
      setArtifacts(await listArtifacts(userId, id));
    } catch (err) {
      console.error('Failed to load chat', err);
    }
  };

  const handleDeleteChat = async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations(conversations.filter(c => c.id !== id));
      if (activeConvId === id) {
        setActiveConvId(null);
        setMessages([]);
        setArtifacts([]);
      }
    } catch (err) {
      console.error('Failed to delete', err);
    }
  };

  const handleSaveTitle = async (id: string) => {
    if (!editingTitle.trim()) {
      setEditingChatId(null);
      return;
    }
    try {
      await updateConversation(id, editingTitle);
      setConversations(conversations.map(c => c.id === id ? { ...c, title: editingTitle } : c));
    } catch (err) {
      console.error('Edit failed', err);
    }
    setEditingChatId(null);
  };

  const selectProject = (id: string | null) => {
    if (id === activeProjectId) return;
    setActiveProjectId(id);
    if (id) localStorage.setItem('omnimind-active-project', id);
    else localStorage.removeItem('omnimind-active-project');
    setActiveConvId(null);
    setMessages([]);
  };

  const openProjectModal = (project?: Project) => {
    setProjectError('');
    setProjectForm({
      name: project?.name || '',
      description: project?.description || '',
      instructions: project?.instructions || '',
    });
    setProjectModal(project ? { mode: 'edit', project } : { mode: 'create' });
  };

  const handleSaveProject = async () => {
    if (!projectForm.name.trim()) {
      setProjectError('Project name is required.');
      return;
    }
    setIsSavingProject(true);
    setProjectError('');
    try {
      if (projectModal?.mode === 'edit' && projectModal.project) {
        const updated = await updateProject(projectModal.project.id, projectForm);
        setProjects(projects.map(p => p.id === updated.id ? updated : p));
      } else {
        const created = await createProject({ ...projectForm, user_id: userId });
        setProjects([created, ...projects]);
        selectProject(created.id);
      }
      setProjectModal(null);
    } catch (err: unknown) {
      setProjectError(err instanceof Error ? err.message : 'Failed to save project');
    }
    setIsSavingProject(false);
  };

  const handleDeleteProject = async (id: string) => {
    if (!window.confirm('Delete this project? Its chats will be kept and moved to All Chats.')) return;
    try {
      await deleteProject(id);
      setProjects(projects.filter(p => p.id !== id));
      setConversations(conversations.map(c => c.project_id === id ? { ...c, project_id: null } : c));
      if (activeProjectId === id) selectProject(null);
    } catch (err) {
      console.error('Failed to delete project', err);
    }
  };

  const handleAddMcp = async () => {
    const isRemote = mcpForm.transport === 'http' || mcpForm.transport === 'sse';
    if (!mcpForm.name.trim() || (isRemote ? !mcpForm.url.trim() : !mcpForm.command.trim())) return;
    setIsAddingMcp(true);
    setMcpError('');
    try {
      let configJson: Record<string, unknown>;

      if (isRemote) {
        configJson = {
          url: mcpForm.url.trim(),
          authorization_token: mcpForm.token.trim() || undefined,
        };
      } else {
        const parsedEnv: Record<string, string> = {};
        if (mcpForm.env.trim()) {
           mcpForm.env.split('\n').forEach(line => {
              const [k, ...v] = line.split('=');
              if (k && k.trim()) parsedEnv[k.trim()] = v.join('=').trim();
           });
        }
        configJson = {
          command: mcpForm.command,
          args: mcpForm.args.split(' ').filter(a => a.trim()),
          env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined
        };
      }

      const serverId = `mcp-${Date.now()}`;
      await createMcpServer({
        id: serverId,
        name: mcpForm.name,
        transport: mcpForm.transport,
        config_json: configJson
      });

      const connectResult = await connectMcpServer(serverId);
      if (!connectResult.connected) {
        if (connectResult.requires_oauth) {
          setShowMcpModal(false);
          setMcpForm({ transport: 'stdio', name: '', command: '', args: '', env: '', url: '', token: '' });
          setMcpServers(await listMcpServers().catch(() => []));
          setIsAddingMcp(false);
          await runMcpOAuthFlow(serverId, mcpForm.name);
          return;
        }
        setMcpError(connectResult.reason || 'Server was added but failed to connect.');
        setMcpServers(await listMcpServers().catch(() => []));
        setIsAddingMcp(false);
        return;
      }

      setShowMcpModal(false);
      setMcpForm({ transport: 'stdio', name: '', command: '', args: '', env: '', url: '', token: '' });
      setMcpServers(await listMcpServers().catch(() => []));
    } catch (err: unknown) {
      setMcpError(err instanceof Error ? err.message : 'Failed to add server');
    }
    setIsAddingMcp(false);
  };

  const handleDeleteMcp = async (serverId: string, serverName: string) => {
    if (!window.confirm(`Remove MCP server "${serverName}"? This disconnects it and removes its tools.`)) return;
    try {
      await deleteMcpServer(serverId);
      setMcpServers(await listMcpServers().catch(() => []));
      setMcpTools(await listMcpTools().catch(() => []));
      setEnabledTools(prev => prev.filter(name => name !== serverName));
    } catch (err: unknown) {
      setMcpError(err instanceof Error ? err.message : 'Failed to delete server');
    }
  };

  const openInstructionsModal = async () => {
    setInstructionsError('');
    setShowInstructionsModal(true);
    try {
      const setting = await getSetting('system_instructions');
      setGlobalInstructions(typeof setting.value === 'string' ? setting.value : '');
    } catch {
      // Leave whatever is in the textarea; saving still works.
    }
  };

  const handleSaveInstructions = async () => {
    setIsSavingInstructions(true);
    setInstructionsError('');
    try {
      await putSetting('system_instructions', globalInstructions.trim() || null);
      setShowInstructionsModal(false);
    } catch (err: unknown) {
      setInstructionsError(err instanceof Error ? err.message : 'Failed to save instructions');
    }
    setIsSavingInstructions(false);
  };

  // Opens the MCP server's OAuth authorization page in a popup, waits for the
  // user to finish signing in (the backend callback closes the popup), then
  // retries the connection. Used both right after adding a server that turns
  // out to need OAuth, and from the standalone "Authorize" action.
  const runMcpOAuthFlow = async (serverId: string, serverName: string) => {
    setAuthorizingServerId(serverId);
    setMcpError('');
    try {
      const { authorization_url } = await startMcpOAuth(serverId);
      const popup = window.open(authorization_url, 'mcp-oauth', 'width=520,height=720');
      if (!popup) {
        setMcpError('Could not open the authorization window — please allow popups for this site and try again.');
        return;
      }

      await new Promise<void>((resolve) => {
        const timeoutAt = Date.now() + 5 * 60 * 1000; // give up after 5 minutes
        const interval = setInterval(() => {
          if (popup.closed || Date.now() > timeoutAt) {
            clearInterval(interval);
            resolve();
          }
        }, 700);
      });

      const connectResult = await connectMcpServer(serverId);
      if (!connectResult.connected) {
        setMcpError(connectResult.reason || `Authorization for "${serverName}" wasn't completed.`);
      }
      setMcpServers(await listMcpServers().catch(() => []));
      setMcpTools(await listMcpTools().catch(() => []));
    } catch (err: unknown) {
      setMcpError(err instanceof Error ? err.message : 'Failed to start authorization');
    }
    setAuthorizingServerId(null);
  };

  const submitMessage = async (messageText: string, historyOverride?: LocalMessage[]) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || isLoading || !userId) return;

    let currentId = activeConvId;
    if (!currentId) {
       const res = await fetch(`${API_BASE_URL}/api/conversations`, {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({title: trimmedMessage.slice(0, 20) + '...', user_id: userId, project_id: activeProjectId})
       });
       const newConv = await res.json();
       currentId = newConv.id;
       setActiveConvId(currentId);
       setConversations([newConv, ...conversations]);
    }

    const historyForRequest = historyOverride ?? messages;
    const userMessage: LocalMessage = { role: 'user', content: trimmedMessage };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setCurrentResponse('');
    setCurrentThinking('');
    setIsThinking(false);
    setToolActivity(null);
    const initialActivity = [
      {
        id: `${Date.now()}-start`,
        label: 'Reading your request',
        detail: `${provider} / ${model}`,
        kind: 'status',
      },
    ] satisfies ActivityEvent[];
    activityRef.current = initialActivity;
    setActivityEvents(initialActivity);
    thinkingRef.current = '';
    thinkStartRef.current = 0;

    let streamed = '';

    await chatStream({
      conversationId: currentId as string,
      userId,
      message: trimmedMessage,
      provider,
      model,
      projectId: activeProjectId,
      history: historyForRequest,
      settings: { enabled_tools: enabledTools },
      onThinkingStart: () => {
        thinkStartRef.current = Date.now();
        setIsThinking(true);
        pushActivity({ label: 'Thinking through the request', kind: 'thinking' });
      },
      onThinkingChunk: (chunk) => {
        thinkingRef.current += chunk;
        setCurrentThinking(t => t + chunk);
      },
      onThinkingEnd: () => {
        setIsThinking(false);
      },
      onResearchProgress: (progress) => {
        setResearchProgress(progress);
        pushActivity({ label: progress.message, detail: `${progress.percentage}% complete`, kind: 'research' });
      },
      onToolStatus: (status) => {
        setToolActivity(status);
        pushActivity({
          label: `Using ${status.toolName.replaceAll('_', ' ')}`,
          detail: status.status,
          kind: 'tool',
        });
      },
      onToolSources: (payload) => {
        pushActivity({
          label: `Found ${payload.sources.length} source${payload.sources.length === 1 ? '' : 's'}`,
          detail: payload.toolName.replaceAll('_', ' '),
          kind: 'source',
          sources: payload.sources,
        });
      },
      onChunk: (chunk) => {
        if (chunk === '\x00CLEAR') {
          // Backend detected a text-based tool call; discard what we streamed
          streamed = '';
          setCurrentResponse('');
          return;
        }
        streamed += chunk;
        setCurrentResponse(normalizeAssistantContent(streamed));
      },
      onResponseReplace: (content) => {
        streamed = normalizeAssistantContent(content);
        setCurrentResponse(streamed);
      },
      onToolApproval: (request) => {
        setPendingApprovals((prev) => [...prev, request]);
      },
      onToolApprovalResolved: (resolved) => {
        setPendingApprovals((prev) => prev.filter((a) => a.approval_id !== resolved.approval_id));
        setExpandedApprovals((prev) => {
          const next = new Set(prev);
          next.delete(resolved.approval_id);
          return next;
        });
      },
      onDone: () => {
        const finalAnswer = normalizeAssistantContent(streamed);
        const finalThinking = thinkingRef.current;
        const thinkSecs = thinkStartRef.current ? Math.round((Date.now() - thinkStartRef.current) / 1000) : 0;
        const finalActivity = activityRef.current;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: finalAnswer, thinking: finalThinking || undefined, thinkSecs, activity: finalActivity } as LocalMessage & { thinkSecs?: number }
        ]);
        setCurrentResponse('');
        setCurrentThinking('');
        setIsThinking(false);
        setResearchProgress(null);
        setToolActivity(null);
        thinkingRef.current = '';
        setIsLoading(false);
        setToolActivity(null);
        setActivityEvents([]);
        activityRef.current = [];
        setPendingApprovals([]);
        listArtifacts(userId, currentId || undefined).then(setArtifacts).catch(() => {});
        listTasks(userId).then(setTasks).catch(() => {});
      },
      onError: (err) => {
        console.error('Chat error:', err);
        setIsLoading(false);
        setActivityEvents([]);
        activityRef.current = [];
        setPendingApprovals([]);
      }
    });
  };

  const handleSend = async () => {
    await submitMessage(input);
  };

  const handleCopyMessage = async (message: LocalMessage, index: number) => {
    const content = message.role === 'assistant'
      ? normalizeAssistantContent(message.content)
      : message.content;
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageIndex(index);
      window.setTimeout(() => setCopiedMessageIndex(null), 1200);
    } catch (err) {
      console.error('Copy failed', err);
    }
  };

  const handleRerunMessage = async (index: number) => {
    if (isLoading) return;
    const target = messages[index] as LocalMessage | undefined;
    if (!target) return;

    if (target.role === 'user') {
      await submitMessage(target.content, messages.slice(0, index));
      return;
    }

    const previousUserIndex = messages
      .slice(0, index)
      .map((message, messageIndex) => ({ message, messageIndex }))
      .reverse()
      .find(({ message }) => message.role === 'user')?.messageIndex;

    if (previousUserIndex === undefined) return;
    const prompt = messages[previousUserIndex].content;
    await submitMessage(prompt, messages.slice(0, previousUserIndex));
  };

  const providerOptions = { ...FALLBACK_PROVIDERS, ...providers };
  const modelOptions = providerOptions[provider] || [];

  return (
    <div className="fixed inset-0 flex font-sans overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--fg)' }}>

      {/* Project Modal */}
      {projectModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ background: 'var(--scrim)' }}>
           <div
             className="w-[420px] rounded-3xl p-6 shadow-2xl animate-fade-in relative overflow-hidden border"
             style={{ background: 'var(--elev)', borderColor: 'var(--line-2)' }}
           >
              <button onClick={() => setProjectModal(null)} className="absolute top-4 right-4 transition-colors" style={{ color: 'var(--fg-3)' }}>
                <X className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold tracking-wide mb-1" style={{ color: 'var(--fg)' }}>
                {projectModal.mode === 'edit' ? 'Edit Project' : 'Create Project'}
              </h2>
              <p className="text-xs mb-4" style={{ color: 'var(--fg-3)' }}>
                Group chats together and give them shared custom instructions.
              </p>

              <div className="space-y-4">
                 <div>
                   <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Name</label>
                   <input
                     value={projectForm.name}
                     onChange={e => setProjectForm({...projectForm, name: e.target.value})}
                     placeholder="e.g., Marketing Copy"
                     className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border"
                     style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                   />
                 </div>
                 <div>
                   <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Description (optional)</label>
                   <input
                     value={projectForm.description}
                     onChange={e => setProjectForm({...projectForm, description: e.target.value})}
                     placeholder="What is this project about?"
                     className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border"
                     style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                   />
                 </div>
                 <div>
                   <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Custom Instructions</label>
                   <textarea
                     value={projectForm.instructions}
                     onChange={e => setProjectForm({...projectForm, instructions: e.target.value})}
                     placeholder="These instructions are added to the system prompt for every chat in this project. e.g., 'You are a senior copywriter. Keep answers concise and on-brand.'"
                     rows={6}
                     className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light custom-scrollbar resize-none border"
                     style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                   />
                 </div>
              </div>

              {projectError && (
                <div className="mt-4 text-xs p-2 rounded-lg border" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, transparent)', borderColor: 'var(--red)' }}>
                  {projectError}
                </div>
              )}

              <button
                onClick={handleSaveProject}
                disabled={isSavingProject}
                className="w-full mt-6 font-semibold py-2.5 rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {isSavingProject && <Orbit className="w-4 h-4 spin" />}
                <span>{isSavingProject ? 'Saving...' : projectModal.mode === 'edit' ? 'Save Changes' : 'Create Project'}</span>
              </button>
           </div>
        </div>
      )}

      {/* Custom Instructions Modal */}
      {showInstructionsModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ background: 'var(--scrim)' }}>
           <div
             className="w-[480px] rounded-3xl p-6 shadow-2xl animate-fade-in relative overflow-hidden border"
             style={{ background: 'var(--elev)', borderColor: 'var(--line-2)' }}
           >
              <button onClick={() => setShowInstructionsModal(false)} className="absolute top-4 right-4 transition-colors" style={{ color: 'var(--fg-3)' }}>
                <X className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold tracking-wide mb-1" style={{ color: 'var(--fg)' }}>Custom Instructions</h2>
              <p className="text-xs mb-4" style={{ color: 'var(--fg-3)' }}>
                Applied to every chat, in every project. Project instructions layer on top of these.
              </p>
              <textarea
                value={globalInstructions}
                onChange={e => setGlobalInstructions(e.target.value)}
                placeholder={"e.g. Reply concisely. I'm a TypeScript developer — show code examples in TS.\nAlways use metric units."}
                rows={8}
                className="w-full rounded-xl px-4 py-3 text-sm outline-none transition-all font-light custom-scrollbar resize-none border"
                style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
              />
              {instructionsError && (
                <div className="mt-3 text-xs p-2 rounded-lg border" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, transparent)', borderColor: 'var(--red)' }}>
                  {instructionsError}
                </div>
              )}
              <button
                onClick={handleSaveInstructions}
                disabled={isSavingInstructions}
                className="w-full mt-5 font-semibold py-2.5 rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {isSavingInstructions && <Orbit className="w-4 h-4 spin" />}
                <span>{isSavingInstructions ? 'Saving...' : 'Save Instructions'}</span>
              </button>
           </div>
        </div>
      )}

      {/* MCP Modal */}
      {showMcpModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm" style={{ background: 'var(--scrim)' }}>
           <div
             className="w-96 rounded-3xl p-6 shadow-2xl animate-fade-in relative overflow-hidden border"
             style={{ background: 'var(--elev)', borderColor: 'var(--line-2)' }}
           >
              <button onClick={() => setShowMcpModal(false)} className="absolute top-4 right-4 transition-colors" style={{ color: 'var(--fg-3)' }}>
                <X className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold tracking-wide mb-1" style={{ color: 'var(--fg)' }}>Add MCP Server</h2>
              <p className="text-xs mb-4" style={{ color: 'var(--fg-3)' }}>Connect a local (stdio) or remote (HTTP/SSE) MCP server.</p>

              <div className="flex rounded-xl p-1 mb-4 border" style={{ background: 'var(--bg-2)', borderColor: 'var(--line)' }}>
                 {(['stdio', 'http', 'sse'] as const).map(t => (
                   <button
                     key={t}
                     onClick={() => setMcpForm({...mcpForm, transport: t})}
                     className="flex-1 text-[11px] font-semibold uppercase tracking-wider py-1.5 rounded-lg transition-all"
                     style={mcpForm.transport === t
                       ? { background: 'var(--accent)', color: 'var(--on-accent)' }
                       : { color: 'var(--fg-3)' }}
                   >
                     {t === 'stdio' ? 'Local' : t.toUpperCase()}
                   </button>
                 ))}
              </div>

              <div className="space-y-4">
                 <div>
                   <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Server Name</label>
                   <input
                     value={mcpForm.name}
                     onChange={e => setMcpForm({...mcpForm, name: e.target.value})}
                     placeholder={mcpForm.transport === 'stdio' ? 'e.g., local-sqlite' : 'e.g., mimilabs'}
                     className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border"
                     style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                   />
                 </div>
                 {mcpForm.transport === 'stdio' ? (
                   <>
                     <div>
                       <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Command (Executable)</label>
                       <input
                         value={mcpForm.command}
                         onChange={e => setMcpForm({...mcpForm, command: e.target.value})}
                         placeholder="e.g., npx or python"
                         className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border font-mono"
                         style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                       />
                     </div>
                     <div>
                       <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Arguments (Space separated)</label>
                       <input
                         value={mcpForm.args}
                         onChange={e => setMcpForm({...mcpForm, args: e.target.value})}
                         placeholder="-y @modelcontextprotocol/server-sqlite"
                         className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border font-mono"
                         style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                       />
                     </div>
                     <div>
                       <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Environment Config (KEY=VALUE)</label>
                       <textarea
                         value={mcpForm.env}
                         onChange={e => setMcpForm({...mcpForm, env: e.target.value})}
                         placeholder={"BRAVE_API_KEY=B_SA3d82h...\nGITHUB_TOKEN=ghp_..."}
                         rows={2}
                         className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light custom-scrollbar resize-none border font-mono"
                         style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                       />
                     </div>
                   </>
                 ) : (
                   <>
                     <div>
                       <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Server URL</label>
                       <input
                         value={mcpForm.url}
                         onChange={e => setMcpForm({...mcpForm, url: e.target.value})}
                         placeholder="https://www.mimilabs.ai/api/mcp"
                         className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border font-mono"
                         style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                       />
                     </div>
                     <div>
                       <label className="text-[10px] uppercase tracking-widest font-bold ml-1 font-mono" style={{ color: 'var(--fg-3)' }}>Authorization Token (optional)</label>
                       <input
                         value={mcpForm.token}
                         onChange={e => setMcpForm({...mcpForm, token: e.target.value})}
                         placeholder="Bearer token, if the server requires one"
                         className="w-full rounded-xl px-4 py-2 text-sm mt-1 outline-none transition-all font-light border font-mono"
                         style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                       />
                     </div>
                   </>
                 )}
              </div>

              {mcpError && (
                <div className="mt-4 text-xs p-2 rounded-lg border" style={{ color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 12%, transparent)', borderColor: 'var(--red)' }}>
                  {mcpError}
                </div>
              )}

              <button
                onClick={handleAddMcp}
                disabled={isAddingMcp}
                className="w-full mt-6 font-semibold py-2.5 rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {isAddingMcp && <Orbit className="w-4 h-4 spin" />}
                <span>{isAddingMcp ? 'Adding...' : 'Add Connection'}</span>
              </button>
           </div>
        </div>
      )}


      {/* Sidebar */}
      <div className="w-72 flex flex-col p-4 z-20 h-full border-r" style={{ background: 'var(--bg-2)', borderColor: 'var(--line)' }}>
        {/* Header */}
        <div className="flex items-center space-x-3 px-2 mb-6 flex-shrink-0">
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center border"
            style={{ background: 'var(--bg-3)', borderColor: 'var(--line)' }}
          >
            <Orbit className="w-5 h-5" style={{ color: 'var(--accent)' }} />
          </div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: 'var(--fg)' }}>OmniMind</h1>
        </div>

        {/* New Chat Button */}
        <button
          onClick={handleNewChat}
          className="w-full py-2.5 px-4 mb-5 rounded-xl transition-all text-sm font-medium flex items-center justify-center space-x-2 border shadow-md flex-shrink-0 om-hover-soft"
          style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--fg)' }}
        >
          <Plus className="w-4 h-4" /> <span>New Chat</span>
        </button>

        {/* Projects */}
        <div className="mb-4 flex-shrink-0">
          <div className="text-[10px] px-2 mb-2 uppercase tracking-[0.2em] font-bold flex items-center justify-between font-mono" style={{ color: 'var(--fg-4)' }}>
            <div className="flex items-center space-x-2">
              <Folder className="w-3 h-3" />
              <span>Projects</span>
            </div>
            <button
              onClick={() => openProjectModal()}
              className="p-1 rounded-md transition-colors om-hover"
              style={{ color: 'var(--fg-4)' }}
              title="Create Project"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          <div className="max-h-36 overflow-y-auto custom-scrollbar pr-2 space-y-1">
            <div
              className="group flex items-center justify-between px-3 py-2 rounded-xl text-xs cursor-pointer transition-all border"
              style={
                activeProjectId === null
                  ? { background: 'var(--bg-3)', borderColor: 'var(--line-2)' }
                  : { background: 'transparent', borderColor: 'transparent', opacity: 0.65 }
              }
              onMouseEnter={(e) => { if (activeProjectId !== null) e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { if (activeProjectId !== null) e.currentTarget.style.opacity = '0.65'; }}
              onClick={() => selectProject(null)}
            >
              <div className="flex items-center space-x-3 flex-1 min-w-0">
                <MessageSquare className="w-3 h-3 flex-shrink-0" style={{ color: activeProjectId === null ? 'var(--accent)' : 'var(--fg-3)' }} />
                <div className="truncate font-medium" style={{ color: activeProjectId === null ? 'var(--fg)' : 'var(--fg-2)' }}>All Chats</div>
              </div>
            </div>
            {projects.map((p) => (
              <div
                key={p.id}
                className="group flex items-center justify-between px-3 py-2 rounded-xl text-xs cursor-pointer transition-all border"
                style={
                  activeProjectId === p.id
                    ? { background: 'var(--bg-3)', borderColor: 'var(--line-2)' }
                    : { background: 'transparent', borderColor: 'transparent', opacity: 0.65 }
                }
                onMouseEnter={(e) => { if (activeProjectId !== p.id) e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { if (activeProjectId !== p.id) e.currentTarget.style.opacity = '0.65'; }}
                onClick={() => selectProject(p.id)}
              >
                <div className="flex items-center space-x-3 flex-1 min-w-0">
                  {activeProjectId === p.id
                    ? <FolderOpen className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--accent)' }} />
                    : <Folder className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--fg-3)' }} />}
                  <div className="truncate font-medium" style={{ color: activeProjectId === p.id ? 'var(--fg)' : 'var(--fg-2)' }} title={p.description || p.name}>{p.name}</div>
                </div>
                <div className="hidden group-hover:flex items-center space-x-1 ml-2">
                  <button title="Edit Project" onClick={(e) => { e.stopPropagation(); openProjectModal(p); }} className="p-1.5 rounded-lg transition-colors om-hover" style={{ color: 'var(--fg-3)' }}><Edit3 className="w-3 h-3" /></button>
                  <button title="Delete Project" onClick={(e) => { e.stopPropagation(); handleDeleteProject(p.id); }} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--fg-3)' }} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-3)'; }}><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* History Area */}
        <div className="flex-1 min-h-[120px] max-h-56 flex flex-col mb-4">
          <div className="text-[10px] px-2 mb-3 uppercase tracking-[0.2em] font-bold flex items-center space-x-2 flex-shrink-0 font-mono" style={{ color: 'var(--fg-4)' }}>
            <Clock className="w-3 h-3" />
            <span>History</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-1">
            {conversations.filter((c) => (c.project_id ?? null) === activeProjectId).map((c: Conversation) => (
              <div
                key={c.id}
                className="group flex items-center justify-between px-3 py-2.5 rounded-xl text-xs cursor-pointer transition-all border"
                style={
                  activeConvId === c.id
                    ? { background: 'var(--bg-3)', borderColor: 'var(--line-2)' }
                    : { background: 'transparent', borderColor: 'transparent', opacity: 0.65 }
                }
                onMouseEnter={(e) => { if (activeConvId !== c.id) e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={(e) => { if (activeConvId !== c.id) e.currentTarget.style.opacity = '0.65'; }}
              >
                <div className="flex items-center space-x-3 flex-1 min-w-0" onClick={() => loadConversation(c.id)}>
                   <MessageSquare className="w-3 h-3 flex-shrink-0" style={{ color: activeConvId === c.id ? 'var(--accent)' : 'var(--fg-3)' }} />
                   <div className="flex-1 min-w-0">
                     {editingChatId === c.id ? (
                       <input
                         autoFocus
                         title="Edit chat title"
                         onClick={(e) => e.stopPropagation()}
                         value={editingTitle}
                         onChange={(e) => setEditingTitle(e.target.value)}
                         onBlur={() => handleSaveTitle(c.id)}
                         onKeyDown={(e) => {
                           if(e.key === 'Enter') handleSaveTitle(c.id);
                           if(e.key === 'Escape') setEditingChatId(null);
                         }}
                         className="w-full rounded px-1.5 py-0.5 outline-none max-w-[150px] border"
                         style={{ background: 'var(--bg)', borderColor: 'var(--accent-line)', color: 'var(--fg)' }}
                       />
                     ) : (
                       <div className="truncate font-medium" style={{ color: activeConvId === c.id ? 'var(--fg)' : 'var(--fg-2)' }}>{c.title || 'Untitled Chat'}</div>
                     )}
                     <div className="text-[10px] mt-0.5 font-mono" style={{ color: 'var(--fg-4)' }}>{new Date(c.updated_at).toLocaleDateString()}</div>
                   </div>
                </div>

                <div className="hidden group-hover:flex items-center space-x-1 ml-2">
                   <button title="Edit Title" onClick={(e) => { e.stopPropagation(); setEditingChatId(c.id); setEditingTitle(c.title || ''); }} className="p-1.5 rounded-lg transition-colors om-hover" style={{ color: 'var(--fg-3)' }}><Edit3 className="w-3 h-3" /></button>
                   <button title="Delete Chat" onClick={(e) => { e.stopPropagation(); handleDeleteChat(c.id); }} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--fg-3)' }} onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--red)'; }} onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-3)'; }}><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Data & MCP Areas */}
        <div className="space-y-4 pt-4 border-t shrink-0" style={{ borderColor: 'var(--line)' }}>
          {/* Artifacts */}
          <div>
            <div className="text-[10px] px-2 mb-2 uppercase tracking-[0.2em] font-bold flex items-center justify-between font-mono" style={{ color: 'var(--fg-4)' }}>
              <div className="flex items-center space-x-2">
                 <FileText className="w-3 h-3" />
                 <span>Artifacts</span>
              </div>
              <button className="p-1 rounded-md transition-colors om-hover" style={{ color: 'var(--fg-4)' }} title="Upload user document (mockup)">
                 <UploadCloud className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2 max-h-24 overflow-y-auto custom-scrollbar pr-2">
              {artifacts.length === 0 ? (
                <div className="text-[10px] leading-relaxed px-2 italic rounded-lg p-2 border" style={{ color: 'var(--fg-4)', background: 'var(--bg-3)', borderColor: 'var(--line)' }}>
                   No artifacts yet. Ask the AI to write a document. Alternatively, hit the upload icon to supply user knowledge files.
                </div>
              ) : artifacts.slice(0, 3).map((artifact) => (
                <a
                  key={artifact.id}
                  href={`${API_BASE_URL}/artifacts/${artifact.path.split('/generated_artifacts/').pop()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center space-x-3 rounded-xl border px-3 py-2 transition-all group om-hover-soft"
                  style={{ borderColor: 'var(--line)', background: 'var(--bg-3)' }}
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    <FileText className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] truncate font-medium" style={{ color: 'var(--fg)' }}>{artifact.name}</div>
                    <div className="text-[9px] uppercase mt-0.5 tracking-wider font-mono" style={{ color: 'var(--fg-4)' }}>{artifact.kind}</div>
                  </div>
                </a>
              ))}
            </div>
          </div>

          {/* MCP Connections */}
          <div>
            <div className="text-[10px] px-2 mb-2 uppercase tracking-[0.2em] font-bold flex items-center justify-between font-mono" style={{ color: 'var(--fg-4)' }}>
              <div className="flex items-center space-x-2">
                 <Server className="w-3 h-3" />
                 <span>MCP Connections</span>
              </div>
              <button onClick={() => setShowMcpModal(true)} className="p-1 rounded-md transition-colors om-hover" style={{ color: 'var(--fg-4)' }} title="Add Connection">
                 <Plus className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2 max-h-24 overflow-y-auto custom-scrollbar pr-2">
              {mcpServers.length === 0 ? (
                <div className="text-[11px] px-2 italic" style={{ color: 'var(--fg-4)' }}>No servers connected.</div>
              ) : mcpServers.map((server) => (
                <div key={server.id} className="flex items-center justify-between rounded-xl border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--line)', background: 'var(--bg-3)' }}>
                  <div className="flex items-center space-x-2 truncate">
                     <Wrench className="w-3 h-3" style={{ color: 'var(--fg-3)' }} />
                     <span className="truncate font-medium" style={{ color: 'var(--fg)' }}>{server.name}</span>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    {server.connected ? (
                      <span className="flex h-2 w-2 rounded-full" style={{ background: 'var(--green)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--green) 20%, transparent)' }}></span>
                    ) : (
                      <button
                        onClick={() => runMcpOAuthFlow(server.id, server.name)}
                        disabled={authorizingServerId === server.id}
                        className="flex items-center space-x-1 transition-colors om-hover disabled:opacity-50"
                        style={{ color: 'var(--amber)' }}
                        title="Authorize connection"
                      >
                        {authorizingServerId === server.id ? <Orbit className="w-3 h-3 spin" /> : <ShieldCheck className="w-3 h-3" />}
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteMcp(server.id, server.name)}
                      className="transition-colors om-hover"
                      style={{ color: 'var(--fg-4)' }}
                      title="Remove server"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Intelligence Config */}
        <div className="space-y-4 pt-5 mt-auto border-t shrink-0 pb-2" style={{ borderColor: 'var(--line)' }}>
          <div className="text-[10px] px-1 uppercase tracking-[0.2em] font-bold flex items-center justify-between font-mono" style={{ color: 'var(--fg-4)' }}>
            <div className="flex items-center space-x-2">
              <Brain className="w-3 h-3" />
              <span>Intelligence</span>
            </div>
            <button
              onClick={openInstructionsModal}
              className="p-1 rounded-md transition-colors om-hover"
              style={{ color: 'var(--fg-4)' }}
              title="Custom instructions (apply to every chat)"
            >
              <Settings className="w-3 h-3" />
            </button>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {Object.keys(providerOptions).map((providerName: string) => (
                <button
                  key={providerName}
                  type="button"
                  onClick={async () => {
                    const isNewProvider = provider !== providerName;
                    setProvider(providerName);

                    try {
                      setIsRefreshingModels(true);
                      const liveModels = await fetchProviderModels(providerName);
                      if (liveModels.length > 0) {
                        setProviders(prev => ({ ...prev, [providerName]: liveModels }));
                        // Only reset model if it's a new provider OR current model isn't in the live list
                        if (isNewProvider || !liveModels.includes(model)) {
                          setModel(liveModels[0]);
                        }
                      }
                    } catch {
                      // Fallback logic
                      const fallback = providerOptions[providerName] || [];
                      if (isNewProvider && fallback.length > 0) setModel(fallback[0]);
                    } finally {
                      setIsRefreshingModels(false);
                    }
                  }}
                  className="rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-all text-left"
                  style={
                    provider === providerName
                      ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft)', color: 'var(--accent)' }
                      : { borderColor: 'var(--line)', background: 'var(--bg-3)', color: 'var(--fg-2)' }
                  }
                >
                  {providerName}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <select
                value={model}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
                className="flex-1 min-w-0 rounded-lg border p-2 text-xs outline-none transition-all font-mono"
                style={{ borderColor: 'var(--line)', background: 'var(--bg-3)', color: 'var(--fg-2)' }}
              >
                {modelOptions.map((modelName: string) => (
                  <option key={modelName} value={modelName} style={{ background: 'var(--elev)', color: 'var(--fg)' }}>
                    {modelName}
                  </option>
                ))}
              </select>
              <button
                title="Refresh model list from provider"
                disabled={isRefreshingModels}
                onClick={async () => {
                  try {
                    setIsRefreshingModels(true);
                    setProviderError('');
                    const liveModels = await fetchProviderModels(provider);
                    if (liveModels.length > 0) {
                      setProviders(prev => ({ ...prev, [provider]: liveModels }));
                      if (!liveModels.includes(model)) setModel(liveModels[0]);
                    }
                  } catch (err: unknown) {
                    setProviderError('Refresh failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
                  } finally {
                    setIsRefreshingModels(false);
                  }
                }}
                className="flex-shrink-0 p-2 rounded-lg border transition-all disabled:opacity-30 om-hover-soft"
                style={{ borderColor: 'var(--line)', background: 'var(--bg-3)', color: 'var(--fg-3)' }}
              >
                {isRefreshingModels
                  ? <Loader2 className="w-3.5 h-3.5 spin" />
                  : <span className="text-xs font-bold">↻</span>
                }
              </button>
            </div>
            {providerError ? (
              <p className="text-[10px]" style={{ color: 'var(--red)' }}>{providerError}</p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative overflow-hidden min-w-0 h-full" style={{ background: 'var(--bg)' }}>
        {/* Background Decorative Gradient */}
        <div
          className="absolute top-0 right-0 w-[520px] h-[420px] z-0 pointer-events-none"
          style={{ background: 'radial-gradient(circle, var(--accent-soft), transparent 70%)', opacity: 0.5, marginRight: '-120px', marginTop: '-160px' }}
        ></div>

        {/* Header */}
        <header
          className="h-14 shrink-0 border-b flex items-center justify-between px-6 z-10 backdrop-blur-md"
          style={{ borderColor: 'var(--line)', background: 'color-mix(in srgb, var(--bg) 80%, transparent)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
             <div className="text-[15px] font-semibold tracking-tight truncate max-w-[42vw]" style={{ color: 'var(--fg)' }}>
               {currentConversation ? currentConversation.title : 'New Session'}
             </div>
             {activeProjectId && projects.find(p => p.id === activeProjectId) && (
               <div
                 className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10.5px] font-semibold whitespace-nowrap border"
                 style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)', color: 'var(--accent)' }}
                 title="Active project — its custom instructions apply to chats here"
               >
                 <FolderOpen className="w-3 h-3" />
                 <span className="truncate max-w-[140px]">{projects.find(p => p.id === activeProjectId)?.name}</span>
               </div>
             )}
             <div
               className="flex items-center gap-2 px-2.5 py-1 rounded-lg border text-[10.5px] font-mono whitespace-nowrap"
               style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--fg-3)' }}
             >
               <span className="w-[5px] h-[5px] rounded-full" style={{ background: 'var(--accent)' }}></span>
               {provider} · {model}
             </div>
          </div>
          <div className="flex items-center gap-1.5">
             {currentConversation && (
               <div className="flex items-center gap-2 px-2.5 mr-2">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: isLoading ? 'var(--accent)' : 'var(--green)', animation: isLoading ? 'om-breathe 1.3s ease-in-out infinite' : 'none' }}
                  ></span>
                  <span className="text-[9.5px] font-bold tracking-[0.16em] uppercase font-mono" style={{ color: isLoading ? 'var(--accent)' : 'var(--green)' }}>
                    {isLoading ? 'Live' : 'Ready'}
                  </span>
               </div>
             )}
            <button
              onClick={toggleTheme}
              className="w-[34px] h-[34px] rounded-lg transition-all flex items-center justify-center border om-hover-soft"
              style={{ borderColor: 'transparent', color: 'var(--fg-3)' }}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                {theme === 'dark' ? (
                  <Sun className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                ) : (
                  <Moon className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                )}
            </button>
            <button
              onClick={() => alert('Settings module coming soon!')}
              className="w-[34px] h-[34px] rounded-lg transition-all flex items-center justify-center om-hover-soft"
              style={{ color: 'var(--fg-3)' }}
            >
                <Settings className="w-4 h-4" />
            </button>
            <div className="w-px h-[22px] mx-1" style={{ background: 'var(--line)' }}></div>
            <button
              onClick={() => {
                if (messages.length === 0) return alert('No messages to share yet!');
                const chatText = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                navigator.clipboard.writeText(chatText)
                  .then(() => alert('Conversation transcript copied to clipboard!'))
                  .catch(() => alert('Failed to copy to clipboard.'));
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-all border om-hover-soft"
              style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--fg)' }}
            >
               <span>Share</span>
               <Share2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 custom-scrollbar z-10 scroll-smooth min-h-0">
          <div className="max-w-4xl mx-auto min-h-full flex flex-col">
            {messages.length === 0 && !isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center space-y-6 select-none m-auto pb-20">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center border"
                  style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--accent)' }}
                >
                  <Orbit className="w-9 h-9" />
                </div>
                <div className="text-center space-y-2">
                    <p className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--fg)' }}>How can I help today?</p>
                    <p className="text-[11px] uppercase tracking-[0.22em] font-semibold font-mono" style={{ color: 'var(--fg-4)' }}>Universal intelligence engine</p>
                </div>
              </div>
            ) : (
              <div className="space-y-8 pb-10">
                {messages.map((m, i) => {
                  const lm = m as LocalMessage & { thinkSecs?: number };
                  const displayContent = m.role === 'assistant'
                    ? normalizeAssistantContent(m.content)
                    : m.content;
                  return (
                  <div key={i} className={`group/message flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                    <div className={`${m.role === 'user' ? 'max-w-[90%] md:max-w-[72%]' : 'w-full max-w-3xl'}`}>
                      {m.role === 'user' ? (
                        <div
                          className="rounded-2xl px-4 py-3 text-[14.5px] font-medium leading-relaxed whitespace-pre-wrap tracking-wide border"
                          style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--fg)' }}
                        >
                          {displayContent}
                        </div>
                      ) : (
                        <div className="px-1 py-1">
                          {lm.activity && lm.activity.length > 0 && <ActivityPanel events={lm.activity} isLive={false} />}
                          {lm.thinking && <ThinkingBlock content={lm.thinking} elapsed={lm.thinkSecs} />}
                          <div className="om-prose">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
                          </div>
                        </div>
                      )}
                      <div className={`mt-1.5 flex items-center gap-1 opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 transition-opacity ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <button
                          type="button"
                          title={copiedMessageIndex === i ? 'Copied' : 'Copy'}
                          onClick={() => handleCopyMessage(lm, i)}
                          className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors om-hover"
                          style={{ color: 'var(--fg-4)' }}
                        >
                          {copiedMessageIndex === i ? <CheckCircle className="w-3.5 h-3.5" style={{ color: 'var(--green)' }} /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          type="button"
                          title="Rerun"
                          onClick={() => handleRerunMessage(i)}
                          disabled={isLoading}
                          className="h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 om-hover"
                          style={{ color: 'var(--fg-4)' }}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  );
                })}

                {isLoading && activityEvents.length > 0 && (
                  <div className="flex justify-start animate-fade-in">
                    <ActivityPanel events={activityEvents} isLive={isLoading} />
                  </div>
                )}

                {researchProgress && (
                  <div className="max-w-4xl mx-auto w-full mb-4">
                    <ResearchProgressBar message={researchProgress.message} percentage={researchProgress.percentage} />
                  </div>
                )}

                {toolActivity && !researchProgress && (
                  <div className="flex justify-start animate-fade-in">
                    <div
                      className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
                      style={{ borderColor: 'var(--line)', background: 'var(--bg-2)', color: 'var(--fg-3)' }}
                    >
                      <Loader2 className="w-3.5 h-3.5 spin" style={{ color: 'var(--accent)' }} />
                      <span>Using {toolActivity.toolName.replaceAll('_', ' ')}</span>
                    </div>
                  </div>
                )}

                {(currentThinking || currentResponse) && (
                  <div className="flex justify-start animate-fade-in">
                    <div className="w-full max-w-3xl px-1 py-1">
                      <div className="relative">
                        {currentThinking && <ThinkingBlock content={currentThinking} isLive={isThinking} />}
                        {currentResponse && (
                          currentResponse.includes('{"name":') && currentResponse.includes('"arguments":') ? (
                            <div className="flex items-center space-x-3 pt-2 pb-1" style={{ color: 'var(--accent)' }}>
                               <Loader2 className="w-4 h-4 spin" />
                               <span className="text-xs font-semibold tracking-wider font-mono uppercase">Agent Generating Tool Call...</span>
                            </div>
                          ) : (
                            <div className="om-prose relative">
                               <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentResponse}</ReactMarkdown>
                               <span
                                 className="inline-block w-2.5 h-4 ml-1 mt-1 rounded-sm align-middle"
                                 style={{ background: 'var(--accent)', animation: 'om-blink 1s step-start infinite' }}
                               ></span>
                            </div>
                          )
                        )}
                        {isThinking && !currentResponse && (
                          <div className="flex items-center space-x-2 pt-1" style={{ color: 'var(--fg-3)' }}>
                            <Loader2 className="w-3.5 h-3.5 spin" />
                            <span className="text-[11px] font-medium tracking-wide">Processing...</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Tool Approval Cards */}
                {pendingApprovals.map((approval) => {
                  const isExpanded = expandedApprovals.has(approval.approval_id);
                  const detailLines = (approval.detail || '').split('\n');
                  const isLong = detailLines.length > 12 || (approval.detail || '').length > 600;
                  const displayDetail = (!isLong || isExpanded)
                    ? approval.detail
                    : detailLines.slice(0, 10).join('\n') + '\n...';

                  return (
                    <div key={approval.approval_id} className="flex justify-start animate-fade-in">
                      <div
                        className="max-w-[90%] md:max-w-[85%] rounded-2xl overflow-hidden border"
                        style={{ borderColor: 'var(--amber)', background: 'color-mix(in srgb, var(--amber) 9%, var(--bg-2))' }}
                      >
                        {/* Header */}
                        <div className="flex items-center space-x-3 px-5 pt-4 pb-3">
                          <div
                            className="w-9 h-9 rounded-xl flex items-center justify-center border"
                            style={{ background: 'color-mix(in srgb, var(--amber) 18%, transparent)', borderColor: 'var(--amber)' }}
                          >
                            <Terminal className="w-4.5 h-4.5" style={{ color: 'var(--amber)' }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold tracking-wide" style={{ color: 'var(--fg)' }}>
                              {approval.tool_icon} {approval.tool_label}
                            </div>
                            <div className="text-[11px] mt-0.5 tracking-wide font-medium truncate font-mono" style={{ color: 'var(--fg-3)' }}>
                              {approval.summary}
                            </div>
                          </div>
                          <div
                            className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full border"
                            style={{ background: 'color-mix(in srgb, var(--amber) 16%, transparent)', borderColor: 'var(--amber)' }}
                          >
                            <div className="w-2 h-2 rounded-full" style={{ background: 'var(--amber)', animation: 'om-pulse 1.4s ease-in-out infinite' }}></div>
                            <span className="text-[9px] font-bold uppercase tracking-[0.15em] font-mono" style={{ color: 'var(--amber)' }}>Awaiting Approval</span>
                          </div>
                        </div>

                        {/* Content preview */}
                        <div className="px-5 pb-3">
                          <div className="relative rounded-xl overflow-hidden border" style={{ background: 'var(--bg)', borderColor: 'var(--line)' }}>
                            <pre className={`text-[12px] font-mono leading-relaxed p-4 overflow-x-auto custom-scrollbar whitespace-pre-wrap break-words ${isLong && !isExpanded ? 'max-h-[240px] overflow-y-hidden' : 'max-h-[500px] overflow-y-auto'}`} style={{ color: 'var(--fg-2)' }}>
                              {displayDetail}
                            </pre>
                            {isLong && (
                              <button
                                onClick={() => {
                                  setExpandedApprovals((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(approval.approval_id)) next.delete(approval.approval_id);
                                    else next.add(approval.approval_id);
                                    return next;
                                  });
                                }}
                                className="w-full flex items-center justify-center space-x-1.5 py-2 text-[11px] font-semibold tracking-wide transition-colors border-t om-hover-soft"
                                style={{ borderColor: 'var(--line)', color: 'var(--amber)' }}
                              >
                                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                <span>{isExpanded ? 'Show Less' : `Show Full Content (${detailLines.length} lines)`}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center space-x-3 px-5 pb-4 pt-1">
                          <button
                            onClick={async () => {
                              try { await submitToolApproval(approval.approval_id, true); }
                              catch (e) { console.error('Approval submit failed', e); }
                            }}
                            className="flex-1 flex items-center justify-center space-x-2 py-2.5 rounded-xl font-bold text-sm tracking-wide hover:scale-[1.02] active:scale-[0.98] transition-all"
                            style={{ background: 'var(--green)', color: 'var(--on-green)' }}
                          >
                            <ShieldCheck className="w-4 h-4" />
                            <span>Approve</span>
                          </button>
                          <button
                            onClick={async () => {
                              try { await submitToolApproval(approval.approval_id, false, 'User rejected'); }
                              catch (e) { console.error('Reject submit failed', e); }
                            }}
                            className="flex-1 flex items-center justify-center space-x-2 py-2.5 rounded-xl font-bold text-sm tracking-wide hover:scale-[1.02] active:scale-[0.98] transition-all border"
                            style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--fg-2)' }}
                          >
                            <ShieldX className="w-4 h-4" />
                            <span>Reject</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div ref={messagesEndRef} className="h-4" />
              </div>
            )}
          </div>
        </div>

        {/* Input area */}
        <div className="p-4 md:p-6 pt-0 z-20 shrink-0">
          <div className="max-w-4xl mx-auto relative w-full">
             <div
               className="relative rounded-[1.6rem] flex flex-col p-2 border transition-all duration-300 shadow-2xl"
               style={{ background: 'var(--bg-2)', borderColor: 'var(--line)' }}
             >
                <textarea
                  value={input}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask anything or request tasks..."
                  className="w-full bg-transparent border-none outline-none px-5 pt-4 pb-2 text-[14.5px] font-light tracking-wide resize-none min-h-[56px] custom-scrollbar focus:ring-0"
                  style={{ color: 'var(--fg)' }}
                  rows={1}
                />
                <div className="flex justify-between items-center px-3 pb-2 pt-1 w-full relative">
                   <div className="flex items-center space-x-2 relative">
                     <button
                       onClick={() => setShowToolSelector(!showToolSelector)}
                       title="Select tools to run"
                       className="flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border"
                       style={
                         enabledTools.length > 0
                           ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent-line)' }
                           : { background: 'var(--bg-3)', color: 'var(--fg-3)', borderColor: 'var(--line)' }
                       }
                     >
                       <Wrench className="w-3.5 h-3.5" />
                       <span>{enabledTools.length} {enabledTools.length === 1 ? 'Tool' : 'Tools'} Enabled</span>
                     </button>

                     {showToolSelector && (
                       <div
                         className="absolute bottom-12 left-0 w-64 rounded-2xl p-4 shadow-2xl z-50 flex flex-col space-y-3 animate-fade-in border"
                         style={{ background: 'var(--elev)', borderColor: 'var(--line-2)' }}
                       >
                         <div className="flex items-center justify-between mb-1">
                           <span className="text-[10px] font-bold uppercase tracking-[0.15em] font-mono" style={{ color: 'var(--fg-3)' }}>Select Integrations</span>
                           <button onClick={() => setShowToolSelector(false)} style={{ color: 'var(--fg-4)' }}><X className="w-3.5 h-3.5"/></button>
                         </div>

                         <label className="flex items-center space-x-3 p-2 rounded-xl cursor-pointer transition-all border border-transparent om-hover-soft" style={{ background: 'transparent' }}>
                           <input
                             type="checkbox"
                             checked={enabledTools.includes("web_search")}
                             onChange={(e) => {
                               if (e.target.checked) setEnabledTools([...enabledTools, "web_search"]);
                               else setEnabledTools(enabledTools.filter(t => t !== "web_search"));
                             }}
                             className="w-4 h-4 rounded cursor-pointer"
                             style={{ accentColor: 'var(--accent)' }}
                           />
                           <div className="flex flex-col">
                             <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Simple Web Search</span>
                             <span className="text-[10px] mt-0.5 leading-tight" style={{ color: 'var(--fg-4)' }}>Fast DuckDuckGo Snippets</span>
                           </div>
                         </label>

                         <label className="flex items-center space-x-3 p-2 rounded-xl cursor-pointer transition-all border border-transparent om-hover-soft">
                           <input
                             type="checkbox"
                             checked={enabledTools.includes("deep_research")}
                             onChange={(e) => {
                               if (e.target.checked) setEnabledTools([...enabledTools, "deep_research"]);
                               else setEnabledTools(enabledTools.filter(t => t !== "deep_research"));
                             }}
                             className="w-4 h-4 rounded cursor-pointer"
                             style={{ accentColor: 'var(--accent)' }}
                           />
                           <div className="flex flex-col">
                             <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Deep Research Agent</span>
                             <span className="text-[10px] mt-0.5 leading-tight" style={{ color: 'var(--fg-3)' }}>Crawls full pages & synthesizes</span>
                           </div>
                         </label>


                          <label className="flex items-center space-x-3 p-2 rounded-xl cursor-pointer transition-all border border-transparent om-hover-soft">
                            <input
                              type="checkbox"
                              checked={enabledTools.includes("computer_use")}
                              onChange={(e) => {
                                if (e.target.checked) setEnabledTools([...enabledTools, "computer_use"]);
                                else setEnabledTools(enabledTools.filter(t => t !== "computer_use"));
                              }}
                              className="w-4 h-4 rounded cursor-pointer"
                              style={{ accentColor: 'var(--amber)' }}
                            />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Computer Use</span>
                              <span className="text-[10px] mt-0.5 leading-tight" style={{ color: 'var(--amber)' }}>Bash, read/write files &#x2022; Requires approval</span>
                            </div>
                          </label>
                         {mcpServers.length > 0 && <div className="h-px w-full my-1" style={{ background: 'var(--line)' }} />}

                         {mcpServers.map(server => (
                           <label key={server.name} className="flex items-center space-x-3 p-2 rounded-xl cursor-pointer transition-all border border-transparent om-hover-soft">
                             <input
                               type="checkbox"
                               checked={enabledTools.includes(server.name)}
                               onChange={(e) => {
                                 if (e.target.checked) setEnabledTools([...enabledTools, server.name]);
                                 else setEnabledTools(enabledTools.filter(t => t !== server.name));
                               }}
                               className="w-4 h-4 rounded cursor-pointer"
                               style={{ accentColor: 'var(--accent)' }}
                             />
                             <div className="flex flex-col flex-1 min-w-0">
                               <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{server.name}</span>
                               <span className="text-[10px] mt-0.5 leading-tight" style={{ color: server.connected ? 'var(--fg-4)' : 'var(--amber)' }}>
                                 {server.connected ? 'Connected MCP Connector' : 'Needs authorization'}
                               </span>
                             </div>
                             {!server.connected && (
                               <button
                                 onClick={(e) => { e.preventDefault(); e.stopPropagation(); runMcpOAuthFlow(server.id, server.name); }}
                                 disabled={authorizingServerId === server.id}
                                 className="transition-colors om-hover shrink-0 disabled:opacity-50"
                                 style={{ color: 'var(--amber)' }}
                                 title="Authorize connection"
                               >
                                 {authorizingServerId === server.id ? <Orbit className="w-3.5 h-3.5 spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                               </button>
                             )}
                             <button
                               onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteMcp(server.id, server.name); }}
                               className="transition-colors om-hover shrink-0"
                               style={{ color: 'var(--fg-4)' }}
                               title="Remove server"
                             >
                               <Trash2 className="w-3.5 h-3.5" />
                             </button>
                           </label>
                         ))}
                         {mcpServers.length === 0 && (
                            <div className="text-[10px] italic px-2" style={{ color: 'var(--fg-4)' }}>No custom MCP servers connected.</div>
                         )}
                       </div>
                     )}
                   </div>

                   <div className="absolute right-0 bottom-0 mb-1 mr-1">
                      <button
                        onClick={handleSend}
                        disabled={isLoading || !input.trim()}
                        className="p-3 rounded-2xl transition-all duration-300 flex items-center justify-center"
                        style={
                          isLoading || !input.trim()
                            ? { background: 'var(--bg-3)', color: 'var(--fg-4)', cursor: 'not-allowed' }
                            : { background: 'var(--accent)', color: 'var(--on-accent)' }
                        }
                      >
                        <svg className="w-[18px] h-[18px] ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                   </div>
                </div>
             </div>
             <div className="flex justify-center mt-2.5 pointer-events-none">
                 <p
                   className="inline-flex items-center space-x-2 text-[9px] uppercase tracking-[0.2em] font-bold px-3 py-1.5 rounded-full border font-mono"
                   style={{ background: 'var(--bg-2)', borderColor: 'var(--line)', color: 'var(--fg-4)' }}
                 >
                    <span className="w-[5px] h-[5px] rounded-full" style={{ background: 'var(--green)' }}></span>
                    <span>Dynamic Context & Storage Active</span>
                 </p>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
