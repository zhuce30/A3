from __future__ import annotations

from django.http import JsonResponse

from backend.apps.accounts.models import UserRole


TEACHING_ROLES = {UserRole.TEACHER, UserRole.ADMIN}


def require_authenticated(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "请先登录"}, status=401)
    return None


def require_teacher_role(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if request.user.role not in TEACHING_ROLES:
        return JsonResponse({"success": False, "error": "当前账号无教师权限"}, status=403)
    return None
