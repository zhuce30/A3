from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


PDF_CJK_FONT_NAME = "A3NotoSansCJK"


@lru_cache(maxsize=1)
def register_pdf_cjk_font() -> str:
    configured = (os.getenv("A3_PDF_CJK_FONT_PATH") or "").strip()
    candidates = [
        configured,
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "C:/Windows/Fonts/NotoSansSC-VF.ttf",
        "C:/Windows/Fonts/simhei.ttf",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_file():
            continue
        pdfmetrics.registerFont(TTFont(PDF_CJK_FONT_NAME, str(path), subfontIndex=0))
        return PDF_CJK_FONT_NAME
    raise RuntimeError("未找到可嵌入的中文 PDF 字体，请配置 A3_PDF_CJK_FONT_PATH。")
