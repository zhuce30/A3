from __future__ import annotations

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class NormalizedMarkdown:
    raw_text: str
    markdown: str
    content_format: str
    features: list[str]


SUPERSCRIPT_MAP = str.maketrans(
    {
        "²": "^2",
        "³": "^3",
        "⁴": "^4",
        "⁵": "^5",
        "⁶": "^6",
        "⁷": "^7",
        "⁸": "^8",
        "⁹": "^9",
    }
)


PPT_SYMBOL_MAP = str.maketrans(
    {
        "\uf02d": "-",
        "\uf051": "-",
        "\uf061": "\u03b1",
        "\uf065": "\u03b5",
        "\uf06a": "\u03c6",
        "\uf070": "\u03c0",
        "\uf071": "\u03b8",
        "\uf072": "\u03c1",
        "\uf073": "\u03c3",
        "\uf077": "\u03c9",
        "\uf0a3": "\u2264",
        "\uf0a5": "\u221e",
        "\uf0ad": "\u2191",
        "\uf0ae": "\u2192",
        "\uf0af": "\u2193",
        "\uf0b0": "°",
        "\uf0b3": "\u2265",
        "\uf0b4": "\u00d7",
        "\uf0d0": "\u2220",
        "\uf0e5": "\u03a3",
        "□": "-",
        "�": "",
    }
)

PRIVATE_USE_PATTERN = re.compile(r"[\ue000-\uf8ff]")


def normalize_material_markdown(text: str) -> NormalizedMarkdown:
    raw = str(text or "").strip()
    markdown = raw.translate(SUPERSCRIPT_MAP)
    features: list[str] = []

    markdown, symbol_found = _repair_ppt_symbol_font(markdown)
    if symbol_found:
        features.append("symbol_repair")

    markdown, block_found = _repair_inline_markdown_blocks(markdown)
    if block_found:
        features.append("structure")
        if re.search(r"(?m)^\|\s*:?-{3,}:?", markdown):
            features.append("table")

    markdown, table_found = _repair_compact_pipe_table(markdown)
    if table_found:
        features.append("table")

    markdown, math_found = _wrap_bare_equations(markdown)
    if math_found:
        features.append("math")

    markdown = _repair_bullets(markdown)
    if re.search(r"(?m)^[-*]\s+", markdown):
        features.append("list")

    return NormalizedMarkdown(
        raw_text=raw,
        markdown=markdown.strip(),
        content_format="markdown",
        features=sorted(set(features)),
    )


def _wrap_bare_equations(text: str) -> tuple[str, bool]:
    found = False

    def replace(match: re.Match[str]) -> str:
        nonlocal found
        prefix = match.group(1)
        equation = _normalize_equation_text(match.group(2).strip())
        if not _should_wrap_equation(equation):
            return match.group(0)
        found = True
        return f"{prefix}${equation}$"

    math_chars = r"A-Za-z0-9_\u0370-\u03ff{}^()+=\-*/.,\s≤≥∞→↑↓×°∠Σ"
    pattern = rf"(^|[^${math_chars}])([{math_chars}]+=[{math_chars}]+)"
    return re.sub(pattern, replace, text), found


def _normalize_equation_text(value: str) -> str:
    value = value.strip(" ,，")
    # PPT extraction often flattens s² to s2 in characteristic equations.
    value = re.sub(r"\bs2(?=\s*[+\-])", "s^2", value)
    return value


def _should_wrap_equation(equation: str) -> bool:
    if len(equation) < 5:
        return False
    normalized = equation.strip()
    if re.match(r"^\(\d+\)\s*[^=]+=\s*[-+]?\d+(?:\.\d+)?$", normalized):
        return False
    if normalized.count("=") > 1 and not re.search(r"[+*/^Σ∑]", normalized):
        return False
    return bool(re.search(r"[+*/^Σ∑]|[A-Za-z]\^\d", normalized))


def _repair_compact_pipe_table(text: str) -> tuple[str, bool]:
    if "\n" in text or "|" not in text or "| ---" in text:
        return text, False

    cells = [cell.strip() for cell in text.strip().strip("|").split("|") if cell.strip()]
    if len(cells) < 6:
        return text, False

    column_count = next((count for count in (5, 4, 3, 2) if len(cells) % count == 0 and len(cells) // count >= 2), None)
    if not column_count:
        return text, False

    rows = [cells[index : index + column_count] for index in range(0, len(cells), column_count)]
    lines = [_format_row(rows[0]), _format_row(["---"] * column_count), *[_format_row(row) for row in rows[1:]]]
    return "\n".join(lines), True


def _repair_inline_markdown_blocks(text: str) -> tuple[str, bool]:
    found = False
    repaired_lines: list[str] = []

    for raw_line in text.splitlines() or [text]:
        line = _repair_inline_block_marker(raw_line.strip())
        if line != raw_line.strip():
            found = True

        heading_table = re.match(r"^(#{1,6}\s+[^|]+?)\s+(\|.+)$", line)
        if heading_table:
            found = True
            repaired_lines.append(heading_table.group(1).strip())
            repaired_lines.extend(_split_compact_table_separator(heading_table.group(2).strip()))
            continue

        repaired_lines.extend(_split_compact_table_separator(line))

    return "\n".join(repaired_lines), found


def _repair_inline_block_marker(line: str) -> str:
    line = re.sub(r"^\s*-{3,}\s+(#{1,6}\s+)", r"\1", line)
    line = re.sub(r"^\s*[-*]\s+(#{1,6}\s+)", r"\1", line)
    return line


def _split_compact_table_separator(line: str) -> list[str]:
    if "|" not in line:
        return [line]
    parts = [_normalize_table_row_spacing(part.strip()) for part in re.sub(r"\|\s+\|", "|\n|", line).splitlines() if part.strip()]
    return parts or [line]


def _normalize_table_row_spacing(line: str) -> str:
    if not (line.startswith("|") and line.endswith("|")):
        return line
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    if len(cells) < 2:
        return line
    return _format_row(cells)


def _format_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _repair_bullets(text: str) -> str:
    return re.sub(r"(?m)^\s*[•·]\s+", "- ", text)


def _repair_ppt_symbol_font(text: str) -> tuple[str, bool]:
    repaired = text.translate(PPT_SYMBOL_MAP)
    repaired = PRIVATE_USE_PATTERN.sub("", repaired)
    return repaired, repaired != text
