import React, { useState, useEffect, useRef } from 'react';
import {
  Rocket,
  Shield,
  KeyRound,
  Globe,
  Server,
  Layers,
  Database,
  CheckCircle2,
  AlertCircle,
  Terminal,
  ExternalLink,
  RefreshCw,
  Plus,
  Sparkles,
  ArrowRight,
  ChevronRight,
  Eye,
  Info,
  Archive,
  GitBranch,
  Wand2,
  Copy,
  Check,
  Cpu,
  FileText
} from 'lucide-react';

interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  branch: string;
  status: string;
  servicesCount: number;
}

interface VaultCred {
  id: string;
  keyName: string;
  description: string;
  maskedPreview: string;
  scope: string;
  boundProjectsCount: number;
}

interface DeploymentPlan {
  projectName: string;
  framework: string;
  runtime: string;
  runtimeStrategy?: 'docker_priority' | 'native_production';
  readmeSummary?: {
    projectOverview: string;
    howItWorks: string;
    setupWorkflow: string[];
    detectedBuildCommand?: string;
    detectedStartCommand?: string;
    detectedPort?: number;
    detectedMigrationCommand?: string;
  };
  exposedPort: number;
  healthCheckPath: string;
  migrationCommand?: string;
  suggestedSubdomain: string;
  environmentVariables: Array<{
    key: string;
    type: 'AUTO_GENERATED_SECRET' | 'INTERNAL_INFRASTRUCTURE' | 'EXTERNAL_REQUIRED' | 'OPTIONAL_DEFAULT';
    description: string;
    defaultValue?: string;
    matchingVaultCredentialId?: string;
    reusePrompt?: string;
  }>;
  requiredBackingServices: Array<{
    serviceType: string;
    strategy: string;
    reason: string;
  }>;
}

interface RouteItem {
  routeId: string;
  hostname: string;
  targetUpstream: string;
  provider: string;
  sslActive: boolean;
}

interface BackupItem {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  type: string;
}

interface SystemStatus {
  status: string;
  engine: string;
  version: string;
  docker: string;
  proxy: {
    provider: string;
    connected: boolean;
  };
}

const API_BASE = typeof window !== 'undefined' && window.location.port === '5173'
  ? `http://${window.location.hostname}:3000`
  : '';

const WS_BASE = typeof window !== 'undefined' && window.location.port === '5173'
  ? `ws://${window.location.hostname}:3000`
  : (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}` : '');

export default function App() {
  const [activeTab, setActiveTab] = useState<'deploy' | 'projects' | 'vault' | 'proxy' | 'backups'>('deploy');
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  // Deploy state
  const [repoUrl, setRepoUrl] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [autoDeploying, setAutoDeploying] = useState(false);
  const [planResult, setPlanResult] = useState<{
    projectId: string;
    deploymentId: string;
    plan: DeploymentPlan;
  } | null>(null);
  const [varDecisions, setVarDecisions] = useState<Record<string, {
    action: 'use_existing' | 'create_new';
    vaultCredentialId?: string;
    newValue?: string;
    description?: string;
  }>>({});
  const [deploying, setDeploying] = useState(false);
  const [deploymentLogs, setDeploymentLogs] = useState<Array<{
    timestamp: number;
    level: string;
    stage: string;
    message: string;
  }>>([]);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);

  // Lists state
  const [projects, setProjects] = useState<Project[]>([]);
  const [vaultCreds, setVaultCreds] = useState<VaultCred[]>([]);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [runningBackup, setRunningBackup] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Add Credential Modal
  const [showAddCred, setShowAddCred] = useState(false);
  const [newCredKey, setNewCredKey] = useState('');
  const [newCredValue, setNewCredValue] = useState('');
  const [newCredDesc, setNewCredDesc] = useState('');
  const [newCredScope, setNewCredScope] = useState<'GLOBAL' | 'PROJECT_SCOPED'>('GLOBAL');

  const logEndRef = useRef<HTMLDivElement>(null);

  // Fetch initial data
  const fetchData = async () => {
    try {
      const [sysRes, projRes, vaultRes, routeRes, backupRes] = await Promise.all([
        fetch(`${API_BASE}/api/system/status`),
        fetch(`${API_BASE}/api/projects`),
        fetch(`${API_BASE}/api/vault/credentials`),
        fetch(`${API_BASE}/api/routes`),
        fetch(`${API_BASE}/api/backups`),
      ]);
      if (sysRes.ok) setSystemStatus(await sysRes.json());
      if (projRes.ok) setProjects(await projRes.json());
      if (vaultRes.ok) setVaultCreds(await vaultRes.json());
      if (routeRes.ok) setRoutes(await routeRes.json());
      if (backupRes.ok) setBackups(await backupRes.json());
    } catch {
      // Backend maybe loading
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 6000);
    return () => clearInterval(interval);
  }, []);

  // WebSocket for deployment logs
  useEffect(() => {
    if (!planResult?.deploymentId) return;

    const ws = new WebSocket(`${WS_BASE}/ws/logs?deploymentId=${planResult.deploymentId}`);

    ws.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        setDeploymentLogs((prev) => [...prev, log]);
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      } catch {
        // Ignored
      }
    };

    return () => {
      ws.close();
    };
  }, [planResult?.deploymentId]);

  // Handle 1-Click Zero-Touch Autonomous Deployment (URL Only!)
  const handleAutoDeploy = async () => {
    if (!repoUrl.trim()) return;

    setAutoDeploying(true);
    setPlanResult(null);
    setDeploymentLogs([]);
    setLiveUrl(null);

    try {
      const res = await fetch(`${API_BASE}/api/deployments/auto-deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });
      const data = await res.json();
      if (res.ok) {
        setPlanResult({
          projectId: data.projectId,
          deploymentId: data.deploymentId,
          plan: data.plan,
        });
        setLiveUrl(data.liveUrl);
        fetchData();
      } else {
        alert(data.error || 'Auto-deployment failed');
      }
    } catch (err: any) {
      alert(`Auto-deploy network error: ${err.message}`);
    } finally {
      setAutoDeploying(false);
    }
  };

  // Handle repository analysis (Interactive flow)
  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;

    setAnalyzing(true);
    setPlanResult(null);
    setDeploymentLogs([]);
    setLiveUrl(null);

    try {
      const res = await fetch(`${API_BASE}/api/deployments/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl }),
      });
      const data = await res.json();
      if (res.ok) {
        setPlanResult(data);

        // Pre-fill variable decisions with matching vault credentials if any
        const initialDecisions: Record<string, any> = {};
        for (const v of data.plan.environmentVariables) {
          if (v.matchingVaultCredentialId) {
            initialDecisions[v.key] = {
              action: 'use_existing',
              vaultCredentialId: v.matchingVaultCredentialId,
            };
          } else if (v.type === 'EXTERNAL_REQUIRED') {
            initialDecisions[v.key] = {
              action: 'create_new',
              newValue: '',
              description: v.description,
            };
          }
        }
        setVarDecisions(initialDecisions);
      } else {
        alert(data.error || 'Repository analysis failed');
      }
    } catch (err: any) {
      alert(`Network error: ${err.message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  // Handle deployment execution
  const handleExecuteDeploy = async () => {
    if (!planResult) return;
    setDeploying(true);

    const formattedDecisions = Object.entries(varDecisions).map(([key, dec]) => ({
      key,
      action: dec.action,
      vaultCredentialId: dec.vaultCredentialId,
      newValue: dec.newValue,
      description: dec.description,
    }));

    try {
      const res = await fetch(`${API_BASE}/api/deployments/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deploymentId: planResult.deploymentId,
          variableDecisions: formattedDecisions,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setLiveUrl(data.liveUrl);
        fetchData();
      } else {
        alert(data.error || 'Deployment execution failed');
      }
    } catch (err: any) {
      alert(`Deployment error: ${err.message}`);
    } finally {
      setDeploying(false);
    }
  };

  // Handle on-demand backup
  const handleRunBackup = async () => {
    setRunningBackup(true);
    try {
      const res = await fetch(`${API_BASE}/api/backups/run`, { method: 'POST' });
      if (res.ok) fetchData();
    } finally {
      setRunningBackup(false);
    }
  };

  // Handle create new credential in vault
  const handleCreateCred = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCredKey || !newCredValue || !newCredDesc) return;

    try {
      const res = await fetch(`${API_BASE}/api/vault/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyName: newCredKey,
          value: newCredValue,
          description: newCredDesc,
          scope: newCredScope,
        }),
      });
      if (res.ok) {
        setShowAddCred(false);
        setNewCredKey('');
        setNewCredValue('');
        setNewCredDesc('');
        fetchData();
      }
    } catch {
      // Ignored
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100">
      {/* Top Navbar */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="h-9 w-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Rocket className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-tight text-white">DeployMind</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                AI MONOLITH
              </span>
            </div>
            <p className="text-xs text-slate-400">Zero-Config Autonomous Self-Hosting</p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center space-x-1 bg-slate-900 border border-slate-800 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('deploy')}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'deploy'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>Deploy</span>
          </button>
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'projects'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            <span>Projects ({projects.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('vault')}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'vault'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            <span>Vault ({vaultCreds.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('proxy')}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'proxy'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>Proxy ({routes.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('backups')}
            className={`flex items-center space-x-2 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              activeTab === 'backups'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Archive className="h-3.5 w-3.5" />
            <span>Backups ({backups.length})</span>
          </button>
        </nav>

        {/* System Status Indicators */}
        <div className="flex items-center space-x-3 text-xs font-mono">
          <div className="flex items-center space-x-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md">
            <span className={`h-2 w-2 rounded-full ${systemStatus?.docker === 'connected' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="text-slate-400">Docker</span>
          </div>
          <div className="flex items-center space-x-1.5 bg-slate-900 border border-slate-800 px-2.5 py-1 rounded-md">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-slate-400 uppercase">{systemStatus?.proxy.provider || 'CADDY'}</span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {/* TAB 1: NEW DEPLOYMENT */}
        {activeTab === 'deploy' && (
          <div className="space-y-6">
            {/* Hero Input Box */}
            <div className="bg-gradient-to-b from-slate-900 to-slate-900/60 border border-slate-800 rounded-xl p-6 shadow-xl">
              <div className="max-w-3xl">
                <div className="flex items-center space-x-2 text-emerald-400 text-xs font-mono mb-1">
                  <Wand2 className="h-3.5 w-3.5" />
                  <span>AUTONOMOUS ZERO-TOUCH PIPELINE</span>
                </div>
                <h1 className="text-xl font-bold text-white mb-1.5">
                  Paste Repository URL & Go Live
                </h1>
                <p className="text-sm text-slate-400 mb-5">
                  No Dockerfile? No problem. The agent inspects code, synthesizes missing Dockerfiles, provisions shared PostgreSQL/Redis, wires secrets, and configures SSL routing automatically.
                </p>

                <div className="space-y-3">
                  <div className="relative">
                    <input
                      type="url"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      placeholder="https://github.com/n8n-io/n8n or https://github.com/org/repo"
                      required
                      className="w-full bg-slate-950 border border-slate-700/80 rounded-lg px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2.5">
                    {/* Primary: 1-Click Auto Deploy (Zero Manual Config) */}
                    <button
                      type="button"
                      onClick={handleAutoDeploy}
                      disabled={autoDeploying || analyzing}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg text-sm flex items-center space-x-2 transition-all disabled:opacity-50 shadow-lg shadow-emerald-950"
                    >
                      {autoDeploying ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          <span>Autonomously Deploying...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" />
                          <span>1-Click Auto Deploy (Zero-Config)</span>
                        </>
                      )}
                    </button>

                    {/* Secondary: Interactive Plan Review */}
                    <button
                      type="button"
                      onClick={handleAnalyze}
                      disabled={analyzing || autoDeploying}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium px-5 py-2.5 rounded-lg text-sm flex items-center space-x-2 transition-all disabled:opacity-50"
                    >
                      {analyzing ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          <span>Analyzing...</span>
                        </>
                      ) : (
                        <>
                          <Eye className="h-4 w-4 text-slate-400" />
                          <span>Inspect Plan First</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Automation Badges */}
                <div className="flex flex-wrap gap-3 mt-4 pt-4 border-t border-slate-800 text-[11px] text-slate-400">
                  <div className="flex items-center space-x-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Auto-Dockerfile Synthesizer</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Multi-Tenant DB Auto-Provisioning</span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Autonomous Diagnostic Self-Healing</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Synthesized Deployment Plan Review */}
            {planResult && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left 2 Cols: Plan details & Variable Decisions */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Plan Overview Card */}
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                      <div>
                        <h2 className="text-base font-semibold text-white">Autonomous Deployment Plan</h2>
                        <p className="text-xs text-slate-400">Synthesized from codebase manifests and README specifications</p>
                      </div>
                      <span className="px-2.5 py-1 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 text-xs font-mono">
                        Port {planResult.plan.exposedPort}
                      </span>
                    </div>

                    {/* Priority 1 vs Priority 2 Runtime Strategy Banner */}
                    <div className={`mb-4 p-3 rounded-lg border text-xs flex items-center justify-between ${
                      planResult.plan.runtimeStrategy === 'docker_priority'
                        ? 'bg-blue-950/30 border-blue-800/60 text-blue-300'
                        : 'bg-amber-950/30 border-amber-800/60 text-amber-300'
                    }`}>
                      <div className="flex items-center space-x-2.5">
                        <Cpu className="h-4 w-4 flex-shrink-0" />
                        <div>
                          <span className="font-semibold uppercase tracking-wider block">
                            {planResult.plan.runtimeStrategy === 'docker_priority'
                              ? 'Runtime: Priority 1 - Docker Container'
                              : 'Runtime: Priority 2 Fallback - Native Host (Strict Production)'}
                          </span>
                          <span className="text-[11px] text-slate-400">
                            {planResult.plan.runtimeStrategy === 'docker_priority'
                              ? 'Full container network isolation, 1024MB RAM & 1 CPU constraints.'
                              : 'Docker offline. Running directly in production mode; devDependencies pruned to maximize storage, RAM & CPU efficiency.'}
                          </span>
                        </div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${
                        planResult.plan.runtimeStrategy === 'docker_priority'
                          ? 'bg-blue-900/60 text-blue-200 border border-blue-700'
                          : 'bg-amber-900/60 text-amber-200 border border-amber-700'
                      }`}>
                        {planResult.plan.runtimeStrategy === 'docker_priority' ? 'ISOLATED' : 'STRICT PROD'}
                      </span>
                    </div>

                    {/* README Semantic Understanding Section */}
                    {planResult.plan.readmeSummary && (
                      <div className="mb-4 bg-slate-950 border border-slate-800/80 rounded-lg p-3.5 text-xs space-y-2">
                        <div className="flex items-center space-x-2 text-slate-300 font-semibold">
                          <FileText className="h-3.5 w-3.5 text-emerald-400" />
                          <span>README Semantic Understanding & Setup Workflow</span>
                        </div>
                        <p className="text-slate-400">{planResult.plan.readmeSummary.projectOverview}</p>
                        {planResult.plan.readmeSummary.howItWorks && (
                          <div className="bg-slate-900/80 p-2 rounded border border-slate-800 text-slate-300">
                            <span className="text-slate-500 font-mono text-[10px] block uppercase">Architecture</span>
                            {planResult.plan.readmeSummary.howItWorks}
                          </div>
                        )}
                        {planResult.plan.readmeSummary.setupWorkflow && planResult.plan.readmeSummary.setupWorkflow.length > 0 && (
                          <div>
                            <span className="text-slate-500 font-mono text-[10px] block uppercase mb-1">Discovered Setup Steps</span>
                            <div className="flex flex-wrap gap-1.5">
                              {planResult.plan.readmeSummary.setupWorkflow.map((step, sIdx) => (
                                <span key={sIdx} className="bg-slate-900 text-slate-300 px-2 py-0.5 rounded border border-slate-800 text-[11px]">
                                  {step}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-slate-400">
                          {planResult.plan.readmeSummary.detectedBuildCommand && (
                            <div>
                              <span className="text-slate-500">Production Build: </span>
                              <code className="text-emerald-400 font-mono">{planResult.plan.readmeSummary.detectedBuildCommand}</code>
                            </div>
                          )}
                          {planResult.plan.readmeSummary.detectedStartCommand && (
                            <div>
                              <span className="text-slate-500">Production Start: </span>
                              <code className="text-emerald-400 font-mono">{planResult.plan.readmeSummary.detectedStartCommand}</code>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mb-4">
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <span className="text-slate-500 block mb-0.5">Project</span>
                        <span className="font-medium text-slate-200">{planResult.plan.projectName}</span>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <span className="text-slate-500 block mb-0.5">Runtime / Framework</span>
                        <span className="font-medium text-slate-200 uppercase">{planResult.plan.framework}</span>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <span className="text-slate-500 block mb-0.5">Subdomain</span>
                        <span className="font-medium text-emerald-400">{planResult.plan.suggestedSubdomain}</span>
                      </div>
                      <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                        <span className="text-slate-500 block mb-0.5">Proxy Ingress</span>
                        <span className="font-medium text-slate-200 uppercase">{systemStatus?.proxy.provider || 'CADDY'}</span>
                      </div>
                    </div>

                    {/* Shared Infrastructure Dependencies */}
                    {planResult.plan.requiredBackingServices.length > 0 && (
                      <div className="mb-4">
                        <span className="text-xs font-semibold text-slate-300 block mb-2">Backing Services Managed:</span>
                        <div className="space-y-1.5">
                          {planResult.plan.requiredBackingServices.map((s, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs bg-slate-950 border border-slate-800 px-3 py-2 rounded-lg">
                              <div className="flex items-center space-x-2">
                                <Database className="h-3.5 w-3.5 text-emerald-400" />
                                <span className="font-medium uppercase text-slate-200">{s.serviceType}</span>
                                <span className="text-slate-500">({s.reason})</span>
                              </div>
                              <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px]">
                                Multi-Tenant Reuse
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Environment Variables & Reusable Vault Decisions */}
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <div className="border-b border-slate-800 pb-3 mb-4">
                      <h3 className="text-base font-semibold text-white">Environment Configuration & Secret Resolution</h3>
                      <p className="text-xs text-slate-400">
                        Secrets can be auto-generated, linked to shared infrastructure, or re-used from your Credential Vault.
                      </p>
                    </div>

                    <div className="space-y-3">
                      {planResult.plan.environmentVariables.map((v) => {
                        const currentDecision = varDecisions[v.key];

                        return (
                          <div key={v.key} className="bg-slate-950 border border-slate-800 rounded-lg p-3.5">
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <div className="flex items-center space-x-2">
                                  <span className="font-mono text-sm font-semibold text-emerald-400">{v.key}</span>
                                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400 uppercase">
                                    {v.type.replace('_', ' ')}
                                  </span>
                                </div>
                                <p className="text-xs text-slate-400 mt-0.5">{v.description}</p>
                              </div>
                            </div>

                            {/* Auto-generated / Infrastructure badges */}
                            {v.type === 'AUTO_GENERATED_SECRET' && (
                              <div className="text-xs text-emerald-400/90 bg-emerald-950/40 border border-emerald-900/60 rounded px-2.5 py-1.5 flex items-center space-x-2">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                                <span>Will automatically generate a high-entropy 256-bit cryptographic secret.</span>
                              </div>
                            )}

                            {v.type === 'INTERNAL_INFRASTRUCTURE' && (
                              <div className="text-xs text-blue-400/90 bg-blue-950/40 border border-blue-900/60 rounded px-2.5 py-1.5 flex items-center space-x-2">
                                <Database className="h-3.5 w-3.5 text-blue-400" />
                                <span>Will automatically inject isolated connection string from shared infrastructure.</span>
                              </div>
                            )}

                            {/* Vault Reuse Option or External Required */}
                            {(v.type === 'EXTERNAL_REQUIRED' || v.matchingVaultCredentialId) && (
                              <div className="mt-2.5 pt-2.5 border-t border-slate-800/80 space-y-2">
                                {v.reusePrompt && (
                                  <div className="bg-amber-950/30 border border-amber-900/50 rounded p-2 text-xs text-amber-300 flex items-center space-x-2">
                                    <Info className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
                                    <span>{v.reusePrompt}</span>
                                  </div>
                                )}

                                <div className="flex items-center space-x-3 text-xs mb-2">
                                  {v.matchingVaultCredentialId && (
                                    <label className="flex items-center space-x-1.5 cursor-pointer">
                                      <input
                                        type="radio"
                                        name={`action_${v.key}`}
                                        checked={currentDecision?.action === 'use_existing'}
                                        onChange={() =>
                                          setVarDecisions((prev) => ({
                                            ...prev,
                                            [v.key]: {
                                              action: 'use_existing',
                                              vaultCredentialId: v.matchingVaultCredentialId,
                                            },
                                          }))
                                        }
                                        className="text-emerald-500 focus:ring-emerald-500"
                                      />
                                      <span className="text-slate-300">Use Existing Vault Credential</span>
                                    </label>
                                  )}

                                  <label className="flex items-center space-x-1.5 cursor-pointer">
                                    <input
                                      type="radio"
                                      name={`action_${v.key}`}
                                      checked={currentDecision?.action === 'create_new'}
                                      onChange={() =>
                                        setVarDecisions((prev) => ({
                                          ...prev,
                                          [v.key]: {
                                            action: 'create_new',
                                            newValue: '',
                                            description: `Key for ${planResult.plan.projectName}`,
                                          },
                                        }))
                                      }
                                      className="text-emerald-500 focus:ring-emerald-500"
                                    />
                                    <span className="text-slate-300">Create New (Custom Value)</span>
                                  </label>
                                </div>

                                {currentDecision?.action === 'create_new' && (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                                    <input
                                      type="password"
                                      placeholder={`Enter secret value for ${v.key}`}
                                      value={currentDecision?.newValue || ''}
                                      onChange={(e) =>
                                        setVarDecisions((prev) => ({
                                          ...prev,
                                          [v.key]: {
                                            ...prev[v.key],
                                            action: 'create_new',
                                            newValue: e.target.value,
                                          },
                                        }))
                                      }
                                      className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    />
                                    <input
                                      type="text"
                                      placeholder="Descriptive label (e.g. Org Production Key)"
                                      value={currentDecision?.description || ''}
                                      onChange={(e) =>
                                        setVarDecisions((prev) => ({
                                          ...prev,
                                          [v.key]: {
                                            ...prev[v.key],
                                            action: 'create_new',
                                            description: e.target.value,
                                          },
                                        }))
                                      }
                                      className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-5 pt-4 border-t border-slate-800 flex justify-end">
                      <button
                        onClick={handleExecuteDeploy}
                        disabled={deploying}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-6 py-2.5 rounded-lg text-sm flex items-center space-x-2 transition-all shadow-lg shadow-emerald-950 disabled:opacity-50"
                      >
                        {deploying ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin" />
                            <span>Deploying Application...</span>
                          </>
                        ) : (
                          <>
                            <Rocket className="h-4 w-4" />
                            <span>Authorize & Deploy Now</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right 1 Col: Live Terminal Logs Console */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col h-[650px]">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
                    <div className="flex items-center space-x-2">
                      <Terminal className="h-4 w-4 text-emerald-400" />
                      <span className="text-sm font-semibold text-white">Live Execution Stream</span>
                    </div>
                    {(deploying || autoDeploying) && (
                      <span className="flex h-2 w-2 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                    )}
                  </div>

                  {/* Terminal Window */}
                  <div className="flex-1 bg-black/80 rounded-lg p-3 font-mono text-xs overflow-y-auto space-y-1.5 border border-slate-900">
                    {deploymentLogs.length === 0 && (
                      <div className="text-slate-600 italic">Waiting for deployment execution...</div>
                    )}

                    {deploymentLogs.map((log, idx) => (
                      <div key={idx} className="leading-relaxed">
                        <span className="text-slate-500">[{log.stage}]</span>{' '}
                        <span
                          className={
                            log.level === 'error'
                              ? 'text-red-400'
                              : log.level === 'warn'
                              ? 'text-amber-400'
                              : log.level === 'success'
                              ? 'text-emerald-400'
                              : 'text-slate-300'
                          }
                        >
                          {log.message}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>

                  {/* Live URL Card */}
                  {liveUrl && (
                    <div className="mt-3 bg-emerald-950/60 border border-emerald-800 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-[10px] uppercase font-mono text-emerald-400 block">Service Active</span>
                          <span className="text-sm font-semibold text-white">{liveUrl}</span>
                        </div>
                        <a
                          href={liveUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="bg-emerald-600 hover:bg-emerald-500 text-white p-2 rounded-md"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: PROJECTS */}
        {activeTab === 'projects' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Active Deployed Projects</h2>
              <button
                onClick={() => setActiveTab('deploy')}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-3.5 py-2 rounded-lg flex items-center space-x-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>New Project</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => {
                const webhookUrl = `${window.location.origin}/api/webhooks/${p.id}`;

                return (
                  <div key={p.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 hover:border-slate-700 transition-all flex flex-col justify-between">
                    <div>
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <h3 className="font-semibold text-white text-base">{p.name}</h3>
                          <span className="text-xs font-mono text-slate-400">{p.slug}</span>
                        </div>
                        <span className="px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] uppercase font-mono">
                          {p.status}
                        </span>
                      </div>

                      <p className="text-xs text-slate-400 truncate mb-3">{p.repoUrl}</p>

                      {/* Push-to-Deploy Webhook Box */}
                      <div className="bg-slate-950 border border-slate-800/80 rounded-lg p-2.5 mb-3">
                        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                          <span className="flex items-center space-x-1">
                            <GitBranch className="h-3 w-3 text-emerald-400" />
                            <span>Push-to-Deploy Webhook</span>
                          </span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(webhookUrl);
                              setCopiedId(p.id);
                              setTimeout(() => setCopiedId(null), 2000);
                            }}
                            className="text-emerald-400 hover:text-emerald-300 font-mono text-[10px] flex items-center space-x-1"
                          >
                            {copiedId === p.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            <span>{copiedId === p.id ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                        <div className="font-mono text-[10px] text-slate-500 truncate">{webhookUrl}</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs pt-3 border-t border-slate-800 text-slate-400">
                      <span>{p.servicesCount} running services</span>
                      <button
                        onClick={() => {
                          setRepoUrl(p.repoUrl);
                          setActiveTab('deploy');
                        }}
                        className="text-emerald-400 hover:text-emerald-300 font-medium flex items-center space-x-1"
                      >
                        <span>Redeploy</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 3: CREDENTIAL VAULT */}
        {activeTab === 'vault' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Reusable Credential & Variable Vault</h2>
                <p className="text-xs text-slate-400">
                  Securely stored AES-256-GCM credentials. Supports duplicate key names cleanly with descriptive human labels and scoping.
                </p>
              </div>
              <button
                onClick={() => setShowAddCred(true)}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-3.5 py-2 rounded-lg flex items-center space-x-1.5"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Credential</span>
              </button>
            </div>

            {/* Credential Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Key Name</th>
                    <th className="px-4 py-3 font-semibold">Description / Label</th>
                    <th className="px-4 py-3 font-semibold">Masked Preview</th>
                    <th className="px-4 py-3 font-semibold">Scope</th>
                    <th className="px-4 py-3 font-semibold">Referencing Projects</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {vaultCreds.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-800/40">
                      <td className="px-4 py-3 font-mono font-medium text-emerald-400">{c.keyName}</td>
                      <td className="px-4 py-3 text-slate-300">{c.description}</td>
                      <td className="px-4 py-3 font-mono text-slate-400">{c.maskedPreview}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-[10px] font-mono">
                          {c.scope}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400">{c.boundProjectsCount} projects</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Modal: Add Credential */}
            {showAddCred && (
              <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <h3 className="font-semibold text-white">Store New Credential in Vault</h3>
                    <button onClick={() => setShowAddCred(false)} className="text-slate-400 hover:text-white">✕</button>
                  </div>

                  <form onSubmit={handleCreateCred} className="space-y-3 text-xs">
                    <div>
                      <label className="block text-slate-400 mb-1">Key Name (e.g. OPENAI_API_KEY)</label>
                      <input
                        type="text"
                        value={newCredKey}
                        onChange={(e) => setNewCredKey(e.target.value)}
                        placeholder="OPENAI_API_KEY"
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Description / Disambiguation Label</label>
                      <input
                        type="text"
                        value={newCredDesc}
                        onChange={(e) => setNewCredDesc(e.target.value)}
                        placeholder="Production Client Alpha Key with GPT-4"
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Plaintext Secret Value</label>
                      <input
                        type="password"
                        value={newCredValue}
                        onChange={(e) => setNewCredValue(e.target.value)}
                        placeholder="sk-proj-..."
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-slate-100 font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-slate-400 mb-1">Scope</label>
                      <select
                        value={newCredScope}
                        onChange={(e) => setNewCredScope(e.target.value as any)}
                        className="w-full bg-slate-950 border border-slate-800 rounded p-2 text-slate-100"
                      >
                        <option value="GLOBAL">GLOBAL (Available to any project)</option>
                        <option value="PROJECT_SCOPED">PROJECT_SCOPED</option>
                      </select>
                    </div>

                    <div className="pt-3 flex justify-end space-x-2">
                      <button
                        type="button"
                        onClick={() => setShowAddCred(false)}
                        className="px-3 py-1.5 rounded bg-slate-800 text-slate-300"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                      >
                        Save to Vault
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: PROXY & INGRESS */}
        {activeTab === 'proxy' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Reverse Proxy Ingress & Routing</h2>
                <p className="text-xs text-slate-400">
                  Active zero-downtime routes in {systemStatus?.proxy.provider.toUpperCase() || 'CADDY'} with automatic SSL/TLS termination.
                </p>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Subdomain / Hostname</th>
                    <th className="px-4 py-3 font-semibold">Internal Upstream</th>
                    <th className="px-4 py-3 font-semibold">Proxy Engine</th>
                    <th className="px-4 py-3 font-semibold">SSL Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {routes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                        No active reverse proxy routes yet. Deploy a project to generate subdomains.
                      </td>
                    </tr>
                  ) : (
                    routes.map((r) => (
                      <tr key={r.routeId} className="hover:bg-slate-800/40">
                        <td className="px-4 py-3 font-mono font-medium text-emerald-400">{r.hostname}</td>
                        <td className="px-4 py-3 font-mono text-slate-300">{r.targetUpstream}</td>
                        <td className="px-4 py-3 uppercase text-slate-400">{r.provider}</td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px]">
                            SSL ACTIVE (Let's Encrypt)
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: AUTOMATED BACKUPS */}
        {activeTab === 'backups' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Automated Database Backups</h2>
                <p className="text-xs text-slate-400">
                  Daily automated snapshots of shared PostgreSQL tenant databases and SQLite state with automatic 7-day retention.
                </p>
              </div>
              <button
                onClick={handleRunBackup}
                disabled={runningBackup}
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium px-4 py-2 rounded-lg flex items-center space-x-1.5 disabled:opacity-50"
              >
                {runningBackup ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Backing up...</span>
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5" />
                    <span>Backup Now</span>
                  </>
                )}
              </button>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Snapshot Name</th>
                    <th className="px-4 py-3 font-semibold">Database Type</th>
                    <th className="px-4 py-3 font-semibold">Size</th>
                    <th className="px-4 py-3 font-semibold">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {backups.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                        No backup archives generated yet. Click "Backup Now" to create an instant snapshot.
                      </td>
                    </tr>
                  ) : (
                    backups.map((b) => (
                      <tr key={b.id} className="hover:bg-slate-800/40">
                        <td className="px-4 py-3 font-mono font-medium text-emerald-400">{b.name}</td>
                        <td className="px-4 py-3 uppercase text-slate-300">{b.type}</td>
                        <td className="px-4 py-3 text-slate-400 font-mono">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
                        <td className="px-4 py-3 text-slate-400">{new Date(b.createdAt).toLocaleString()}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
