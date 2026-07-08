"""Local knowledge base domain."""

from importlib import import_module

__all__ = ["index_manager"]


def __getattr__(name: str):
    if name == "index_manager":
        return import_module("backend.domains.knowledge_base.index_manager")
    raise AttributeError(name)
