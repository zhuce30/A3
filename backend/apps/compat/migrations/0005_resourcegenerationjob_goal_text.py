from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("compat", "0004_resourcegenerationjob"),
    ]

    operations = [
        migrations.AlterField(
            model_name="resourcegenerationjob",
            name="goal",
            field=models.TextField(blank=True),
        ),
    ]
