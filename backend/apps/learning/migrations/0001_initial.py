import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='Course',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(max_length=64, unique=True)),
                ('title', models.CharField(max_length=128)),
                ('description', models.TextField(blank=True)),
                ('edition', models.CharField(blank=True, max_length=64)),
                ('cover', models.CharField(blank=True, max_length=255)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'a3_courses',
                'ordering': ['code'],
            },
        ),
        migrations.CreateModel(
            name='Chapter',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('order', models.PositiveSmallIntegerField()),
                ('title', models.CharField(max_length=128)),
                ('description', models.TextField(blank=True)),
                ('estimated_minutes', models.PositiveIntegerField(default=60)),
                ('course', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='chapters', to='learning.course')),
            ],
            options={
                'db_table': 'a3_course_chapters',
                'ordering': ['order'],
            },
        ),
        migrations.CreateModel(
            name='CourseEnrollment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('progress', models.PositiveSmallIntegerField(default=0)),
                ('enrolled_at', models.DateTimeField(auto_now_add=True)),
                ('last_studied_at', models.DateTimeField(blank=True, null=True)),
                ('course', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='enrollments', to='learning.course')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='course_enrollments', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'a3_course_enrollments',
            },
        ),
        migrations.CreateModel(
            name='KnowledgePoint',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('code', models.CharField(max_length=64, unique=True)),
                ('order', models.PositiveSmallIntegerField()),
                ('title', models.CharField(max_length=128)),
                ('description', models.TextField(blank=True)),
                ('difficulty', models.PositiveSmallIntegerField(default=2)),
                ('estimated_minutes', models.PositiveIntegerField(default=30)),
                ('chapter', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='knowledge_points', to='learning.chapter')),
            ],
            options={
                'db_table': 'a3_knowledge_points',
                'ordering': ['chapter__order', 'order'],
            },
        ),
        migrations.CreateModel(
            name='KnowledgePrerequisite',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('knowledge_point', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='prerequisite_edges', to='learning.knowledgepoint')),
                ('prerequisite', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='dependent_edges', to='learning.knowledgepoint')),
            ],
            options={
                'db_table': 'a3_knowledge_prerequisites',
            },
        ),
        migrations.CreateModel(
            name='LearningPath',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('version', models.PositiveIntegerField(default=1)),
                ('status', models.CharField(choices=[('active', '使用中'), ('archived', '已归档')], default='active', max_length=16)),
                ('title', models.CharField(max_length=160)),
                ('rationale', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('course', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='learning_paths', to='learning.course')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='learning_paths', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'a3_learning_paths',
                'ordering': ['-created_at'],
            },
        ),
        migrations.CreateModel(
            name='LearningPathItem',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('order', models.PositiveIntegerField()),
                ('status', models.CharField(choices=[('locked', '待解锁'), ('current', '进行中'), ('completed', '已完成')], default='locked', max_length=16)),
                ('progress', models.PositiveSmallIntegerField(default=0)),
                ('reason', models.CharField(blank=True, max_length=255)),
                ('estimated_minutes', models.PositiveIntegerField(default=30)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('knowledge_point', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='path_items', to='learning.knowledgepoint')),
                ('path', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='items', to='learning.learningpath')),
            ],
            options={
                'db_table': 'a3_learning_path_items',
                'ordering': ['order'],
            },
        ),
        migrations.AddConstraint(
            model_name='chapter',
            constraint=models.UniqueConstraint(fields=('course', 'order'), name='unique_course_chapter_order'),
        ),
        migrations.AddConstraint(
            model_name='courseenrollment',
            constraint=models.UniqueConstraint(fields=('user', 'course'), name='unique_user_course_enrollment'),
        ),
        migrations.AddConstraint(
            model_name='knowledgeprerequisite',
            constraint=models.UniqueConstraint(fields=('knowledge_point', 'prerequisite'), name='unique_knowledge_prerequisite'),
        ),
        migrations.AddConstraint(
            model_name='learningpath',
            constraint=models.UniqueConstraint(fields=('user', 'course', 'version'), name='unique_learning_path_version'),
        ),
        migrations.AddConstraint(
            model_name='learningpathitem',
            constraint=models.UniqueConstraint(fields=('path', 'order'), name='unique_path_item_order'),
        ),
        migrations.AddConstraint(
            model_name='learningpathitem',
            constraint=models.UniqueConstraint(fields=('path', 'knowledge_point'), name='unique_path_knowledge_point'),
        ),
    ]
