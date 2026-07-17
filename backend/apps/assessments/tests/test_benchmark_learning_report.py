from __future__ import annotations

import json
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from backend.apps.accounts.models import User


class BenchmarkLearningReportCommandTests(TestCase):
    def setUp(self):
        self.phone = "13800003199"
        self.password = "BenchmarkSecret123"
        self.user = User.objects.create_user(
            phone=self.phone,
            password=self.password,
            display_name="Benchmark Student",
        )

    def test_json_output_contains_only_aggregate_metrics(self):
        stdout = StringIO()

        call_command(
            "benchmark_learning_report",
            "--user-id",
            str(self.user.pk),
            "--period",
            "30d",
            "--repeat",
            "2",
            "--json",
            stdout=stdout,
        )

        output = stdout.getvalue().strip()
        payload = json.loads(output)
        self.assertEqual(
            set(payload),
            {"success", "period", "repeat", "elapsedMs", "queryCount"},
        )
        self.assertEqual(payload["success"], True)
        self.assertEqual(payload["period"], "30d")
        self.assertEqual(payload["repeat"], 2)
        self.assertEqual(set(payload["elapsedMs"]), {"min", "average", "max"})
        self.assertEqual(set(payload["queryCount"]), {"min", "average", "max"})
        for metric in (payload["elapsedMs"], payload["queryCount"]):
            self.assertTrue(all(isinstance(value, (int, float)) for value in metric.values()))
            self.assertLessEqual(metric["min"], metric["average"])
            self.assertLessEqual(metric["average"], metric["max"])
        self.assertGreater(payload["queryCount"]["min"], 0)
        self.assertNotIn(self.phone, output)
        self.assertNotIn(self.password, output)
        self.assertNotIn(self.user.password, output)
        self.assertNotIn("Benchmark Student", output)
        self.assertNotIn("report", output.lower())
        self.assertNotIn("session", output.lower())

    def test_text_output_contains_metrics_without_user_data(self):
        stdout = StringIO()

        call_command(
            "benchmark_learning_report",
            "--user-id",
            str(self.user.pk),
            "--period",
            "7d",
            "--repeat",
            "1",
            stdout=stdout,
        )

        output = stdout.getvalue().strip()
        self.assertIn("success=true", output)
        self.assertIn("period=7d", output)
        self.assertIn("repeat=1", output)
        self.assertIn("elapsedMs", output)
        self.assertIn("queryCount", output)
        self.assertNotIn(self.phone, output)
        self.assertNotIn(self.password, output)

    def test_missing_user_is_rejected_without_echoing_identifier(self):
        missing_id = "999999999"

        with self.assertRaisesMessage(CommandError, "User not found") as context:
            call_command(
                "benchmark_learning_report",
                "--user-id",
                missing_id,
                "--json",
                stdout=StringIO(),
            )

        self.assertNotIn(missing_id, str(context.exception))

    def test_invalid_repeat_and_period_are_rejected(self):
        for repeat in (0, 21, "abc"):
            with self.subTest(repeat=repeat):
                with self.assertRaises(CommandError):
                    call_command(
                        "benchmark_learning_report",
                        "--user-id",
                        str(self.user.pk),
                        "--repeat",
                        str(repeat),
                        stdout=StringIO(),
                    )

        with self.assertRaises(CommandError):
            call_command(
                "benchmark_learning_report",
                "--user-id",
                str(self.user.pk),
                "--period",
                "1d",
                stdout=StringIO(),
            )

    @patch(
        "backend.apps.assessments.management.commands.benchmark_learning_report.build_learning_report",
        return_value={},
    )
    def test_repeat_controls_the_number_of_report_measurements(self, build_report):
        call_command(
            "benchmark_learning_report",
            "--user-id",
            str(self.user.pk),
            "--repeat",
            "3",
            "--json",
            stdout=StringIO(),
        )

        self.assertEqual(build_report.call_count, 3)
        self.assertTrue(
            all(call.kwargs == {"period": "30d"} for call in build_report.call_args_list)
        )
        measured_users = [call.args[0] for call in build_report.call_args_list]
        self.assertEqual({user.pk for user in measured_users}, {self.user.pk})
        self.assertEqual(len({id(user) for user in measured_users}), 3)
