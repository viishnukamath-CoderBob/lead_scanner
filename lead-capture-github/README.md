# Lead Capture – event nametag scanning web app

Browser-based (PWA-capable) app: log in → pick demo topic/booth → scan nametag with the device camera → review → Hot/Warm/Cold + notes → save → next attendee.
Admin area (same URL) with live dashboard, user & topic management and **Excel (.xlsx) export**.

## Features
- **Auth**: username/password (scrypt hashes), HttpOnly session cookie, login throttling, roles `admin` / `user`, same-origin (CSRF) checks, CSP.
- **Scanning** (works on Chrome, Edge, Safari, mobile browsers; camera needs HTTPS):
  - Nametag text OCR, fully on-device (tesseract.js served from this app): crops to the on-screen frame, ignores the event header, reads Firstname Lastname + Company Name. Auto-captures when two consecutive reads agree; "Capture now" button and manual entry as fallbacks. Clear message if camera permission is denied.
- **Centralised database**: PostgreSQL when `DATABASE_URL` is set (production); local SQLite file otherwise (dev/demo).
- **Real-time sync**: Server-Sent Events push every create/update/delete to all signed-in devices (leads list, admin dashboard).
- **Offline tolerance**: if the network drops, leads are queued on the device and auto-synced (idempotent via `client_id`).
- **Admin**: stats by temperature/topic/team member, manage topics (add/rename/disable), manage users (create, reset password, disable), edit/delete any lead, **Export Excel** (Leads + Summary sheets).

## Run locally
```
npm install
ADMIN_PASSWORD='choose-a-password' npm start     # http://localhost:3000
```
Camera works on `http://localhost`; on other devices it requires HTTPS (see deploy).
If `ADMIN_PASSWORD` is not set, a random one is printed in the log on first start.

## Deploy (shared HTTPS URL)
**Render (easiest):** push this folder to GitHub → Render → *New > Blueprint* → select repo. `render.yaml` provisions the web service + PostgreSQL. Set `ADMIN_PASSWORD` when prompted. The resulting `https://….onrender.com` URL is the shared link.

**Any Docker host (Fly.io, Railway, Cloud Run, Azure, IBM Code Engine…):** build the `Dockerfile`, set env vars below, attach a PostgreSQL database, and make sure TLS is terminated by the platform.

| Env var | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (enables cloud DB). Set `PGSSL=disable` if your DB has no TLS. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Initial admin account (created only when the users table is empty) |
| `SEED_TOPICS` | Comma-separated initial topics |
| `FORCE_HTTPS=1` | Redirect HTTP→HTTPS behind a proxy |
| `PORT` | Listen port |

Requires Node ≥ 22.5 (only for the SQLite fallback; uses built-in `node:sqlite`).

## After deploying
1. Sign in as admin → **Admin** tab → add your demo topics and create a user per booth/presenter.
2. Share the URL. Users sign in, choose a topic (tap the topic chip in the header to switch) and start scanning.
3. **Admin → Export Excel** any time.
