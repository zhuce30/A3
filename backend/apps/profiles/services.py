from __future__ import annotations

from django.db import transaction

from backend.apps.accounts.models import User
from backend.apps.accounts.services import public_user, verify_code
from backend.apps.learning.models import Course, KnowledgePoint, LearningPath, LearningPathStatus
from backend.apps.learning.services import default_course
from backend.apps.profiles.dynamic_profile import build_dynamic_profile
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot


PROFILE_FIELDS = {
    "grade",
    "major_direction",
    "foundation_level",
    "daily_study_time",
    "pace",
    "learning_goals",
    "weak_points",
    "learning_preferences",
    "expected_resources",
    "extra_profile",
}

PROFILE_STRING_LIMITS = {
    "displayName": 64,
    "email": 254,
    "studentId": 64,
    "school": 128,
}

ONBOARDING_STEPS = {"role", "phone", "welcome", "privacy", "profile", "complete"}
PROFILE_LIST_LIMIT = 12
PROFILE_LIST_ITEM_LIMIT = 128
PROFILE_COMPLETION_MODE_COMPLETE = "complete"
PROFILE_COMPLETION_MODE_DIAGNOSTIC_READY = "diagnostic_ready"

PROFILE_STATIC_OPTIONS = {
    "majorDirections": [
        "计算机科学与技术",
        "软件工程",
        "网络工程",
        "信息安全",
        "人工智能",
    ],
    "grades": ["大一", "大二", "大三", "大四", "研究生", "其他"],
    "foundationLevels": ["基础较弱", "基础一般", "基础较好", "基础扎实"],
    "learningGoals": ["掌握操作系统", "应对课程考试", "补齐进程与内存管理", "完成课程实验", "准备考研专业课"],
    "learningPreferences": ["课堂讲解", "图解流程", "例题推导", "动画演示", "互动练习", "错题复盘", "代码实验"],
    "expectedResources": ["视频课程", "课件讲义", "练习题库", "知识卡片", "算法演示", "代码实验"],
    "dailyStudyTimes": ["30", "60", "120", "180"],
    "paces": [
        {"value": "relaxed", "label": "稳扎稳打"},
        {"value": "standard", "label": "标准节奏"},
        {"value": "intensive", "label": "强化提升"},
    ],
}


def public_profile(profile: LearnerProfile | None) -> dict | None:
    if profile is None:
        return None
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    snapshot = aggregate_profile_snapshot(profile, save=False)
    extra_profile = {
        **extra_profile,
        "dynamicProfile": build_dynamic_profile(profile, extra=extra_profile),
        "dynamicProfileV2": snapshot,
        "profileSnapshot": snapshot,
    }
    return {
        "id": str(profile.id),
        "grade": profile.grade,
        "majorDirection": profile.major_direction,
        "foundationLevel": profile.foundation_level,
        "dailyStudyTime": profile.daily_study_time,
        "pace": profile.pace,
        "learningGoals": profile.learning_goals,
        "weakPoints": profile.weak_points,
        "learningPreferences": profile.learning_preferences,
        "expectedResources": profile.expected_resources,
        "extraProfile": extra_profile,
        "createdAt": profile.created_at.isoformat() if profile.created_at else "",
        "updatedAt": profile.updated_at.isoformat() if profile.updated_at else "",
    }


def get_profile_payload(user: User) -> dict:
    profile = getattr(user, "learner_profile", None)
    return {"user": public_user(user), "profile": public_profile(profile)}


def get_learning_profile_options() -> dict:
    course = default_course()

    weak_points = []
    if course is not None:
        points = (
            KnowledgePoint.objects.filter(chapter__course=course)
            .select_related("chapter")
            .order_by("chapter__order", "order")
        )
        weak_points = [
            {
                "value": point.title,
                "label": point.title,
                "chapter": f"第 {point.chapter.order} 章 · {point.chapter.title}",
                "difficulty": point.difficulty,
            }
            for point in points
        ]

    return {
        "course": {
            "id": str(course.id),
            "code": course.code,
            "title": course.title,
        } if course else None,
        "options": {**PROFILE_STATIC_OPTIONS, "weakPoints": weak_points},
    }


def _clean_string(value, field_name: str, *, max_length: int, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    cleaned = value.strip()
    if required and not cleaned:
        raise ValueError(f"{field_name} is required")
    if len(cleaned) > max_length:
        raise ValueError(f"{field_name} is too long")
    return cleaned


def _clean_bool(value, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _clean_choice(value, field_name: str, allowed: set[str], *, required: bool = True) -> str:
    cleaned = _clean_string(value, field_name, max_length=PROFILE_LIST_ITEM_LIMIT, required=required)
    if cleaned and cleaned not in allowed:
        raise ValueError(f"{field_name} is not supported")
    return cleaned


def _clean_string_list(value, field_name: str, allowed: set[str] | None = None) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list")

    cleaned_items = []
    seen = set()
    for raw_item in value:
        item = _clean_string(raw_item, field_name, max_length=PROFILE_LIST_ITEM_LIMIT, required=True)
        if allowed is not None and item not in allowed:
            raise ValueError(f"{field_name} contains unsupported value")
        if item not in seen:
            seen.add(item)
            cleaned_items.append(item)

    if len(cleaned_items) > PROFILE_LIST_LIMIT:
        raise ValueError(f"{field_name} has too many items")
    return cleaned_items


def _profile_allowed_values(options: dict) -> dict[str, set[str]]:
    return {
        "majorDirection": set(options["majorDirections"]),
        "grade": set(options["grades"]),
        "foundationLevel": set(options["foundationLevels"]),
        "learningGoals": set(options["learningGoals"]),
        "learningPreferences": set(options["learningPreferences"]),
        "expectedResources": set(options["expectedResources"]),
        "dailyStudyTime": set(options["dailyStudyTimes"]),
        "pace": {item["value"] for item in options["paces"]},
        "weakPoints": {item["value"] for item in options["weakPoints"]},
    }


@transaction.atomic
def update_user_profile(user: User, payload: dict) -> dict:
    user_fields = []
    phone = str(payload.get("phone", "")).strip()
    code = str(payload.get("code", "")).strip()
    if phone and code:
        if User.objects.filter(phone=phone).exclude(id=user.id).exists():
            raise ValueError("手机号已绑定到其他账号")
        if not verify_code(phone, code, purpose="bind", consume=True):
            raise ValueError("验证码不正确或已过期")
        user.phone = phone
        user.phone_bound = True
        user.onboarding_step = "welcome"
        user_fields.extend(["phone", "phone_bound", "onboarding_step"])

    user_mapping = {
        "displayName": "display_name",
        "email": "email",
        "studentId": "student_id",
        "school": "school",
        "privacyAccepted": "privacy_accepted",
        "onboardingStep": "onboarding_step",
    }
    if "phoneBound" in payload and payload["phoneBound"] != user.phone_bound:
        raise ValueError("手机号绑定状态只能通过验证码修改")
    if "role" in payload:
        requested_role = str(payload.get("role", "")).strip()
        if requested_role != user.role:
            raise ValueError("身份变更需要由管理员审核")
        user.onboarding_step = "welcome" if user.phone_bound else "phone"
        user_fields.append("onboarding_step")

    for input_key, model_field in user_mapping.items():
        if input_key in payload:
            value = payload[input_key]
            if input_key in PROFILE_STRING_LIMITS:
                value = _clean_string(value, input_key, max_length=PROFILE_STRING_LIMITS[input_key])
            elif input_key == "privacyAccepted":
                value = _clean_bool(value, input_key)
            elif input_key == "onboardingStep":
                value = _clean_choice(value, input_key, ONBOARDING_STEPS)
            setattr(user, model_field, value)
            user_fields.append(model_field)
            if input_key == "privacyAccepted":
                user.onboarding_step = "profile" if value else "privacy"
                user_fields.append("onboarding_step")
    if user_fields:
        user_fields.append("updated_at")
        user.save(update_fields=sorted(set(user_fields)))
    if "consents" in payload and isinstance(payload["consents"], dict):
        profile, _ = LearnerProfile.objects.get_or_create(user=user)
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        extra_profile["consents"] = {
            **(extra_profile.get("consents") if isinstance(extra_profile.get("consents"), dict) else {}),
            **payload["consents"],
        }
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])
    return get_profile_payload(user)


@transaction.atomic
def extract_and_save_profile(user: User, text: str) -> dict:
    """Extract learner profile fields from free-form text and save them."""
    from backend.apps.profiles.extractor import extract_profile_from_text, map_extracted_to_profile_fields

    if not user.privacy_accepted:
        raise PermissionError("请先完成隐私授权，再进行学习画像抽取")

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    existing = {
        "grade": profile.grade,
        "major_direction": profile.major_direction,
        "foundation_level": profile.foundation_level,
        "daily_study_time": profile.daily_study_time,
        "pace": profile.pace,
        "learning_goals": profile.learning_goals,
        "weak_points": profile.weak_points,
        "learning_preferences": profile.learning_preferences,
        "expected_resources": profile.expected_resources,
    }
    raw = extract_profile_from_text(text, existing_profile=existing)
    fields = map_extracted_to_profile_fields(raw)
    for field, value in fields.items():
        setattr(profile, field, value)
    if fields:
        profile.save(update_fields=list(fields.keys()) + ["updated_at"])
    return {
        "profile": public_profile(profile),
        "extracted": raw,
        "updatedFields": list(fields.keys()),
        "profileReadiness": profile_readiness(profile),
        "nextAction": profile_next_action(user, profile),
    }


def profile_readiness(profile: LearnerProfile | None) -> dict:
    checks = [
        ("grade", bool(profile and profile.grade), "年级"),
        ("majorDirection", bool(profile and profile.major_direction), "专业方向"),
        ("foundationLevel", bool(profile and profile.foundation_level), "基础水平"),
        ("dailyStudyTime", bool(profile and profile.daily_study_time), "每日时间"),
        ("learningGoals", bool(profile and profile.learning_goals), "学习目标"),
        ("weakPoints", bool(profile and profile.weak_points), "薄弱点"),
        ("learningPreferences", bool(profile and profile.learning_preferences), "学习偏好"),
        ("expectedResources", bool(profile and profile.expected_resources), "资源偏好"),
    ]
    completed = [key for key, ready, _label in checks if ready]
    missing = [{"field": key, "label": label} for key, ready, label in checks if not ready]
    score = round(len(completed) * 100 / len(checks)) if checks else 0
    if score >= 90:
        status = "ready"
    elif score >= 60:
        status = "partial"
    else:
        status = "incomplete"
    return {
        "score": score,
        "status": status,
        "completedFields": completed,
        "missingFields": missing,
        "summary": "画像已可用于生成诊断、路径和学习计划" if status == "ready" else "画像信息不足，请补齐关键字段",
    }


def setup_readiness(profile: LearnerProfile | None) -> dict:
    required_fields = [
        ("majorDirection", bool(profile and profile.major_direction)),
        ("grade", bool(profile and profile.grade)),
        ("learningGoals", bool(profile and profile.learning_goals)),
        ("learningPreferences", bool(profile and profile.learning_preferences)),
        ("dailyStudyTime", bool(profile and profile.daily_study_time)),
        ("expectedResources", bool(profile and profile.expected_resources)),
    ]
    deferred_dimensions = [
        field
        for field, ready in [
            ("foundationLevel", bool(profile and profile.foundation_level)),
            ("weakPoints", bool(profile and profile.weak_points)),
            ("pace", bool(profile and profile.pace)),
        ]
        if not ready
    ]
    missing_required_fields = [field for field, ready in required_fields if not ready]
    return {
        "status": "ready_for_diagnostic" if not missing_required_fields else "incomplete",
        "missingRequiredFields": missing_required_fields,
        "deferredDimensions": deferred_dimensions,
    }


def profile_next_action(user: User, profile: LearnerProfile | None) -> dict:
    readiness = setup_readiness(profile)
    if not user.privacy_accepted:
        return {"label": "完成隐私授权", "href": "/a3/privacy", "reason": "未授权前不进行个性化画像处理"}
    if readiness["status"] != "ready_for_diagnostic":
        return {"label": "补齐学习画像", "href": "/a3/profile-setup", "reason": "关键画像字段仍不完整"}
    return {
        "label": "开始入学诊断",
        "href": "/a3/admission-diagnostic",
        "reason": "学习设置已保存，诊断会补齐基础和薄弱点",
    }


def _profile_completion_mode(payload: dict) -> str:
    raw_mode = payload.get("completionMode")
    if raw_mode is None or (isinstance(raw_mode, str) and not raw_mode.strip()):
        return PROFILE_COMPLETION_MODE_COMPLETE
    if not isinstance(raw_mode, str):
        raise ValueError("completionMode 不受支持")
    mode = raw_mode.strip()
    if mode not in {PROFILE_COMPLETION_MODE_COMPLETE, PROFILE_COMPLETION_MODE_DIAGNOSTIC_READY}:
        raise ValueError("completionMode 不受支持")
    return mode


def _validate_learning_profile_payload(payload: dict) -> str:
    mode = _profile_completion_mode(payload)
    checks = [
        ("majorDirection", "专业方向", bool(str(payload.get("majorDirection") or "").strip())),
        ("grade", "年级", bool(str(payload.get("grade") or "").strip())),
        ("learningGoals", "学习目标", isinstance(payload.get("learningGoals"), list) and bool(payload.get("learningGoals"))),
        ("learningPreferences", "学习偏好", isinstance(payload.get("learningPreferences"), list) and bool(payload.get("learningPreferences"))),
        ("dailyStudyTime", "每日时间", bool(str(payload.get("dailyStudyTime") or "").strip())),
        ("expectedResources", "资源类型", isinstance(payload.get("expectedResources"), list) and bool(payload.get("expectedResources"))),
    ]
    if mode == PROFILE_COMPLETION_MODE_COMPLETE:
        checks.extend(
            [
                ("foundationLevel", "基础水平", bool(str(payload.get("foundationLevel") or "").strip())),
                ("weakPoints", "薄弱知识点", isinstance(payload.get("weakPoints"), list) and bool(payload.get("weakPoints"))),
                ("pace", "学习节奏", bool(str(payload.get("pace") or "").strip())),
            ]
        )
    missing = [label for _field, label, ready in checks if not ready]
    if missing:
        raise ValueError(f"请先补齐：{'、'.join(missing)}")
    return mode


def _validate_complete_learning_profile_payload(payload: dict) -> str:
    return _validate_learning_profile_payload(payload)


def _save_learning_profile_core(user: User, payload: dict, *, refresh_learning_assets: bool = True) -> dict:
    completion_mode = _validate_learning_profile_payload(payload)
    display_name = _clean_string(payload.get("displayName", ""), "displayName", max_length=64)
    if display_name:
        user.display_name = display_name
        user.save(update_fields=["display_name", "updated_at"])

    options = get_learning_profile_options()["options"]
    allowed = _profile_allowed_values(options)

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    field_mapping = {
        "grade": "grade",
        "majorDirection": "major_direction",
        "foundationLevel": "foundation_level",
        "dailyStudyTime": "daily_study_time",
        "pace": "pace",
        "learningGoals": "learning_goals",
        "weakPoints": "weak_points",
        "learningPreferences": "learning_preferences",
        "expectedResources": "expected_resources",
        "extraProfile": "extra_profile",
    }
    changed_fields = []
    for input_key, model_field in field_mapping.items():
        if input_key in payload:
            value = payload[input_key]
            if input_key in {"majorDirection", "grade", "foundationLevel", "pace"}:
                value = _clean_choice(
                    value,
                    input_key,
                    allowed[input_key],
                    required=not (
                        completion_mode == PROFILE_COMPLETION_MODE_DIAGNOSTIC_READY
                        and input_key in {"foundationLevel", "pace"}
                    ),
                )
            elif input_key == "dailyStudyTime":
                value = _clean_choice(value, input_key, allowed[input_key])
                value = int(value)
            elif input_key in {"learningGoals", "weakPoints", "learningPreferences", "expectedResources"}:
                value = _clean_string_list(value, input_key, allowed[input_key])
            elif input_key == "extraProfile" and not isinstance(value, dict):
                raise ValueError("extraProfile must be an object")
            setattr(profile, model_field, value)
            changed_fields.append(model_field)
    if changed_fields:
        changed_fields.append("updated_at")
        profile.save(update_fields=changed_fields)

    readiness = setup_readiness(profile)
    profile_setup_complete = readiness["status"] == "ready_for_diagnostic"
    user.profile_completed = profile_setup_complete
    if profile_setup_complete:
        user.onboarding_step = "complete"
    user.save(update_fields=["profile_completed", "onboarding_step", "updated_at"])
    generated = {"path": False, "studyPlan": False}
    generation_error = ""
    if refresh_learning_assets:
        try:
            from backend.apps.learning.services import generate_learning_path, generate_study_plan

            generate_learning_path(user, force=True)
            generated["path"] = True
            generate_study_plan(user, duration_days=14, force=True)
            generated["studyPlan"] = True
        except Exception as exc:
            generation_error = str(exc)

    profile.refresh_from_db()
    payload = get_profile_payload(user)
    payload.update(
        {
            "profileReadiness": profile_readiness(profile),
            "setupReadiness": setup_readiness(profile),
            "completionMode": completion_mode,
            "nextAction": profile_next_action(user, profile),
            "generated": generated,
            "personalizationImpact": personalization_impact(user, profile),
        }
    )
    if generation_error:
        payload["generationError"] = generation_error
    return payload


def save_learning_profile(user: User, payload: dict) -> dict:
    from backend.apps.compat.agent_kernel import run_profile_setup_workflow

    completion_mode = _validate_learning_profile_payload(payload)
    result = run_profile_setup_workflow(user, payload)
    if not result.success:
        raise ValueError(str(result.output.get("error") or "学习画像智能体工作流执行失败"))
    profile = LearnerProfile.objects.get(user=user)
    response = get_profile_payload(user)
    response.update(
        {
            "profileReadiness": profile_readiness(profile),
            "setupReadiness": setup_readiness(profile),
            "completionMode": completion_mode,
            "nextAction": profile_next_action(user, profile),
            "generated": {
                "path": bool(result.state.get("pathGenerated")),
                "studyPlan": bool(result.state.get("studyPlanGenerated")),
            },
            "personalizationImpact": personalization_impact(user, profile),
            "traceId": result.trace.get("traceId"),
        }
    )
    return response


def personalization_impact(user: User, profile: LearnerProfile) -> dict:
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan") if isinstance(extra_profile.get("studyPlan"), dict) else {}
    adaptive_policy = plan.get("adaptivePolicy") if isinstance(plan.get("adaptivePolicy"), dict) else {}
    path = (
        LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE)
        .prefetch_related("items__knowledge_point")
        .order_by("-version")
        .first()
    )
    path_focus = []
    if path:
        path_focus = [
            {
                "title": item.knowledge_point.title,
                "reason": item.reason,
                "order": item.order,
            }
            for item in path.items.all().order_by("order")[:3]
        ]
    weak_points = profile.weak_points if isinstance(profile.weak_points, list) else []
    return {
        "profileInputs": {
            "foundationLevel": profile.foundation_level,
            "dailyStudyTime": profile.daily_study_time,
            "pace": profile.pace,
            "weakPoints": weak_points,
            "learningGoals": profile.learning_goals if isinstance(profile.learning_goals, list) else [],
            "learningPreferences": profile.learning_preferences if isinstance(profile.learning_preferences, list) else [],
        },
        "pathFocus": path_focus,
        "plan": {
            "dailyMinutes": plan.get("dailyMinutes"),
            "durationDays": plan.get("durationDays"),
            "mode": adaptive_policy.get("mode"),
            "reason": adaptive_policy.get("reason") or plan.get("coachTip") or "根据画像、路径和错题状态生成学习节奏。",
        },
        "explanation": "学习画像会参与路径排序、每日学习时长、任务负荷和复习安排生成。",
    }
