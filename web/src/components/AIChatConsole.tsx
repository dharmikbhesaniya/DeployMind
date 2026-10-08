import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Send,
  Terminal,
  ShieldAlert,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  RotateCw,
  Cpu,
  Play,
  Square,
  Trash2,
  ExternalLink,
  MessageSquare
} from 'lucide-react';

interface ChatMessage {
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
  };
  actionResult?: {
    action: string;
    success: boolean;
    output?: any;
    error?: string;
  };
}

interface AIChatConsoleProps {
  apiBase: string;
  onRefreshData?: () => void;
}

export const AIChatConsole: React.FC<AIChatConsoleProps> = ({ apiBase, onRefreshData }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Hello! I am **DeployMind AI**, powered by **TypeSafe Jev** (fast decision engine) and **ChatGPT** (conversational reasoning).

Ask me anything or give me natural commands like:
- 🚀 *"Deploy https://github.com/webadderallorg/Recordly"*
- 📋 *"Show me logs for recordly"*
- ⚡ *"Stop service web"* or *"Start service web"*
- 🗑️ *"Delete project recordly"* *(I will ask permission before deleting)*
- 📊 *"What services and routes are currently active?"*`,
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleSendMessage = async (customMessage?: string) => {
    const textToSend = customMessage || input;
    if (!textToSend.trim() || loading) return;

    const userMsg: ChatMessage = {
      id: `usr_${Date.now()}`,
      role: 'user',
      content: textToSend.trim(),
      timestamp: new Date().toLocaleTimeString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!customMessage) setInput('');
    setLoading(true);

    try {
      const res = await fetch(`${apiBase}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend.trim(),
          history: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const aiMsg: ChatMessage = {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: data.message,
        timestamp: new Date().toLocaleTimeString(),
        intent: data.intent,
        interactivePrompt: data.interactivePrompt,
        actionResult: data.actionResult,
      };

      setMessages((prev) => [...prev, aiMsg]);
      if (onRefreshData) onRefreshData();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ Failed to process command: ${err.message}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPrompt = async (promptId: string, approved: boolean, messageId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/ai/chat/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, approved }),
      });

      const data = await res.json();

      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === messageId) {
            return {
              ...m,
              interactivePrompt: undefined, // remove prompt once decided
              content: `${m.content}\n\n${approved ? '✅ **Action Approved & Executed**:' : '❌ **Action Denied**:'} ${data.message}`,
            };
          }
          return m;
        })
      );

      if (onRefreshData) onRefreshData();
    } catch (err: any) {
      alert(`Error processing confirmation: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex flex-col h-[750px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
      {/* Top Console Bar */}
      <div className="bg-slate-950 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="h-7 w-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-semibold text-sm text-white">DeployMind AI Assistant</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-[10px] text-emerald-400 font-mono">
                Jev (System 1) + ChatGPT (System 2)
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Claude Code-style conversational systems manager</p>
          </div>
        </div>

        {/* Quick Command Suggestions */}
        <div className="hidden md:flex items-center space-x-2">
          <button
            onClick={() => handleSendMessage('Show me active system status and health')}
            className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
          >
            Status Check
          </button>
          <button
            onClick={() => handleSendMessage('Show me recent logs for all running services')}
            className="text-[11px] px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 transition"
          >
            Tailing Logs
          </button>
        </div>
      </div>

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 font-sans text-xs">
        {messages.map((m) => (
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

              {/* Claude Code Interactive Permission Guardrail Card */}
              {m.interactivePrompt && (
                <div className="mt-3.5 bg-red-950/40 border border-red-800/80 rounded-lg p-3 space-y-2.5">
                  <div className="flex items-start space-x-2">
                    <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-red-200 text-xs">
                        {m.interactivePrompt.title}
                      </h4>
                      <p className="text-[11px] text-red-300/90 mt-0.5">
                        {m.interactivePrompt.details}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2 pt-1 border-t border-red-900/60">
                    <button
                      onClick={() =>
                        handleConfirmPrompt(m.interactivePrompt!.id, true, m.id)
                      }
                      disabled={loading}
                      className="bg-red-600 hover:bg-red-500 text-white font-medium px-3 py-1.5 rounded text-[11px] flex items-center space-x-1"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      <span>Approve & Execute</span>
                    </button>
                    <button
                      onClick={() =>
                        handleConfirmPrompt(m.interactivePrompt!.id, false, m.id)
                      }
                      disabled={loading}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium px-3 py-1.5 rounded text-[11px] flex items-center space-x-1 border border-slate-700"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Cancel Action</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex items-center space-x-2 text-slate-400 py-2 px-1">
            <RotateCw className="h-3.5 w-3.5 animate-spin text-emerald-400" />
            <span className="text-xs font-mono">
              Evaluating intent with TypeSafe Jev & reasoning...
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Form */}
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
          placeholder="Ask DeployMind AI to deploy, inspect logs, start/stop services, or configure variables..."
          className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          disabled={loading}
        />
        <button
          onClick={() => handleSendMessage()}
          disabled={loading || !input.trim()}
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-lg text-xs font-medium flex items-center space-x-1.5 disabled:opacity-50 transition"
        >
          <Send className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Send</span>
        </button>
      </div>
    </div>
  );
};
