"""Session management - tmux and ttyd orchestration."""

import json
import os
import signal
import socket
import subprocess

# Configuration
TTYD_BASE_PORT = 7700
TTYD_MAX_PORT = 7799  # Max 100 sessions

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYSTEM_PROMPT_PATH = os.path.join(BASE_DIR, "system-prompt.txt")
WORKDIRS_FILE = "/etc/sandboxer/session_workdirs.json"

# RAM-only state
ttyd_processes: dict[str, tuple[int, int]] = {}  # name -> (pid, port)
session_order: list[str] = []

# Persisted state: session_name -> workdir
session_workdirs: dict[str, str] = {}


# ═══ Workdir Persistence ═══

def _load_workdirs():
    """Load session workdirs from disk."""
    global session_workdirs
    if os.path.isfile(WORKDIRS_FILE):
        try:
            with open(WORKDIRS_FILE) as f:
                session_workdirs = json.load(f)
        except (json.JSONDecodeError, IOError):
            session_workdirs = {}


def _save_workdirs():
    """Save session workdirs to disk."""
    try:
        os.makedirs(os.path.dirname(WORKDIRS_FILE), exist_ok=True)
        with open(WORKDIRS_FILE, "w") as f:
            json.dump(session_workdirs, f)
    except IOError:
        pass  # Silent fail


def _cleanup_workdirs(existing_sessions: set[str]):
    """Remove workdir entries for sessions that no longer exist."""
    global session_workdirs
    stale = [name for name in session_workdirs if name not in existing_sessions]
    if stale:
        for name in stale:
            del session_workdirs[name]
        _save_workdirs()


def get_session_workdir(session_name: str) -> str | None:
    """Get the workdir for a session."""
    return session_workdirs.get(session_name)


# Initialize on module load
_load_workdirs()


# ═══ Ordering (RAM only) ═══

def set_order(order: list[str]):
    """Set session display order."""
    global session_order
    session_order = order


def get_ordered_sessions(sessions: list[dict]) -> list[dict]:
    """Return sessions sorted by stored order, new sessions at end."""
    session_map = {s["name"]: s for s in sessions}
    result = []

    # Add sessions in stored order
    for name in session_order:
        if name in session_map:
            result.append(session_map.pop(name))

    # Add remaining (new) sessions at end
    for session in session_map.values():
        result.append(session)
        session_order.append(session["name"])

    # Clean up stale entries
    existing = {s["name"] for s in sessions}
    session_order[:] = [n for n in session_order if n in existing]

    # Cleanup stale workdir entries and add workdir to each session
    _cleanup_workdirs(existing)
    for s in result:
        s["workdir"] = session_workdirs.get(s["name"])

    return result


# ═══ tmux Operations ═══

def get_tmux_sessions() -> list[dict]:
    """Get list of all tmux sessions."""
    try:
        result = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name}|#{session_created}|#{session_windows}|#{session_attached}"],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            return []

        sessions = []
        for line in result.stdout.strip().split("\n"):
            if line:
                parts = line.split("|")
                name = parts[0]
                # Filter out SSH takeover sessions created by sandboxer-shell
                if name.startswith("split-"):
                    continue
                sessions.append({
                    "name": name,
                    "created": parts[1] if len(parts) > 1 else "",
                    "windows": parts[2] if len(parts) > 2 else "1",
                    "attached": parts[3] == "1" if len(parts) > 3 else False,
                    "title": get_pane_title(name),
                })
        # Sort by creation time (oldest first) so new sessions appear at end
        sessions.sort(key=lambda s: int(s["created"]) if s["created"].isdigit() else 0)
        return sessions
    except Exception:
        return []


def get_pane_title(session_name: str) -> str | None:
    """Get pane title set by Claude Code."""
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-t", session_name, "-p", "#{pane_title}"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            title = result.stdout.strip()
            if title.startswith("\u2733 "):  # ✳
                title = title[2:]
            return title if title and title != "Window Title" else None
    except Exception:
        pass
    return None


def create_session(name: str, session_type: str = "claude", workdir: str = "/home/sandboxer", resume_id: str = None):
    """Create a new tmux session."""
    subprocess.run(["tmux", "new-session", "-d", "-s", name, "-c", workdir], capture_output=True)

    # Enable mouse mode for scrolling
    subprocess.run(["tmux", "set", "-t", name, "mouse", "on"], capture_output=True)

    if session_type == "claude":
        cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --system-prompt {SYSTEM_PROMPT_PATH}"
        subprocess.run(["tmux", "send-keys", "-t", name, cmd, "Enter"], capture_output=True)
    elif session_type == "resume":
        if resume_id:
            cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --resume {resume_id} --system-prompt {SYSTEM_PROMPT_PATH}"
        else:
            cmd = f"IS_SANDBOX=1 claude --dangerously-skip-permissions --resume --system-prompt {SYSTEM_PROMPT_PATH}"
        subprocess.run(["tmux", "send-keys", "-t", name, cmd, "Enter"], capture_output=True)
    elif session_type == "lazygit":
        subprocess.run(["tmux", "send-keys", "-t", name, "lazygit", "Enter"], capture_output=True)
    # bash type: just leave the shell prompt, no command

    # Add to order
    if name not in session_order:
        session_order.append(name)

    # Track workdir (persisted)
    session_workdirs[name] = workdir
    _save_workdirs()


def rename_session(old_name: str, new_name: str) -> bool:
    """Rename a tmux session."""
    result = subprocess.run(["tmux", "rename-session", "-t", old_name, new_name], capture_output=True)
    if result.returncode == 0:
        # Update ttyd mapping
        if old_name in ttyd_processes:
            ttyd_processes[new_name] = ttyd_processes.pop(old_name)
        # Update order
        if old_name in session_order:
            idx = session_order.index(old_name)
            session_order[idx] = new_name
        # Update workdir mapping
        if old_name in session_workdirs:
            session_workdirs[new_name] = session_workdirs.pop(old_name)
            _save_workdirs()
        return True
    return False


def kill_session(name: str):
    """Kill a tmux session and its ttyd."""
    stop_ttyd(name)
    subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)
    if name in session_order:
        session_order.remove(name)
    # Remove workdir tracking
    if name in session_workdirs:
        del session_workdirs[name]
        _save_workdirs()


# ═══ ttyd Management ═══

def find_free_port() -> int:
    """Find a free port in range 7700-7799."""
    used_ports = {port for _, (_, port) in ttyd_processes.items()}
    port = TTYD_BASE_PORT

    while port <= TTYD_MAX_PORT:
        if port not in used_ports:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("127.0.0.1", port))
                    return port
            except OSError:
                pass
        port += 1

    raise RuntimeError("Maximum 100 sessions reached (ports 7700-7799 exhausted)")


def start_ttyd(session_name: str) -> int:
    """Start ttyd for a session, return port."""
    # Check if already running
    if session_name in ttyd_processes:
        pid, port = ttyd_processes[session_name]
        try:
            os.kill(pid, 0)  # Check if process exists
            return port
        except OSError:
            del ttyd_processes[session_name]

    port = find_free_port()

    # Catppuccin Mocha theme (JSON format for xterm.js)
    theme_json = '{"background":"#1e1e2e","foreground":"#cdd6f4","cursor":"#f5e0dc","cursorAccent":"#1e1e2e","selectionBackground":"#585b70","selectionForeground":"#cdd6f4","black":"#45475a","red":"#f38ba8","green":"#a6e3a1","yellow":"#f9e2af","blue":"#89b4fa","magenta":"#f5c2e7","cyan":"#94e2d5","white":"#bac2de","brightBlack":"#585b70","brightRed":"#f38ba8","brightGreen":"#a6e3a1","brightYellow":"#f9e2af","brightBlue":"#89b4fa","brightMagenta":"#f5c2e7","brightCyan":"#94e2d5","brightWhite":"#a6adc8"}'
    theme_opts = ["-t", f"theme={theme_json}"]

    proc = subprocess.Popen(
        ["ttyd", "-W", "-i", "127.0.0.1", "-p", str(port)] + theme_opts + ["tmux", "attach-session", "-t", session_name],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )

    ttyd_processes[session_name] = (proc.pid, port)
    return port


def stop_ttyd(session_name: str):
    """Stop ttyd for a session."""
    if session_name in ttyd_processes:
        pid, _ = ttyd_processes[session_name]
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        del ttyd_processes[session_name]


def get_ttyd_port(session_name: str) -> int | None:
    """Get ttyd port for a session, or None if not running."""
    if session_name in ttyd_processes:
        return ttyd_processes[session_name][1]
    return None


# ═══ Session Naming ═══

def generate_session_name(session_type: str = "claude", workdir: str = "/home/sandboxer") -> str:
    """Generate session name: <dir>-<type>-<number>."""
    dir_name = os.path.basename(workdir.rstrip("/")) or "root"
    prefix = f"{dir_name}-{session_type}-"

    existing = get_tmux_sessions()
    max_num = 0
    for s in existing:
        if s["name"].startswith(prefix):
            try:
                num = int(s["name"][len(prefix):])
                max_num = max(max_num, num)
            except ValueError:
                pass

    return f"{prefix}{max_num + 1}"


# ═══ Directory Discovery ═══

GIT_DIR = "/home/sandboxer/git"

def get_directories() -> list[str]:
    """Get list of starting directories: / and subdirs of /home/sandboxer/git."""
    dirs = ["/"]
    try:
        for entry in sorted(os.listdir(GIT_DIR)):
            path = f"{GIT_DIR}/{entry}"
            if os.path.isdir(path) and not entry.startswith("."):
                dirs.append(path)
    except Exception:
        pass
    return dirs


# ═══ Resume Sessions ═══

def get_resumable_sessions(workdir: str) -> list[dict]:
    """Get list of resumable Claude sessions for a directory."""
    project_dir = workdir.replace("/", "-") if workdir != "/" else "-"
    claude_projects_path = os.path.expanduser(f"~/.claude/projects/{project_dir}")

    sessions = []
    try:
        if os.path.isdir(claude_projects_path):
            for filename in os.listdir(claude_projects_path):
                if filename.startswith("agent-") or not filename.endswith(".jsonl"):
                    continue

                filepath = os.path.join(claude_projects_path, filename)
                session_id = filename[:-6]  # Remove .jsonl
                size = os.path.getsize(filepath)

                if size == 0:
                    continue

                mtime = os.path.getmtime(filepath)
                summary = None
                message_count = 0
                branch = None

                try:
                    with open(filepath, "r") as f:
                        for line in f:
                            try:
                                data = json.loads(line)
                                msg_type = data.get("type")

                                if msg_type in ("user", "assistant", "human"):
                                    message_count += 1

                                if msg_type == "summary":
                                    summary = data.get("summary", "")[:80]

                                if not branch:
                                    branch = data.get("gitBranch")

                                if msg_type in ("user", "human") and not summary:
                                    msg = data.get("message", {})
                                    content = msg.get("content", [])
                                    if content and isinstance(content, list):
                                        for item in content:
                                            if item.get("type") == "text":
                                                text = item.get("text", "").replace("\n", " ").strip()
                                                summary = text[:80]
                                                break
                            except json.JSONDecodeError:
                                pass
                except Exception:
                    pass

                sessions.append({
                    "id": session_id,
                    "size": size,
                    "summary": summary or session_id[:8] + "...",
                    "mtime": mtime,
                    "message_count": message_count,
                    "branch": branch,
                })

        sessions.sort(key=lambda x: x["mtime"], reverse=True)
    except Exception:
        pass

    return sessions
