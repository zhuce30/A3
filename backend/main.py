from fastapi import FastAPI

from backend.api.routes.health import router as health_router
from backend.api.routes.knowledge_base import router as knowledge_base_router


def create_app() -> FastAPI:
    app = FastAPI(title="A3 Local Knowledge Base API", version="0.1.0")
    app.include_router(health_router)
    app.include_router(knowledge_base_router)
    return app


app = create_app()
