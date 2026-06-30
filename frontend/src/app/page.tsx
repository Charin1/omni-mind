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
  createMcpServer,
  submitToolApproval,
} from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Search, Clock, FileText, CheckCircle, Orbit, Server, Wrench, MessageSquare, Plus, Settings, Edit3, Trash2, X, UploadCloud, BrainCircuit, Share2, Loader2, Terminal, ShieldCheck, ShieldX, ChevronDown, ChevronUp, Copy, RotateCcw, Link2, Sun, Moon } from 'lucide-react';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

interface Conversation {
  id: string;
  title: string;
  provider?: string;
  model?: string;
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
    <div className="mb-3 rounded-2xl border border-purple-500/25 bg-purple-950/20 overflow-hidden transition-all">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-purple-500/5 transition-all"
      >
        <div className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${isLive ? 'bg-purple-500/20' : 'bg-purple-500/10'}`}>
          <BrainCircuit className={`w-3 h-3 ${isLive ? 'text-purple-400 animate-pulse' : 'text-purple-400/60'}`} />
        </div>
        <span className={`text-[11px] font-semibold tracking-wider ${isLive ? 'text-purple-300' : 'text-purple-400/60'}`}>
          {isLive ? 'Thinking...' : elapsed !== undefined ? `Thought for ${elapsed}s` : 'Model Reasoning'}
        </span>
        {isLive && (
          <span className="flex gap-0.5 ml-1">
            {[0, 150, 300].map(d => (
              <span key={d} className="w-1 h-1 rounded-full bg-purple-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
            ))}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] text-purple-400/40 font-mono">{content.length} chars</span>
        {expanded
          ? <ChevronUp className="w-3 h-3 text-purple-400/40 flex-shrink-0" />
          : <ChevronDown className="w-3 h-3 text-purple-400/40 flex-shrink-0" />}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          className="max-h-52 overflow-y-auto border-t border-purple-500/10 custom-scrollbar"
        >
          <pre className="text-[11.5px] text-purple-200/50 font-mono leading-relaxed whitespace-pre-wrap break-words px-4 py-3">
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

  if (!latest) return null;

  return (
    <div className="mb-4 w-full max-w-3xl rounded-2xl border border-white/10 bg-white/[0.035] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.035] transition-colors"
      >
        <div className="h-7 w-7 rounded-lg bg-accent/15 border border-accent/20 flex items-center justify-center">
          {isLive ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <CheckCircle className="h-4 w-4 text-accent" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.18em] text-white/35 font-bold">
            {isLive ? 'Working' : 'Activity'}
          </div>
          <div className="truncate text-sm text-white/78">{latest.label}</div>
        </div>
        {sources.length > 0 && (
          <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/45">
            {sources.length} sources
          </span>
        )}
        {expanded ? <ChevronUp className="h-4 w-4 text-white/35" /> : <ChevronDown className="h-4 w-4 text-white/35" />}
      </button>

      {expanded && (
        <div className="border-t border-white/10 px-4 py-3">
          <div className="max-h-52 overflow-y-auto custom-scrollbar space-y-3 pr-1">
            {events.map((event) => (
              <div key={event.id} className="flex gap-3">
                <div className="mt-1 h-2 w-2 rounded-full bg-accent/70 shadow-[0_0_8px_rgba(var(--accent),0.5)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white/75">{event.label}</div>
                  {event.detail && <div className="mt-0.5 text-xs text-white/38">{event.detail}</div>}
                  {event.sources && event.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {event.sources.map((source) => (
                        <a
                          key={source.url}
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] text-white/55 hover:text-white/90 hover:border-accent/30 transition-colors"
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
    <div className="mb-6 rounded-3xl border border-accent/30 bg-accent/5 p-5 shadow-[0_0_40px_rgba(var(--accent),0.1)] relative overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-accent/20 flex items-center justify-center border border-accent/30 shadow-inner">
            <Search className="w-4 h-4 text-accent animate-spin-slow" />
          </div>
          <div>
            <span className="text-[10px] font-bold text-accent/50 uppercase tracking-[0.2em] block mb-0.5">Deep Research Status</span>
            <span className="text-sm font-medium text-white/90">{message}</span>
          </div>
        </div>
        <div className="text-right">
          <span className="text-lg font-bold text-accent tabular-nums">{percentage}%</span>
        </div>
      </div>
      <div className="relative h-2 w-full bg-white/5 rounded-full overflow-hidden border border-white/5">
        <div 
          className="absolute top-0 left-0 h-full bg-gradient-to-r from-primary/60 via-accent to-primary/60 shadow-[0_0_15px_rgba(var(--accent),0.6)] transition-all duration-700 ease-out rounded-full"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-white/30 font-medium">
         <span>Comprehensive Analysis in progress...</span>
         <span className="flex gap-1">
            {[0, 1, 2].map(i => (
              <span key={i} className="w-1 h-1 rounded-full bg-accent animate-pulse" style={{ animationDelay: `${i * 200}ms` }} />
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
      if (saved === 'light') {
        document.documentElement.classList.add('light');
      } else {
        document.documentElement.classList.remove('light');
      }
    } else {
      const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      if (prefersLight) {
        setTheme('light');
        document.documentElement.classList.add('light');
      }
    }
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('omnimind-theme', next);
    if (next === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
  };
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
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

  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', env: '' });
  const [mcpError, setMcpError] = useState('');
  const [isAddingMcp, setIsAddingMcp] = useState(false);
  
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
        body: JSON.stringify({ title: 'New Chat', user_id: userId })
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

  const handleAddMcp = async () => {
    if (!mcpForm.name.trim() || !mcpForm.command.trim()) return;
    setIsAddingMcp(true);
    setMcpError('');
    try {
      const parsedEnv: Record<string, string> = {};
      if (mcpForm.env.trim()) {
         mcpForm.env.split('\n').forEach(line => {
            const [k, ...v] = line.split('=');
            if (k && k.trim()) parsedEnv[k.trim()] = v.join('=').trim();
         });
      }

      const configJson = {
        command: mcpForm.command,
        args: mcpForm.args.split(' ').filter(a => a.trim()),
        env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined
      };
      await createMcpServer({
        id: `mcp-${Date.now()}`,
        name: mcpForm.name,
        transport: 'stdio',
        config_json: configJson
      });
      setShowMcpModal(false);
      setMcpForm({ name: '', command: '', args: '', env: '' });
      setMcpServers(await listMcpServers().catch(() => []));
    } catch (err: unknown) {
      setMcpError(err instanceof Error ? err.message : 'Failed to add server');
    }
    setIsAddingMcp(false);
  };

  const submitMessage = async (messageText: string, historyOverride?: LocalMessage[]) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || isLoading || !userId) return;
    
    let currentId = activeConvId;
    if (!currentId) {
       const res = await fetch(`${API_BASE_URL}/api/conversations`, {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({title: trimmedMessage.slice(0, 20) + '...', user_id: userId})
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
    <div className="fixed inset-0 flex bg-background text-foreground font-sans overflow-hidden">
      
      {/* MCP Modal */}
      {showMcpModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
           <div className="w-96 glass-dark rounded-3xl border border-white/10 p-6 shadow-2xl animate-fade-in relative overflow-hidden">
              <button onClick={() => setShowMcpModal(false)} className="absolute top-4 right-4 text-white/40 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold tracking-wide mb-1 text-white/90">Add MCP Server</h2>
              <p className="text-xs text-white/40 mb-6">Connect local stdio executable tools.</p>
              
              <div className="space-y-4">
                 <div>
                   <label className="text-[10px] text-white/50 uppercase tracking-widest font-bold ml-1">Server Name</label>
                   <input value={mcpForm.name} onChange={e => setMcpForm({...mcpForm, name: e.target.value})} placeholder="e.g., local-sqlite" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm mt-1 outline-none focus:border-accent/50 transition-all font-light" />
                 </div>
                 <div>
                   <label className="text-[10px] text-white/50 uppercase tracking-widest font-bold ml-1">Command (Executable)</label>
                   <input value={mcpForm.command} onChange={e => setMcpForm({...mcpForm, command: e.target.value})} placeholder="e.g., npx or python" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm mt-1 outline-none focus:border-accent/50 transition-all font-light" />
                 </div>
                 <div>
                   <label className="text-[10px] text-white/50 uppercase tracking-widest font-bold ml-1">Arguments (Space separated)</label>
                   <input value={mcpForm.args} onChange={e => setMcpForm({...mcpForm, args: e.target.value})} placeholder="-y @modelcontextprotocol/server-sqlite" className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm mt-1 outline-none focus:border-accent/50 transition-all font-light" />
                 </div>
                 <div>
                   <label className="text-[10px] text-white/50 uppercase tracking-widest font-bold ml-1">Environment Config (KEY=VALUE)</label>
                   <textarea value={mcpForm.env} onChange={e => setMcpForm({...mcpForm, env: e.target.value})} placeholder="BRAVE_API_KEY=B_SA3d82h...&#10;GITHUB_TOKEN=ghp_..." rows={2} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm mt-1 outline-none focus:border-accent/50 transition-all font-light custom-scrollbar resize-none" />
                 </div>
              </div>

              {mcpError && <div className="mt-4 text-xs text-red-400 bg-red-400/10 p-2 rounded-lg border border-red-500/20">{mcpError}</div>}

              <button 
                onClick={handleAddMcp}
                disabled={isAddingMcp}
                className="w-full mt-6 bg-white text-black font-semibold py-2.5 rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center space-x-2 shadow-[0_0_15px_rgba(255,255,255,0.15)] disabled:opacity-50"
              >
                {isAddingMcp && <Orbit className="w-4 h-4 animate-spin" />}
                <span>{isAddingMcp ? 'Adding...' : 'Add Connection'}</span>
              </button>
           </div>
        </div>
      )}


      {/* Sidebar */}
      <div className="w-80 glass-dark border-r border-white/10 flex flex-col p-4 z-20 h-full">
        {/* Header */}
        <div className="flex items-center space-x-3 px-2 mb-6 flex-shrink-0">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-lg shadow-lg">
            <Orbit className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gradient tracking-tight">OmniMind</h1>
        </div>
        
        {/* New Chat Button */}
        <button 
          onClick={handleNewChat}
          className="w-full py-2.5 px-4 mb-5 glass hover:bg-white/10 hover:border-white/20 rounded-xl transition-all text-sm font-medium flex items-center justify-center space-x-2 border border-white/5 shadow-md flex-shrink-0">
          <Plus className="w-4 h-4" /> <span>New Chat</span>
        </button>

        {/* History Area */}
        <div className="flex-1 min-h-[120px] max-h-56 flex flex-col mb-4">
          <div className="text-[10px] text-white/30 px-2 mb-3 uppercase tracking-[0.2em] font-bold flex items-center space-x-2 flex-shrink-0">
            <Clock className="w-3 h-3" />
            <span>History</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-1">
            {conversations.map((c: Conversation) => (
              <div 
                key={c.id} 
                className={`group flex items-center justify-between px-3 py-2.5 rounded-xl text-xs cursor-pointer transition-all border ${activeConvId === c.id ? 'bg-white/10 border-white/20 shadow-sm' : 'hover:bg-white/5 border-transparent opacity-60 hover:opacity-100'}`}
              >
                <div className="flex items-center space-x-3 flex-1 min-w-0" onClick={() => loadConversation(c.id)}>
                   <MessageSquare className="w-3 h-3 flex-shrink-0" />
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
                         className="w-full bg-[#111] border border-white/20 rounded px-1.5 py-0.5 text-white outline-none focus:border-accent max-w-[150px]"
                       />
                     ) : (
                       <div className="truncate font-medium">{c.title || 'Untitled Chat'}</div>
                     )}
                     <div className="text-[10px] opacity-40 mt-0.5">{new Date(c.updated_at).toLocaleDateString()}</div>
                   </div>
                </div>
                
                <div className="hidden group-hover:flex items-center space-x-1 ml-2">
                   <button title="Edit Title" onClick={(e) => { e.stopPropagation(); setEditingChatId(c.id); setEditingTitle(c.title || ''); }} className="p-1.5 hover:bg-white/10 rounded-lg text-white/40 hover:text-white transition-colors"><Edit3 className="w-3 h-3" /></button>
                   <button title="Delete Chat" onClick={(e) => { e.stopPropagation(); handleDeleteChat(c.id); }} className="p-1.5 hover:bg-red-500/20 rounded-lg text-white/40 hover:text-red-400 transition-colors"><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Data & MCP Areas */}
        <div className="space-y-4 pt-4 border-t border-white/5 shrink-0">
          {/* Artifacts */}
          <div>
            <div className="text-[10px] text-white/30 px-2 mb-2 uppercase tracking-[0.2em] font-bold flex items-center justify-between">
              <div className="flex items-center space-x-2">
                 <FileText className="w-3 h-3" />
                 <span>Artifacts</span>
              </div>
              <button className="text-white/20 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10" title="Upload user document (mockup)">
                 <UploadCloud className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2 max-h-24 overflow-y-auto custom-scrollbar pr-2">
              {artifacts.length === 0 ? (
                <div className="text-[10px] leading-relaxed text-white/30 px-2 italic bg-black/20 rounded-lg p-2 border border-white/5">
                   No artifacts yet. Ask the AI to write a document. Alternatively, hit the upload icon to supply user knowledge files.
                </div>
              ) : artifacts.slice(0, 3).map((artifact) => (
                <a
                  key={artifact.id}
                  href={`${API_BASE_URL}/artifacts/${artifact.path.split('/generated_artifacts/').pop()}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center space-x-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 hover:bg-white/10 hover:border-white/20 transition-all group"
                >
                  <div className="w-6 h-6 rounded-md bg-accent/20 flex items-center justify-center flex-shrink-0 text-accent group-hover:bg-accent/30">
                    <FileText className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] truncate font-medium text-white/90">{artifact.name}</div>
                    <div className="text-[9px] text-white/40 uppercase mt-0.5 tracking-wider">{artifact.kind}</div>
                  </div>
                </a>
              ))}
            </div>
          </div>

          {/* MCP Connections */}
          <div>
            <div className="text-[10px] text-white/30 px-2 mb-2 uppercase tracking-[0.2em] font-bold flex items-center justify-between">
              <div className="flex items-center space-x-2">
                 <Server className="w-3 h-3" />
                 <span>MCP Connections</span>
              </div>
              <button onClick={() => setShowMcpModal(true)} className="text-white/40 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10" title="Add Connection">
                 <Plus className="w-3 h-3" />
              </button>
            </div>
            <div className="space-y-2 max-h-24 overflow-y-auto custom-scrollbar pr-2">
              {mcpServers.length === 0 ? (
                <div className="text-[11px] text-white/20 px-2 italic">No servers connected.</div>
              ) : mcpServers.map((server) => (
                <div key={server.id} className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[11px]">
                  <div className="flex items-center space-x-2 truncate">
                     <Wrench className="w-3 h-3 text-white/50" />
                     <span className="truncate font-medium">{server.name}</span>
                  </div>
                  <span className="flex h-2 w-2 rounded-full bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></span>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        {/* Intelligence Config */}
        <div className="space-y-4 pt-5 mt-auto border-t border-white/5 shrink-0 pb-2">
          <div className="text-[10px] text-white/30 px-1 uppercase tracking-[0.2em] font-bold flex items-center space-x-2">
            <Brain className="w-3 h-3" />
            <span>Intelligence</span>
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
                  className={`rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-all ${
                    provider === providerName
                      ? 'border-accent/40 bg-accent/10 text-accent shadow-sm'
                      : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                  }`}
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
                className="flex-1 min-w-0 rounded-lg border border-white/10 bg-white/5 p-2 text-xs outline-none transition-all focus:border-accent/50 focus:ring-1 focus:ring-accent/50 text-white/80"
              >
                {modelOptions.map((modelName: string) => (
                  <option key={modelName} value={modelName} className="bg-[#121418]">
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
                className="flex-shrink-0 p-2 rounded-lg border border-white/10 bg-white/5 text-white/40 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all disabled:opacity-30"
              >
                {isRefreshingModels
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <span className="text-xs font-bold">↻</span>
                }
              </button>
            </div>
            {providerError ? (
              <p className="text-[10px] text-red-400/80">{providerError}</p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative bg-background/50 overflow-hidden min-w-0 h-full">
        {/* Background Decorative Gradients */}
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/20 rounded-full blur-[120px] -mr-40 -mt-40 z-0 pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-accent/10 rounded-full blur-[100px] -ml-40 -mb-40 z-0 pointer-events-none"></div>

        {/* Header */}
        <header className="h-16 shrink-0 border-b border-foreground/5 flex items-center justify-between px-8 glass-dark z-10 backdrop-blur-md">
          <div className="flex items-center space-x-3">
             <div className="w-8 h-8 rounded-xl glass flex items-center justify-center border border-white/10 shadow-[0_0_15px_rgba(255,255,255,0.1)]">
                <BrainCircuit className="w-5 h-5 text-white" />
             </div>
             <h1 className="text-xl font-semibold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70 tracking-wide">
               {currentConversation ? currentConversation.title : 'New Session'}
             </h1>
          </div>
          <div className="flex items-center space-x-4">
             {currentConversation && (
               <div className="flex items-center space-x-2 mr-4">
                  <div className="w-2 h-2 rounded-full bg-accent shadow-[0_0_8px_rgba(var(--accent),0.8)] animate-pulse"></div>
                  <span className="text-xs font-semibold text-accent/80 tracking-widest uppercase">Live</span>
               </div>
             )}
            <button 
              onClick={toggleTheme}
              className="p-2.5 rounded-xl hover:bg-white/10 text-white/60 hover:text-white transition-all shadow-sm flex items-center justify-center"
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
                {theme === 'dark' ? (
                  <Sun className="w-4.5 h-4.5 text-amber-400" />
                ) : (
                  <Moon className="w-4.5 h-4.5 text-indigo-400" />
                )}
            </button>
            <button 
              onClick={() => alert('Settings module coming soon!')}
              className="p-2.5 rounded-xl hover:bg-white/10 text-white/60 hover:text-white transition-all shadow-sm"
            >
                <Settings className="w-4.5 h-4.5" />
            </button>
            <div className="h-6 w-px bg-white/10"></div>
            <button 
              onClick={() => {
                if (messages.length === 0) return alert('No messages to share yet!');
                const chatText = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                navigator.clipboard.writeText(chatText)
                  .then(() => alert('Conversation transcript copied to clipboard!'))
                  .catch(() => alert('Failed to copy to clipboard.'));
              }}
              className="flex items-center space-x-2 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-xl text-sm font-medium transition-all border border-white/5 hover:border-white/20 hover:shadow-lg backdrop-blur-xl"
            >
               <span>Share</span>
               <Share2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 custom-scrollbar z-10 scroll-smooth min-h-0">
          <div className="max-w-4xl mx-auto min-h-full flex flex-col">
            {messages.length === 0 && !isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center space-y-6 opacity-40 select-none m-auto pb-20">
                <div className="w-24 h-24 rounded-3xl glass flex items-center justify-center text-4xl shadow-[0_0_30px_rgba(var(--accent),0.1)] border border-foreground/10">
                  <Orbit className="w-12 h-12 text-foreground/80" />
                </div>
                <div className="text-center space-y-3">
                    <p className="text-3xl font-extralight tracking-[0.15em] bg-clip-text text-transparent bg-gradient-to-b from-foreground to-foreground/50">OmniMind</p>
                    <p className="text-xs text-foreground/50 uppercase tracking-[0.3em] font-semibold">Universal Intelligence Engine</p>
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
                      <div className={`${
                          m.role === 'user' 
                          ? 'rounded-3xl bg-white/[0.08] border border-white/10 px-5 py-3.5 text-white shadow-sm' 
                          : `px-1 py-1 prose ${theme === 'dark' ? 'prose-invert' : ''} prose-p:leading-relaxed prose-pre:bg-background/50 prose-pre:border prose-pre:border-foreground/10 prose-a:text-accent prose-a:no-underline hover:prose-a:underline`
                      }`}>
                        {m.role === 'user' ? (
                           <div className="text-[15px] font-medium leading-relaxed whitespace-pre-wrap tracking-wide">{displayContent}</div>
	                        ) : (
	                           <div className="text-[15px] leading-7 font-normal tracking-wide markdown-body text-white/88">
                              {lm.activity && lm.activity.length > 0 && <ActivityPanel events={lm.activity} isLive={false} />}
	                              {lm.thinking && <ThinkingBlock content={lm.thinking} elapsed={lm.thinkSecs} />}
	                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
	                           </div>
                        )}
                      </div>
                      <div className={`mt-2 flex items-center gap-1 opacity-0 group-hover/message:opacity-100 focus-within:opacity-100 transition-opacity ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <button
                          type="button"
                          title={copiedMessageIndex === i ? 'Copied' : 'Copy'}
                          onClick={() => handleCopyMessage(lm, i)}
                          className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-white/35 hover:text-white/90 hover:bg-white/10 transition-colors"
                        >
                          {copiedMessageIndex === i ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </button>
                        <button
                          type="button"
                          title="Rerun"
                          onClick={() => handleRerunMessage(i)}
                          disabled={isLoading}
                          className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-white/35 hover:text-white/90 hover:bg-white/10 transition-colors disabled:opacity-30"
                        >
                          <RotateCcw className="w-4 h-4" />
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
                    <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-white/55">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                      <span>Using {toolActivity.toolName.replaceAll('_', ' ')}</span>
                    </div>
                  </div>
                )}
                
                {(currentThinking || currentResponse) && (
                  <div className="flex justify-start animate-fade-in">
                    <div className={`w-full max-w-3xl px-1 py-1 prose ${theme === 'dark' ? 'prose-invert' : ''} prose-p:leading-relaxed prose-pre:bg-background/50 prose-pre:border prose-pre:border-foreground/10 prose-a:text-accent prose-a:no-underline`}>
                      <div className="text-[15px] leading-7 font-normal tracking-wide markdown-body relative text-white/88">
                        {currentThinking && <ThinkingBlock content={currentThinking} isLive={isThinking} />}
                        {currentResponse && (
                          currentResponse.includes('{"name":') && currentResponse.includes('"arguments":') ? (
                            <div className="flex items-center space-x-3 text-accent animate-pulse opacity-80 pt-2 pb-1">
                               <Loader2 className="w-4 h-4 animate-spin" />
                               <span className="text-xs font-semibold tracking-wider font-mono uppercase">Agent Generating Tool Call...</span>
                            </div>
                          ) : (
                            <>
                               <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentResponse}</ReactMarkdown>
                               <span className="inline-block w-2.5 h-4 ml-1 mt-1 bg-foreground/80 animate-pulse rounded-sm align-middle shadow-[0_0_8px_rgba(var(--foreground),0.5)]"></span>
                            </>
                          )
                        )}
                        {isThinking && !currentResponse && (
                          <div className="flex items-center space-x-2 text-purple-300/60 pt-1">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
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
                      <div className="max-w-[90%] md:max-w-[85%] rounded-3xl border-2 border-amber-500/40 bg-gradient-to-br from-amber-500/10 via-amber-900/10 to-transparent backdrop-blur-xl shadow-[0_0_30px_rgba(245,158,11,0.15)] overflow-hidden">
                        {/* Header */}
                        <div className="flex items-center space-x-3 px-6 pt-5 pb-3">
                          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30 shadow-lg">
                            <Terminal className="w-5 h-5 text-amber-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-amber-200 tracking-wide">
                              {approval.tool_icon} {approval.tool_label}
                            </div>
                            <div className="text-[11px] text-amber-300/60 mt-0.5 tracking-wide font-medium truncate">
                              {approval.summary}
                            </div>
                          </div>
                          <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 border border-amber-500/30">
                            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(245,158,11,0.8)]"></div>
                            <span className="text-[9px] font-bold text-amber-300 uppercase tracking-[0.15em]">Awaiting Approval</span>
                          </div>
                        </div>
                        
                        {/* Content preview */}
                        <div className="px-6 pb-3">
                          <div className="relative rounded-xl bg-black/40 border border-white/10 overflow-hidden">
                            <pre className={`text-[12px] text-white/80 font-mono leading-relaxed p-4 overflow-x-auto custom-scrollbar whitespace-pre-wrap break-words ${isLong && !isExpanded ? 'max-h-[240px] overflow-y-hidden' : 'max-h-[500px] overflow-y-auto'}`}>
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
                                className="w-full flex items-center justify-center space-x-1.5 py-2 bg-gradient-to-t from-black/80 to-black/20 text-amber-300/80 hover:text-amber-200 text-[11px] font-semibold tracking-wide transition-colors border-t border-white/5"
                              >
                                {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                <span>{isExpanded ? 'Show Less' : `Show Full Content (${detailLines.length} lines)`}</span>
                              </button>
                            )}
                          </div>
                        </div>
                        
                        {/* Action buttons */}
                        <div className="flex items-center space-x-3 px-6 pb-5 pt-1">
                          <button
                            onClick={async () => {
                              try { await submitToolApproval(approval.approval_id, true); } 
                              catch (e) { console.error('Approval submit failed', e); }
                            }}
                            className="flex-1 flex items-center justify-center space-x-2 py-3 rounded-2xl bg-gradient-to-r from-green-500 to-emerald-500 text-white font-bold text-sm tracking-wide hover:scale-[1.02] active:scale-[0.98] transition-all shadow-lg shadow-green-500/25 hover:shadow-green-500/40"
                          >
                            <ShieldCheck className="w-4.5 h-4.5" />
                            <span>Approve</span>
                          </button>
                          <button
                            onClick={async () => {
                              try { await submitToolApproval(approval.approval_id, false, 'User rejected'); } 
                              catch (e) { console.error('Reject submit failed', e); }
                            }}
                            className="flex-1 flex items-center justify-center space-x-2 py-3 rounded-2xl bg-white/5 border border-white/15 text-white/70 font-bold text-sm tracking-wide hover:bg-red-500/15 hover:border-red-500/30 hover:text-red-300 hover:scale-[1.02] active:scale-[0.98] transition-all"
                          >
                            <ShieldX className="w-4.5 h-4.5" />
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
             <div className="absolute inset-0 bg-background/80 rounded-[2.5rem] blur-xl z-0 -m-4 pointer-events-none"></div>
             <div className="relative glass-dark rounded-[2.2rem] flex flex-col p-2 border border-white/10 focus-within:border-accent/40 focus-within:shadow-[0_0_30px_rgba(var(--accent),0.2)] transition-all duration-500 shadow-2xl backdrop-blur-xl">
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
                  className="w-full bg-transparent border-none outline-none px-6 pt-5 pb-3 text-[15px] font-light tracking-wide resize-none min-h-[64px] custom-scrollbar focus:ring-0 text-white/90 placeholder-white/30"
                  rows={1}
                />
                <div className="flex justify-between items-center px-4 pb-2 pt-1 w-full relative">
                   <div className="flex items-center space-x-2 relative">
                     <button 
                       onClick={() => setShowToolSelector(!showToolSelector)}
                       title="Select tools to run"
                       className={`flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                         enabledTools.length > 0 
                          ? 'bg-accent/20 text-accent border-accent/30 shadow-[0_0_10px_rgba(var(--accent),0.2)]' 
                          : 'bg-white/5 text-white/40 border-white/5 hover:bg-white/10 hover:text-white/70'
                       }`}
                     >
                       <Wrench className="w-3.5 h-3.5" />
                       <span>{enabledTools.length} {enabledTools.length === 1 ? 'Tool' : 'Tools'} Enabled</span>
                     </button>
                     
                     {showToolSelector && (
                       <div className="absolute bottom-12 left-0 w-64 glass-dark border border-white/10 rounded-2xl p-4 shadow-[0_0_40px_rgba(0,0,0,0.8)] z-50 flex flex-col space-y-3 animate-fade-in backdrop-blur-3xl">
                         <div className="flex items-center justify-between mb-1">
                           <span className="text-[10px] font-bold text-white/50 uppercase tracking-[0.15em]">Select Integrations</span>
                           <button onClick={() => setShowToolSelector(false)} className="text-white/30 hover:text-white"><X className="w-3.5 h-3.5"/></button>
                         </div>
                         
                         <label className="flex items-center space-x-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-all border border-transparent hover:border-white/5">
                           <input 
                             type="checkbox" 
                             checked={enabledTools.includes("web_search")}
                             onChange={(e) => {
                               if (e.target.checked) setEnabledTools([...enabledTools, "web_search"]);
                               else setEnabledTools(enabledTools.filter(t => t !== "web_search"));
                             }}
                             className="w-4 h-4 text-accent border-white/20 rounded focus:ring-0 focus:ring-offset-0 bg-white/5 cursor-pointer"
                           />
                           <div className="flex flex-col">
                             <span className="text-sm font-medium text-white/90">Simple Web Search</span>
                             <span className="text-[10px] text-white/40 mt-0.5 leading-tight">Fast DuckDuckGo Snippets</span>
                           </div>
                         </label>
                         
                         <label className="flex items-center space-x-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-all border border-transparent hover:border-white/5">
                           <input 
                             type="checkbox" 
                             checked={enabledTools.includes("deep_research")}
                             onChange={(e) => {
                               if (e.target.checked) setEnabledTools([...enabledTools, "deep_research"]);
                               else setEnabledTools(enabledTools.filter(t => t !== "deep_research"));
                             }}
                             className="w-4 h-4 text-purple-400 border-white/20 rounded focus:ring-0 focus:ring-offset-0 bg-white/5 cursor-pointer"
                           />
                           <div className="flex flex-col">
                             <span className="text-sm font-medium text-purple-100">Deep Research Agent</span>
                             <span className="text-[10px] text-purple-300 mt-0.5 leading-tight">Crawls full pages & synthesizes</span>
                           </div>
                         </label>
                         

                          <label className="flex items-center space-x-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-all border border-transparent hover:border-white/5">
                            <input 
                              type="checkbox" 
                              checked={enabledTools.includes("computer_use")}
                              onChange={(e) => {
                                if (e.target.checked) setEnabledTools([...enabledTools, "computer_use"]);
                                else setEnabledTools(enabledTools.filter(t => t !== "computer_use"));
                              }}
                              className="w-4 h-4 text-amber-400 border-white/20 rounded focus:ring-0 focus:ring-offset-0 bg-white/5 cursor-pointer"
                            />
                            <div className="flex flex-col">
                              <span className="text-sm font-medium text-amber-100">Computer Use</span>
                              <span className="text-[10px] text-amber-300/70 mt-0.5 leading-tight">Bash, read/write files &#x2022; Requires approval</span>
                            </div>
                          </label>
                         {mcpServers.length > 0 && <div className="h-px w-full bg-white/5 my-1" />}
                         
                         {mcpServers.map(server => (
                           <label key={server.name} className="flex items-center space-x-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-all border border-transparent hover:border-white/5">
                             <input 
                               type="checkbox" 
                               checked={enabledTools.includes(server.name)}
                               onChange={(e) => {
                                 if (e.target.checked) setEnabledTools([...enabledTools, server.name]);
                                 else setEnabledTools(enabledTools.filter(t => t !== server.name));
                               }}
                               className="w-4 h-4 text-accent border-white/20 rounded focus:ring-0 focus:ring-offset-0 bg-white/5 cursor-pointer"
                             />
                             <div className="flex flex-col">
                               <span className="text-sm font-medium text-white/90">{server.name}</span>
                               <span className="text-[10px] text-white/40 mt-0.5 leading-tight">Connected MCP Connector</span>
                             </div>
                           </label>
                         ))}
                         {mcpServers.length === 0 && (
                            <div className="text-[10px] text-white/30 italic px-2">No custom MCP servers connected.</div>
                         )}
                       </div>
                     )}
                   </div>
                   
                   <div className="absolute right-0 bottom-0 mb-1 mr-1">
                      <button 
                        onClick={handleSend}
                        disabled={isLoading || !input.trim()}
                        className={`p-3.5 rounded-[1.8rem] transition-all duration-300 flex items-center justify-center ${
                            isLoading || !input.trim() 
                            ? 'opacity-30 bg-white/5' 
                            : 'bg-white text-black hover:scale-105 active:scale-95 shadow-lg shadow-white/20'
                        }`}
                      >
                        <svg className="w-5 h-5 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                      </button>
                   </div>
                </div>
             </div>
             <div className="flex justify-center mt-3 pointer-events-none">
                 <p className="inline-flex items-center space-x-2 text-[9px] text-white/30 uppercase tracking-[0.2em] font-bold bg-white/5 px-3 py-1.5 rounded-full border border-white/5 backdrop-blur-sm">
                    <CheckCircle className="w-3 h-3 text-accent" />
                    <span>Dynamic Context & Storage Active</span>
                 </p>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}
