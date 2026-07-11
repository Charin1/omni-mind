"""
Domain metrics for OmniMind.

Call sites use the module-level helpers (record_chat_request, etc.) which are
safe no-ops until bind_instruments() is called by telemetry.init_telemetry().
If OpenTelemetry isn't installed or is disabled, every helper silently does
nothing, so instrumented code paths need no guards.

Metric catalog (all prefixed `omnimind_`):
- chat_requests_total{provider, model, status}        counter
- chat_ttft_seconds{provider, model}                  histogram (time to first token)
- chat_duration_seconds{provider, model, status}      histogram (full stream)
- chat_tokens_total{provider, model, direction}       counter (input|output)
- active_streams{provider}                            up/down counter
- tool_calls_total{tool, status}                      counter
- tool_duration_seconds{tool}                         histogram
- mcp_connects_total{transport, status}               counter
- memory_retrievals_total{}                           counter
- research_tasks_total{status}                        counter
"""
import time
from contextlib import contextmanager
from typing import Optional

_instruments: dict = {}


def bind_instruments() -> None:
    """Create real OTel instruments. Called once telemetry is configured."""
    from opentelemetry import metrics

    meter = metrics.get_meter("omnimind")
    _instruments["chat_requests"] = meter.create_counter(
        "omnimind_chat_requests_total", description="Chat requests", unit="1"
    )
    _instruments["chat_ttft"] = meter.create_histogram(
        "omnimind_chat_ttft_seconds", description="Time to first streamed token", unit="s"
    )
    _instruments["chat_duration"] = meter.create_histogram(
        "omnimind_chat_duration_seconds", description="Full chat stream duration", unit="s"
    )
    _instruments["chat_tokens"] = meter.create_counter(
        "omnimind_chat_tokens_total", description="Tokens processed", unit="1"
    )
    _instruments["active_streams"] = meter.create_up_down_counter(
        "omnimind_active_streams", description="In-flight chat streams", unit="1"
    )
    _instruments["tool_calls"] = meter.create_counter(
        "omnimind_tool_calls_total", description="Tool invocations", unit="1"
    )
    _instruments["tool_duration"] = meter.create_histogram(
        "omnimind_tool_duration_seconds", description="Tool execution time", unit="s"
    )
    _instruments["mcp_connects"] = meter.create_counter(
        "omnimind_mcp_connects_total", description="MCP connection attempts", unit="1"
    )
    _instruments["memory_retrievals"] = meter.create_counter(
        "omnimind_memory_retrievals_total", description="Semantic memory lookups", unit="1"
    )
    _instruments["research_tasks"] = meter.create_counter(
        "omnimind_research_tasks_total", description="Deep research runs", unit="1"
    )


def record_chat_request(provider: str, model: str, status: str) -> None:
    inst = _instruments.get("chat_requests")
    if inst:
        inst.add(1, {"provider": provider, "model": model, "status": status})


def record_chat_ttft(provider: str, model: str, seconds: float) -> None:
    inst = _instruments.get("chat_ttft")
    if inst:
        inst.record(seconds, {"provider": provider, "model": model})


def record_chat_duration(provider: str, model: str, status: str, seconds: float) -> None:
    inst = _instruments.get("chat_duration")
    if inst:
        inst.record(seconds, {"provider": provider, "model": model, "status": status})


def record_chat_tokens(provider: str, model: str, direction: str, count: int) -> None:
    inst = _instruments.get("chat_tokens")
    if inst and count > 0:
        inst.add(count, {"provider": provider, "model": model, "direction": direction})


def stream_started(provider: str) -> None:
    inst = _instruments.get("active_streams")
    if inst:
        inst.add(1, {"provider": provider})


def stream_finished(provider: str) -> None:
    inst = _instruments.get("active_streams")
    if inst:
        inst.add(-1, {"provider": provider})


def record_tool_call(tool: str, status: str, seconds: Optional[float] = None) -> None:
    inst = _instruments.get("tool_calls")
    if inst:
        inst.add(1, {"tool": tool, "status": status})
    if seconds is not None:
        dur = _instruments.get("tool_duration")
        if dur:
            dur.record(seconds, {"tool": tool})


@contextmanager
def timed_tool_call(tool: str):
    """Context manager that records a tool call with duration + ok/error status."""
    start = time.monotonic()
    try:
        yield
    except Exception:
        record_tool_call(tool, "error", time.monotonic() - start)
        raise
    record_tool_call(tool, "ok", time.monotonic() - start)


def record_mcp_connect(transport: str, status: str) -> None:
    inst = _instruments.get("mcp_connects")
    if inst:
        inst.add(1, {"transport": transport, "status": status})


def record_memory_retrieval(count: int = 1) -> None:
    inst = _instruments.get("memory_retrievals")
    if inst:
        inst.add(count, {})


def record_research_task(status: str) -> None:
    inst = _instruments.get("research_tasks")
    if inst:
        inst.add(1, {"status": status})
