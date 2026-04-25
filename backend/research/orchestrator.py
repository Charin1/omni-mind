import asyncio
import json
import re
import logging
import time
from typing import List, Dict, Any, Optional, Callable
from tools.web_search import web_search_tools
from llm.litellm_gateway import LiteLLMGateway
from providers.base import Message, ModelConfig

logger = logging.getLogger("uvicorn.error")

class ResearchOrchestrator:
    def __init__(self, llm_gateway: LiteLLMGateway):
        self.llm_gateway = llm_gateway

    async def execute_research(
        self, 
        query: str, 
        provider: str, 
        model: str, 
        on_progress: Optional[Any] = None
    ) -> str:
        """Main entry point for agentic deep research."""
        logger.info(f"Starting deep research for: {query}")
        
        async def _emit(msg: str, percent: int):
            if on_progress:
                await on_progress(msg, percent)

        # 1. Intent Analysis
        await _emit("Analyzing research intent...", 10)
        sub_queries = await self._generate_sub_queries(query, provider, model)
        if not sub_queries:
            sub_queries = [query]
            
        # 2. Parallel Search
        await _emit(f"Searching web with {len(sub_queries)} optimized queries...", 30)
        search_tasks = [web_search_tools.search_web(sq, max_results=5, include_content=False) for sq in sub_queries]
        search_results_raw = await asyncio.gather(*search_tasks)
        
        # 3. Extract and Deduplicate URLs with Domain Diversity
        import urllib.parse
        all_urls = []
        for res_json in search_results_raw:
            try:
                results = json.loads(res_json)
                if isinstance(results, list):
                    for r in results:
                        if r.get('href'):
                            all_urls.append(r['href'])
            except:
                continue
        
        seen_urls = set()
        seen_domains = {}
        unique_urls = []
        
        for url in all_urls:
            if url in seen_urls:
                continue
                
            try:
                domain = urllib.parse.urlparse(url).netloc
                if not domain: continue
            except:
                continue
                
            # Diversity Rule: Max 2 pages from the same domain
            count = seen_domains.get(domain, 0)
            if count < 2:
                unique_urls.append(url)
                seen_urls.add(url)
                seen_domains[domain] = count + 1
        
        top_urls = unique_urls[:10] # Slightly increased to 10 for better coverage with diversity
        if not top_urls:
             await _emit("No relevant web results found.", 100)
             return "I couldn't find any relevant web results for your query."

        # 4. Parallel Fetching
        await _emit(f"Fetching {len(top_urls)} relevant sources in parallel...", 50)
        pages = await web_search_tools.fetch_multiple_urls(top_urls)
        
        # 5. Chunked Processing & Knowledge Extraction
        await _emit("Extracting knowledge and analyzing large documents...", 70)
        
        # Determine dynamic chunk size and concurrency based on provider
        p_lower = provider.lower()
        if p_lower in ["ollama", "lmstudio"]:
            max_concurrency = 2
            chunk_size = 6000 # Smaller chunks for local models (~1.5k tokens)
        elif p_lower in ["anthropic", "openai", "gemini", "google"]:
            max_concurrency = 15
            chunk_size = 32000 # Larger chunks for cloud models (~8k tokens)
        else:
            max_concurrency = 5
            chunk_size = 12000
            
        semaphore = asyncio.Semaphore(max_concurrency)
        total_pages = len(pages)
        processed_pages = 0
        import urllib.parse
        
        # Hard limit for the extraction phase (2 minutes)
        RESEARCH_EXTRACT_TIMEOUT = 120 
        start_time = time.time()
        deadline = start_time + RESEARCH_EXTRACT_TIMEOUT
        
        async def _process_with_tracking(page):
            nonlocal processed_pages
            url = page.get("url", "unknown")
            
            # Check if we've passed the global deadline before starting this page
            if time.time() > deadline:
                logger.warning(f"Research deadline reached. Skipping extraction for: {url}")
                return f"Source ({url}): [Skipped due to research time limit]"
                
            try:
                domain = urllib.parse.urlparse(url).netloc
                if not domain: domain = url[:30]
            except:
                domain = url[:30]
                
            # Wrap individual page processing with a local timeout to prevent single-page hangs
            try:
                # Calculate remaining time for this specific page
                remaining = max(5, deadline - time.time())
                res = await asyncio.wait_for(
                    self._process_page(page, query, provider, model, chunk_size, semaphore),
                    timeout=remaining
                )
            except asyncio.TimeoutError:
                logger.warning(f"Page extraction timed out for {url}")
                res = f"Source ({url}): [Extraction timed out]"
            except Exception as e:
                logger.error(f"Error processing page {url}: {e}")
                res = f"Source ({url}): [Error: {str(e)}]"

            processed_pages += 1
            current_p = 70 + int((processed_pages / total_pages) * 15)
            await _emit(f"Analyzed {processed_pages}/{total_pages} sources ({domain})...", current_p)
            return res

        extraction_tasks = [_process_with_tracking(page) for page in pages]
        extraction_results = await asyncio.gather(*extraction_tasks)
        
        # 6. Final Synthesis
        await _emit("Synthesizing final research report with citations...", 90)
        final_report = await self._synthesize(query, extraction_results, provider, model)
        
        await _emit("Research complete.", 100)
        return final_report

    async def _generate_sub_queries(self, query: str, provider: str, model: str) -> List[str]:
        prompt = f"""You are a research planning assistant. Analyze the following complex user query and decompose it into 3-4 specific search queries that would help gather comprehensive information.
        
User Query: {query}

Return ONLY a JSON list of strings. Example: ["query 1", "query 2"]"""
        
        try:
            response = await self.llm_gateway.chat(
                provider=provider,
                messages=[Message(role="user", content=prompt)],
                config=ModelConfig(model=model, temperature=0.3)
            )
            # Extract JSON list
            match = re.search(r'\[.*\]', response, re.DOTALL)
            if match:
                return json.loads(match.group())
        except Exception as e:
            logger.error(f"Error generating sub-queries: {e}")
        return []

    async def _process_page(self, page: Dict[str, str], original_query: str, provider: str, model: str, chunk_size: int, semaphore: asyncio.Semaphore) -> str:
        url = page.get("url", "Unknown")
        content = page.get("content", "")
        
        if content.startswith("Error"):
            return f"Source ({url}): Failed to fetch."

        # Chunking: split content based on model capability
        chunks = [content[i:i + chunk_size] for i in range(0, len(content), chunk_size)]
        
        # If only one chunk, just process it
        if len(chunks) == 1:
            return await self._extract_facts(chunks[0], url, original_query, provider, model, semaphore)
            
        # Process chunks in parallel (throttled by semaphore)
        tasks = [self._extract_facts(c, url, original_query, provider, model, semaphore) for c in chunks]
        results = await asyncio.gather(*tasks)
        return "\n".join(results)

    async def _extract_facts(self, chunk: str, url: str, query: str, provider: str, model: str, semaphore: asyncio.Semaphore) -> str:
        prompt = f"""Extract all key facts, data points, and relevant information from the following text that helps answer the user's query: "{query}"
        
Source URL: {url}
Text Chunk:
---
{chunk}
---

Provide a concise summary of the findings from this chunk. Include specific numbers, dates, and names if present."""
        
        try:
            async with semaphore:
                return await self.llm_gateway.chat(
                    provider=provider,
                    messages=[Message(role="user", content=prompt)],
                    config=ModelConfig(model=model, temperature=0.1, timeout=60.0) # 60s per chunk max
                )
        except Exception as e:
            logger.error(f"Error extracting facts from {url}: {e}")
            return f"Error extracting from {url}"

    async def _synthesize(self, query: str, notes: List[str], provider: str, model: str) -> str:
        combined_notes = "\n\n---\n\n".join(notes)
        prompt = f"""You are a professional research synthesizer. Below are collected notes from multiple web sources regarding the user's query.
        
User Query: {query}

Collected Notes:
{combined_notes}

Task: Provide a comprehensive, well-structured, and detailed research report that answers the user's query in depth. 
- Use clear headings.
- Include citations (using the source URLs provided in the notes).
- Synthesize conflicting information if found.
- Use markdown formatting for readability."""

        try:
            return await self.llm_gateway.chat(
                provider=provider,
                messages=[Message(role="user", content=prompt)],
                config=ModelConfig(model=model, temperature=0.5)
            )
        except Exception as e:
            logger.error(f"Error during synthesis: {e}")
            return "Error during final synthesis of research results."

# Export a singleton-like factory or the class itself
orchestrator = ResearchOrchestrator(LiteLLMGateway())
