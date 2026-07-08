from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass

import requests
from django.conf import settings
from django.contrib.auth import authenticate, login, logout
from django.core.cache import cache
from django.core.mail import send_mail
from django.core.validators import validate_email
from django.core.exceptions import ValidationError
from django.db.models import Q
from django.http import HttpRequest

from backend.apps.accounts.models import User, UserRole


VERIFICATION_CODE_TTL_SECONDS = 600
VERIFICATION_CODE_COOLDOWN_SECONDS = 60
VERIFICATION_CODE_MAX_ATTEMPTS = 5
VERIFICATION_CODE_PURPOSES = {"register", "reset", "bind"}


@dataclass(frozen=True)
class VerificationCodeDelivery:
    sent: bool
    retry_after: int
    dev_code: str | None = None


def public_user(user: User) -> dict:
    payload = {
        "id": str(user.id),
        "phone": user.phone,
        "email": user.email,
        "studentId": user.student_id,
        "displayName": user.display_name,
        "role": user.role,
        "school": user.school,
        "phoneBound": user.phone_bound,
        "privacyAccepted": user.privacy_accepted,
        "profileCompleted": user.profile_completed,
        "onboardingStep": user.onboarding_step,
        "createdAt": user.created_at.isoformat() if user.created_at else "",
        "updatedAt": user.updated_at.isoformat() if user.updated_at else "",
    }
    profile = getattr(user, "learner_profile", None)
    if profile is not None:
        from backend.apps.profiles.services import public_profile

        profile_payload = public_profile(profile)
        if profile_payload is not None:
            profile_payload["dailyStudyTime"] = str(profile_payload.get("dailyStudyTime") or "")
        payload["learningProfile"] = profile_payload
    return payload


def _normalize_verification_target(target: str) -> str:
    return "".join(target.strip().lower().split())


def _is_email_target(target: str) -> bool:
    try:
        validate_email(target)
    except ValidationError:
        return False
    return True


def _account_phone_from_email(email: str) -> str:
    digest = hashlib.sha256(_normalize_verification_target(email).encode("utf-8")).hexdigest()[:26]
    return f"email:{digest}"


def _verification_key(target: str, purpose: str) -> str:
    digest = hashlib.sha256(_normalize_verification_target(target).encode("utf-8")).hexdigest()
    return f"a3:verify:{purpose}:{digest}"


def _validate_verification_purpose(purpose: str) -> str:
    if purpose not in VERIFICATION_CODE_PURPOSES:
        raise ValueError("验证码用途不正确")
    return purpose


def register_user(
    request: HttpRequest,
    *,
    phone: str = "",
    email: str = "",
    code: str,
    password: str,
    role: str,
    school: str = "",
    display_name: str = "",
) -> User:
    if role != UserRole.STUDENT:
        raise ValueError("教师和管理员账号需要由后台开通")
    email = _normalize_verification_target(email)
    phone = phone.strip()
    if email:
        if not _is_email_target(email):
            raise ValueError("邮箱格式不正确")
        verification_target = email
        account_phone = _account_phone_from_email(email)
    else:
        if not phone:
            raise ValueError("请输入邮箱或手机号")
        verification_target = phone
        account_phone = phone
    if len(password) < 8:
        raise ValueError("密码至少需要 8 位")
    if User.objects.filter(phone=account_phone).exists() or (email and User.objects.filter(email=email).exists()):
        raise ValueError("账号已存在")
    if not verify_code(verification_target, code, purpose="register", consume=True):
        raise ValueError("验证码不正确、已过期或尝试次数过多")

    default_name = display_name.strip() or {
        UserRole.STUDENT: "学生用户",
        UserRole.TEACHER: "教师用户",
        UserRole.ADMIN: "管理员",
    }[role]
    user = User.objects.create_user(
        phone=account_phone,
        email=email,
        password=password,
        role=role,
        school=school,
        display_name=default_name,
        onboarding_step="role",
    )
    login(request, user)
    return user


def login_user(request: HttpRequest, *, identifier: str, password: str) -> User:
    user = authenticate(request, username=identifier, password=password)
    if user is None:
        user = User.objects.filter(
            Q(phone=identifier) | Q(email=identifier) | Q(student_id=identifier)
        ).first()
        if user is not None and not user.check_password(password):
            user = None
    if user is None:
        raise ValueError("账号或密码不正确")
    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    return user


def logout_user(request: HttpRequest) -> None:
    logout(request)


def create_verification_code(target: str, *, purpose: str, allow_dev_code: bool = False) -> VerificationCodeDelivery:
    target = _normalize_verification_target(target)
    purpose = _validate_verification_purpose(purpose)
    if not target:
        raise ValueError("请输入手机号或邮箱")

    key = _verification_key(target, purpose)
    cooldown_key = f"{key}:cooldown"
    if not cache.add(cooldown_key, "1", timeout=VERIFICATION_CODE_COOLDOWN_SECONDS):
        raise ValueError(f"验证码发送过于频繁，请 {VERIFICATION_CODE_COOLDOWN_SECONDS} 秒后重试")

    use_dev_code = bool(allow_dev_code and getattr(settings, "VERIFICATION_CODE_DEV_MODE", False))
    code = str(getattr(settings, "VERIFICATION_CODE_DEV_VALUE", "123456")) if use_dev_code else f"{secrets.randbelow(1_000_000):06d}"
    cache.set(key, {"code": code, "attempts": 0}, timeout=VERIFICATION_CODE_TTL_SECONDS)

    if use_dev_code:
        return VerificationCodeDelivery(
            sent=True,
            retry_after=VERIFICATION_CODE_COOLDOWN_SECONDS,
            dev_code=code,
        )

    webhook_url = str(getattr(settings, "SMS_WEBHOOK_URL", "")).strip()
    if _is_email_target(target):
        try:
            send_mail(
                subject="智学引擎 A3 验证码",
                message=f"你的验证码是 {code}，{VERIFICATION_CODE_TTL_SECONDS // 60} 分钟内有效。若非本人操作，请忽略本邮件。",
                from_email=str(getattr(settings, "DEFAULT_FROM_EMAIL", "") or None),
                recipient_list=[target],
                fail_silently=False,
            )
        except Exception as exc:
            cache.delete_many([key, cooldown_key])
            raise RuntimeError("验证码邮件发送失败，请稍后重试") from exc
        return VerificationCodeDelivery(sent=True, retry_after=VERIFICATION_CODE_COOLDOWN_SECONDS)

    if not webhook_url:
        cache.delete_many([key, cooldown_key])
        raise RuntimeError("短信服务尚未配置")

    headers = {"Content-Type": "application/json"}
    webhook_token = str(getattr(settings, "SMS_WEBHOOK_TOKEN", "")).strip()
    if webhook_token:
        headers["Authorization"] = f"Bearer {webhook_token}"
    try:
        response = requests.post(
            webhook_url,
            json={
                "target": target,
                "code": code,
                "purpose": purpose,
                "expiresIn": VERIFICATION_CODE_TTL_SECONDS,
            },
            headers=headers,
            timeout=10,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        cache.delete_many([key, cooldown_key])
        raise RuntimeError("验证码发送失败，请稍后重试") from exc

    return VerificationCodeDelivery(sent=True, retry_after=VERIFICATION_CODE_COOLDOWN_SECONDS)


def verify_code(target: str, code: str, *, purpose: str, consume: bool = True) -> bool:
    target = _normalize_verification_target(target)
    purpose = _validate_verification_purpose(purpose)
    key = _verification_key(target, purpose)
    record = cache.get(key)
    if not isinstance(record, dict):
        return False

    attempts = int(record.get("attempts", 0))
    if attempts >= VERIFICATION_CODE_MAX_ATTEMPTS:
        cache.delete(key)
        return False

    expected = str(record.get("code", ""))
    matched = bool(code) and hmac.compare_digest(expected, str(code).strip())
    if matched:
        if consume:
            cache.delete(key)
        return True

    attempts += 1
    if attempts >= VERIFICATION_CODE_MAX_ATTEMPTS:
        cache.delete(key)
    else:
        record["attempts"] = attempts
        cache.set(key, record, timeout=VERIFICATION_CODE_TTL_SECONDS)
    return False
