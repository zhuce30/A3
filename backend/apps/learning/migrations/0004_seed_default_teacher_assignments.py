from django.db import migrations


def seed_default_teacher_assignments(apps, schema_editor):
    User = apps.get_model("accounts", "User")
    Course = apps.get_model("learning", "Course")
    CourseTeachingAssignment = apps.get_model("learning", "CourseTeachingAssignment")

    course = Course.objects.filter(code="OS-001", is_active=True).first()
    if course is None:
        return
    teachers = User.objects.filter(role__in=["teacher", "admin"], is_active=True)
    for teacher in teachers:
        CourseTeachingAssignment.objects.get_or_create(teacher=teacher, course=course)


class Migration(migrations.Migration):
    dependencies = [("learning", "0003_course_teaching_assignment")]
    operations = [migrations.RunPython(seed_default_teacher_assignments, migrations.RunPython.noop)]
