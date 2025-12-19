# Sandboxer

Web terminal manager for autonomous Claude Code sessions.
Gives Claude basically complete control of a disposable machine to run multiple Claude instances with --dangerously-skip-permissions as root.

<img width="1200" height="1806" alt="image" src="https://github.com/user-attachments/assets/e6105295-a898-4070-bc06-3458777144ec" />

You can also take over individual sessions via ssh
 
<img width="600" height="702" alt="image" src="https://github.com/user-attachments/assets/e748762f-077a-48ef-82de-fad7c351a863" />



## Features

- **Live previews** - See all sessions at a glance in a grid layout
- **Session persistence** - tmux-backed sessions survive restarts
- **SSH takeover** - Take over any session from your local terminal
- **Drag-drop reordering** - Organize sessions your way
- **Resume sessions** - Pick up previous Claude conversations
- **Multiple directories** - Run Claude in different project contexts

---

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on your dedicated / disposable machine

2. Run:
   ```bash
   claude "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit), copy service files, enable and start services"
   ```

3. Access at `http://<host>:8080` — default login: `admin` / `admin`

4. Change password:
   ```bash
   /home/sandboxer/sandboxer-repo/set-password.sh YOUR_PASSWORD
   sudo systemctl restart sandboxer
   ```
   Or ask Claude: `set sandboxer password to X`

---

## Security

- Do not use this if you are sane, it will give claude complete control of a machine.
- Except on a disposable machine or VM without any secrets on it, also limit git access.

---

## Thanks

Built with [webtui](https://github.com/webtui/webtui)
