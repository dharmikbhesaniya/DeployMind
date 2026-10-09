import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';

// Global fetch interceptor to automatically attach DeployMind administrative credentials
const originalFetch = window.fetch;
let isRefreshing = false;

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  let token = localStorage.getItem('deploymind_admin_token');

  // If making an API call and we have a token, inject Authorization header & credentials
  const newInit: RequestInit = { ...init };
  const headers = new Headers(newInit.headers || (typeof input === 'object' && 'headers' in input ? (input as Request).headers : {}));

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  newInit.headers = headers;
  if (!newInit.credentials) {
    newInit.credentials = 'include';
  }

  let res = await originalFetch(input, newInit);

  // If 401 Unauthorized and not already on the auth endpoint, attempt automatic session bootstrap
  if (res.status === 401 && !url.includes('/api/auth/session') && !url.includes('/api/auth/verify') && !isRefreshing) {
    isRefreshing = true;
    try {
      const sessionRes = await originalFetch('/api/auth/session', { credentials: 'include' });
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        if (sessionData.token) {
          localStorage.setItem('deploymind_admin_token', sessionData.token);
          headers.set('Authorization', `Bearer ${sessionData.token}`);
          newInit.headers = headers;
          res = await originalFetch(input, newInit);
        }
      } else {
        window.dispatchEvent(new CustomEvent('deploymind:auth-error'));
      }
    } catch {
      window.dispatchEvent(new CustomEvent('deploymind:auth-error'));
    } finally {
      isRefreshing = false;
    }
  }

  return res;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
