"""
MCP OAuth 2.0 client support (RFC 9728 protected resource metadata, RFC 8414
authorization server metadata, RFC 7591 dynamic client registration, and the
OAuth 2.1 authorization code + PKCE flow), per the MCP Authorization spec.

This lets us connect to MCP servers that require a user to sign in via a
browser redirect (e.g. mimilabs) instead of a manually-issued static API key.
"""
import base64
import hashlib
import re
import logging
import secrets
import time
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

import httpx

logger = logging.getLogger("uvicorn.error")

# In-flight authorization requests, keyed by the `state` param. Server-local
# and in-memory: fine for a single-process dev app; a restart mid-flow just
# means the user re-clicks "Authorize".
_pending: Dict[str, Dict[str, Any]] = {}

_PROBE_BODY = {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}
_PROBE_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _pkce_pair():
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


_RESOURCE_METADATA_RE = re.compile(r'resource_metadata="([^"]+)"', re.IGNORECASE)


def parse_resource_metadata_url(www_authenticate: str) -> Optional[str]:
    """Extract resource_metadata="..." from a WWW-Authenticate header value.

    The value is auth-param syntax (RFC 9110 s11.6.1): `Bearer key="v", key2="v2"`
    - space-separated after the scheme, comma-separated between params - so a
    naive comma-split treats "Bearer resource_metadata=..." as one opaque
    token and never matches. A regex search is robust to both layouts.
    """
    match = _RESOURCE_METADATA_RE.search(www_authenticate)
    return match.group(1) if match else None


async def discover_resource_metadata(mcp_url: str) -> Optional[Dict[str, Any]]:
    """Probe the MCP endpoint; if it challenges with a WWW-Authenticate header
    pointing at a protected-resource metadata document, fetch and return it."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(mcp_url, headers=_PROBE_HEADERS, json=_PROBE_BODY)
        if resp.status_code not in (401, 403):
            return None
        metadata_url = parse_resource_metadata_url(resp.headers.get("www-authenticate", ""))
        if not metadata_url:
            return None
        meta_resp = await client.get(metadata_url)
        meta_resp.raise_for_status()
        return meta_resp.json()


async def discover_authorization_server(issuer: str) -> Dict[str, Any]:
    """Fetch OAuth AS metadata for an issuer (RFC 8414), falling back to OIDC discovery."""
    parsed = urlparse(issuer)
    candidates = [
        f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-authorization-server{parsed.path}",
        f"{issuer.rstrip('/')}/.well-known/oauth-authorization-server",
        f"{issuer.rstrip('/')}/.well-known/openid-configuration",
    ]
    async with httpx.AsyncClient(timeout=10.0) as client:
        for url in candidates:
            try:
                resp = await client.get(url)
            except httpx.HTTPError:
                continue
            if resp.status_code == 200:
                return resp.json()
    raise RuntimeError(f"Could not discover OAuth server metadata for issuer '{issuer}'")


async def register_client(registration_endpoint: str, redirect_uri: str) -> Dict[str, Any]:
    """Dynamic Client Registration (RFC 7591) - public client, PKCE only."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            registration_endpoint,
            json={
                "client_name": "OmniMind",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            },
        )
        resp.raise_for_status()
        return resp.json()


async def start_authorization(
    server_id: str,
    mcp_url: str,
    redirect_uri: str,
    existing_oauth: Optional[Dict[str, Any]] = None,
) -> str:
    """Run discovery (and dynamic client registration if needed) and return the
    authorization URL the user's browser should be sent to."""
    resource_metadata = await discover_resource_metadata(mcp_url)
    if not resource_metadata or not resource_metadata.get("authorization_servers"):
        raise RuntimeError("Server did not advertise an OAuth authorization server.")

    issuer = resource_metadata["authorization_servers"][0]
    as_metadata = await discover_authorization_server(issuer)

    client_id = (existing_oauth or {}).get("client_id")
    client_secret = (existing_oauth or {}).get("client_secret")
    if not client_id:
        registration_endpoint = as_metadata.get("registration_endpoint")
        if not registration_endpoint:
            raise RuntimeError(
                "This server requires OAuth but doesn't support dynamic client "
                "registration - it needs a pre-registered client_id, which isn't "
                "supported yet."
            )
        registration = await register_client(registration_endpoint, redirect_uri)
        client_id = registration["client_id"]
        client_secret = registration.get("client_secret")

    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)

    _pending[state] = {
        "server_id": server_id,
        "mcp_url": mcp_url,
        "code_verifier": verifier,
        "client_id": client_id,
        "client_secret": client_secret,
        "token_endpoint": as_metadata["token_endpoint"],
        "redirect_uri": redirect_uri,
        "created_at": time.time(),
    }

    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": mcp_url,
    }
    if as_metadata.get("scopes_supported"):
        params["scope"] = " ".join(as_metadata["scopes_supported"])

    return f"{as_metadata['authorization_endpoint']}?{urlencode(params)}"


async def complete_authorization(code: str, state: str) -> Dict[str, Any]:
    """Exchange the authorization code for tokens.

    Returns {"server_id": ..., "oauth": {...}} to persist against the server.
    """
    ctx = _pending.pop(state, None)
    if not ctx:
        raise RuntimeError("Unknown or expired authorization request. Try connecting again.")

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": ctx["redirect_uri"],
        "client_id": ctx["client_id"],
        "code_verifier": ctx["code_verifier"],
        "resource": ctx["mcp_url"],
    }
    if ctx.get("client_secret"):
        data["client_secret"] = ctx["client_secret"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(ctx["token_endpoint"], data=data, headers={"Accept": "application/json"})
        resp.raise_for_status()
        token_payload = resp.json()

    return {
        "server_id": ctx["server_id"],
        "oauth": _token_payload_to_oauth(token_payload, ctx),
    }


async def refresh_access_token(oauth: Dict[str, Any]) -> Dict[str, Any]:
    """Use the refresh_token grant to mint a new access token."""
    if not oauth.get("refresh_token"):
        raise RuntimeError("No refresh token available.")

    data = {
        "grant_type": "refresh_token",
        "refresh_token": oauth["refresh_token"],
        "client_id": oauth["client_id"],
    }
    if oauth.get("client_secret"):
        data["client_secret"] = oauth["client_secret"]
    if oauth.get("mcp_url"):
        data["resource"] = oauth["mcp_url"]

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(oauth["token_endpoint"], data=data, headers={"Accept": "application/json"})
        resp.raise_for_status()
        token_payload = resp.json()

    return _token_payload_to_oauth(token_payload, oauth)


def _token_payload_to_oauth(token_payload: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
    expires_in = token_payload.get("expires_in")
    return {
        "client_id": ctx["client_id"],
        "client_secret": ctx.get("client_secret"),
        "token_endpoint": ctx["token_endpoint"],
        "mcp_url": ctx.get("mcp_url"),
        "access_token": token_payload["access_token"],
        "refresh_token": token_payload.get("refresh_token", ctx.get("refresh_token")),
        "expires_at": (time.time() + expires_in) if expires_in else None,
    }
