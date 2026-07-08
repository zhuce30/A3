from __future__ import annotations

import pymysql

pymysql.install_as_MySQLdb()

from backend.config.celery import app as celery_app

__all__ = ("celery_app",)
