<p align="center">
  <img src="logo.png" width="100" /><br><br>
  <b>Sandboxer</b><br><br>
  An agent orchestrator IDE for disposable machines.<br>
  Run multiple AI agents in parallel, monitor live, schedule tasks, and take over via SSH.
</p>

---


## Features

- **Multi-agent dashboard** - Run and monitor multiple Claude/Gemini sessions in a live grid view
- **One-click sessions** - Instantly spawn claude, chat, lazygit, bash, or gemini sessions
- **Scheduled agents** - Cron-based agent scheduling via `.sandboxer/cron-*.yaml` with conditions
- **SSH takeover** - `ssh -t sandboxer@host sandboxer-shell` to take over any session
- **Mobile chat UI** - Lightweight chat interface as alternative to terminal
- **Session persistence** - All sessions survive restarts via tmux

<img width="2528" height="1428" alt="image" src="https://github.com/user-attachments/assets/6b2e0306-d9b3-4151-b94d-a90fae7573ce" />

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated/disposable machine

2. Run:
   ```bash
   claude --dangerously-skip-permissions "clone github.com/chriopter/sandboxer to /home/sandboxer/git/sandboxer, read README.md for install instructions, then install sandboxer"
   ```

3. Access at `http://<host>:8080` — default: `admin` / `admin`

4. Change password: `claude --dangerously-skip-permissions "change sandboxer password to YOUR_PASSWORD"`

5. Clone repos: `claude --dangerously-skip-permissions "clone github.com/user/repo to /home/sandboxer/git/repo"`

<details>
<summary>Manual Installation Steps (for Claude)</summary>

### Dependencies

```bash
apt update && apt install -y python3 python3-pip tmux fzf
pip3 install pyyaml croniter

# ttyd (web terminal)
curl -sL https://github.com/nicm/tmux/releases/download/tmux/ttyd -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd
# Or: apt install ttyd

# Caddy (reverse proxy)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy

# lazygit
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit && install lazygit /usr/local/bin && rm lazygit lazygit.tar.gz
```

### Setup

```bash
# Create user and directories
useradd -m -s /bin/bash sandboxer || true
mkdir -p /home/sandboxer/git /etc/sandboxer /var/log/sandboxer
chown -R sandboxer:sandboxer /home/sandboxer /etc/sandboxer /var/log/sandboxer

# Clone repo (if not already)
git clone https://github.com/chriopter/sandboxer.git /home/sandboxer/git/sandboxer
chown -R sandboxer:sandboxer /home/sandboxer/git/sandboxer
git config --global --add safe.directory /home/sandboxer/git/sandboxer

# Symlinks
ln -sf /home/sandboxer/git/sandboxer/sandboxer-shell /usr/local/bin/sandboxer-shell

# Systemd service
cp /home/sandboxer/git/sandboxer/sandboxer.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable sandboxer
systemctl start sandboxer

# Caddy config
cp /home/sandboxer/git/sandboxer/Caddyfile /etc/caddy/Caddyfile
systemctl restart caddy

# Set password (creates .sandbox-auth)
/home/sandboxer/git/sandboxer/set-password.sh admin
```

### Verify

```bash
systemctl status sandboxer  # Should be active
curl -u admin:admin http://localhost:8080  # Should return HTML
```

</details>

## Security

> **Warning**: This gives Claude complete control of a machine. Only use on a disposable VM without secrets.

### GitHub Token Best Practices

**Fine-grained PAT permissions (recommended):**
- Actions: Read-only
- Contents: Read and write
- Issues: Read and write
- Metadata: Read-only (required)

**Branch protection:** Require pull request reviews, restrict who can push, restrict deletions, require linear history, block force pushes.

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
    mode TEXT,                 -- 'cli' (terminal) or 'chat' (web UI)
    title TEXT,
    claude_session_id TEXT,    -- For Claude's --resume/--session-id
    created_at TEXT,
    updated_at TEXT
);
```

Sessions use tmux for terminal persistence.

</details>


---

Built with [webtui](https://github.com/webtui/webtui)
