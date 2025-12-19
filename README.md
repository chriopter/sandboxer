# Sandboxer

Web terminal manager for autonomous Claude Code sessions.
Gives Claude basically complete control of a disposable machine to run multiple Claude instances with --dangerously-skip-permissions.

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

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on your dedicated sandbox machine

2. Run:
   ```bash
   claude "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit), copy service files, enable and start services"
   ```

3. Access at `http://<host>:8080` with login `admin` / `admin`

4. To change password, ask Claude:
   ```
   change the sandboxer password to X (run /home/sandboxer/sandboxer-repo/set-password.sh X)
   ```

---

## Security

- Do not use this if you are sane, it will give claude complete control of a machine.
- Except on a disposable machine or VM without any secrets on it.

---

## Thanks

Built with [webtui](https://github.com/webtui/webtui)
