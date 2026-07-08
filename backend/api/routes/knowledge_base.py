from fastapi import APIRouter, Query

from backend.domains.knowledge_base.retriever import search_knowledge_base

router = APIRouter(prefix="/api/kb", tags=["knowledge-base"])


@router.get("/search")
def search(q: str = Query(..., min_length=1), top_k: int = Query(5, ge=1, le=20)):
    results = search_knowledge_base(q, top_k=top_k)
    return {"query": q, "results": [result.model_dump() for result in results]}
