import json
import asyncio
import logging
import re
import urllib.parse
from typing import List, Dict, Any, Optional
import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger("uvicorn.error")

class WebSearchTools:
    """Provides native autonomous web search capabilities for the OmniMind agent."""

    # Define the OpenAI-structured tool schemas to inject into the LLM
    TOOL_SCHEMAS = [
        {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "Perform a DuckDuckGo web search to find relevant information or URLs for deep research.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query (e.g. 'Claude 3.7 sonnet release date')"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of search results to return (default: 5)"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_url",
                "description": "Scrape and read the textual content of a specific webpage URL.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The exact URL to scrape and read."
                        }
                    },
                    "required": ["url"]
                }
            }
        }
    ]

    async def search_web(self, query: str, max_results: int = 5, include_content: bool = True) -> str:
        """Search the web and return a JSON string of normalized results.

        The old duckduckgo_search package can abort the Python process in some
        macOS/headless environments while loading native certificates. Direct
        HTML search keeps failures inside normal Python exceptions and gives us
        multiple fallback engines.
        """
        try:
            raw_results = await self._search_html(query, max_results=max(max_results * 2, 8))
            if not raw_results:
                return "No useful search results found for the query."
            
            # Apply Domain Diversity for the simple search results
            final_results = []
            seen_domains = set()
            for r in raw_results:
                domain = urllib.parse.urlparse(r.get('href', '')).netloc
                if domain and domain not in seen_domains:
                    final_results.append(r)
                    seen_domains.add(domain)
                if len(final_results) >= max_results:
                    break
                
            # If diversity resulted in too few results, fill back in with others
            if len(final_results) < min(3, max_results):
                for r in raw_results:
                    if r not in final_results:
                        final_results.append(r)
                    if len(final_results) >= max_results:
                        break

            # Clean and compact results to prevent context window overflow
            compact_results = []
            for r in final_results:
                item = {
                    "title": r.get("title", ""),
                    "href": r.get("href", ""),
                    "snippet": (r.get("body") or "")[:250],
                }
                if "scraped_content" in r:
                    item["scraped_content"] = r["scraped_content"][:1200]
                compact_results.append(item)

            return json.dumps(compact_results, indent=2)
        except Exception as e:
            logger.error(f"Error executing web search for query '{query}': {e}", exc_info=True)
            return f"Error executing web search: {str(e)}"

    async def _search_html(self, query: str, max_results: int = 10) -> List[Dict[str, str]]:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=12.0, headers=headers) as client:
            searchers = [
                self._search_duckduckgo_html,
                self._search_duckduckgo_lite,
                self._search_bing_html,
            ]
            errors = []
            for searcher in searchers:
                try:
                    results = await searcher(client, query, max_results)
                    results = self._normalize_results(results)
                    if results:
                        return results[:max_results]
                except Exception as e:
                    errors.append(f"{searcher.__name__}: {e}")
                    logger.warning(f"{searcher.__name__} failed for query '{query}': {e}")

        if errors:
            logger.warning(f"All search fallbacks failed for query '{query}': {'; '.join(errors)}")
        return []

    async def _search_duckduckgo_html(self, client: httpx.AsyncClient, query: str, max_results: int) -> List[Dict[str, str]]:
        response = await client.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        for result in soup.select(".result"):
            link = result.select_one(".result__a")
            snippet = result.select_one(".result__snippet")
            if not link:
                continue
            results.append({
                "title": link.get_text(" ", strip=True),
                "href": self._unwrap_duckduckgo_url(link.get("href", "")),
                "body": snippet.get_text(" ", strip=True) if snippet else "",
            })
            if len(results) >= max_results:
                break
        return results

    async def _search_duckduckgo_lite(self, client: httpx.AsyncClient, query: str, max_results: int) -> List[Dict[str, str]]:
        response = await client.get(
            "https://lite.duckduckgo.com/lite/",
            params={"q": query},
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        for link in soup.select("a.result-link, td.result-link a"):
            row = link.find_parent("tr")
            snippet = ""
            if row:
                next_row = row.find_next_sibling("tr")
                if next_row:
                    snippet = next_row.get_text(" ", strip=True)
            results.append({
                "title": link.get_text(" ", strip=True),
                "href": self._unwrap_duckduckgo_url(link.get("href", "")),
                "body": snippet,
            })
            if len(results) >= max_results:
                break
        return results

    async def _search_bing_html(self, client: httpx.AsyncClient, query: str, max_results: int) -> List[Dict[str, str]]:
        response = await client.get(
            "https://www.bing.com/search",
            params={"q": query, "count": max_results},
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results = []
        for result in soup.select("li.b_algo"):
            link = result.select_one("h2 a")
            snippet = result.select_one(".b_caption p")
            if not link:
                continue
            results.append({
                "title": link.get_text(" ", strip=True),
                "href": link.get("href", ""),
                "body": snippet.get_text(" ", strip=True) if snippet else "",
            })
            if len(results) >= max_results:
                break
        return results

    def _normalize_results(self, results: List[Dict[str, str]]) -> List[Dict[str, str]]:
        normalized = []
        seen = set()
        for result in results:
            href = (result.get("href") or "").strip()
            title = (result.get("title") or "").strip()
            if not href or not title:
                continue
            if href.startswith("//"):
                href = f"https:{href}"
            if not href.startswith(("http://", "https://")):
                continue
            clean_url = self._canonicalize_url(href)
            if clean_url in seen:
                continue
            seen.add(clean_url)
            normalized.append({
                "title": title,
                "href": clean_url,
                "body": (result.get("body") or "").strip(),
            })
        return normalized

    def _unwrap_duckduckgo_url(self, url: str) -> str:
        if not url:
            return ""
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        uddg = query.get("uddg")
        if uddg:
            return urllib.parse.unquote(uddg[0])
        return urllib.parse.urljoin("https://duckduckgo.com", url)

    def _canonicalize_url(self, url: str) -> str:
        parsed = urllib.parse.urlparse(url)
        query_pairs = [
            (key, value)
            for key, value in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            if not key.lower().startswith("utm_") and key.lower() not in {"fbclid", "gclid"}
        ]
        return urllib.parse.urlunparse((
            parsed.scheme,
            parsed.netloc.lower(),
            parsed.path or "/",
            "",
            urllib.parse.urlencode(query_pairs, doseq=True),
            "",
        ))

    async def read_url(self, url: str, max_retries: int = 2) -> str:
        """Fetch a URL and extract readable article-like text with retries."""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        }
        
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, headers=headers) as client:
            for attempt in range(max_retries + 1):
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    content_type = response.headers.get("content-type", "").lower()
                    if "text/html" not in content_type and "application/xhtml+xml" not in content_type and "text/plain" not in content_type:
                        return f"Error reading URL {url}: unsupported content type '{content_type or 'unknown'}'"
                    
                    if "text/plain" in content_type:
                        text = response.text
                    else:
                        text = self._extract_readable_text(response.text, url)
                    
                    # Truncate text if it's monstrously large for basic tool use
                    # Orchestrator will handle chunking for full deep research
                    max_chars = 15000 
                    if len(text) > max_chars:
                        text = text[:max_chars] + "\n\n...[Content Truncated due to length]..."
                        
                    return text
                except Exception as e:
                    if attempt == max_retries:
                        return f"Error reading URL {url} after {max_retries + 1} attempts: {str(e)}"
                    # Small wait before retry
                    await asyncio.sleep(1 * (attempt + 1))

    def _extract_readable_text(self, html_text: str, url: str) -> str:
        soup = BeautifulSoup(html_text, 'html.parser')

        metadata = self._extract_metadata(soup, url)
        structured_bits = self._extract_structured_data(soup)

        # Remove scripts, styles, and navigational junk before scoring content.
        for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "iframe", "aside", "form", "svg", "canvas"]):
            tag.decompose()
        for tag in soup.select("[aria-hidden='true'], .ad, .ads, .advertisement, .cookie, .newsletter, .subscribe, .social, .share"):
            tag.decompose()

        content_root = self._select_best_content_root(soup)
        blocks = self._extract_text_blocks(content_root)

        parts = []
        for value in metadata + structured_bits + blocks:
            clean = self._clean_text(value)
            if clean and clean not in parts:
                parts.append(clean)

        text = "\n\n".join(parts)
        return text or "No readable text content found on this page."

    def _extract_metadata(self, soup: BeautifulSoup, url: str) -> List[str]:
        values = [f"Source URL: {url}"]
        if soup.title and soup.title.string:
            values.append(f"Title: {soup.title.string}")
        selectors = [
            ("Description", "meta[name='description']"),
            ("Published", "meta[property='article:published_time']"),
            ("Modified", "meta[property='article:modified_time']"),
            ("Author", "meta[name='author']"),
            ("Site", "meta[property='og:site_name']"),
        ]
        for label, selector in selectors:
            tag = soup.select_one(selector)
            content = tag.get("content", "") if tag else ""
            if content:
                values.append(f"{label}: {content}")
        return values

    def _extract_structured_data(self, soup: BeautifulSoup) -> List[str]:
        values = []
        for script in soup.select("script[type='application/ld+json']"):
            raw = script.string or script.get_text("", strip=True)
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except Exception:
                continue
            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict):
                    continue
                for key in ("headline", "description", "datePublished", "dateModified", "author"):
                    value = item.get(key)
                    if isinstance(value, dict):
                        value = value.get("name")
                    if isinstance(value, list):
                        value = ", ".join(v.get("name", str(v)) if isinstance(v, dict) else str(v) for v in value)
                    if value:
                        values.append(f"{key}: {value}")
                article_body = item.get("articleBody")
                if article_body:
                    values.append(str(article_body))
        return values

    def _select_best_content_root(self, soup: BeautifulSoup):
        candidates = soup.select("article, main, [role='main'], .article, .post, .entry-content, .post-content, .article-body, #content")
        if not candidates:
            return soup.body or soup

        def score(node) -> int:
            paragraphs = node.find_all("p")
            text_len = len(node.get_text(" ", strip=True))
            link_len = sum(len(a.get_text(" ", strip=True)) for a in node.find_all("a"))
            return text_len + (len(paragraphs) * 120) - link_len

        return max(candidates, key=score)

    def _extract_text_blocks(self, root) -> List[str]:
        blocks = []
        for tag in root.find_all(["h1", "h2", "h3", "p", "li", "blockquote", "pre", "td"], recursive=True):
            text = tag.get_text(" ", strip=True)
            if len(text) < 35 and tag.name not in {"h1", "h2", "h3"}:
                continue
            if self._looks_like_boilerplate(text):
                continue
            blocks.append(text)
        if not blocks:
            blocks = [root.get_text("\n", strip=True)]
        return blocks

    def _looks_like_boilerplate(self, text: str) -> bool:
        lowered = text.lower()
        boilerplate = [
            "accept cookies",
            "all rights reserved",
            "sign up",
            "subscribe",
            "enable javascript",
            "privacy policy",
            "terms of service",
            "advertisement",
        ]
        return any(marker in lowered for marker in boilerplate)

    def _clean_text(self, text: str) -> str:
        text = re.sub(r'[ \t\r\f\v]+', ' ', str(text))
        text = re.sub(r'\n\s*\n\s*\n+', '\n\n', text)
        return text.strip()

    async def fetch_multiple_urls(self, urls: List[str]) -> List[Dict[str, str]]:
        """Fetches multiple URLs in parallel."""
        tasks = [self.read_url(url) for url in urls]
        results = await asyncio.gather(*tasks)
        
        formatted_results = []
        for url, res in zip(urls, results):
            formatted_results.append({
                "url": url,
                "content": res
            })
        return formatted_results

# Singleton for easy import
web_search_tools = WebSearchTools()
