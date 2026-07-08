import django.db.models.deletion
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('learning', '0002_seed_default_course'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='AssessmentSession',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('status', models.CharField(choices=[('in_progress', '进行中'), ('completed', '已完成')], default='in_progress', max_length=16)),
                ('question_ids', models.JSONField(default=list)),
                ('current_index', models.PositiveIntegerField(default=0)),
                ('score', models.PositiveSmallIntegerField(default=0)),
                ('started_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('learning_path', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='assessment_sessions', to='learning.learningpath')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='assessment_sessions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'a3_assessment_sessions',
                'ordering': ['-started_at'],
            },
        ),
        migrations.CreateModel(
            name='Question',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('stem', models.TextField()),
                ('options', models.JSONField(default=list)),
                ('correct_answer', models.CharField(max_length=16)),
                ('explanation', models.TextField()),
                ('error_cause', models.CharField(blank=True, max_length=255)),
                ('difficulty', models.PositiveSmallIntegerField(default=2)),
                ('is_active', models.BooleanField(default=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('knowledge_point', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='questions', to='learning.knowledgepoint')),
            ],
            options={
                'db_table': 'a3_questions',
                'ordering': ['knowledge_point__chapter__order', 'knowledge_point__order', 'difficulty'],
            },
        ),
        migrations.CreateModel(
            name='AssessmentAnswer',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('selected_answer', models.CharField(blank=True, max_length=16)),
                ('is_correct', models.BooleanField(default=False)),
                ('is_skipped', models.BooleanField(default=False)),
                ('answered_at', models.DateTimeField(auto_now_add=True)),
                ('session', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='answers', to='assessments.assessmentsession')),
                ('question', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='answers', to='assessments.question')),
            ],
            options={
                'db_table': 'a3_assessment_answers',
                'constraints': [models.UniqueConstraint(fields=('session', 'question'), name='unique_session_question_answer')],
            },
        ),
        migrations.CreateModel(
            name='WrongQuestion',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('wrong_count', models.PositiveIntegerField(default=1)),
                ('consecutive_correct', models.PositiveSmallIntegerField(default=0)),
                ('mastered', models.BooleanField(default=False)),
                ('last_wrong_answer', models.CharField(blank=True, max_length=16)),
                ('last_wrong_at', models.DateTimeField(auto_now=True)),
                ('review_after', models.DateTimeField(blank=True, null=True)),
                ('question', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='wrong_records', to='assessments.question')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='wrong_questions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'a3_wrong_questions',
                'ordering': ['mastered', '-last_wrong_at'],
                'constraints': [models.UniqueConstraint(fields=('user', 'question'), name='unique_user_wrong_question')],
            },
        ),
    ]
