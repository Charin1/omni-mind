'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  ArtifactItem,
  chatStream,
  listArtifacts,
  listProviders,
  listTasks,
  Message,
  TaskItem,
  McpServer,
  McpTool,
  listMcpServers,
  listMcpTools,
  updateConversation,
  deleteConversation,
  createMcpServer
} from '@/lib/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Brain, Search, Clock, FileText, CheckCircle, Orbit, Server, Wrench, MessageSquare, Plus, Settings, Edit3, Trash2, X, UploadCloud } from 'lucide-react';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

interface Conversation {
  id: string;
  title: string;
  provider?: string;
  model?: string;
  updated_at: string;
}

const FALLBACK_PROVIDERS: Record<string, string[]> = {
  openai: ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o4-mini'],
  anthropic: ['claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-preview-09-2025'],
  ollama: ['llama3.2', 'qwen3', 'qwen2.5', 'gemma3', 'mistral'],
};

function getOrCreateUserId() {
  if (typeof window === 'undefined') return 'local-user';
  const existing = window.localStorage.getItem('omnimind-user-id');
  if (existing) return existing;
  const created = window.crypto?.randomUUID?.() || `local-${Date.now()}`;
  window.localStorage.setItem('omnimind-user-id', created);
  return created;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [userId] = useState(getOrCreateUserId);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentResponse, setCurrentResponse] = useState('');
  
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-5-mini');
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const [providerError, setProviderError] = useState('');
  
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');

  const [showMcpModal, setShowMcpModal] = useState(false);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '' });
  const [mcpError, setMcpError] = useState('');
  const [isAddingMcp, setIsAddingMcp] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
      setMessages(data.messages || []);
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
      const configJson = {
        command: mcpForm.command,
        args: mcpForm.args.split(' ').filter(a => a.trim()),
      };
      await createMcpServer({
        id: `mcp-${Date.now()}`,
        name: mcpForm.name,
        transport: 'stdio',
        config_json: configJson
      });
      setShowMcpModal(false);
      setMcpForm({ name: '', command: '', args: '' });
      setMcpServers(await listMcpServers().catch(() => []));
    } catch (err: any) {
      setMcpError(err.message || 'Failed to add server');
    }
    setIsAddingMcp(false);
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || !userId) return;
    
    let currentId = activeConvId;
    if (!currentId) {
       const res = await fetch(`${API_BASE_URL}/api/conversations`, {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({title: input.slice(0, 20) + '...', user_id: userId})
       });
       const newConv = await res.json();
       currentId = newConv.id;
       setActiveConvId(currentId);
       setConversations([newConv, ...conversations]);
    }

    const userMessage: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setCurrentResponse('');

    let streamed = '';

    await chatStream({
      conversationId: currentId as string,
      userId,
      message: input,
      provider,
      model,
      history: messages,
      onChunk: (chunk) => {
        streamed += chunk;
        setCurrentResponse(streamed);
      },
      onDone: () => {
        const finalAnswer = streamed;
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: finalAnswer }
        ]);
        setCurrentResponse('');
        setIsLoading(false);
        listArtifacts(userId, currentId || undefined).then(setArtifacts).catch(() => {});
        listTasks(userId).then(setTasks).catch(() => {});
      },
      onError: (err) => {
        console.error('Chat error:', err);
        setIsLoading(false);
      }
    });
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
                  onClick={() => {
                    setProvider(providerName);
                    const nextModels = providerOptions[providerName] || [];
                    if (nextModels.length > 0) setModel(nextModels[0]);
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
            <select
              value={model}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-white/5 p-2 text-xs outline-none transition-all focus:border-accent/50 focus:ring-1 focus:ring-accent/50 text-white/80"
            >
              {modelOptions.map((modelName: string) => (
                <option key={modelName} value={modelName} className="bg-[#121418]">
                  {modelName}
                </option>
              ))}
            </select>
            {providerError ? (
              <p className="text-[10px] text-red-400/80">{providerError}</p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative bg-background/50 overflow-hidden min-w-0">
        {/* Background Decorative Gradients */}
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/20 rounded-full blur-[120px] -mr-40 -mt-40 z-0 pointer-events-none"></div>
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-accent/10 rounded-full blur-[100px] -ml-40 -mb-40 z-0 pointer-events-none"></div>

        {/* Header */}
        <header className="h-16 border-b border-white/5 flex flex-shrink-0 items-center justify-between px-8 glass-dark z-10 backdrop-blur-md">
          <div className="flex items-center space-x-3">
            <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-accent animate-pulse shadow-[0_0_10px_rgba(255,255,255,0.3)]' : 'bg-green-500/80 shadow-[0_0_8px_rgba(34,197,94,0.6)]'}`}></div>
            <span className="text-xs font-semibold tracking-wider text-white/70 uppercase">
                {isLoading ? 'Processing...' : 'Ready'}
            </span>
          </div>
          
          <div className="flex items-center space-x-6">
            <div className="flex flex-col items-end">
                <span className="text-[10px] text-white/40 uppercase tracking-[0.2em] font-bold">Context</span>
                <div className="h-1.5 w-32 bg-white/5 rounded-full mt-1 overflow-hidden border border-white/10">
                  <div className="h-full bg-gradient-to-r from-accent to-primary w-2/3 transition-all"></div>
                </div>
            </div>
            <div className="p-2 hover:bg-white/10 rounded-xl cursor-pointer transition-all border border-transparent hover:border-white/20">
                <Settings className="w-4 h-4 text-white/60 hover:text-white" />
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 pb-8 custom-scrollbar z-10 w-full flex flex-col items-center">
          <div className="max-w-4xl w-full flex-1 flex flex-col">
            {messages.length === 0 && !isLoading ? (
              <div className="flex-1 flex flex-col items-center justify-center space-y-6 opacity-40 select-none pb-12">
                <div className="w-24 h-24 rounded-3xl glass flex items-center justify-center text-4xl shadow-[0_0_30px_rgba(var(--accent),0.1)] border border-foreground/10">
                  <Orbit className="w-12 h-12 text-foreground/80" />
                </div>
                <div className="text-center space-y-3">
                    <p className="text-3xl font-extralight tracking-[0.15em] bg-clip-text text-transparent bg-gradient-to-b from-foreground to-foreground/50">OmniMind</p>
                    <p className="text-xs text-foreground/50 uppercase tracking-[0.3em] font-semibold">Universal Intelligence Engine</p>
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {messages.map((m: Message, i: number) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
                    <div className={`max-w-[90%] md:max-w-[85%] px-6 py-5 rounded-3xl ${
                        m.role === 'user' 
                        ? 'bg-gradient-to-br from-primary/80 to-accent/80 text-primary-foreground shadow-xl shadow-primary/10' 
                        : 'glass-dark border border-foreground/10 prose prose-invert prose-p:leading-relaxed prose-pre:bg-background/50 prose-pre:border prose-pre:border-foreground/10 prose-a:text-accent prose-a:no-underline hover:prose-a:underline'
                    }`}>
                      {m.role === 'user' ? (
                         <div className="text-[15px] font-medium leading-relaxed whitespace-pre-wrap tracking-wide">{m.content}</div>
                      ) : (
                         <div className="text-[14px] leading-relaxed font-light tracking-wide markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                         </div>
                      )}
                    </div>
                  </div>
                ))}
                
                {currentResponse && (
                  <div className="flex justify-start animate-fade-in">
                    <div className="max-w-[80%] px-6 py-5 rounded-3xl glass-dark border border-foreground/10 prose prose-invert prose-p:leading-relaxed prose-pre:bg-background/50 prose-pre:border prose-pre:border-foreground/10 prose-a:text-accent prose-a:no-underline">
                      <div className="text-[14px] leading-relaxed font-light tracking-wide markdown-body relative">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentResponse}</ReactMarkdown>
                        <span className="inline-block w-2.5 h-4 ml-1 mt-1 bg-foreground/80 animate-pulse rounded-sm align-middle shadow-[0_0_8px_rgba(var(--foreground),0.5)]"></span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} className="h-4" />
              </div>
            )}
          </div>
        </div>

        {/* Input area */}
        <div className="p-4 md:p-6 pt-0 z-20 shrink-0">
          <div className="max-w-4xl mx-auto relative w-full">
             <div className="absolute inset-0 bg-background/80 rounded-[2.5rem] blur-xl z-0 -m-4 pointer-events-none"></div>
             <div className="relative glass-dark rounded-[2.2rem] flex items-end p-2 border border-white/10 focus-within:border-accent/40 focus-within:shadow-[0_0_30px_rgba(var(--accent),0.2)] transition-all duration-500 shadow-2xl backdrop-blur-xl">
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
                  className="flex-1 bg-transparent border-none outline-none px-6 py-5 text-[15px] font-light tracking-wide resize-none h-[64px] custom-scrollbar focus:ring-0 text-white/90 placeholder-white/30"
                  rows={1}
                />
                <button 
                  onClick={handleSend}
                  disabled={isLoading || !input.trim()}
                  className={`m-1.5 p-4 rounded-[1.8rem] transition-all duration-300 flex items-center justify-center ${
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
