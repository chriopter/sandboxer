<p align="center">
  <img src="logo.png" width="120" />
</p>

<h1 align="center">Sandboxer</h1>

<p align="center">
  Web terminal manager for autonomous Claude Code sessions but Claude takes the wheel for the machine itself.<br>
  Start Sessions in Web, take over via SSH, convert them to chat UI for perfect handling on mobile.
</p>

---

<img width="100%" alt="Dashboard" src="https://github.com/user-attachments/assets/e6105295-a898-4070-bc06-3458777144ec" />

## Features

- **Live previews** - See all sessions at a glance in a grid layout
- **Session persistence** - tmux-backed sessions survive restarts
- **SSH takeover** - `ssh -t sandboxer@host sandboxer-shell` to take over sessions (TAB for multi-select split view)
- **Drag & drop** - Reorder sessions your way
- **Resume sessions** - Pick up previous Claude conversations
- **Multiple directories** - Run Claude in different project contexts
- **Image paste** - Ctrl+V images directly into terminal
- **Gemini CLI** - Claude can use Google's Gemini for second opinions

<img width="500" alt="SSH takeover" src="https://github.com/user-attachments/assets/e748762f-077a-48ef-82de-fad7c351a863" />

## Install

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) on a dedicated/disposable machine

2. Run:
   ```bash
   claude "clone github.com/anthropics/sandboxer to /home/sandboxer/sandboxer-repo, read CLAUDE.md, then install: deps (python3 tmux ttyd caddy lazygit gemini-cli), copy service files, enable and start services"
   ```

3. Access at `http://<host>:8080` — default: `admin` / `admin`

4. Change password: `claude "change sandboxer password to YOUR_PASSWORD"`

5. Clone repos: `claude "clone github.com/user/repo to /home/sandboxer/git/repo"`

## Security

> **Warning**: This gives Claude complete control of a machine. Only use on a disposable VM without secrets.

---

Built with [webtui](https://github.com/webtui/webtui)
