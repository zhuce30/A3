from __future__ import annotations

import json

from django.http import HttpRequest


def json_body(request: HttpRequest) -> dict:
    if not request.body:
        return {}
    return json.loads(request.body.decode("utf-8"))
