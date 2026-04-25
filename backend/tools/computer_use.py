"""
Computer Use tools — gives the AI the ability to execute bash commands,
read/write/edit files, and list directories within a sandboxed workspace.

All file operations are restricted to WORKSPACE_ROOT (env var, defaults to
~/omnimind-workspace). Shell commands run inside that directory by default.
"""

import asyncio
import os
import re
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WORKSPACE_ROOT = Path(
    os.getenv("COMPUTER_USE_WORKSPACE", os.path.expanduser("~/omnimind-workspace"))
).resolve()

COMMAND_TIMEOUT_DEFAULT = 30  # seconds
COMMAND_TIMEOUT_MAX = 120
MAX_OUTPUT_CHARS = 50_000  # 50 KB cap per tool result
MAX_FILE_READ_CHARS = 15_000  # keep LLM context manageable

# Commands / patterns that are unconditionally blocked
BLOCKED_PATTERNS: List[re.Pattern] = [
    re.compile(r"\bsudo\b"),
    re.compile(r"\brm\s+(-[rRf]+\s+)*(/|~|\.\.)"),  # rm -rf / etc.
    re.compile(r"\bshutdown\b"),
    re.compile(r"\breboot\b"),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\b\s+.*\bof=/dev/"),
    re.compile(r":\(\)\s*\{"),  # fork bomb
    re.compile(r"\bchmod\s+777\s+/"),
    re.compile(r"\bchown\b.*\s+/"),
    re.compile(r"\bcurl\b.*\|\s*(ba)?sh"),  # pipe-to-shell
    re.compile(r"\bwget\b.*\|\s*(ba)?sh"),
    re.compile(r"\bsystemctl\b"),
    re.compile(r"\blaunchctl\b"),
    re.compile(r"\bdiskutil\b"),
    re.compile(r"\bnc\b.*-[el]"),  # netcat listen
]

# ---------------------------------------------------------------------------
# OpenAI-format tool schemas
# ---------------------------------------------------------------------------

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": (
                "Execute a bash/shell command inside the workspace directory. "
                "Returns stdout, stderr, and exit code. Use this for running scripts, "
                "installing packages, compiling, testing, etc. "
                "The working directory defaults to the sandbox workspace."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute (e.g. 'python main.py', 'ls -la', 'npm install').",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Max seconds to wait (default 30, max 120).",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional sub-directory inside the workspace to run in.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read the contents of a file within the workspace. "
                "Supports optional line-range to read a specific section."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the workspace root.",
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "1-indexed start line (optional).",
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "1-indexed end line, inclusive (optional).",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Create or overwrite a file within the workspace. "
                "Parent directories are created automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the workspace root.",
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file.",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "Find and replace an exact string in a file within the workspace. "
                "The target string must match exactly (including whitespace)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path relative to the workspace root.",
                    },
                    "target": {
                        "type": "string",
                        "description": "The exact string to find and replace.",
                    },
                    "replacement": {
                        "type": "string",
                        "description": "The replacement string.",
                    },
                },
                "required": ["path", "target", "replacement"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": (
                "List the files and directories at the given path within the workspace."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path relative to the workspace root (use '.' for root).",
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "If true, list recursively (max depth 3). Default false.",
                    },
                },
                "required": ["path"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------


def _ensure_workspace():
    """Create the workspace root if it doesn't exist."""
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def _resolve_safe_path(relative_path: str) -> Path:
    """
    Resolve *relative_path* against WORKSPACE_ROOT and verify the result
    doesn't escape the sandbox (e.g. via `../../`).
    """
    _ensure_workspace()
    resolved = (WORKSPACE_ROOT / relative_path).resolve()
    if not str(resolved).startswith(str(WORKSPACE_ROOT)):
        raise PermissionError(
            f"Path '{relative_path}' escapes the workspace sandbox. Access denied."
        )
    return resolved


def _validate_command(command: str) -> Optional[str]:
    """Return an error message if the command is blocked, else None."""
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(command):
            return (
                f"🚫 Command blocked by security policy. "
                f"Matched blocked pattern: {pattern.pattern}"
            )
    return None


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) > limit:
        return text[:limit] + "\n\n...[Output truncated at 50KB]..."
    return text


# ---------------------------------------------------------------------------
# Tool implementation
# ---------------------------------------------------------------------------


class ComputerUseTools:
    """Sandboxed computer-use tools for the OmniMind agent."""

    async def run_command(
        self, command: str, timeout: int = COMMAND_TIMEOUT_DEFAULT, cwd: Optional[str] = None
    ) -> str:
        """Execute a shell command inside the workspace."""
        _ensure_workspace()

        # Security check
        block_msg = _validate_command(command)
        if block_msg:
            return block_msg

        timeout = min(max(timeout, 1), COMMAND_TIMEOUT_MAX)

        work_dir = WORKSPACE_ROOT
        if cwd:
            work_dir = _resolve_safe_path(cwd)
            if not work_dir.is_dir():
                return f"Error: directory '{cwd}' does not exist in workspace."

        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(work_dir),
                # Isolate env – inherit current but pin HOME to workspace
                env={**os.environ, "HOME": str(WORKSPACE_ROOT)},
            )
            try:
                stdout_b, stderr_b = await asyncio.wait_for(
                    proc.communicate(), timeout=timeout
                )
            except asyncio.TimeoutError:
                proc.kill()
                return (
                    f"⏱️ Command timed out after {timeout}s and was terminated.\n"
                    f"Command: {command}"
                )

            stdout = stdout_b.decode(errors="replace")
            stderr = stderr_b.decode(errors="replace")
            exit_code = proc.returncode

            parts = [f"Exit code: {exit_code}"]
            if stdout.strip():
                parts.append(f"--- stdout ---\n{_truncate(stdout)}")
            if stderr.strip():
                parts.append(f"--- stderr ---\n{_truncate(stderr)}")
            if not stdout.strip() and not stderr.strip():
                parts.append("(no output)")

            return "\n".join(parts)
        except Exception as e:
            return f"Error executing command: {str(e)}"

    async def read_file(
        self, path: str, start_line: Optional[int] = None, end_line: Optional[int] = None
    ) -> str:
        """Read a file from the workspace."""
        try:
            resolved = _resolve_safe_path(path)
            if not resolved.exists():
                return f"Error: File '{path}' not found."
            if not resolved.is_file():
                return f"Error: '{path}' is not a file."

            content = resolved.read_text(encoding="utf-8", errors="replace")
            lines = content.splitlines(keepends=True)

            total_lines = len(lines)

            if start_line is not None or end_line is not None:
                s = max((start_line or 1) - 1, 0)
                e = min(end_line or total_lines, total_lines)
                selected = lines[s:e]
                header = f"File: {path}  (lines {s+1}-{e} of {total_lines})\n"
                body = "".join(
                    f"{s + i + 1}: {line}" for i, line in enumerate(selected)
                )
            else:
                header = f"File: {path}  ({total_lines} lines)\n"
                body = "".join(f"{i+1}: {line}" for i, line in enumerate(lines))

            result = header + body
            if len(result) > MAX_FILE_READ_CHARS:
                result = result[:MAX_FILE_READ_CHARS] + "\n\n...[Content truncated]..."
            return result
        except PermissionError as e:
            return str(e)
        except Exception as e:
            return f"Error reading file: {str(e)}"

    async def write_file(self, path: str, content: str) -> str:
        """Write content to a file in the workspace."""
        try:
            resolved = _resolve_safe_path(path)
            resolved.parent.mkdir(parents=True, exist_ok=True)
            resolved.write_text(content, encoding="utf-8")
            lines = content.count("\n") + 1
            return f"✅ Successfully wrote {len(content)} chars ({lines} lines) to {path}"
        except PermissionError as e:
            return str(e)
        except Exception as e:
            return f"Error writing file: {str(e)}"

    async def edit_file(self, path: str, target: str, replacement: str) -> str:
        """Find and replace exact text in a file."""
        try:
            resolved = _resolve_safe_path(path)
            if not resolved.exists():
                return f"Error: File '{path}' not found."

            content = resolved.read_text(encoding="utf-8", errors="replace")
            count = content.count(target)

            if count == 0:
                return (
                    f"Error: Target string not found in '{path}'. "
                    f"Make sure the target matches exactly (including whitespace)."
                )

            new_content = content.replace(target, replacement, 1)
            resolved.write_text(new_content, encoding="utf-8")

            # Find the line number of the replacement
            before = content[: content.index(target)]
            line_no = before.count("\n") + 1

            return (
                f"✅ Replaced 1 occurrence at line {line_no} in {path}. "
                f"({count} total occurrence{'s' if count > 1 else ''} found, replaced first.)"
            )
        except PermissionError as e:
            return str(e)
        except Exception as e:
            return f"Error editing file: {str(e)}"

    async def list_directory(
        self, path: str = ".", recursive: bool = False
    ) -> str:
        """List directory contents in the workspace."""
        try:
            resolved = _resolve_safe_path(path)
            if not resolved.exists():
                return f"Error: Path '{path}' not found."
            if not resolved.is_dir():
                return f"Error: '{path}' is not a directory."

            entries: List[str] = []
            max_depth = 3 if recursive else 1

            def _walk(dir_path: Path, depth: int, prefix: str = ""):
                if depth > max_depth:
                    return
                try:
                    items = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                except PermissionError:
                    entries.append(f"{prefix}[permission denied]")
                    return

                for item in items:
                    # Skip hidden and common noise dirs
                    if item.name.startswith(".") and depth > 1:
                        continue
                    if item.name in {"node_modules", "__pycache__", ".git", ".venv", "venv"}:
                        entries.append(f"{prefix}📁 {item.name}/ (skipped)")
                        continue

                    if item.is_dir():
                        entries.append(f"{prefix}📁 {item.name}/")
                        if recursive:
                            _walk(item, depth + 1, prefix + "  ")
                    else:
                        size = item.stat().st_size
                        if size < 1024:
                            size_str = f"{size}B"
                        elif size < 1024 * 1024:
                            size_str = f"{size / 1024:.1f}KB"
                        else:
                            size_str = f"{size / (1024 * 1024):.1f}MB"
                        entries.append(f"{prefix}📄 {item.name}  ({size_str})")

                    if len(entries) > 500:
                        entries.append("...[listing truncated at 500 entries]...")
                        return

            _walk(resolved, 1)

            header = f"Directory: {path}  ({len(entries)} items)\n"
            return header + "\n".join(entries)
        except PermissionError as e:
            return str(e)
        except Exception as e:
            return f"Error listing directory: {str(e)}"

    def get_tool_description(self, tool_name: str) -> str:
        """Return a human-friendly description for UI display."""
        descriptions = {
            "run_command": "Execute Shell Command",
            "read_file": "Read File",
            "write_file": "Write File",
            "edit_file": "Edit File",
            "list_directory": "List Directory",
        }
        return descriptions.get(tool_name, tool_name)

    def get_tool_icon(self, tool_name: str) -> str:
        """Return an emoji icon for the tool."""
        icons = {
            "run_command": "💻",
            "read_file": "📄",
            "write_file": "✏️",
            "edit_file": "🔧",
            "list_directory": "📂",
        }
        return icons.get(tool_name, "🔨")


# Singleton
computer_use_tools = ComputerUseTools()
