import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Send,
  Terminal,
  ShieldAlert,
  CheckCircle,
  XCircle,
  Plus,
  Trash2,
  ExternalLink,
  MessageSquare,
  Clock,
  ChevronLeft,
  ChevronRight,
  Activity,
  Layers,
  Rocket,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Play,
  Globe,
  Key,
  Download,
  Cpu,
  Sliders,
  Zap
} from 'lucide-react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  intent?: {
    choice: string;
    confidence: number;
    riskLevel: 'SAFE' | 'CAUTION' | 'DESTRUCTIVE';
    evaluationFactors?: string[];
  };
  interactivePrompt?: {
    id: string;
    type: 'permission_request' | 'variable_request';
    title: string;
    action: string;
    target: string;
    details: string;
    riskLevel: 'SAFE' | 'CAUTION' | 'DESTRUCTIVE';
    confidence: number;
    deploymentId?: string;
    projectId?: string;
    repoUrl?: string;
    missingVariables?: Array<{
      key: string;
      description: string;
      defaultValue?: string;
      type: string;
    }>;
    requiredTools?: Array<{
      name: string;
      purpose: string;
      commandOrPackage: string;
    }>;
    accessMode?: 'ASK' | 'AUTO';
  };
  actionResult?: {
    action: string;
    success: boolean;
    output?: any;
    error?: string;
  };
  deploymentStream?: {
    deploymentId: string;
    repoUrl: string;
    subdomain?: string;
  };
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface AIChatConsoleProps {
  apiBase: string;
  wsBase: string;
  onRefreshData?: () => void;
}

const DEFAULT_WELCOME: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content: `Hello! I am **DeployMind AI**, powered by **TypeSafe Jev** (System 1 fast decision engine) and **ChatGPT** (System 2 conversational reasoning).

Ask me anything or give natural commands:
- 🚀 *"Deploy https://github.com/webadderallorg/Recordly"* *(I will stream live progress directly in chat)*
- 📋 *"Show me logs for recordly"*
- ⚡ *"Stop service web"* or *"Start service web"*
- 🗑️ *"Delete project recordly"* *(Requires interactive permission)*
- 📊 *"What services and routes are currently active?"*`,
  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
};

// Sub-component: Live Real-Time Deployment Streamer inside Chat Bubble
const LiveDeploymentStreamer: React.FC<{
  deploymentId: string;
  repoUrl: string;
  subdomain?: string;
  wsBase: string;
  apiBase: string;
  onComplete?: () => void;
}> = ({ deploymentId, repoUrl, subdomain, wsBase, apiBase, onComplete }) => {
  const [logs, setLogs] = useState<Array<{ stage: string; message: string; level: string }>>([]);
  const [status, setStatus] = useState<'deploying' | 'healthy' | 'failed'>('deploying');
  const targetAppUrl = subdomain ? (subdomain.startsWith('http') ? subdomain : `http://${subdomain}`) : null;
  const [liveUrl, setLiveUrl] = useState<string | null>(targetAppUrl);
  const logTerminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initial fetch to check current status if already deployed
    fetch(`${apiBase}/api/deployments/${deploymentId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.status === 'healthy') {
          setStatus('healthy');
          if (data.plan?.suggestedSubdomain) {
            const sub = data.plan.suggestedSubdomain;
            setLiveUrl(sub.startsWith('http') ? sub : `http://${sub}`);
          }
        }
      })
      .catch(() => {});

    const wsUrl = `${wsBase}/ws/logs?deploymentId=${deploymentId}`;
    let socket: WebSocket | null = null;

    try {
      socket = new WebSocket(wsUrl);

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.message) {
            setLogs((prev) => [...prev, { stage: data.stage || 'deploy', message: data.message, level: data.level || 'info' }]);
            
            if (data.message.includes('Deployment complete') || data.level === 'success') {
              setStatus('healthy');
              const match = data.message.match(/https?:\/\/[^\s)]+/);
              if (match) setLiveUrl(match[0]);
              if (onComplete) onComplete();
            } else if (data.level === 'error') {
              setStatus('failed');
            }
          }
        } catch {
          // ignore
        }
      };

      socket.onerror = () => {
        // Fallback or retry
      };
    } catch {
      // ignore
    }

    return () => {
      if (socket) socket.close();
    };
  }, [deploymentId, wsBase, apiBase]);

  useEffect(() => {
    logTerminalRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Derive current pipeline stage
  const lastLog = logs[logs.length - 1];
  const currentStage = lastLog?.stage || 'analyze';
  const effectiveUrl = liveUrl || targetAppUrl;

  return (
    <div className="mt-3.5 bg-slate-950 border border-emerald-900/50 rounded-xl overflow-hidden shadow-lg">
      {/* Streamer Header */}
      <div className="bg-slate-900/90 px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          {status === 'deploying' ? (
            <Loader2 className="h-4 w-4 text-emerald-400 animate-spin" />
          ) : status === 'healthy' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-400" />
          )}
          <span className="font-semibold text-xs text-white">
            {status === 'deploying' ? 'Deploying in Real-Time' : status === 'healthy' ? 'Deployment Live' : 'Deployment Alert'}
          </span>
          <span className="text-[10px] font-mono text-slate-400 truncate max-w-[200px]">{repoUrl}</span>
        </div>

        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
            status === 'healthy'
              ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
              : status === 'failed'
              ? 'bg-red-950 text-red-400 border-red-800'
              : 'bg-emerald-950 text-emerald-300 border-emerald-800/60 animate-pulse'
          }`}
        >
          {status === 'healthy' ? 'ONLINE' : status === 'deploying' ? `STAGE: ${currentStage.toUpperCase()}` : 'FAILED'}
        </span>
      </div>

      {/* Target & Live Application URL Banner */}
      <div className="px-3.5 py-2 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-2 truncate mr-2">
          <Globe className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span className="text-[10px] font-mono text-slate-400 shrink-0">
            {status === 'healthy' ? 'Application URL:' : 'Target Hostname:'}
          </span>
          {effectiveUrl ? (
            <a
              href={effectiveUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-mono font-bold text-emerald-400 hover:text-emerald-300 underline truncate flex items-center space-x-1"
            >
              <span>{effectiveUrl}</span>
              <ExternalLink className="h-3 w-3 inline ml-1 shrink-0" />
            </a>
          ) : (
            <span className="text-xs font-mono text-slate-500">Detecting...</span>
          )}
        </div>

        {status === 'healthy' && effectiveUrl && (
          <a
            href={effectiveUrl}
            target="_blank"
            rel="noreferrer"
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium px-2.5 py-1 rounded flex items-center space-x-1 transition shadow shrink-0"
          >
            <span>Open Application</span>
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Stepper Indicator */}
      <div className="px-3.5 py-2 bg-slate-900/40 border-b border-slate-800/80 flex items-center justify-between text-[10px] font-mono text-slate-400">
        <span className={logs.some(l => l.stage === 'analyze') || status === 'healthy' ? 'text-emerald-400 font-bold' : ''}>1. Analyze</span>
        <span>→</span>
        <span className={logs.some(l => l.stage === 'plan') || status === 'healthy' ? 'text-emerald-400 font-bold' : ''}>2. Jev Plan</span>
        <span>→</span>
        <span className={logs.some(l => l.stage === 'build') || status === 'healthy' ? 'text-emerald-400 font-bold' : ''}>3. Docker</span>
        <span>→</span>
        <span className={logs.some(l => l.stage === 'deploy') || status === 'healthy' ? 'text-emerald-400 font-bold' : ''}>4. Container</span>
        <span>→</span>
        <span className={logs.some(l => l.stage === 'route') || status === 'healthy' ? 'text-emerald-400 font-bold' : ''}>5. Ingress</span>
      </div>

      {/* Real-time Streaming Terminal */}
      <div className="p-3 font-mono text-[11px] max-h-48 overflow-y-auto space-y-1 bg-black/80">
        {logs.length === 0 ? (
          <div className="text-slate-500 italic flex items-center space-x-1.5">
            {status === 'healthy' ? (
              <span className="text-emerald-400">✅ Deployment verified healthy and operational.</span>
            ) : (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-emerald-500" />
                <span>Connecting to real-time deployment stream...</span>
              </>
            )}
          </div>
        ) : (
          logs.map((l, i) => (
            <div key={i} className="flex items-start space-x-2 leading-relaxed">
              <span className="text-slate-500 select-none">[{l.stage}]</span>
              <span
                className={
                  l.level === 'error'
                    ? 'text-red-400'
                    : l.level === 'warn'
                    ? 'text-amber-400'
                    : l.level === 'success'
                    ? 'text-emerald-300 font-semibold'
                    : 'text-slate-300'
                }
              >
                {l.message}
              </span>
            </div>
          ))
        )}
        <div ref={logTerminalRef} />
      </div>

      {/* Completed Live Subdomain Card */}
      {status === 'healthy' && effectiveUrl && (
        <div className="p-3 bg-emerald-950/70 border-t border-emerald-800 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <div>
              <span className="text-[10px] uppercase font-mono text-emerald-400 block font-semibold">Service Online & Ready</span>
              <a
                href={effectiveUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-mono font-bold text-white hover:underline hover:text-emerald-300 flex items-center space-x-1"
              >
                <span>{effectiveUrl}</span>
                <ExternalLink className="h-3.5 w-3.5 ml-1 text-emerald-400 inline" />
              </a>
            </div>
          </div>
          <a
            href={effectiveUrl}
            target="_blank"
            rel="noreferrer"
            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center space-x-1.5 transition shadow-md"
          >
            <span>Launch Web App</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}
    </div>
  );
};

// Sub-component: Claude Code Interactive Permission & Variable Configuration Card
const InteractiveConfigCard: React.FC<{
  prompt: ChatMessage['interactivePrompt'];
  messageId: string;
  onConfirm: (
    promptId: string,
    approved: boolean,
    messageId: string,
    variables?: Record<string, string>,
    enableAutoMode?: boolean
  ) => void;
  loading: boolean;
}> = ({ prompt, messageId, onConfirm, loading }) => {
  if (!prompt) return null;

  // 1. Destructive permission guardrail card (DELETE_PROJECT, etc.)
  if (prompt.type === 'permission_request') {
    return (
      <div className="mt-3.5 bg-red-950/40 border border-red-800/80 rounded-lg p-3 space-y-2.5">
        <div className="flex items-start space-x-2">
          <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-red-200 text-xs">{prompt.title}</h4>
            <p className="text-[11px] text-red-300/90 mt-0.5">{prompt.details}</p>
          </div>
        </div>

        <div className="flex items-center space-x-2 pt-1 border-t border-red-900/60">
          <button
            onClick={() => onConfirm(prompt.id, true, messageId)}
            disabled={loading}
            className="bg-red-600 hover:bg-red-500 text-white font-medium px-3 py-1.5 rounded text-[11px] flex items-center space-x-1 transition"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            <span>Approve & Execute</span>
          </button>
          <button
            onClick={() => onConfirm(prompt.id, false, messageId)}
            disabled={loading}
            className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-3 py-1.5 rounded text-[11px] flex items-center space-x-1 border border-slate-700 transition"
          >
            <XCircle className="h-3.5 w-3.5" />
            <span>Cancel Action</span>
          </button>
        </div>
      </div>
    );
  }

  // 2. Pre-deployment variable configuration and tool approval card
  const [variables, setVariables] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    prompt.missingVariables?.forEach((v) => {
      initial[v.key] = v.defaultValue || '';
    });
    return initial;
  });

  const [enableAuto, setEnableAuto] = useState<boolean>(false);

  const handleInputChange = (key: string, val: string) => {
    setVariables((prev) => ({ ...prev, [key]: val }));
  };

  const handleApprove = () => {
    onConfirm(prompt.id, true, messageId, variables, enableAuto);
  };

  const handleCancel = () => {
    onConfirm(prompt.id, false, messageId);
  };

  return (
    <div className="mt-3.5 bg-slate-900/95 border border-emerald-700/80 rounded-xl p-4 space-y-4 shadow-2xl">
      <div className="flex items-start justify-between border-b border-slate-800 pb-3">
        <div className="flex items-start space-x-2.5">
          <div className="p-1.5 bg-emerald-950 rounded-lg border border-emerald-600/60 text-emerald-400">
            <Sliders className="h-4 w-4" />
          </div>
          <div>
            <h4 className="font-semibold text-white text-xs flex items-center space-x-2">
              <span>{prompt.title}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-800 font-semibold">
                Action Required
              </span>
            </h4>
            <p className="text-[11px] text-slate-300 mt-0.5 leading-relaxed">{prompt.details}</p>
          </div>
        </div>
      </div>

      {/* Missing Required Keys Section */}
      {prompt.missingVariables && prompt.missingVariables.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center space-x-1.5 text-xs font-semibold text-emerald-400">
            <Key className="h-3.5 w-3.5" />
            <span>Required Environment Keys & Configuration ({prompt.missingVariables.length})</span>
          </div>
          <p className="text-[11px] text-slate-400">
            These dependencies are required for the project to operate properly. Values entered will be securely saved into the Vault:
          </p>
          <div className="space-y-2">
            {prompt.missingVariables.map((v) => (
              <div key={v.key} className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-emerald-300 font-bold">{v.key}</span>
                  <span className="text-[9px] uppercase font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                    {v.type === 'EXTERNAL_REQUIRED' ? 'Required' : 'Configurable'}
                  </span>
                </div>
                {v.description && (
                  <p className="text-[10px] text-slate-400 italic">{v.description}</p>
                )}
                <input
                  type="text"
                  value={variables[v.key] ?? ''}
                  onChange={(e) => handleInputChange(v.key, e.target.value)}
                  placeholder={`Enter value for ${v.key}...`}
                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded px-2.5 py-1.5 text-xs text-white font-mono placeholder:text-slate-600 outline-none transition"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool Dependencies to Download Section */}
      {prompt.requiredTools && prompt.requiredTools.length > 0 && (
        <div className="space-y-2.5 pt-2 border-t border-slate-800/80">
          <div className="flex items-center space-x-1.5 text-xs font-semibold text-blue-400">
            <Download className="h-3.5 w-3.5" />
            <span>Dependencies & Tools to Download ({prompt.requiredTools.length})</span>
          </div>
          <p className="text-[11px] text-slate-400">
            DeployMind detected external tools and application dependencies needed by this project:
          </p>
          <div className="space-y-2">
            {prompt.requiredTools.map((t, idx) => (
              <div key={idx} className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Cpu className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <span className="font-semibold text-xs text-slate-200">{t.name}</span>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-900 text-blue-300 border border-slate-700">
                    {t.commandOrPackage}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 pl-5 leading-relaxed">
                  <span className="text-slate-500 font-medium">Why needed:</span> {t.purpose}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Auto Full Access Checkbox */}
      <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800 flex items-start space-x-2.5">
        <input
          type="checkbox"
          id={`auto-mode-${prompt.id}`}
          checked={enableAuto}
          onChange={(e) => setEnableAuto(e.target.checked)}
          className="mt-0.5 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
        />
        <label htmlFor={`auto-mode-${prompt.id}`} className="text-[11px] text-slate-300 cursor-pointer select-none">
          <span className="font-semibold text-white flex items-center space-x-1">
            <Zap className="h-3 w-3 text-amber-400 inline" />
            <span>Enable AUTO Mode (Full Access)</span>
          </span>
          <span className="text-slate-400 block mt-0.5">
            Automatically download and install dependencies for future deployments without asking for approval.
          </span>
        </label>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-800">
        <button
          onClick={handleCancel}
          disabled={loading}
          className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-3.5 py-1.5 rounded-lg text-xs flex items-center space-x-1.5 transition border border-slate-700"
        >
          <XCircle className="h-3.5 w-3.5" />
          <span>Cancel</span>
        </button>

        <button
          onClick={handleApprove}
          disabled={loading}
          className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold px-4 py-1.5 rounded-lg text-xs flex items-center space-x-1.5 transition shadow-lg"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          <span>Approve & Deploy</span>
        </button>
      </div>
    </div>
  );
};

export const AIChatConsole: React.FC<AIChatConsoleProps> = ({ apiBase, wsBase, onRefreshData }) => {
  // 1. Persistent Multi-Chat Sessions State from localStorage
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('deploymind_chat_sessions');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
      } catch {
        // ignore
      }
    }
    return [
      {
        id: 'session_default',
        title: 'New Conversation',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [DEFAULT_WELCOME],
      },
    ];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const savedId = localStorage.getItem('deploymind_active_chat_id');
      if (savedId) return savedId;
    }
    return 'session_default';
  });

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('deploymind_chat_sessions', JSON.stringify(sessions));
      localStorage.setItem('deploymind_active_chat_id', activeSessionId);
    } catch {
      // ignore
    }
  }, [sessions, activeSessionId]);

  // Find active session
  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0] || {
    id: 'fallback',
    title: 'New Conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [DEFAULT_WELCOME],
  };

  const currentMessages = activeSession.messages;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentMessages, loading]);

  // Create a brand new chat session
  const handleCreateNewChat = () => {
    const newSessionId = `session_${Date.now()}`;
    const newSession: ChatSession = {
      id: newSessionId,
      title: 'New Conversation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [
        {
          ...DEFAULT_WELCOME,
          id: `welcome_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ],
    };

    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSessionId);
    setInput('');
  };

  // Delete an old chat session
  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sessions.length <= 1) {
      handleCreateNewChat();
      setSessions((prev) => prev.filter((s) => s.id !== id));
      return;
    }

    const filtered = sessions.filter((s) => s.id !== id);
    setSessions(filtered);
    if (activeSessionId === id) {
      setActiveSessionId(filtered[0]?.id || 'session_default');
    }
  };

  // Send message
  const handleSendMessage = async (customMessage?: string) => {
    const textToSend = customMessage || input;
    if (!textToSend.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: `usr_${Date.now()}`,
      role: 'user',
      content: textToSend.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    // Auto-update session title from first user message
    let sessionTitle = activeSession.title;
    if (activeSession.title === 'New Conversation') {
      sessionTitle = textToSend.trim().length > 30 ? textToSend.trim().slice(0, 30) + '...' : textToSend.trim();
    }

    // Update session with user message immediately
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id === activeSessionId) {
          return {
            ...s,
            title: sessionTitle,
            updatedAt: Date.now(),
            messages: [...s.messages, userMsg],
          };
        }
        return s;
      })
    );

    if (!customMessage) setInput('');
    setLoading(true);

    try {
      const adminToken = localStorage.getItem('deploymind_admin_token');
      const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminToken) {
        chatHeaders['Authorization'] = `Bearer ${adminToken}`;
      }

      const res = await fetch(`${apiBase}/api/ai/chat`, {
        method: 'POST',
        headers: chatHeaders,
        credentials: 'include',
        body: JSON.stringify({
          message: textToSend.trim(),
          history: currentMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Check if response initiated a live deployment
      let deploymentStream: ChatMessage['deploymentStream'] = undefined;
      if (data.actionResult?.action === 'DEPLOY' && data.actionResult?.output?.deploymentId) {
        deploymentStream = {
          deploymentId: data.actionResult.output.deploymentId,
          repoUrl: data.actionResult.output.repoUrl,
          subdomain: data.actionResult.output.subdomain,
        };
      }

      const aiMsg: ChatMessage = {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: data.message,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        intent: data.intent,
        interactivePrompt: data.interactivePrompt,
        actionResult: data.actionResult,
        deploymentStream,
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              updatedAt: Date.now(),
              messages: [...s.messages, aiMsg],
            };
          }
          return s;
        })
      );

      if (onRefreshData) onRefreshData();
    } catch (err: any) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: [
                ...s.messages,
                {
                  id: `err_${Date.now()}`,
                  role: 'assistant',
                  content: `⚠️ Failed to process command: ${err.message}`,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                },
              ],
            };
          }
          return s;
        })
      );
    } finally {
      setLoading(false);
    }
  };

  const [accessMode, setAccessMode] = useState<'ASK' | 'AUTO'>('ASK');

  useEffect(() => {
    fetch(`${apiBase}/api/system/settings`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.accessMode) setAccessMode(d.accessMode);
      })
      .catch(() => {});
  }, [apiBase]);

  const toggleAccessMode = async () => {
    const nextMode = accessMode === 'ASK' ? 'AUTO' : 'ASK';
    try {
      const res = await fetch(`${apiBase}/api/system/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessMode: nextMode }),
      });
      const d = await res.json();
      if (d?.accessMode) setAccessMode(d.accessMode);
    } catch {
      // ignore
    }
  };

  // Interactive Confirmation (Approve / Deny + Variables + Auto Mode)
  const handleConfirmPrompt = async (
    promptId: string,
    approved: boolean,
    messageId: string,
    variables?: Record<string, string>,
    enableAutoMode?: boolean
  ) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/ai/chat/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, approved, variables, enableAutoMode }),
      });

      const data = await res.json();

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id === activeSessionId) {
            return {
              ...s,
              messages: s.messages.map((m) => {
                if (m.id === messageId) {
                  return {
                    ...m,
                    interactivePrompt: undefined,
                    deploymentStream: data.deploymentStream || m.deploymentStream,
                    content: `${m.content}\n\n${approved ? '✅ **Action Approved**:' : '❌ **Action Cancelled**:'} ${data.message}`,
                  };
                }
                return m;
              }),
            };
          }
          return s;
        })
      );

      if (enableAutoMode) {
        setAccessMode('AUTO');
      }

      if (onRefreshData) onRefreshData();
    } catch (err: any) {
      alert(`Error processing confirmation: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-[760px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
      {/* LEFT: Persistent Chat History Sidebar */}
      <div
        className={`${
          sidebarOpen ? 'w-64' : 'w-0'
        } transition-all duration-200 ease-in-out bg-slate-950 border-r border-slate-800 flex flex-col shrink-0 overflow-hidden`}
      >
        {/* New Chat Button */}
        <div className="p-3 border-b border-slate-800">
          <button
            onClick={handleCreateNewChat}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs py-2.5 px-3 rounded-lg flex items-center justify-center space-x-2 transition shadow-sm"
          >
            <Plus className="h-4 w-4" />
            <span>New Chat</span>
          </button>
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="text-[10px] uppercase font-mono text-slate-500 px-2 py-1 font-semibold">
            Recent Conversations
          </div>

          {sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                onClick={() => setActiveSessionId(s.id)}
                className={`group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer text-xs transition ${
                  isActive
                    ? 'bg-slate-800/90 text-white font-medium border border-slate-700/80'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <div className="flex items-center space-x-2 truncate mr-1.5">
                  <MessageSquare className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span className="truncate text-xs">{s.title}</span>
                </div>

                <button
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-1 text-slate-500 rounded transition"
                  title="Delete chat"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Sidebar Footer */}
        <div className="p-3 border-t border-slate-800/80 text-[11px] text-slate-500 flex items-center justify-between font-mono">
          <span>TypeSafe Jev + GPT-4o</span>
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
        </div>
      </div>

      {/* RIGHT: Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-900">
        {/* Top Header Bar */}
        <div className="bg-slate-950 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-slate-400 hover:text-white p-1 hover:bg-slate-800 rounded transition"
              title={sidebarOpen ? 'Collapse chat history' : 'Open chat history'}
            >
              {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            <div className="flex items-center space-x-2">
              <span className="font-semibold text-sm text-white truncate max-w-[240px]">
                {activeSession.title}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-[10px] text-emerald-400 font-mono hidden sm:inline">
                Persistent Chat
              </span>
            </div>
          </div>

          {/* Header Actions: Mode Toggle & Quick Commands */}
          <div className="flex items-center space-x-2">
            {/* Access Mode Toggle Badge */}
            <button
              onClick={toggleAccessMode}
              className={`text-[11px] font-mono px-2.5 py-1 rounded-full border transition flex items-center space-x-1.5 shadow-sm cursor-pointer select-none ${
                accessMode === 'AUTO'
                  ? 'bg-amber-950/80 border-amber-600 text-amber-300 hover:bg-amber-900/80'
                  : 'bg-emerald-950/80 border-emerald-600 text-emerald-300 hover:bg-emerald-900/80'
              }`}
              title="Click to toggle between ASK Mode (requires manual approval for tools) and AUTO Mode (automatic download & full access)"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  accessMode === 'AUTO' ? 'bg-amber-400' : 'bg-emerald-400'
                } animate-pulse`}
              />
              <span className="font-semibold">{accessMode === 'AUTO' ? '⚡ AUTO Mode' : '🛡️ ASK Mode'}</span>
            </button>

            <button
              onClick={() => handleSendMessage('Deploy https://github.com/webadderallorg/Recordly')}
              className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded border border-slate-700 flex items-center space-x-1 transition"
            >
              <Rocket className="h-3 w-3 text-emerald-400" />
              <span>Deploy Recordly</span>
            </button>
            <button
              onClick={() => handleSendMessage('Show me active system status and health')}
              className="hidden md:flex text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
            >
              System Health
            </button>
          </div>
        </div>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 font-sans text-xs">
          {currentMessages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col ${
                m.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div className="flex items-center space-x-1.5 mb-1 px-1">
                <span className="text-[10px] font-mono text-slate-400">
                  {m.role === 'user' ? 'You' : 'DeployMind AI'}
                </span>
                <span className="text-[10px] text-slate-500">• {m.timestamp}</span>
                {m.intent && (
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.2 rounded border ${
                      m.intent.riskLevel === 'DESTRUCTIVE'
                        ? 'bg-red-950 text-red-400 border-red-800'
                        : m.intent.riskLevel === 'CAUTION'
                        ? 'bg-amber-950 text-amber-400 border-amber-800'
                        : 'bg-emerald-950 text-emerald-400 border-emerald-800'
                    }`}
                  >
                    Jev: {m.intent.choice} ({Math.round(m.intent.confidence * 100)}%)
                  </span>
                )}
              </div>

              <div
                className={`max-w-[85%] rounded-xl p-3.5 leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'bg-slate-950 border border-slate-800 text-slate-200 shadow-sm'
                }`}
              >
                <div className="whitespace-pre-wrap space-y-2">
                  {m.content}
                </div>

                {/* Claude Code Interactive Configuration & Permission Card */}
                {m.interactivePrompt && (
                  <InteractiveConfigCard
                    prompt={m.interactivePrompt}
                    messageId={m.id}
                    onConfirm={handleConfirmPrompt}
                    loading={loading}
                  />
                )}

                {/* Real-time Streaming Deployment Widget */}
                {m.deploymentStream && (
                  <LiveDeploymentStreamer
                    deploymentId={m.deploymentStream.deploymentId}
                    repoUrl={m.deploymentStream.repoUrl}
                    subdomain={m.deploymentStream.subdomain}
                    wsBase={wsBase}
                    apiBase={apiBase}
                    onComplete={onRefreshData}
                  />
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center space-x-2 text-slate-400 py-2 px-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400" />
              <span className="text-xs font-mono">
                Classifying intent with TypeSafe Jev & executing pipeline...
              </span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="bg-slate-950 p-3 border-t border-slate-800 flex items-center space-x-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder="Talk with DeployMind AI: 'Deploy https://...', 'Show logs', 'Stop service web'..."
            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            disabled={loading}
          />
          <button
            onClick={() => handleSendMessage()}
            disabled={loading || !input.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-lg text-xs font-medium flex items-center space-x-1.5 disabled:opacity-50 transition shadow"
          >
            <Send className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Send</span>
          </button>
        </div>
      </div>
    </div>
  );
};
