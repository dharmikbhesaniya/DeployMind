# Domain Binding and Subdomain Ingress Configuration

This guide details how to bind a custom domain (such as one managed through GoDaddy) to a DeployMind VPS installation, enabling automatic subdomain routing for all deployed applications.

---

## 1. Overview

DeployMind uses Caddy as an ingress reverse proxy listening on port 80 (and port 443 for TLS). When external requests arrive at the VPS, Caddy inspects the incoming `Host` header and directs the traffic to either:
- The DeployMind control plane (via root domain or `deploymind.<domain>`).
- An isolated application container or native process (via `<subdomain>.<domain>`).

By configuring a wildcard DNS record, every new deployment receives an active subdomain without requiring repetitive DNS adjustments.

---

## 2. Prerequisites

1. A domain name registered with GoDaddy (e.g., `testexample.com`).
2. A VPS with a static public IPv4 address (e.g., `123.45.67.89`).
3. DeployMind running on the VPS.

---

## 3. GoDaddy DNS Configuration

Choose the scenario that matches your infrastructure:

### Scenario A: Dedicated Domain (Root Domain Assigned to VPS)
Use this when `testexample.com` is dedicated exclusively to this DeployMind installation.

| Record Type | Name / Host | Target / Points To | TTL | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **A** | `@` | `<YOUR_VPS_PUBLIC_IP>` | 1/2 Hour (or default) | Directs root domain (`testexample.com`) to VPS |
| **A** | `*` | `<YOUR_VPS_PUBLIC_IP>` | 1/2 Hour (or default) | Directs all subdomains (`*.testexample.com`) to VPS |

---

### Scenario B: Subdomain Delegation (When Root Domain is in Use by an Existing Website)
Use this if `testexample.com` is already hosting an existing website. You **do not touch or modify the root `@` record**. Instead, you dedicate a subdomain such as `vps.testexample.com` (or `apps.testexample.com`) to DeployMind.

In GoDaddy DNS, leave `@` as is, and add these two records:

| Record Type | Name / Host | Target / Points To | TTL | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **A** | `vps` | `<YOUR_VPS_PUBLIC_IP>` | 1/2 Hour (or default) | Directs `vps.testexample.com` (DeployMind Dashboard) to VPS |
| **A** | `*.vps` | `<YOUR_VPS_PUBLIC_IP>` | 1/2 Hour (or default) | **Nested Wildcard:** Directs all app subdomains (`*.vps.testexample.com`) to VPS |

#### How Nested Wildcard (`*.vps`) Works
- `vps.testexample.com` routes to the DeployMind Control Plane.
- `recordly.vps.testexample.com` routes to the Recordly service.
- `app1.vps.testexample.com` routes to App 1.
- Your primary website at `testexample.com` and `www.testexample.com` remains completely untouched and unaffected.

---

## 4. VPS Firewall and Port Configuration

Ensure traffic on standard HTTP (port 80) and HTTPS (port 443) can reach Caddy:

### Ubuntu / Debian (UFW)
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

### Cloud Provider Security Groups
If the VPS operates in a cloud provider (AWS EC2, DigitalOcean, Hetzner, GCP, or Linode), confirm that the associated Security Group or Firewall permits inbound TCP traffic on ports `80` and `443` from `0.0.0.0/0`.

---

## 5. DeployMind Environment Configuration

In the DeployMind installation directory, set `BASE_DOMAIN` in `.env`:

```env
# Scenario A (Dedicated Domain):
# BASE_DOMAIN=testexample.com

# Scenario B (Subdomain Delegation when root domain is already in use):
BASE_DOMAIN=vps.testexample.com
```

Save the file and restart DeployMind.

---

## 6. Traffic Flow Architecture (Scenario B Example)

```
User Browser
     │
     ▼
GoDaddy DNS (*.vps.testexample.com)
     │
     ▼ Resolves to VPS Public IP
VPS Port 80 (Caddy Ingress)
     │
     ├─► Host: vps.testexample.com ────────────► DeployMind Control Plane (:3000)
     ├─► Host: recordly.vps.testexample.com ───► Recordly Service (:4000)
     └─► Host: app1.vps.testexample.com ───────► App 1 Container

(External primary site at testexample.com continues to route to its existing host untouched)
```

---

## 7. Verification

Once DNS propagation is complete (typically 5 to 30 minutes), verify the configuration:

### 1. Check DNS Resolution
```bash
dig +short testexample.com
dig +short recordly.testexample.com
```
Both commands should return your VPS public IP address.

### 2. Verify HTTP Response
```bash
curl -I http://testexample.com/
curl -I http://recordly.testexample.com/
```
Both endpoints should return `HTTP/1.1 200 OK` with the `Via: 1.1 Caddy` header.

---

## 8. Summary Checklist

- [ ] Added `@` A record pointing to VPS public IP in GoDaddy.
- [ ] Added `*` A record pointing to VPS public IP in GoDaddy.
- [ ] Confirmed ports 80 and 443 are open on the VPS firewall.
- [ ] Configured `BASE_DOMAIN=testexample.com` in `.env`.
- [ ] Deployed an application and validated access via `<app-name>.testexample.com`.
