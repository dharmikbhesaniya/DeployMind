/**
 * DeployMind Frontend Client Configuration & Constants
 * Reads from Vite environment variables (VITE_*) with dynamic origin fallbacks.
 */

const getApiBase = (): string => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  if (typeof window !== 'undefined') {
    // If running on Vite dev server port 5173, point to backend on 3000 by default
    if (window.location.port === '5173') {
      return `http://${window.location.hostname}:3000`;
    }
    // When served together or behind reverse proxy
    return '';
  }
  return 'http://localhost:3000';
};

const getWsBase = (): string => {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  if (typeof window !== 'undefined') {
    if (window.location.port === '5173') {
      return `ws://${window.location.hostname}:3000`;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return 'ws://localhost:3000';
};

export const CLIENT_CONSTANTS = {
  APP_TITLE: import.meta.env.VITE_APP_TITLE || 'DeployMind',
  API_BASE_URL: getApiBase(),
  WS_BASE_URL: getWsBase(),
  STORAGE_KEYS: {
    CHAT_SESSIONS: 'deploymind_chat_sessions',
    ACTIVE_CHAT_ID: 'deploymind_active_chat_id',
    THEME_MODE: 'deploymind_theme',
  },
  DEFAULT_POLL_INTERVAL_MS: 3000,
} as const;
