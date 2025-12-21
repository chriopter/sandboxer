<p align="center">
  <img src="logo.png" width="120" />
</p>

<h1 align="center">Sandboxer</h1>

<p align="center">
  Web terminal manager for autonomous Claude Code sessions.<br>
  Run multiple Claude instances with <code>--dangerously-skip-permissions</code> on a disposable machine.
</p>

---

<img width="100%" alt="Dashboard" src="https://github.com/user-attachments/assets/e6105295-a898-4070-bc06-3458777144ec" />

## Features

- **Live previews** - See all sessions at a glance in a grid layout
- **Session persistence** - tmux-backed sessions survive restarts
- **SSH takeover** - Take over any session from your terminal (TAB for multi-select split view)
- **Drag & drop** - Reorder sessions your way
- **Resume sessions** - Pick up previous Claude conversations
- **Multiple directories** - Run Claude in different project contexts
- **Image paste** - Ctrl+V images directly into terminal
- **Gemini CLI** - Claude can use Google's Gemini for second opinions

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated/disposable machine

2. Run:
   ```bash
   claude "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit gemini-cli), copy service files, enable and start services"
   ```

3. Access at `http://<host>:8080` — default: `admin` / `admin`

4. Change password:
   ```bash
   /home/sandboxer/sandboxer-repo/set-password.sh YOUR_PASSWORD
   ```

5. Clone your repos to `/home/sandboxer/git/`:
   ```bash
   git clone <your-repo> /home/sandboxer/git/<repo-name>
   ```
   The folder dropdown only shows subdirectories of `/home/sandboxer/git/`.

## SSH Takeover

Take over sessions from your local terminal:

```bash
ssh -t sandboxer@host sandboxer-shell
```

<img width="500" alt="SSH takeover" src="https://github.com/user-attachments/assets/e748762f-077a-48ef-82de-fad7c351a863" />

Use **TAB** to multi-select sessions → automatic tmux split view.

## Security

> **Warning**: This gives Claude complete control of a machine. Only use on a disposable VM without secrets.

---

Built with [webtui](https://github.com/webtui/webtui)
