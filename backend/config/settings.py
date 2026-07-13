from __future__ import annotations

import os
from pathlib import Path

from celery.schedules import crontab
from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

from backend.config.cache import build_cache_config
from backend.core.settings import BACKEND_ROOT

load_dotenv(BACKEND_ROOT / ".env", override=True)

BASE_DIR = Path(__file__).resolve().parents[1]

def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


DEBUG = env_bool("DJANGO_DEBUG", False)
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "a3-dev-secret-key-change-before-production"
    else:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG=0")
ALLOWED_HOSTS = [host.strip() for host in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")]

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.admin",
    "rest_framework",
    "corsheaders",
    "backend.apps.accounts",
    "backend.apps.profiles",
    "backend.apps.knowledge_base",
    "backend.apps.learning",
    "backend.apps.assessments",
    "backend.apps.engagement",
    "backend.apps.system",
    "backend.apps.compat",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "backend.apps.accounts.middleware.BearerTokenAuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "backend.config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "backend.config.wsgi.application"
ASGI_APPLICATION = "backend.config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "NAME": os.getenv("MYSQL_DATABASE", "a3_learning"),
        "USER": os.getenv("MYSQL_USER", "root"),
        "PASSWORD": os.getenv("MYSQL_PASSWORD", ""),
        "HOST": os.getenv("MYSQL_HOST", "127.0.0.1"),
        "PORT": os.getenv("MYSQL_PORT", "3306"),
        "OPTIONS": {
            "charset": "utf8mb4",
            "init_command": "SET sql_mode='STRICT_TRANS_TABLES'",
        },
    }
}

CACHE_REDIS_URL = os.getenv("CACHE_REDIS_URL", "").strip()
if not DEBUG and not CACHE_REDIS_URL:
    raise ImproperlyConfigured(
        "CACHE_REDIS_URL must be set when DJANGO_DEBUG=0 so verification codes "
        "are shared between web workers"
    )
CACHES = build_cache_config(CACHE_REDIS_URL)

AUTH_USER_MODEL = "accounts.User"

LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002",
    ).split(",")
]
CORS_ALLOW_CREDENTIALS = True

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS

SMS_WEBHOOK_URL = os.getenv("SMS_WEBHOOK_URL", "")
SMS_WEBHOOK_TOKEN = os.getenv("SMS_WEBHOOK_TOKEN", "")
EMAIL_BACKEND = os.getenv("EMAIL_BACKEND", "django.core.mail.backends.smtp.EmailBackend")
EMAIL_HOST = os.getenv("EMAIL_HOST", "smtp.qq.com")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "465"))
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", False)
EMAIL_USE_SSL = env_bool("EMAIL_USE_SSL", True)
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "3062221819@qq.com")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", EMAIL_HOST_USER or "3062221819@qq.com")
VERIFICATION_CODE_DEV_MODE = env_bool("VERIFICATION_CODE_DEV_MODE", False)
VERIFICATION_CODE_DEV_VALUE = os.getenv("VERIFICATION_CODE_DEV_VALUE", "123456")

KNOWLEDGE_UPLOAD_ROOT = os.getenv("KNOWLEDGE_UPLOAD_ROOT", str(BASE_DIR.parent / "data" / "uploads"))
KNOWLEDGE_UPLOAD_MAX_BYTES = int(os.getenv("KNOWLEDGE_UPLOAD_MAX_BYTES", str(200 * 1024 * 1024)))

CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"))
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", "cache+memory://")
CELERY_TASK_IGNORE_RESULT = True
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = int(os.getenv("CELERY_TASK_TIME_LIMIT", "14400"))
CELERY_TASK_SOFT_TIME_LIMIT = int(os.getenv("CELERY_TASK_SOFT_TIME_LIMIT", "13800"))
CELERY_BEAT_POLICY_OUTCOME_HOUR = int(os.getenv("CELERY_BEAT_POLICY_OUTCOME_HOUR", "3"))
CELERY_BEAT_POLICY_OUTCOME_MINUTE = int(os.getenv("CELERY_BEAT_POLICY_OUTCOME_MINUTE", "15"))
CELERY_BEAT_SCHEDULE = {
    "a3-evaluate-optimization-policy-outcomes-daily": {
        "task": "learning.evaluate_optimization_policy_outcomes",
        "schedule": crontab(hour=CELERY_BEAT_POLICY_OUTCOME_HOUR, minute=CELERY_BEAT_POLICY_OUTCOME_MINUTE),
        "kwargs": {"days": 7},
    }
}

A3_AGENT_CIRCUIT_RECENT_LIMIT = int(os.getenv("A3_AGENT_CIRCUIT_RECENT_LIMIT", "12"))
A3_AGENT_CIRCUIT_MIN_SAMPLES = int(os.getenv("A3_AGENT_CIRCUIT_MIN_SAMPLES", "3"))
A3_AGENT_CIRCUIT_OPEN_THRESHOLD = float(os.getenv("A3_AGENT_CIRCUIT_OPEN_THRESHOLD", "0.5"))
A3_AGENT_RUNTIME_POLICIES = {
    "ProfileAgent": {"maxRetries": int(os.getenv("A3_PROFILE_AGENT_MAX_RETRIES", "1")), "timeoutMs": int(os.getenv("A3_PROFILE_AGENT_TIMEOUT_MS", "2500"))},
    "PlannerAgent": {"maxRetries": int(os.getenv("A3_PLANNER_AGENT_MAX_RETRIES", "1")), "timeoutMs": int(os.getenv("A3_PLANNER_AGENT_TIMEOUT_MS", "5000"))},
    "RetrieverAgent": {"maxRetries": int(os.getenv("A3_RETRIEVER_AGENT_MAX_RETRIES", "1")), "timeoutMs": int(os.getenv("A3_RETRIEVER_AGENT_TIMEOUT_MS", "3000"))},
    "VerifierAgent": {"maxRetries": int(os.getenv("A3_VERIFIER_AGENT_MAX_RETRIES", "1")), "timeoutMs": int(os.getenv("A3_VERIFIER_AGENT_TIMEOUT_MS", "3000"))},
    "AssessmentAgent": {"maxRetries": int(os.getenv("A3_ASSESSMENT_AGENT_MAX_RETRIES", "0")), "timeoutMs": int(os.getenv("A3_ASSESSMENT_AGENT_TIMEOUT_MS", "2000"))},
    "StudyPlanAgent": {"maxRetries": int(os.getenv("A3_STUDY_PLAN_AGENT_MAX_RETRIES", "1")), "timeoutMs": int(os.getenv("A3_STUDY_PLAN_AGENT_TIMEOUT_MS", "4000"))},
}

if CELERY_BROKER_URL == "filesystem://":
    CELERY_QUEUE_ROOT = BASE_DIR / "knowledge_base" / "celery_queue"
    CELERY_QUEUE_ROOT.mkdir(parents=True, exist_ok=True)
    (CELERY_QUEUE_ROOT / "processed").mkdir(parents=True, exist_ok=True)
    CELERY_BROKER_TRANSPORT_OPTIONS = {
        "data_folder_in": str(CELERY_QUEUE_ROOT),
        "data_folder_out": str(CELERY_QUEUE_ROOT),
        "processed_folder": str(CELERY_QUEUE_ROOT / "processed"),
        "store_processed": True,
    }
