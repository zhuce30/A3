from __future__ import annotations

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


class UserRole(models.TextChoices):
    STUDENT = "student", "学生"
    TEACHER = "teacher", "教师"
    ADMIN = "admin", "管理员"


class UserManager(BaseUserManager):
    def create_user(self, phone: str, password: str | None = None, **extra_fields):
        if not phone:
            raise ValueError("手机号不能为空")
        user = self.model(phone=phone.strip(), **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, phone: str, password: str | None = None, **extra_fields):
        extra_fields.setdefault("role", UserRole.ADMIN)
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_active", True)
        return self.create_user(phone, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    phone = models.CharField("手机号", max_length=32, unique=True)
    email = models.EmailField("邮箱", blank=True)
    student_id = models.CharField("学号", max_length=64, blank=True)
    display_name = models.CharField("显示名称", max_length=64, default="同学")
    role = models.CharField("角色", max_length=16, choices=UserRole.choices, default=UserRole.STUDENT)
    school = models.CharField("学校/学院", max_length=128, blank=True)
    phone_bound = models.BooleanField("已绑定手机号", default=True)
    privacy_accepted = models.BooleanField("已授权隐私协议", default=False)
    profile_completed = models.BooleanField("已完成学习画像", default=False)
    onboarding_step = models.CharField("引导步骤", max_length=32, default="welcome")
    is_active = models.BooleanField("启用", default=True)
    is_staff = models.BooleanField("员工状态", default=False)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    objects = UserManager()

    USERNAME_FIELD = "phone"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        db_table = "a3_users"
        verbose_name = "用户"
        verbose_name_plural = "用户"

    def __str__(self) -> str:
        return f"{self.display_name}({self.phone})"


class UserAccessState(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="access_state")
    registration_ip = models.GenericIPAddressField(null=True, blank=True)
    registration_country = models.CharField(max_length=8, blank=True)
    last_ip = models.GenericIPAddressField(null=True, blank=True)
    last_country = models.CharField(max_length=8, blank=True)
    last_path = models.CharField(max_length=255, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True, db_index=True)
    last_persisted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_user_access_states"


class UserAccessEvent(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="access_events")
    event_type = models.CharField(max_length=32)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    country = models.CharField(max_length=8, blank=True)
    path = models.CharField(max_length=255, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        db_table = "a3_user_access_events"
        ordering = ["-created_at", "-id"]
        indexes = [models.Index(fields=["user", "event_type", "-created_at"], name="a3_access_user_event_idx")]
