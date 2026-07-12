from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from time import perf_counter
from typing import Any


MAX_CODE_CHARS = 20_000
MAX_STDIN_CHARS = 8_000
MAX_OUTPUT_CHARS = 8_000
MAX_TEST_CASES = 12
DEFAULT_TIMEOUT_MS = 3_000
MIN_TIMEOUT_MS = 100
MAX_TIMEOUT_MS = 5_000


def run_code_lab(payload: dict[str, Any]) -> dict[str, Any]:
    language = str(payload.get("language") or "Python").strip()
    if not _is_python(language):
        raise ValueError("当前代码实验 runner 仅支持 Python")

    code = _strip_markdown_code_fence(str(payload.get("code") or ""))
    if not code.strip():
        raise ValueError("code 不能为空")
    if len(code) > MAX_CODE_CHARS:
        raise ValueError(f"code 不能超过 {MAX_CODE_CHARS} 个字符")

    timeout_ms = _clamp_timeout(payload.get("timeoutMs"))
    mode = str(payload.get("mode") or "run").strip().lower()
    if mode == "judge":
        return _judge_python(code, payload.get("testCases"), timeout_ms)
    if mode != "run":
        raise ValueError("mode 必须是 run 或 judge")
    return _run_python_case(code, str(payload.get("stdin") or ""), timeout_ms)


def _judge_python(code: str, test_cases: Any, timeout_ms: int) -> dict[str, Any]:
    if not isinstance(test_cases, list) or not test_cases:
        raise ValueError("judge 模式需要 testCases 数组")
    if len(test_cases) > MAX_TEST_CASES:
        raise ValueError(f"testCases 最多支持 {MAX_TEST_CASES} 个")

    results: list[dict[str, Any]] = []
    for index, item in enumerate(test_cases):
        if not isinstance(item, dict):
            raise ValueError("testCases 每一项必须是对象")
        expected = str(item.get("expectedStdout") if item.get("expectedStdout") is not None else item.get("expectedOutput") or "")
        run = _run_python_case(code, str(item.get("stdin") or ""), timeout_ms)
        passed = run["status"] == "passed" and _normalize_output(run.get("stdout", "")) == _normalize_output(expected)
        results.append(
            {
                "name": str(item.get("name") or f"用例 {index + 1}")[:80],
                "passed": passed,
                "status": run["status"],
                "stdin": _truncate(str(item.get("stdin") or ""), MAX_STDIN_CHARS),
                "expectedStdout": expected,
                "actualStdout": run.get("stdout", ""),
                "stderr": run.get("stderr", ""),
                "exitCode": run.get("exitCode"),
                "durationMs": run.get("durationMs", 0),
                "error": run.get("error", ""),
            }
        )

    passed_count = sum(1 for item in results if item["passed"])
    return {
        "status": "passed" if passed_count == len(results) else "failed",
        "mode": "judge",
        "provider": "local_subprocess",
        "language": "Python",
        "passedCount": passed_count,
        "totalCount": len(results),
        "testResults": results,
    }


def _run_python_case(code: str, stdin: str, timeout_ms: int) -> dict[str, Any]:
    if len(stdin) > MAX_STDIN_CHARS:
        raise ValueError(f"stdin 不能超过 {MAX_STDIN_CHARS} 个字符")

    with tempfile.TemporaryDirectory(prefix="a3_code_lab_") as tmpdir:
        script_path = Path(tmpdir) / "main.py"
        script_path.write_text(code, encoding="utf-8")
        started = perf_counter()
        try:
            completed = subprocess.run(
                [sys.executable, "-I", str(script_path)],
                input=stdin,
                text=True,
                capture_output=True,
                cwd=tmpdir,
                env=_minimal_env(),
                timeout=timeout_ms / 1000,
                check=False,
            )
            duration_ms = int((perf_counter() - started) * 1000)
        except subprocess.TimeoutExpired as exc:
            duration_ms = int((perf_counter() - started) * 1000)
            return {
                "status": "timeout",
                "mode": "run",
                "provider": "local_subprocess",
                "language": "Python",
                "stdout": _truncate(exc.stdout or "", MAX_OUTPUT_CHARS),
                "stderr": _truncate(exc.stderr or "", MAX_OUTPUT_CHARS),
                "exitCode": None,
                "durationMs": duration_ms,
                "error": f"运行超时：超过 {timeout_ms}ms，进程已停止。",
            }

    stdout = _truncate(completed.stdout, MAX_OUTPUT_CHARS)
    stderr = _truncate(completed.stderr, MAX_OUTPUT_CHARS)
    return {
        "status": "passed" if completed.returncode == 0 else "failed",
        "mode": "run",
        "provider": "local_subprocess",
        "language": "Python",
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": completed.returncode,
        "durationMs": duration_ms,
        "error": "" if completed.returncode == 0 else "程序运行失败，请查看 stderr。",
        "truncated": len(completed.stdout) > MAX_OUTPUT_CHARS or len(completed.stderr) > MAX_OUTPUT_CHARS,
    }


def _clamp_timeout(value: Any) -> int:
    try:
        timeout_ms = int(value or DEFAULT_TIMEOUT_MS)
    except (TypeError, ValueError):
        timeout_ms = DEFAULT_TIMEOUT_MS
    return max(MIN_TIMEOUT_MS, min(timeout_ms, MAX_TIMEOUT_MS))


def _is_python(language: str) -> bool:
    normalized = language.lower()
    return "python" in normalized or normalized in {"py", "python3"}


def _truncate(value: str, limit: int) -> str:
    text = value if isinstance(value, str) else str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n...输出已截断..."


def _normalize_output(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").rstrip()


def _strip_markdown_code_fence(code: str) -> str:
    text = code.strip()
    lines = text.splitlines()
    if len(lines) >= 2 and lines[0].strip().startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip() + "\n"
    if lines and lines[0].strip().startswith("```"):
        return "\n".join(lines[1:]).strip() + "\n"
    return code


def _minimal_env() -> dict[str, str]:
    allowed_keys = ("SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP")
    env = {key: os.environ[key] for key in allowed_keys if key in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env
