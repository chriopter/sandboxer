<p align="center">
  <img src="logo.png" width="100" /><br><br>
  <b>Sandboxer</b><br><br>
  Give Claude root access to a disposable machine and let it run autonomously.<br>
  Monitor multiple agents live, take over via SSH, or switch to chat UI on mobile.
</p>

---

<img width="2812" height="1564" alt="image" src="https://github.com/user-attachments/assets/fb2cebf0-0f94-4b3c-b7ad-9fef30babfca" />

## Features

- **Live previews** - See all Claude sessions at a glance in a scalable grid layout
- **CLI ↔ Chat toggle** - Switch any session between terminal and chat UI; context preserved via `--resume`
- **Mobile chat** - Full chat interface on mobile with real-time sync across devices
- **SSH takeover** - `ssh -t sandboxer@host sandboxer-shell` to take over any session from terminal
- **Session persistence** - All sessions survive restarts; chat history stored in SQLite

<img width="500" alt="SSH takeover" src="https://github.com/user-attachments/assets/e748762f-077a-48ef-82de-fad7c351a863" />

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated/disposable machine

2. Run:
   ```bash
   claude --dangerously-skip-permissions "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit fzf gemini-cli), copy service files, symlink sandboxer-shell to /usr/local/bin, enable and start services"
   ```

3. Access at `http://<host>:8080` — default: `admin` / `admin`

4. Change password: `claude --dangerously-skip-permissions "change sandboxer password to YOUR_PASSWORD"`

5. Clone repos: `claude --dangerously-skip-permissions "clone github.com/user/repo to /home/sandboxer/git/repo"`

## Security

> **Warning**: This gives Claude complete control of a machine. Only use on a disposable VM without secrets.

## Mobile Access (Terminus/Blink)

Set `sandboxer-shell` as your SSH client's startup command:

| App | Setting |
|-----|---------|
| Terminus | Host → Startup Command → `sandboxer-shell` |
| Blink | Config → Startup Command → `sandboxer-shell` |

Then connect via SSH — you'll get folder picker → session picker → attached.

## Technical

<details>
<summary>Data Storage</summary>

All session and message data is stored in SQLite at `/etc/sandboxer/sandboxer.db`:

**Sessions table:**
```sql
CREATE TABLE sessions (
    name TEXT PRIMARY KEY,
    workdir TEXT NOT NULL,
    type TEXT NOT NULL,        -- 'claude', 'chat', 'bash', 'lazygit'
    mode TEXT DEFAULT 'cli',   -- 'cli' or 'chat'
    title TEXT,
    claude_session_id TEXT,    -- For Claude's --resume
    created_at TEXT,
    updated_at TEXT
);
```

**Messages table (chat history):**
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    session_name TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    metadata TEXT,             -- JSON for tool_use etc.
    created_at TEXT
);
```

CLI sessions use tmux for terminal persistence. Chat sessions store both:
- Messages in SQLite (for UI history across refreshes)
- Claude's session UUID for `--resume` (for conversation context)

</details>

<details>
<summary>Chat Sync Architecture</summary>

Chat messages sync across browser tabs via Server-Sent Events (SSE):

1. **On page load**: `/api/chat-sync` sends full history from SQLite, then subscribes to live updates
2. **On message send**: `/api/chat-send` saves to SQLite and broadcasts to all subscribers
3. **Result**: Multiple tabs see the same conversation in real-time

```
Browser Tab 1          Server              Browser Tab 2
     │                   │                      │
     ├──GET /chat-sync──►│◄──GET /chat-sync────┤
     │◄─────history──────┤──────history───────►│
     │                   │                      │
     ├──POST /chat-send─►│                      │
     │                   ├────save to SQLite    │
     │◄────SSE stream────┤────SSE broadcast───►│
     │                   │                      │
```

</details>

---

Built with [webtui](https://github.com/webtui/webtui)
