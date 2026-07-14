from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.test import SimpleTestCase
from pypdf import PdfWriter

from backend.domains.knowledge_base.multimodal_parser import _parse_pdf


class PdfRuntimeDependencyTests(SimpleTestCase):
    def test_requirements_include_aes_pdf_support(self):
        requirements_path = Path(__file__).resolve().parents[3] / "requirements.txt"
        requirements = requirements_path.read_text(encoding="utf-8").splitlines()

        self.assertIn("cryptography>=3.1", requirements)

    def test_parser_opens_aes_encrypted_pdf_with_empty_user_password(self):
        with TemporaryDirectory() as temp_dir:
            pdf_path = Path(temp_dir) / "aes-encrypted.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=300, height=400)
            writer.encrypt(user_password="", owner_password="owner", algorithm="AES-256")
            with pdf_path.open("wb") as output:
                writer.write(output)

            with patch(
                "backend.domains.knowledge_base.multimodal_parser._render_pdf_pages",
                return_value=({}, []),
            ):
                result = _parse_pdf(pdf_path)

        self.assertNotEqual(result.status, "failed")
        self.assertEqual(len(result.pages), 1)
