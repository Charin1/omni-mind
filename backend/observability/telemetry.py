"""
OpenTelemetry setup for OmniMind.

Follows the project's graceful-degradation pattern: if the OpenTelemetry
packages aren't installed, or OTEL_ENABLED=false, everything becomes a no-op
and the app boots exactly as before.

Signals:
- Traces  -> OTLP/HTTP  (default http://localhost:4318, the otel-collector)
- Metrics -> OTLP/HTTP  (same collector; scraped by Prometheus, viewed in Grafana)

Auto-instrumentation: FastAPI (server spans), httpx (outbound LLM/tool calls),
SQLAlchemy (DB queries). Domain metrics live in observability/metrics.py.
"""
import logging
import os

logger = logging.getLogger("uvicorn.error")

_OTEL_AVAILABLE = True
try:
    from opentelemetry import metrics as otel_metrics
    from opentelemetry import trace
    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
except ImportError:
    _OTEL_AVAILABLE = False


def init_telemetry(app) -> bool:
    """Initialize tracing + metrics and instrument the app.

    Returns True when telemetry is active, False when disabled/unavailable.
    """
    if not _OTEL_AVAILABLE:
        logger.info("OpenTelemetry packages not installed - telemetry disabled")
        return False

    if os.getenv("OTEL_ENABLED", "true").lower() in ("false", "0", "no"):
        logger.info("OTEL_ENABLED=false - telemetry disabled")
        return False

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    resource = Resource.create({
        "service.name": os.getenv("OTEL_SERVICE_NAME", "omnimind-backend"),
        "service.version": os.getenv("OMNIMIND_VERSION", "dev"),
        "deployment.environment": os.getenv("OMNIMIND_ENV", "local"),
    })

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))
    )
    trace.set_tracer_provider(tracer_provider)

    metric_reader = PeriodicExportingMetricReader(
        OTLPMetricExporter(endpoint=f"{endpoint}/v1/metrics"),
        export_interval_millis=int(os.getenv("OTEL_METRIC_EXPORT_INTERVAL_MS", "10000")),
    )
    # Second-scale buckets - the SDK defaults are tuned for milliseconds and
    # would collapse all sub-5s latencies into one bucket.
    latency_buckets = ExplicitBucketHistogramAggregation(
        boundaries=[0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120, 300]
    )
    meter_provider = MeterProvider(
        resource=resource,
        metric_readers=[metric_reader],
        views=[
            View(instrument_name="omnimind_chat_ttft_seconds", aggregation=latency_buckets),
            View(instrument_name="omnimind_chat_duration_seconds", aggregation=latency_buckets),
            View(instrument_name="omnimind_tool_duration_seconds", aggregation=latency_buckets),
        ],
    )
    otel_metrics.set_meter_provider(meter_provider)

    # Logs: bridge Python logging -> OTLP (collector routes them to Loki).
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=f"{endpoint}/v1/logs"))
    )
    set_logger_provider(logger_provider)
    otel_log_handler = LoggingHandler(level=logging.INFO, logger_provider=logger_provider)
    logging.getLogger().addHandler(otel_log_handler)          # app-wide loggers
    logging.getLogger("uvicorn.error").addHandler(otel_log_handler)  # uvicorn doesn't propagate to root

    # Late import so domain instruments bind to the real MeterProvider
    from observability import metrics as domain_metrics
    domain_metrics.bind_instruments()

    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app)
    except Exception as e:
        logger.warning("FastAPI instrumentation failed: %s", e)

    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        HTTPXClientInstrumentor().instrument()
    except Exception as e:
        logger.warning("httpx instrumentation failed: %s", e)

    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
        from db.database import engine
        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
    except Exception as e:
        logger.warning("SQLAlchemy instrumentation failed: %s", e)

    logger.info("OpenTelemetry active - exporting to %s", endpoint)
    return True
