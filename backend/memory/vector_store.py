import chromadb
from chromadb.utils import embedding_functions
from typing import List, Dict, Any, Optional

class VectorStore:
    def __init__(self, path: str = "./chroma_db", collection_name: str = "omnimind_memories"):
        self.client = chromadb.PersistentClient(path=path)
        self.embedding_fn = embedding_functions.DefaultEmbeddingFunction()
        self.collection = self.client.get_or_create_collection(
            name=collection_name, 
            embedding_function=self.embedding_fn
        )

    def add_memory(self, id: str, text: str, metadata: Dict[str, Any]):
        self.collection.add(
            documents=[text],
            metadatas=[metadata],
            ids=[id]
        )

    def search(
        self,
        query: str,
        top_k: int = 5,
        metadata_filter: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        results = self.collection.query(
            query_texts=[query],
            n_results=top_k,
            where=metadata_filter,
        )
        
        memories = []
        if results['documents']:
            for i in range(len(results['documents'][0])):
                memories.append({
                    "content": results['documents'][0][i],
                    "metadata": results['metadatas'][0][i],
                    "id": results['ids'][0][i],
                    "distance": results['distances'][0][i] if 'distances' in results else None
                })
        return memories

    def delete_memory(self, id: str):
        self.collection.delete(ids=[id])
