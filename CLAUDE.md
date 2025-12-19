# Sandboxer

Web-based terminal session manager with live previews.

**Runs as root on dedicated sandbox servers.**

## After Changing Code

```bash
sudo systemctl restart sandboxer
```

Sessions (tmux) survive restarts. Only the web UI briefly disconnects.

## Structure

```
sandboxer-repo/
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
- **sessions.py** - tmux/ttyd orchestration, RAM-only state
- **ttyd** - Web terminal, one per session (ports 7700-7799)
- **tmux** - Session persistence layer
- **Caddy** - Reverse proxy (:8080 → server + ttyd), basicauth

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

## Running Locally

```bash
cd /home/sandboxer/sandboxer-repo
python3 -m sandboxer.app
```

## SSH Session Takeover

```bash
ssh -t sandboxer@host "sudo tmux attach -t 'session-name'"
ssh -t sandboxer@host sandboxer-shell  # Interactive picker
```

Detach: `Ctrl-B d` | Switch: `Ctrl-B s`
