from __future__ import annotations

import os
import socket
import subprocess
import sys
import time


def main() -> int:
    if os.getenv("A3_WAIT_FOR_DB", "1").strip().lower() in {"1", "true", "yes", "on"}:
        wait_for_mysql()
    if os.getenv("A3_RUN_MIGRATIONS", "1").strip().lower() in {"1", "true", "yes", "on"}:
        run_manage("migrate", "--noinput")
    if os.getenv("A3_SEED_DEMO_DATA", "1").strip().lower() in {"1", "true", "yes", "on"}:
        run_manage("seed_demo_data")
    command = sys.argv[1:] or ["python", "manage.py", "runserver", "0.0.0.0:8000"]
    return subprocess.call(command)


def wait_for_mysql() -> None:
    host = os.getenv("MYSQL_HOST", "mysql")
    port = int(os.getenv("MYSQL_PORT", "3306"))
    timeout_seconds = int(os.getenv("A3_DB_WAIT_SECONDS", "60"))
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            with socket.create_connection((host, port), timeout=3):
                return
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timed out waiting for MySQL at {host}:{port}")
            time.sleep(2)


def run_manage(*args: str) -> None:
    subprocess.check_call(["python", "manage.py", *args])


if __name__ == "__main__":
    raise SystemExit(main())
