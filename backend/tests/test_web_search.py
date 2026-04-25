import asyncio
import os
import sys
from unittest.mock import MagicMock, patch

# Add backend to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.web_search import WebSearchTools

async def test_parallel_fetching():
    search_tools = WebSearchTools()
    urls = ["https://example.com/1", "https://example.com/2"]
    
    # Mock read_url to avoid actual network calls during unit test
    with patch.object(WebSearchTools, 'read_url', return_value="Mock Content") as mock_read:
        results = await search_tools.fetch_multiple_urls(urls)
        
        assert len(results) == 2
        assert results[0]['url'] == urls[0]
        assert results[1]['content'] == "Mock Content"
        assert mock_read.call_count == 2
        print("[SUCCESS] Parallel fetching logic verified.")

async def test_retry_logic():
    search_tools = WebSearchTools()
    url = "https://failing-site.com"
    
    # Mock httpx.AsyncClient.get to raise an error
    # We want to verify it retries
    with patch('httpx.AsyncClient.get', side_effect=Exception("Connection Failed")) as mock_get:
        # read_url(url, max_retries=2)
        result = await search_tools.read_url(url, max_retries=1)
        
        # 1 initial + 1 retry = 2 calls
        assert mock_get.call_count == 2
        assert "Error reading URL" in result
        print("[SUCCESS] Retry logic verified.")

async def test_result_normalization():
    search_tools = WebSearchTools()
    results = search_tools._normalize_results([
        {
            "title": "Example",
            "href": "https://Example.com/page?utm_source=test&id=1",
            "body": "Snippet",
        },
        {
            "title": "Duplicate",
            "href": "https://example.com/page?id=1",
            "body": "Duplicate snippet",
        },
        {
            "title": "Bad",
            "href": "/relative-url",
            "body": "Nope",
        },
    ])

    assert len(results) == 1
    assert results[0]["href"] == "https://example.com/page?id=1"
    print("[SUCCESS] Search result normalization verified.")

async def test_readable_text_extraction():
    search_tools = WebSearchTools()
    html = """
    <html>
      <head>
        <title>Research Article</title>
        <meta name="description" content="Useful description">
      </head>
      <body>
        <nav>Navigation junk</nav>
        <article>
          <h1>Research Article</h1>
          <p>This paragraph contains a meaningful fact with enough text to survive filtering.</p>
          <p>accept cookies</p>
        </article>
      </body>
    </html>
    """

    text = search_tools._extract_readable_text(html, "https://example.com/article")
    assert "Source URL: https://example.com/article" in text
    assert "Title: Research Article" in text
    assert "Useful description" in text
    assert "meaningful fact" in text
    assert "Navigation junk" not in text
    assert "accept cookies" not in text
    print("[SUCCESS] Readable text extraction verified.")

async def run_all():
    print("--- Running WebSearchTools Unit Tests ---")
    await test_parallel_fetching()
    await test_retry_logic()
    await test_result_normalization()
    await test_readable_text_extraction()

if __name__ == "__main__":
    asyncio.run(run_all())
