from pathlib import Path

from django.test import SimpleTestCase


class BackendContainerRuntimeTests(SimpleTestCase):
    def test_backend_image_installs_pptx_renderer(self):
        dockerfile = Path(__file__).resolve().parents[3] / "Dockerfile"
        contents = dockerfile.read_text(encoding="utf-8")

        self.assertIn("libreoffice-impress", contents)
        self.assertIn("libreoffice-writer", contents)
