# Sandboxer

Web-based terminal session manager with live previews.

**Runs as root on dedicated sandbox servers.**

## Location

All repos live in `/home/sandboxer/git/`. The folder dropdown only shows `/` and subfolders of `/home/sandboxer/git/`.

## After Changing Code

```bash
sudo systemctl restart sandboxer
```

Sessions (tmux) survive restarts. Only the web UI briefly disconnects.

## Structure

```
/home/sandboxer/git/sandboxer/
├── sandboxer/
│   ├── app.py              # HTTP server, routing
│   ├── sessions.py         # tmux/ttyd management
│   ├── static/
│   │   ├── style.css
│   │   ├── main.js
│   │   ├── terminal.js
│   │   ├── catppuccin.css
│   │   └── webtui.css
│   └── templates/
│       ├── index.html
│       └── terminal.html
├── set-password.sh         # Set Caddy basicauth password
├── remove-password.sh      # Remove password protection
├── sandboxer-shell         # SSH session picker script
├── sandboxer.service       # Systemd unit
├── Caddyfile               # Reference config (actual: /etc/caddy/Caddyfile)
└── system-prompt.txt       # Claude system prompt
```

## Architecture

- **app.py** - HTTP server (port 8081), serves UI and manages sessions
- **sessions.py** - tmux/ttyd orchestration, session tracking
- **ttyd** - Web terminal, one per session (ports 7700-7799)
- **tmux** - Session persistence layer
- **Caddy** - Reverse proxy (:8080 → server + ttyd), basicauth

## Folder Context Switching

The folder dropdown acts as a **context switcher**, not just a working directory selector:

- When a folder is selected, only sessions created in that folder are displayed
- Sessions from parent folders and sibling folders are hidden
- Select `/` to show all sessions across all folders

**How it works:**

| File | What it stores |
|------|----------------|
| `/etc/sandboxer/session_workdirs.json` | `{session_name: workdir}` mapping |
| `/etc/sandboxer/selected_folder` | Last selected folder (persistent) |

**Lifecycle:**
- On session create → workdir saved to JSON
- On session delete → entry removed from JSON
- On server start → JSON loaded, stale entries cleaned
- On folder change → cards filtered client-side, selection saved server-side

**Legacy sessions** (created before tracking) are always visible.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Main dashboard |
| GET | `/create?type=claude\|bash\|lazygit&dir=PATH` | Create session |
| GET | `/kill?session=NAME` | Kill session |
| GET | `/terminal?session=NAME` | Full terminal page |
| GET | `/api/sessions` | JSON session list |
| GET | `/api/resume-sessions?dir=PATH` | Resumable Claude sessions |
| GET | `/api/stats` | CPU/mem/disk usage |
| POST | `/api/order` | Set session order |
| POST | `/api/selected-folder` | Save selected folder |

## Running Locally

```bash
cd /home/sandboxer/git/sandboxer
python3 -m sandboxer.app
```

## SSH Session Takeover

```bash
ssh -t sandboxer@host "sudo tmux attach -t 'session-name'"
ssh -t sandboxer@host sandboxer-shell                              # Folder picker → session picker
ssh -t sandboxer@host sandboxer-shell -f /home/sandboxer/git/valiido  # Direct to folder context
ssh -t sandboxer@host sandboxer-shell --all                        # Skip folder picker, show all
```

**Session display format:** `[folder] title (session-name) [time]`

The SSH button in the web UI copies a command with the current folder context.

Detach: `Ctrl-B d` | Switch: `Ctrl-B s`
