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
│   ├── app.py              # HTTP server + session management (~350 lines)
│   ├── ws.py               # WebSocket server for xterm.js
│   ├── static/
│   │   ├── app.js          # Client-side JS
│   │   ├── style.css       # Catppuccin theme
│   │   └── vendor/         # Local xterm.js (NO CDN!)
│   │       ├── xterm.min.js
│   │       ├── xterm.min.css
│   │       ├── addon-fit.min.js
│   │       └── addon-webgl.min.js
│   └── templates/
│       ├── index.html
│       └── terminal.html
├── scripts/
│   └── pull-xterm.sh       # Update xterm.js vendor files
├── config/
│   ├── sandboxer.service
│   ├── Caddyfile
│   ├── system-prompt.txt
│   └── *.sh                # Helper scripts
└── SKILL.md                # OpenClaw skill definition
```

## Architecture

- **app.py** - HTTP server (port 8081), serves UI and manages tmux sessions
- **ws.py** - WebSocket server (port 8082), connects xterm.js to tmux via PTY
- **xterm.js** - Client-side terminal rendering (local vendor files, NO CDN)
- **tmux** - Session persistence layer
- **Caddy** - Reverse proxy (:8080 → server + WebSocket), basicauth

## No CDN Policy

**Never use CDN links for JavaScript or CSS.** All dependencies must be vendored locally:

```bash
# Update xterm.js
./scripts/pull-xterm.sh
```

This ensures the app works offline and doesn't depend on external services.

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

## Auth

Login credentials are in `.sandbox-auth` (gitignored).

## Git Commit Rules

**Multiple agents may be working on this repo simultaneously.** Follow these rules:

1. **Only commit files you touched** - Use `git add <specific-files>` not `git add .`
2. **Always include Claude co-author** - Every commit must have:

```
Commit message here

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

This ensures proper attribution in the git history. See [example commit](https://github.com/chriopter/sandboxer/commit/bd1727faddb59b281f788986d0e61a1bcc21685a).

## Mosh Session Takeover

```bash
mosh sandboxer@host -- sudo tmux attach -t 'session-name'
mosh sandboxer@host -- sandboxer-shell                              # Folder picker → session picker
mosh sandboxer@host -- sandboxer-shell -f /home/sandboxer/git/valiido  # Direct to folder context
mosh sandboxer@host -- sandboxer-shell --all                        # Skip folder picker, show all
```

**Session display format:** `[folder] title (session-name) [time]`

The mosh button in the web UI copies a command with the current folder context.

Detach: `Ctrl-B d` | Switch: `Ctrl-B s`

## CSS Variables (Catppuccin Mocha)

Use these in style.css:

| Variable | Usage |
|----------|-------|
| `--crust` | Darkest background |
| `--base` | Main background |
| `--surface` | Elevated surfaces |
| `--overlay` | Borders, muted elements |
| `--text` | Primary text |
| `--subtext` | Secondary text |
| `--green` | Success, create actions |
| `--red` | Danger, delete actions |
| `--teal` | Links, mosh button |
| `--mauve` | Primary accent |
