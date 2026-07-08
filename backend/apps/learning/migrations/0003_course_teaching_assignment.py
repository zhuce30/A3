from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("learning", "0002_seed_default_course"),
    ]

    operations = [
        migrations.CreateModel(
            name="CourseTeachingAssignment",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("course", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="teaching_assignments", to="learning.course")),
                ("teacher", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="teaching_assignments", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "a3_course_teaching_assignments",
            },
        ),
        migrations.AddConstraint(
            model_name="courseteachingassignment",
            constraint=models.UniqueConstraint(fields=("teacher", "course"), name="unique_teacher_course_assignment"),
        ),
    ]
