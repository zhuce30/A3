from .common import *


class CodeLabRunnerTests(CompatApiTestCase):
    def setUp(self):
        super().setUp()
        self.pack_id = "test-code-lab-pack"
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "extra_profile": {
                    "resourcePacks": [
                        {
                            "resourcePackId": self.pack_id,
                            "schemaVersion": "a3.resource-pack.v2",
                            "goal": "测试代码实验 runner",
                            "resources": [
                                {
                                    "type": "code_lab",
                                    "title": "代码实验",
                                    "content": {"language": "Python", "starterCode": "print('hello')"},
                                    "citations": [],
                                    "verified": False,
                                    "estimatedMinutes": 20,
                                    "personalizationReason": "测试资源包",
                                }
                            ],
                        }
                    ]
                }
            },
        )

    def test_code_lab_run_executes_python_and_returns_output(self):
        response = self.client.post(
            f"/api/resources/packs/{self.pack_id}/code-lab/run/",
            data=json.dumps(
                {
                    "language": "Python",
                    "code": "name = input()\nprint(f'hello {name}')\n",
                    "stdin": "A3\n",
                    "mode": "run",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["result"]["status"], "passed")
        self.assertEqual(payload["result"]["stdout"], "hello A3\n")
        self.assertEqual(payload["result"]["exitCode"], 0)
        self.assertGreaterEqual(payload["result"]["durationMs"], 0)

    def test_code_lab_run_strips_markdown_code_fence(self):
        response = self.client.post(
            f"/api/resources/packs/{self.pack_id}/code-lab/run/",
            data=json.dumps(
                {
                    "language": "Python",
                    "code": "```python\nprint('ok')\n```",
                    "mode": "run",
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["result"]["status"], "passed")
        self.assertEqual(payload["result"]["stdout"], "ok\n")

    def test_code_lab_run_times_out_with_readable_error(self):
        response = self.client.post(
            f"/api/resources/packs/{self.pack_id}/code-lab/run/",
            data=json.dumps(
                {
                    "language": "Python",
                    "code": "while True:\n    pass\n",
                    "mode": "run",
                    "timeoutMs": 200,
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["result"]["status"], "timeout")
        self.assertIn("运行超时", payload["result"]["error"])

    def test_code_lab_judge_returns_per_case_results(self):
        response = self.client.post(
            f"/api/resources/packs/{self.pack_id}/code-lab/run/",
            data=json.dumps(
                {
                    "language": "Python",
                    "code": "print(int(input()) * 2)\n",
                    "mode": "judge",
                    "testCases": [
                        {"name": "double 3", "stdin": "3\n", "expectedStdout": "6\n"},
                        {"name": "double 4 wrong expectation", "stdin": "4\n", "expectedStdout": "9\n"},
                    ],
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        result = payload["result"]
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["passedCount"], 1)
        self.assertEqual(result["totalCount"], 2)
        self.assertTrue(result["testResults"][0]["passed"])
        self.assertFalse(result["testResults"][1]["passed"])
        self.assertEqual(result["testResults"][1]["actualStdout"], "8\n")
