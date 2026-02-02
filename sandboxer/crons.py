"""Cronjob management - scheduled task execution."""

import os
import threading
import time
from datetime import datetime

try:
    import yaml
except ImportError:
    yaml = None

try:
    from croniter import croniter
except ImportError:
    croniter = None

from . import db
from . import sessions

# Constants
GIT_DIR = "/home/sandboxer/git"
CRON_DIR = ".sandboxer"
CRON_FILE_PREFIX = "cron-"
CRON_LOG_FILE = "/var/log/sandboxer/crons.log"
SCAN_INTERVAL = 60  # Scan repos for cron files every 60 seconds
CHECK_INTERVAL = 30  # Check for due jobs every 30 seconds


def log(message: str):
    """Write a log message to the cron log file."""
    try:
        os.makedirs(os.path.dirname(CRON_LOG_FILE), exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(CRON_LOG_FILE, "a") as f:
            f.write(f"[{timestamp}] {message}\n")
    except Exception:
        pass  # Silent fail
    # Also print to stdout for systemd journal
    print(f"[crons] {message}")

# Module state
_scheduler_thread = None
_scheduler_running = False


def get_next_run(schedule: str, from_time: datetime = None) -> datetime | None:
    """Calculate next run time from a cron schedule string."""
    if croniter is None:
        print("[crons] croniter not installed, cannot calculate next run")
        return None

    try:
        base = from_time or datetime.now()
        cron = croniter(schedule, base)
        return cron.get_next(datetime)
    except Exception as e:
        log(f"Invalid schedule '{schedule}': {e}")
        return None


def format_datetime(dt: datetime) -> str:
    """Format datetime as ISO string for database."""
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def parse_datetime(s: str) -> datetime | None:
    """Parse ISO datetime string from database."""
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def parse_cron_file(file_path: str) -> dict | None:
    """Parse a single cron-*.yaml file and return cron definition."""
    if yaml is None:
        log(f"PyYAML not installed, cannot parse {file_path}")
        return None

    try:
        with open(file_path, 'r') as f:
            cron = yaml.safe_load(f)

        if not cron:
            return None

        # Derive name from filename if not specified: cron-foo.yaml -> foo
        filename = os.path.basename(file_path)
        if filename.startswith(CRON_FILE_PREFIX) and filename.endswith('.yaml'):
            default_name = filename[len(CRON_FILE_PREFIX):-5]
        else:
            default_name = filename.replace('.yaml', '')

        name = cron.get('name', default_name)
        schedule = cron.get('schedule')
        cron_type = cron.get('type')

        # Validate required fields
        if not schedule or not cron_type:
            log(f"Skipping {file_path}: missing schedule or type")
            return None

        # Validate type
        if cron_type not in ('claude', 'bash', 'loop'):
            log(f"Skipping {file_path}: invalid type '{cron_type}'")
            return None

        # Validate prompt/command based on type
        if cron_type in ('claude', 'loop') and not cron.get('prompt'):
            log(f"Skipping {file_path}: {cron_type} type requires prompt")
            return None
        if cron_type == 'bash' and not cron.get('command'):
            log(f"Skipping {file_path}: bash type requires command")
            return None

        return {
            'name': name,
            'schedule': schedule,
            'type': cron_type,
            'prompt': cron.get('prompt'),
            'command': cron.get('command'),
            'condition': cron.get('condition'),
            'condition_script': cron.get('condition_script'),
            'enabled': cron.get('enabled', True),
        }
    except Exception as e:
        log(f"Error parsing {file_path}: {e}")
        return None


def discover_crons() -> dict[str, list[dict]]:
    """Scan all repos for .sandboxer/cron-*.yaml files.

    Returns: {repo_path: [cron_definitions]}
    """
    discovered = {}

    try:
        for entry in os.listdir(GIT_DIR):
            repo_path = os.path.join(GIT_DIR, entry)
            if not os.path.isdir(repo_path) or entry.startswith('.'):
                continue

            cron_dir = os.path.join(repo_path, CRON_DIR)
            if not os.path.isdir(cron_dir):
                continue

            crons = []
            for filename in os.listdir(cron_dir):
                if filename.startswith(CRON_FILE_PREFIX) and filename.endswith('.yaml'):
                    cron_file = os.path.join(cron_dir, filename)
                    cron = parse_cron_file(cron_file)
                    if cron:
                        crons.append(cron)

            if crons:
                discovered[repo_path] = crons
    except Exception as e:
        log(f"Error scanning repos: {e}")

    return discovered


def sync_crons_to_db():
    """Discover crons from files and sync to database.

    - Adds new crons
    - Updates existing crons
    - Removes crons that no longer exist in files
    """
    discovered = discover_crons()

    # Track all valid cron IDs from files
    valid_ids = set()

    for repo_path, crons in discovered.items():
        repo_name = os.path.basename(repo_path)

        for cron in crons:
            cron_id = f"{repo_name}:{cron['name']}"
            valid_ids.add(cron_id)

            # Check if cron exists
            existing = db.get_cron(cron_id)

            # Calculate next run if not set or schedule changed
            next_run = None
            if existing:
                # If schedule changed, recalculate next run
                if existing['schedule'] != cron['schedule']:
                    next_dt = get_next_run(cron['schedule'])
                    next_run = format_datetime(next_dt) if next_dt else None
                else:
                    # Keep existing next_run
                    next_run = existing['next_run']
            else:
                # New cron, calculate initial next run
                next_dt = get_next_run(cron['schedule'])
                next_run = format_datetime(next_dt) if next_dt else None

            # Preserve enabled state from DB if it was manually toggled
            enabled = cron['enabled']
            if existing and not cron.get('enabled', True):
                # File says disabled, respect that
                enabled = False
            elif existing:
                # File says enabled (or default), preserve manual toggle from DB
                enabled = bool(existing['enabled'])

            db.upsert_cron(
                cron_id=cron_id,
                repo_path=repo_path,
                name=cron['name'],
                schedule=cron['schedule'],
                cron_type=cron['type'],
                prompt=cron.get('prompt'),
                command=cron.get('command'),
                condition=cron.get('condition'),
                condition_script=cron.get('condition_script'),
                enabled=enabled,
                next_run=next_run
            )

    # Remove crons that no longer exist in files
    all_db_crons = db.get_all_crons()
    for cron in all_db_crons:
        if cron['id'] not in valid_ids:
            log(f"Removing stale cron: {cron['id']}")
            db.delete_cron(cron['id'])


def check_condition(cron: dict) -> tuple[bool, str]:
    """Check if cron condition is met. Returns (should_run, reason)."""
    condition = cron.get('condition')
    condition_script = cron.get('condition_script')

    if not condition and not condition_script:
        return True, "no condition"

    repo_path = cron['repo_path']
    script_path = None

    try:
        import subprocess
        import tempfile

        # If condition_script is provided, write to temp file
        if condition_script:
            with tempfile.NamedTemporaryFile(mode='w', suffix='.sh', delete=False) as f:
                f.write(condition_script)
                script_path = f.name
            os.chmod(script_path, 0o755)
            condition = script_path

        # Run condition script in repo directory
        result = subprocess.run(
            condition,
            shell=True,
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=30  # 30 second timeout for condition check
        )

        if result.returncode == 0:
            return True, "condition met"
        else:
            output = result.stdout.strip() or result.stderr.strip() or f"exit code {result.returncode}"
            return False, f"condition not met: {output[:100]}"

    except subprocess.TimeoutExpired:
        return False, "condition timeout"
    except Exception as e:
        return False, f"condition error: {str(e)[:100]}"
    finally:
        # Clean up temp script file
        if script_path and os.path.exists(script_path):
            try:
                os.unlink(script_path)
            except Exception:
                pass


def execute_cron(cron: dict):
    """Execute a cron job by creating a session and running the command/prompt."""
    cron_id = cron['id']
    repo_path = cron['repo_path']
    cron_type = cron['type']
    prompt = cron.get('prompt')
    command = cron.get('command')

    # Check condition first
    should_run, reason = check_condition(cron)
    if not should_run:
        log(f"Skipping cron {cron_id}: {reason}")
        # Update next_run time even if skipped
        now = datetime.now()
        next_dt = get_next_run(cron['schedule'], now)
        if next_dt:
            db.update_cron_field(cron_id, 'next_run', format_datetime(next_dt))
        return

    # Generate session name
    timestamp = datetime.now().strftime("%H%M")
    repo_name = os.path.basename(repo_path)
    session_name = f"cron-{repo_name}-{cron['name']}-{timestamp}"

    # Sanitize session name (tmux doesn't like dots)
    session_name = sessions.sanitize_session_name(session_name)

    log(f"Executing cron {cron_id}: creating session {session_name}")

    # Record execution start
    execution_id = db.add_cron_execution(cron_id, session_name, "started")

    try:
        import subprocess

        if cron_type == 'bash':
            # Create bash session
            sessions.create_session(session_name, 'bash', repo_path)
            # Send command
            subprocess.run(
                ["tmux", "send-keys", "-t", session_name, command, "Enter"],
                capture_output=True
            )
        elif cron_type == 'claude':
            # Create claude session
            sessions.create_session(session_name, 'claude', repo_path)
            # Wait for claude to fully start up before injecting prompt
            time.sleep(4)
            # Send prompt text
            subprocess.run(
                ["tmux", "send-keys", "-t", session_name, "-l", prompt],
                capture_output=True
            )
            # Small delay to ensure text is received before Enter
            time.sleep(0.5)
            subprocess.run(
                ["tmux", "send-keys", "-t", session_name, "Enter"],
                capture_output=True
            )
        elif cron_type == 'loop':
            # Create loop session
            sessions.create_session(session_name, 'loop', repo_path)
            # Wait for claude-loop to fully start up before injecting prompt
            time.sleep(4)
            # Send prompt text
            subprocess.run(
                ["tmux", "send-keys", "-t", session_name, "-l", prompt],
                capture_output=True
            )
            # Small delay to ensure text is received before Enter
            time.sleep(0.5)
            subprocess.run(
                ["tmux", "send-keys", "-t", session_name, "Enter"],
                capture_output=True
            )

        # Move cron session to front of order so it appears at top
        if session_name in sessions.session_order:
            sessions.session_order.remove(session_name)
            sessions.session_order.insert(0, session_name)
            sessions._save_session_order()

        # Start ttyd for web access
        sessions.start_ttyd(session_name)

        # Update execution status
        db.update_cron_execution(execution_id, "completed")

        # Update last_run and next_run
        now = datetime.now()
        next_dt = get_next_run(cron['schedule'], now)
        db.update_cron_field(cron_id, 'last_run', format_datetime(now))
        if next_dt:
            db.update_cron_field(cron_id, 'next_run', format_datetime(next_dt))

        log(f"Cron {cron_id} executed successfully, next run: {next_dt}")

    except Exception as e:
        log(f"Error executing cron {cron_id}: {e}")
        db.update_cron_execution(execution_id, "failed")


def check_due_crons():
    """Check for and execute any due cron jobs."""
    now = format_datetime(datetime.now())
    due_crons = db.get_due_crons(now)

    for cron in due_crons:
        try:
            execute_cron(cron)
        except Exception as e:
            log(f"Error processing cron {cron['id']}: {e}")


def scheduler_loop():
    """Main scheduler loop - runs in background thread."""
    global _scheduler_running

    print("[crons] Scheduler started")

    last_scan = 0
    last_check = 0

    while _scheduler_running:
        now = time.time()

        # Scan for cron files periodically
        if now - last_scan >= SCAN_INTERVAL:
            try:
                sync_crons_to_db()
            except Exception as e:
                log(f"Error syncing crons: {e}")
            last_scan = now

        # Check for due jobs
        if now - last_check >= CHECK_INTERVAL:
            try:
                check_due_crons()
            except Exception as e:
                log(f"Error checking due crons: {e}")
            last_check = now

        # Sleep briefly to avoid busy waiting
        time.sleep(5)

    print("[crons] Scheduler stopped")


def start_scheduler():
    """Start the cron scheduler background thread."""
    global _scheduler_thread, _scheduler_running

    if _scheduler_thread is not None and _scheduler_thread.is_alive():
        print("[crons] Scheduler already running")
        return

    # Check dependencies
    if yaml is None:
        print("[crons] WARNING: PyYAML not installed, cron scheduler disabled")
        print("[crons] Install with: pip install pyyaml")
        return

    if croniter is None:
        print("[crons] WARNING: croniter not installed, cron scheduler disabled")
        print("[crons] Install with: pip install croniter")
        return

    _scheduler_running = True
    _scheduler_thread = threading.Thread(target=scheduler_loop, daemon=True)
    _scheduler_thread.start()

    # Do initial sync
    try:
        sync_crons_to_db()
    except Exception as e:
        log(f"Error during initial sync: {e}")


def stop_scheduler():
    """Stop the cron scheduler."""
    global _scheduler_running
    _scheduler_running = False


def trigger_cron(cron_id: str) -> tuple[bool, str]:
    """Manually trigger a cron job. Returns (success, message)."""
    cron = db.get_cron(cron_id)
    if not cron:
        return False, f"Cron job '{cron_id}' not found"

    try:
        execute_cron(cron)
        return True, f"Cron job '{cron_id}' triggered successfully"
    except Exception as e:
        return False, f"Error triggering cron: {e}"


def toggle_cron(cron_id: str) -> tuple[bool, str, bool]:
    """Toggle a cron job's enabled state. Returns (success, message, new_state)."""
    cron = db.get_cron(cron_id)
    if not cron:
        return False, f"Cron job '{cron_id}' not found", False

    new_state = not bool(cron['enabled'])
    db.update_cron_field(cron_id, 'enabled', 1 if new_state else 0)

    # If enabling, recalculate next run
    if new_state:
        next_dt = get_next_run(cron['schedule'])
        if next_dt:
            db.update_cron_field(cron_id, 'next_run', format_datetime(next_dt))

    status = "enabled" if new_state else "disabled"
    return True, f"Cron job '{cron_id}' {status}", new_state


def get_crons_for_ui() -> list[dict]:
    """Get all crons with UI-friendly formatting."""
    crons = db.get_all_crons()
    result = []

    for cron in crons:
        repo_name = os.path.basename(cron['repo_path'])

        # Parse next_run for display
        next_run_dt = parse_datetime(cron.get('next_run'))
        next_run_display = None
        if next_run_dt:
            now = datetime.now()
            diff = next_run_dt - now
            if diff.total_seconds() < 0:
                next_run_display = "overdue"
            elif diff.total_seconds() < 60:
                next_run_display = "< 1 min"
            elif diff.total_seconds() < 3600:
                mins = int(diff.total_seconds() / 60)
                next_run_display = f"{mins} min"
            elif diff.total_seconds() < 86400:
                hours = int(diff.total_seconds() / 3600)
                next_run_display = f"{hours}h"
            else:
                days = int(diff.total_seconds() / 86400)
                next_run_display = f"{days}d"

        result.append({
            'id': cron['id'],
            'name': cron['name'],
            'repo': repo_name,
            'repo_path': cron['repo_path'],
            'schedule': cron['schedule'],
            'type': cron['type'],
            'enabled': bool(cron['enabled']),
            'next_run': cron.get('next_run'),
            'next_run_display': next_run_display,
            'last_run': cron.get('last_run'),
        })

    return result
