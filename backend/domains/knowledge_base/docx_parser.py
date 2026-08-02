from __future__ import annotations

import re
from dataclasses import dataclass, replace
from pathlib import Path


DOCX_TEXT_CHUNK_MAX_CHARS = 1200


@dataclass(frozen=True)
class DocxContentBlock:
    block_type: str
    markdown: str
    section: str
    heading_level: int
    block_index: int
    paragraph_start: int | None = None
    paragraph_end: int | None = None
    table_index: int | None = None


def parse_docx_blocks(
    path: Path,
    *,
    max_blocks: int | None = None,
    max_chars: int | None = None,
) -> list[DocxContentBlock]:
    try:
        from docx import Document
        from docx.oxml.table import CT_Tbl
        from docx.oxml.text.paragraph import CT_P
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ModuleNotFoundError as exc:
        raise RuntimeError("python-docx is required to parse DOCX files") from exc

    document = Document(str(path))
    blocks: list[DocxContentBlock] = []
    paragraph_buffer: list[tuple[int, str]] = []
    section = path.stem
    heading_level = 0
    paragraph_index = 0
    table_index = 0
    emitted_chars = 0
    exhausted = (max_blocks is not None and max_blocks <= 0) or (max_chars is not None and max_chars <= 0)

    def append_block(block: DocxContentBlock) -> None:
        nonlocal emitted_chars, exhausted
        if exhausted:
            return
        if max_blocks is not None and len(blocks) >= max_blocks:
            exhausted = True
            return
        markdown = block.markdown
        if max_chars is not None:
            remaining = max_chars - emitted_chars
            if remaining <= 0:
                exhausted = True
                return
            if len(markdown) > remaining:
                markdown = markdown[:remaining]
                exhausted = True
        blocks.append(replace(block, markdown=markdown))
        emitted_chars += len(markdown)
        if (max_blocks is not None and len(blocks) >= max_blocks) or (
            max_chars is not None and emitted_chars >= max_chars
        ):
            exhausted = True

    def flush_paragraphs() -> None:
        nonlocal paragraph_buffer
        for chunk in _chunk_paragraphs(paragraph_buffer):
            append_block(
                DocxContentBlock(
                    block_type="text",
                    markdown="\n\n".join(text for _, text in chunk),
                    section=section,
                    heading_level=heading_level,
                    block_index=len(blocks) + 1,
                    paragraph_start=chunk[0][0],
                    paragraph_end=chunk[-1][0],
                )
            )
            if exhausted:
                break
        paragraph_buffer = []

    for child in document.element.body.iterchildren():
        if exhausted:
            break
        if isinstance(child, CT_P):
            paragraph = Paragraph(child, document)
            text = _clean_text(paragraph.text)
            if not text:
                continue
            paragraph_index += 1
            next_heading_level = _heading_level(paragraph.style.name if paragraph.style else "")
            if next_heading_level:
                flush_paragraphs()
                if exhausted:
                    break
                section = text
                heading_level = next_heading_level
                continue
            paragraph_buffer.append((paragraph_index, _paragraph_markdown(paragraph, text)))
            continue

        if isinstance(child, CT_Tbl):
            flush_paragraphs()
            if exhausted:
                break
            table_index += 1
            markdown = _table_markdown(Table(child, document))
            if markdown:
                append_block(
                    DocxContentBlock(
                        block_type="table",
                        markdown=markdown,
                        section=section,
                        heading_level=heading_level,
                        block_index=len(blocks) + 1,
                        table_index=table_index,
                    )
                )

    if not exhausted:
        flush_paragraphs()
    return blocks


def _chunk_paragraphs(paragraphs: list[tuple[int, str]]) -> list[list[tuple[int, str]]]:
    chunks: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    current_length = 0
    for paragraph in paragraphs:
        paragraph_length = len(paragraph[1]) + (2 if current else 0)
        if current and current_length + paragraph_length > DOCX_TEXT_CHUNK_MAX_CHARS:
            chunks.append(current)
            current = []
            current_length = 0
        current.append(paragraph)
        current_length += paragraph_length
    if current:
        chunks.append(current)
    return chunks


def _heading_level(style_name: str) -> int:
    match = re.search(r"(?:Heading|标题)\s*([1-9])", str(style_name or ""), flags=re.IGNORECASE)
    return int(match.group(1)) if match else 0


def _paragraph_markdown(paragraph, text: str) -> str:
    style_name = str(paragraph.style.name if paragraph.style else "")
    lowered = style_name.lower()
    if "code" in lowered or "代码" in style_name:
        return f"```text\n{text}\n```"
    if "list bullet" in lowered or "项目符号" in style_name:
        return f"- {text}"
    if "list number" in lowered or "编号" in style_name:
        return f"1. {text}"
    return text


def _table_markdown(table) -> str:
    rows = [[_escape_table_cell(cell.text) for cell in row.cells] for row in table.rows]
    rows = [row for row in rows if any(row)]
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    header = normalized[0]
    body = normalized[1:]
    lines = [
        f"| {' | '.join(header)} |",
        f"| {' | '.join('---' for _ in range(width))} |",
    ]
    lines.extend(f"| {' | '.join(row)} |" for row in body)
    return "\n".join(lines)


def _escape_table_cell(value: str) -> str:
    return _clean_text(value).replace("|", r"\|").replace("\n", "<br>")


def _clean_text(value: str) -> str:
    return "\n".join(line.strip() for line in str(value or "").replace("\r", "\n").split("\n") if line.strip())
