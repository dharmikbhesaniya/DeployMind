# DeployAgent 🚀

> **Open-Source AI-First Autonomous Deployment Platform**  
> Paste any Git repository URL. DeployAgent inspects the codebase, extracts setup directives from the README, provisions shared databases, synthesizes environment variables, and configures reverse proxy ingress with automatic SSL.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Architecture](https://img.shields.io/badge/architecture-Modular%20Monolith-emerald.svg)](docs/ARCHITECTURE_AND_DESIGN.md)
[![Proxy](https://img.shields.io/badge/proxy-Caddy%20%7C%20Traefik-purple.svg)](docs/ARCHITECTURE_AND_DESIGN.md)

---

## What Makes DeployAgent Different?

Traditional self-hosted PaaS solutions (like Coolify, Dokploy, and CapRover) require engineers to manually populate environment variables, set up ports, build dockerfiles, and link databases.

DeployAgent replaces manual configuration with an **autonomous AI reasoning pipeline**:

1. **Zero-Config URL Ingestion:** Provide any Git repository URL.
2. **Semantic README Parsing:** Extracts runtime dependencies, configuration parameters, and installation commands from project documentation.
3. **Multi-Tenant Infrastructure Sharing:** Reuses existing PostgreSQL and Redis clusters on the host by creating isolated tenant databases and users—reducing idle RAM consumption.
4. **Reusable Credential Vault:** Automatically detects matching credentials (e.g., `OPENAI_API_KEY`) from prior projects. Cleanly manages duplicate key names using descriptive labels and scoping.
5. **Pluggable Ingress Engine:** Programs **Caddy** (dynamic JSON REST API) or **Traefik** for instant routing and automatic Let's Encrypt SSL.
6. **Diagnostic Auto-Healing:** Analyzes startup logs to detect missing database migrations or mismatched ports and automatically applies remediation.

---

## Architecture: The Modular Monolith

DeployAgent is built as a single, unified container designed to run on any VPS:

* **Backend:** Node.js 22 LTS, TypeScript, Fastify, Dockerode.
* **Database:** Embedded SQLite with Write-Ahead Logging (WAL) via Drizzle ORM.
* **Web UI:** Embedded React SPA with Tailwind CSS and live WebSocket streaming.
* **Proxy Drivers:** Native adapters for Caddy and Traefik.

Read the complete [High-Level and Low-Level Design (HLD/LLD)](docs/ARCHITECTURE_AND_DESIGN.md) for full architectural specifications.

---

## Quick Start

### 1. Run with Docker Compose

```bash
git clone https://github.com/deployagent/deployagent.git
cd deployagent
docker compose up -d
```

Open `http://localhost:3000` to access the dashboard.

### 2. Local Development

```bash
# Install dependencies
npm install
cd web && npm install && cd ..

# Run backend with hot reload
npm run dev

# Run frontend in separate terminal
cd web && npm run dev
```

### 3. Run Automated Tests

```bash
npm test
```

---

## Configuration Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the DeployAgent monolith HTTP server |
| `DEPLOYAGENT_DATA_DIR` | `.data` | Directory for SQLite database and encryption keys |
| `PROXY_PROVIDER` | `caddy` | Ingress driver: `caddy` or `traefik` |
| `CADDY_API_URL` | `http://127.0.0.1:2019` | Dynamic admin API URL for Caddy |
| `BASE_DOMAIN` | `localhost` | Base domain for generating application subdomains |
| `AI_PROVIDER` | `openai` | AI Gateway provider (`openai`, `anthropic`, `gemini`, `ollama`) |
| `AI_API_KEY` | - | API key for LLM structured output reasoning |

---

## License

Licensed under the [Apache License 2.0](LICENSE).
