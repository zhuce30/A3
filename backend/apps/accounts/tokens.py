from __future__ import annotations

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.utils import timezone

TOKEN_SALT = "a3.accounts.bearer-token"
TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 7


def create_access_token(user) -> str:
    payload = {
        "sub": str(user.id),
        "phone": user.phone,
        "role": user.role,
        "iat": int(timezone.now().timestamp()),
    }
    return signing.dumps(payload, salt=TOKEN_SALT)


def user_from_access_token(token: str):
    if not token:
        return None
    try:
        payload = signing.loads(
            token,
            salt=TOKEN_SALT,
            max_age=int(getattr(settings, "A3_ACCESS_TOKEN_MAX_AGE", TOKEN_MAX_AGE_SECONDS)),
        )
    except signing.BadSignature:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    User = get_user_model()
    return User.objects.filter(id=user_id, is_active=True).first()
