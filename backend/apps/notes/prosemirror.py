from __future__ import annotations

import math
from typing import Any
from urllib.parse import urlsplit


# These limits allow substantial notes while bounding validation and indexing work.
MAX_DOCUMENT_DEPTH = 64
MAX_DOCUMENT_NODES = 10_000
MAX_DOCUMENT_TEXT = 1_000_000
MAX_ATTRIBUTE_STRING = 8_192
MAX_URL_LENGTH = 2_048
MAX_ATTACHMENT_LABEL = 255


class DocumentValidationError(ValueError):
    def __init__(self, message: str, code: str = "invalid_note_content") -> None:
        super().__init__(message)
        self.code = code


NODE_ATTRS = {
    "doc": set(),
    "paragraph": {"align", "indent", "textIndent"},
    "heading": {"level", "align", "indent", "textIndent"},
    "text": set(),
    "blockquote": set(),
    "code_block": {"params", "language"},
    "hard_break": set(),
    "horizontal_rule": set(),
    "image": {"src", "alt", "title", "width", "height"},
    "bullet_list": {"listStyleType", "fontsize", "color"},
    "ordered_list": {"order", "listStyleType", "fontsize", "color"},
    "list_item": set(),
    "table": set(),
    "table_row": set(),
    "table_cell": {"colspan", "rowspan", "colwidth", "background"},
    "table_header": {"colspan", "rowspan", "colwidth", "background"},
    "math_inline": {"latex", "value", "text"},
    "math_display": {"latex", "value", "text"},
    "inline_math": {"latex", "value", "text"},
    "block_math": {"latex", "value", "text"},
    "equation": {"latex", "value", "text", "display"},
    "inline_equation": {"latex", "value", "text"},
    "block_equation": {"latex", "value", "text"},
    "attachment_reference": {"attachmentId", "label", "kind", "mimeType"},
    "attachment_ref": {"attachmentId", "label", "kind", "mimeType"},
}
MARK_ATTRS = {
    "em": set(),
    "strong": set(),
    "code": set(),
    "fontsize": {"fontsize"},
    "fontname": {"fontname"},
    "forecolor": {"color"},
    "backcolor": {"backcolor"},
    "subscript": set(),
    "superscript": set(),
    "strikethrough": set(),
    "underline": set(),
    "link": {"href", "title", "target"},
    "mark": {"index"},
}
REQUIRED_MARK_STRING_ATTRS = {
    "fontsize": "fontsize",
    "fontname": "fontname",
    "forecolor": "color",
    "backcolor": "backcolor",
    "link": "href",
}
MATH_TYPES = {
    "math_inline",
    "math_display",
    "inline_math",
    "block_math",
    "equation",
    "inline_equation",
    "block_equation",
}
INLINE_NODES = {
    "text",
    "hard_break",
    "image",
    "math_inline",
    "inline_math",
    "inline_equation",
    "attachment_reference",
    "attachment_ref",
}
BLOCK_NODES = {
    "paragraph",
    "heading",
    "blockquote",
    "code_block",
    "horizontal_rule",
    "bullet_list",
    "ordered_list",
    "table",
    "math_display",
    "block_math",
    "equation",
    "block_equation",
    "attachment_reference",
    "attachment_ref",
}
LEAF_NODES = {"text", "hard_break", "horizontal_rule", "image", "attachment_reference", "attachment_ref"}
BLOCK_TYPES = {"paragraph", "heading", "blockquote", "code_block", "list_item"}


def _invalid(message: str) -> None:
    raise DocumentValidationError(message)


def _too_large(message: str) -> None:
    raise DocumentValidationError(message, code="note_document_too_large")


def _validate_string_length(owner_type: str, key: str, value: str) -> None:
    limit = MAX_ATTRIBUTE_STRING
    if key in {"src", "href"}:
        limit = MAX_URL_LENGTH
    elif owner_type in {"attachment_reference", "attachment_ref"} and key == "label":
        limit = MAX_ATTACHMENT_LABEL
    if len(value) > limit:
        _too_large(f"{owner_type}.{key} 超过长度限制")


def _validate_attrs(owner_type: str, attrs: Any, allowed: set[str]) -> None:
    if not isinstance(attrs, dict):
        _invalid(f"{owner_type} 的 attrs 必须是对象")
    if set(attrs) - allowed:
        _invalid(f"{owner_type} 包含不支持的属性")
    for key, attr_value in attrs.items():
        if key == "colwidth":
            if not isinstance(attr_value, list) or any(
                value is not None and (isinstance(value, bool) or not isinstance(value, int) or value <= 0)
                for value in attr_value
            ):
                _invalid("colwidth 必须是正整数数组")
        elif not isinstance(attr_value, (str, int, float, bool, type(None))):
            _invalid(f"{owner_type} 的属性值格式不正确")
        if isinstance(attr_value, float) and not math.isfinite(attr_value):
            _invalid(f"{owner_type}.{key} 必须是有限数值")
        if isinstance(attr_value, str):
            _validate_string_length(owner_type, str(key), attr_value)


def _require_nonempty_string(attrs: dict[str, Any], key: str, owner_type: str) -> None:
    value = attrs.get(key)
    if not isinstance(value, str) or not value.strip():
        _invalid(f"{owner_type} 必须包含非空字符串属性 {key}")


def _validate_url(value: str, *, owner_type: str) -> None:
    if any(character.isspace() or ord(character) < 32 for character in value):
        _invalid(f"{owner_type} 地址格式不安全")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise DocumentValidationError(f"{owner_type} 地址格式不正确") from exc
    if owner_type == "image":
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            _invalid("image.src 仅支持 http 或 https 地址")
        return
    scheme = parsed.scheme.lower()
    if scheme in {"http", "https"}:
        if not parsed.netloc:
            _invalid("link.href 地址格式不正确")
    elif scheme == "mailto":
        if not parsed.path:
            _invalid("link.href 邮件地址不能为空")
    elif scheme or parsed.netloc or value.startswith("//"):
        _invalid("link.href 使用了不支持的地址协议")


def _validate_node_attrs(node_type: str, attrs: dict[str, Any]) -> None:
    _validate_attrs(node_type, attrs, NODE_ATTRS[node_type])
    if node_type == "image":
        _require_nonempty_string(attrs, "src", node_type)
        _validate_url(attrs["src"], owner_type="image")
    elif node_type in {"attachment_reference", "attachment_ref"}:
        _require_nonempty_string(attrs, "attachmentId", node_type)

    if node_type == "heading" and "level" in attrs:
        level = attrs["level"]
        if isinstance(level, bool) or not isinstance(level, int) or not 1 <= level <= 6:
            _invalid("heading.level 必须是 1 到 6 的整数")
    if node_type == "ordered_list" and "order" in attrs:
        order = attrs["order"]
        if isinstance(order, bool) or not isinstance(order, int) or order < 1:
            _invalid("ordered_list.order 必须是正整数")
    if node_type in {"table_cell", "table_header"}:
        for key in ("colspan", "rowspan"):
            if key in attrs:
                value = attrs[key]
                if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                    _invalid(f"{node_type}.{key} 必须是正整数")
    if node_type == "equation" and "display" in attrs and not isinstance(attrs["display"], bool):
        _invalid("equation.display 必须是布尔值")

    string_or_null_attrs = {
        "image": {"alt", "title"},
        "attachment_reference": {"label", "kind", "mimeType"},
        "attachment_ref": {"label", "kind", "mimeType"},
    }
    for key in string_or_null_attrs.get(node_type, set()):
        if key in attrs and attrs[key] is not None and not isinstance(attrs[key], str):
            _invalid(f"{node_type}.{key} 必须是字符串或 null")


def _validate_marks(node_type: str, marks: Any) -> None:
    if node_type not in INLINE_NODES:
        _invalid("块级节点不能包含 marks")
    if not isinstance(marks, list):
        _invalid("marks 必须是数组")
    for mark in marks:
        if not isinstance(mark, dict) or set(mark) - {"type", "attrs"}:
            _invalid("mark 格式不正确")
        mark_type = mark.get("type")
        if mark_type not in MARK_ATTRS:
            _invalid("笔记包含不支持的 mark")
        attrs = mark.get("attrs", {})
        _validate_attrs(str(mark_type), attrs, MARK_ATTRS[mark_type])
        required_attr = REQUIRED_MARK_STRING_ATTRS.get(mark_type)
        if required_attr:
            _require_nonempty_string(attrs, required_attr, str(mark_type))
        if mark_type == "link":
            _validate_url(attrs["href"], owner_type="link")
            for key in ("title", "target"):
                if key in attrs and attrs[key] is not None and not isinstance(attrs[key], str):
                    _invalid(f"link.{key} 必须是字符串或 null")


def _allowed_children(node_type: str) -> set[str]:
    if node_type == "doc":
        return BLOCK_NODES
    if node_type in {"paragraph", "heading"}:
        return INLINE_NODES
    if node_type in {"blockquote", "table_cell", "table_header"}:
        return BLOCK_NODES
    if node_type == "code_block" or node_type in MATH_TYPES:
        return {"text"}
    if node_type in {"bullet_list", "ordered_list"}:
        return {"list_item"}
    if node_type == "list_item":
        return BLOCK_NODES
    if node_type == "table":
        return {"table_row"}
    if node_type == "table_row":
        return {"table_cell", "table_header"}
    return set()


def validate_content(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("type") != "doc":
        _invalid("笔记内容必须是有效的 ProseMirror doc")

    node_count = 0
    text_size = 0
    stack: list[tuple[Any, str | None, int]] = [(value, None, 1)]
    while stack:
        node, parent_type, depth = stack.pop()
        if depth > MAX_DOCUMENT_DEPTH:
            _too_large(f"笔记文档深度不能超过 {MAX_DOCUMENT_DEPTH} 层")
        node_count += 1
        if node_count > MAX_DOCUMENT_NODES:
            _too_large(f"笔记文档节点不能超过 {MAX_DOCUMENT_NODES} 个")
        if not isinstance(node, dict) or set(node) - {"type", "attrs", "content", "marks", "text"}:
            _invalid("笔记节点格式不正确")
        node_type = node.get("type")
        if node_type not in NODE_ATTRS:
            _invalid("笔记包含不支持的节点类型")
        if parent_type and node_type not in _allowed_children(parent_type):
            _invalid(f"{node_type} 不能放在 {parent_type} 中")
        attrs = node.get("attrs", {})
        _validate_node_attrs(str(node_type), attrs)
        if "marks" in node:
            _validate_marks(str(node_type), node["marks"])

        if node_type == "text":
            text = node.get("text")
            if not isinstance(text, str):
                _invalid("文本节点的 text 必须是字符串")
            text_size += len(text)
            if text_size > MAX_DOCUMENT_TEXT:
                _too_large(f"笔记文本不能超过 {MAX_DOCUMENT_TEXT} 个字符")
        elif "text" in node:
            _invalid("非文本节点不能包含 text")

        if node_type in LEAF_NODES:
            if "content" in node:
                _invalid(f"{node_type} 不能包含 content")
            continue

        children = node.get("content", [])
        if not isinstance(children, list):
            _invalid("笔记节点 content 必须是数组")
        if node_type in {
            "blockquote",
            "bullet_list",
            "ordered_list",
            "table",
            "table_row",
            "table_cell",
            "table_header",
        } and not children:
            _invalid(f"{node_type} 的 content 不能为空")
        if node_type == "list_item" and (
            not children or not isinstance(children[0], dict) or children[0].get("type") != "paragraph"
        ):
            _invalid("list_item 必须以 paragraph 开始")
        if node_type in MATH_TYPES:
            formula_attrs = (attrs.get("latex"), attrs.get("value"), attrs.get("text"))
            for formula_attr in formula_attrs:
                if formula_attr is not None and (
                    not isinstance(formula_attr, str) or not formula_attr.strip()
                ):
                    _invalid(f"{node_type} 的公式属性必须是非空字符串")
            child_text = "".join(
                child.get("text", "")
                for child in children
                if isinstance(child, dict)
                and child.get("type") == "text"
                and isinstance(child.get("text", ""), str)
            )
            if not any(isinstance(item, str) and item.strip() for item in formula_attrs) and not child_text.strip():
                _invalid(f"{node_type} 必须包含非空公式内容")
        stack.extend((child, str(node_type), depth + 1) for child in reversed(children))
    return value


def extract_note_text(content: dict[str, Any]) -> str:
    """Return deterministic searchable text from a validated ProseMirror document."""

    def render(node: Any) -> str:
        if not isinstance(node, dict):
            return ""
        node_type = node.get("type")
        if node_type == "text":
            return node.get("text", "") if isinstance(node.get("text"), str) else ""
        if node_type in {"hard_break", "hardBreak"}:
            return "\n"
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        if node_type in MATH_TYPES:
            formula = attrs.get("latex") or attrs.get("value") or attrs.get("text")
            if isinstance(formula, str):
                return formula
        if node_type in {"attachment_reference", "attachment_ref"}:
            return attrs.get("label", "") if isinstance(attrs.get("label"), str) else ""
        if node_type == "image":
            return attrs.get("alt", "") if isinstance(attrs.get("alt"), str) else ""
        children = node.get("content") if isinstance(node.get("content"), list) else []
        if node_type in {"table_row", "tableRow"}:
            cells = [render(child).strip() for child in children]
            return "\t".join(cell for cell in cells if cell) + "\n"
        rendered = "".join(render(child) for child in children)
        if node_type in BLOCK_TYPES:
            return rendered.rstrip() + "\n"
        return rendered

    lines = [line.rstrip() for line in render(content).splitlines()]
    return "\n".join(line for line in lines if line).strip()
