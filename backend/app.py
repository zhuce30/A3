"""Compatibility entrypoint.

Prefer running `uvicorn backend.main:app`.
"""

from backend.main import app, create_app

__all__ = ["app", "create_app"]
