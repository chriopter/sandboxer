<p align="center">
  <img src="logo.png" width="100" /><br><br>
  <b>Sandboxer</b><br><br>
  Claude Code IDE for dedicated machines.<br>
  Run parallel agents, schedule tasks, monitor live, SSH takeover.
</p>

---

## Features

- **Live agent grid** - Multiple Claude sessions with real-time terminal preview
- **One-click spawn** - Claude, Gemini, lazygit, bash sessions
- **Scheduled agents** - Cron-based automation via `.sandboxer/cron-*.yaml`
- **SSH takeover** - `sandboxer-shell` to attach any session from terminal
- **Session persistence** - All sessions survive restarts (tmux)

<img width="2528" height="1428" alt="image" src="https://github.com/user-attachments/assets/6b2e0306-d9b3-4151-b94d-a90fae7573ce" />

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated machine

2. Run:
   ```bash
   claude --dangerously-skip-permissions "clone github.com/chriopter/sandboxer to /home/sandboxer/git/sandboxer, read README.md for install instructions, then install sandboxer"
   ```

3. Access `http://<host>:8080` — default: `admin` / `admin`

4. Change password: `claude -p "change sandboxer password to YOUR_PASSWORD"`

<details>
<summary>Manual install steps (for Claude)</summary>

```bash
# Dependencies
apt update && apt install -y python3 python3-pip tmux caddy fzf
pip3 install pyyaml croniter psutil

# lazygit
LAZYGIT_VERSION=$(curl -s "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" | grep -Po '"tag_name": "v\K[^"]*')
curl -Lo lazygit.tar.gz "https://github.com/jesseduffield/lazygit/releases/latest/download/lazygit_${LAZYGIT_VERSION}_Linux_x86_64.tar.gz"
tar xf lazygit.tar.gz lazygit && install lazygit /usr/local/bin && rm lazygit lazygit.tar.gz

# Setup
useradd -m -s /bin/bash sandboxer || true
mkdir -p /home/sandboxer/git /etc/sandboxer /var/log/sandboxer
chown -R sandboxer:sandboxer /home/sandboxer /etc/sandboxer /var/log/sandboxer

git clone https://github.com/chriopter/sandboxer.git /home/sandboxer/git/sandboxer
chown -R sandboxer:sandboxer /home/sandboxer/git/sandboxer
git config --global --add safe.directory /home/sandboxer/git/sandboxer

ln -sf /home/sandboxer/git/sandboxer/config/sandboxer-shell /usr/local/bin/sandboxer-shell
cp /home/sandboxer/git/sandboxer/sandboxer.service /etc/systemd/system/
cp /home/sandboxer/git/sandboxer/Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload && systemctl enable sandboxer && systemctl start sandboxer
systemctl restart caddy

/home/sandboxer/git/sandboxer/set-password.sh admin
```
</details>

## Security

> **Warning**: Only use on dedicated/disposable machines without secrets.

**GitHub PAT permissions:** Contents (rw), Issues (rw), Actions (r), Metadata (r)

---

v2.0 · Built with [xterm.js](https://xtermjs.org/)
