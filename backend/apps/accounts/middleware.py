from __future__ import annotations

from backend.apps.accounts.tokens import user_from_access_token


class BearerTokenAuthenticationMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.user.is_authenticated:
            header = request.META.get("HTTP_AUTHORIZATION", "")
            scheme, _, token = header.partition(" ")
            if scheme.lower() == "bearer" and token:
                user = user_from_access_token(token.strip())
                if user is not None:
                    request.user = user
        return self.get_response(request)
