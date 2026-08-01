from pathlib import Path
from unittest.mock import Mock, patch

from django.test import SimpleTestCase
from reportlab.pdfbase.ttfonts import TTFError

from backend.apps.assessments.pdf_fonts import PDF_CJK_FONT_NAME, register_pdf_cjk_font


class PdfFontRegistrationTests(SimpleTestCase):
    def tearDown(self):
        register_pdf_cjk_font.cache_clear()
        super().tearDown()

    def test_backend_image_installs_embeddable_cjk_truetype_font(self):
        dockerfile = (Path(__file__).resolve().parents[3] / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("fonts-wqy-zenhei", dockerfile)

    @patch("backend.apps.assessments.pdf_fonts.pdfmetrics.registerFont")
    @patch("backend.apps.assessments.pdf_fonts.TTFont")
    @patch("backend.apps.assessments.pdf_fonts.Path.is_file", return_value=True)
    def test_registration_skips_unsupported_font_and_uses_next_candidate(
        self,
        _is_file,
        tt_font,
        register_font,
    ):
        register_pdf_cjk_font.cache_clear()
        supported_font = Mock()
        tt_font.side_effect = [TTFError("postscript outlines are not supported"), supported_font]

        result = register_pdf_cjk_font()

        self.assertEqual(result, PDF_CJK_FONT_NAME)
        self.assertEqual(tt_font.call_count, 2)
        register_font.assert_called_once_with(supported_font)
