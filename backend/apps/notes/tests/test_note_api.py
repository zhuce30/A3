from __future__ import annotations

import json
import math
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteMutation, Notebook, NoteRevision, NoteTag


EMPTY_DOC = {"type": "doc", "content": []}


def doc(*paragraphs: str) -> dict:
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": paragraph}]}
            for paragraph in paragraphs
        ],
    }


class NoteApiTestCase(TestCase):
    def setUp(self) -> None:
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800002001", password="test-password")
        self.other_user = user_model.objects.create_user(phone="13800002002", password="test-password")
        self.client.force_login(self.user)

    def post_json(self, url: str, payload: object):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")

    def patch_json(self, url: str, payload: object):
        return self.client.patch(url, data=json.dumps(payload), content_type="application/json")

    def delete_json(self, url: str, payload: object | None = None):
        return self.client.delete(
            url,
            data=json.dumps(payload) if payload is not None else "",
            content_type="application/json",
        )

    def create_note(self, **overrides) -> Note:
        values = {
            "user": self.user,
            "title": "线性代数",
            "content_json": doc("矩阵与向量"),
            "content_text": "矩阵与向量",
        }
        values.update(overrides)
        return Note.objects.create(**values)

    def patch_note(self, note: Note, mutation_id: uuid.UUID | None = None, **overrides):
        payload = {
            "baseVersion": note.version,
            "clientMutationId": str(mutation_id or uuid.uuid4()),
            "title": "更新后的标题",
            "content": doc("更新后的正文"),
            "source": "autosave",
        }
        payload.update(overrides)
        return self.patch_json(reverse("notes:note-detail", args=[note.id]), payload)


class AuthenticationAndOwnershipTests(NoteApiTestCase):
    def test_all_endpoints_require_authentication(self) -> None:
        notebook_id = uuid.uuid4()
        tag_id = uuid.uuid4()
        note_id = uuid.uuid4()
        revision_id = uuid.uuid4()
        cases = (
            ("get", reverse("notes:notebook-list"), None),
            ("post", reverse("notes:notebook-list"), {}),
            ("patch", reverse("notes:notebook-detail", args=[notebook_id]), {}),
            ("get", reverse("notes:tag-list"), None),
            ("post", reverse("notes:tag-list"), {}),
            ("delete", reverse("notes:tag-detail", args=[tag_id]), None),
            ("get", reverse("notes:note-list"), None),
            ("post", reverse("notes:note-list"), {}),
            ("get", reverse("notes:note-detail", args=[note_id]), None),
            ("patch", reverse("notes:note-detail", args=[note_id]), {}),
            ("delete", reverse("notes:note-detail", args=[note_id]), None),
            ("post", reverse("notes:note-restore", args=[note_id]), {}),
            ("delete", reverse("notes:note-purge", args=[note_id]), {"confirm": True}),
            ("get", reverse("notes:revision-list", args=[note_id]), None),
            ("post", reverse("notes:revision-restore", args=[note_id, revision_id]), {}),
            ("get", reverse("notes:search"), None),
        )
        self.client.logout()

        for method, url, payload in cases:
            with self.subTest(method=method, url=url):
                caller = getattr(self.client, method)
                response = (
                    caller(url, data=json.dumps(payload), content_type="application/json")
                    if payload is not None
                    else caller(url)
                )
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.json()["code"], "authentication_required")

    def test_foreign_object_ids_are_not_visible_or_writable(self) -> None:
        foreign_book = Notebook.objects.create(user=self.other_user, name="别人的笔记本")
        foreign_tag = NoteTag.objects.create(user=self.other_user, name="私有标签")
        foreign_note = Note.objects.create(user=self.other_user, title="私有笔记", content_json=EMPTY_DOC)
        foreign_revision = NoteRevision.objects.create(
            note=foreign_note,
            version=1,
            source=NoteRevision.Source.MANUAL,
            title_snapshot=foreign_note.title,
            content_json_snapshot=EMPTY_DOC,
        )
        cases = (
            (self.patch_json, reverse("notes:notebook-detail", args=[foreign_book.id]), {"name": "越权"}),
            (self.delete_json, reverse("notes:tag-detail", args=[foreign_tag.id]), None),
            (self.client.get, reverse("notes:note-detail", args=[foreign_note.id]), None),
            (
                self.patch_json,
                reverse("notes:note-detail", args=[foreign_note.id]),
                {"baseVersion": 1, "clientMutationId": str(uuid.uuid4()), "title": "越权"},
            ),
            (self.delete_json, reverse("notes:note-detail", args=[foreign_note.id]), None),
            (self.post_json, reverse("notes:note-restore", args=[foreign_note.id]), {}),
            (self.delete_json, reverse("notes:note-purge", args=[foreign_note.id]), {"confirm": True}),
            (self.client.get, reverse("notes:revision-list", args=[foreign_note.id]), None),
            (
                self.post_json,
                reverse("notes:revision-restore", args=[foreign_note.id, foreign_revision.id]),
                {"baseVersion": 1, "clientMutationId": str(uuid.uuid4())},
            ),
        )

        for caller, url, payload in cases:
            with self.subTest(url=url):
                response = caller(url) if payload is None else caller(url, payload)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json()["code"], "not_found")

        search = self.client.get(reverse("notes:search"), {"notebookId": str(foreign_book.id)})
        self.assertEqual(search.status_code, 404)

    def test_foreign_mutation_id_is_scoped_to_its_owner(self) -> None:
        mutation_id = uuid.uuid4()
        foreign_note = Note.objects.create(user=self.other_user, title="其他", content_json=EMPTY_DOC)
        NoteMutation.objects.create(
            user=self.other_user,
            note=foreign_note,
            mutation_id=mutation_id,
            resulting_version=2,
        )
        own_note = self.create_note()

        response = self.patch_note(own_note, mutation_id=mutation_id)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["resultingVersion"], 2)


class NotebookAndTagApiTests(NoteApiTestCase):
    def test_create_list_rename_and_archive_notebooks(self) -> None:
        created = self.post_json(reverse("notes:notebook-list"), {"name": "课程", "sortOrder": 3})
        self.assertEqual(created.status_code, 201)
        notebook = created.json()["notebook"]
        self.assertEqual(notebook["name"], "课程")
        self.assertEqual(notebook["sortOrder"], 3)
        self.assertFalse(notebook["isArchived"])

        updated = self.patch_json(
            reverse("notes:notebook-detail", args=[notebook["id"]]),
            {"name": "归档课程", "isArchived": True},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["notebook"]["name"], "归档课程")
        self.assertTrue(updated.json()["notebook"]["isArchived"])

        listed = self.client.get(reverse("notes:notebook-list"))
        self.assertEqual(listed.status_code, 200)
        self.assertEqual([item["id"] for item in listed.json()["notebooks"]], [notebook["id"]])

    def test_create_list_delete_tags_and_normalized_duplicates(self) -> None:
        created = self.post_json(reverse("notes:tag-list"), {"name": "  Straße  ", "color": "#336699"})
        self.assertEqual(created.status_code, 201)
        tag = created.json()["tag"]
        self.assertEqual(tag["name"], "Straße")
        self.assertNotIn("normalizedName", tag)

        duplicate = self.post_json(reverse("notes:tag-list"), {"name": "STRASSE"})
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.json()["code"], "tag_already_exists")

        listed = self.client.get(reverse("notes:tag-list"))
        self.assertEqual([item["id"] for item in listed.json()["tags"]], [tag["id"]])
        deleted = self.delete_json(reverse("notes:tag-detail", args=[tag["id"]]))
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(NoteTag.objects.filter(pk=tag["id"]).exists())


class NoteLifecycleApiTests(NoteApiTestCase):
    def test_create_list_detail_and_update_note_with_nullable_notebook_and_tags(self) -> None:
        notebook = Notebook.objects.create(user=self.user, name="数学")
        tag = NoteTag.objects.create(user=self.user, name="重点")
        created = self.post_json(
            reverse("notes:note-list"),
            {
                "title": "矩阵",
                "content": doc("第一段", "第二段"),
                "notebookId": str(notebook.id),
                "tagIds": [str(tag.id)],
                "isPinned": True,
            },
        )
        self.assertEqual(created.status_code, 201)
        note = created.json()["note"]
        self.assertEqual(note["version"], 1)
        self.assertEqual(note["contentText"], "第一段\n第二段")
        self.assertEqual(note["notebook"]["id"], str(notebook.id))
        self.assertEqual(note["tags"][0]["id"], str(tag.id))
        self.assertNotIn("content_json", note)

        listed = self.client.get(reverse("notes:note-list")).json()["notes"]
        self.assertEqual(listed[0]["id"], note["id"])
        self.assertNotIn("content", listed[0])
        detail = self.client.get(reverse("notes:note-detail", args=[note["id"]])).json()["note"]
        self.assertEqual(detail["content"], doc("第一段", "第二段"))

        updated = self.patch_json(
            reverse("notes:note-detail", args=[note["id"]]),
            {
                "baseVersion": 1,
                "clientMutationId": str(uuid.uuid4()),
                "notebookId": None,
                "tagIds": [],
                "content": doc("新正文"),
                "source": "manual",
            },
        )
        self.assertEqual(updated.status_code, 200)
        updated_note = updated.json()["note"]
        self.assertEqual(updated_note["version"], 2)
        self.assertIsNone(updated_note["notebook"])
        self.assertEqual(updated_note["tags"], [])
        self.assertEqual(updated_note["contentText"], "新正文")

    def test_all_relation_ids_are_resolved_for_current_owner(self) -> None:
        foreign_book = Notebook.objects.create(user=self.other_user, name="其他")
        foreign_tag = NoteTag.objects.create(user=self.other_user, name="其他")
        for payload in (
            {"title": "x", "content": EMPTY_DOC, "notebookId": str(foreign_book.id)},
            {"title": "x", "content": EMPTY_DOC, "tagIds": [str(foreign_tag.id)]},
        ):
            with self.subTest(payload=payload):
                response = self.post_json(reverse("notes:note-list"), payload)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json()["code"], "not_found")

    def test_stale_version_returns_conflict_without_overwrite(self) -> None:
        note = self.create_note()
        first = self.patch_note(note, title="第一位写入")
        self.assertEqual(first.status_code, 200)

        stale = self.patch_json(
            reverse("notes:note-detail", args=[note.id]),
            {
                "baseVersion": 1,
                "clientMutationId": str(uuid.uuid4()),
                "title": "不应覆盖",
                "source": "autosave",
            },
        )
        self.assertEqual(stale.status_code, 409)
        body = stale.json()
        self.assertEqual(body["code"], "note_version_conflict")
        self.assertEqual(body["serverVersion"], 2)
        self.assertEqual(body["serverNote"]["title"], "第一位写入")
        note.refresh_from_db()
        self.assertEqual(note.title, "第一位写入")

    def test_zero_base_version_returns_conflict_without_overwrite(self) -> None:
        note = self.create_note()
        response = self.patch_json(
            reverse("notes:note-detail", args=[note.id]),
            {
                "baseVersion": 0,
                "clientMutationId": str(uuid.uuid4()),
                "title": "不应写入",
                "content": doc("不应写入"),
            },
        )

        self.assertEqual(response.status_code, 409)
        payload = response.json()
        self.assertEqual(payload["code"], "note_version_conflict")
        self.assertEqual(payload["serverVersion"], 1)
        self.assertEqual(payload["serverNote"]["id"], str(note.id))
        self.assertEqual(payload["serverNote"]["version"], 1)
        note.refresh_from_db()
        self.assertEqual(note.title, "线性代数")
        self.assertEqual(note.content_json, doc("矩阵与向量"))
        self.assertFalse(NoteMutation.objects.filter(note=note).exists())

    def test_mutation_retry_is_idempotent_and_different_mutation_conflicts(self) -> None:
        note = self.create_note()
        mutation_id = uuid.uuid4()
        first = self.patch_note(note, mutation_id=mutation_id, title="只写一次")
        note.refresh_from_db()
        second = self.patch_note(note, mutation_id=uuid.uuid4(), title="后续版本")
        retry = self.patch_json(
            reverse("notes:note-detail", args=[note.id]),
            {
                "baseVersion": 1,
                "clientMutationId": str(mutation_id),
                "title": "重试不覆盖",
                "source": "autosave",
            },
        )
        different = self.patch_json(
            reverse("notes:note-detail", args=[note.id]),
            {
                "baseVersion": 2,
                "clientMutationId": str(uuid.uuid4()),
                "title": "并发覆盖",
                "source": "autosave",
            },
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.json()["idempotent"])
        self.assertEqual(retry.json()["resultingVersion"], 2)
        self.assertEqual(different.status_code, 409)
        note.refresh_from_db()
        self.assertEqual(note.version, 3)
        self.assertEqual(note.title, "后续版本")
        self.assertEqual(NoteMutation.objects.filter(note=note).count(), 2)

    def test_same_mutation_id_cannot_be_reused_for_another_note(self) -> None:
        first_note = self.create_note(title="第一条")
        second_note = self.create_note(title="第二条")
        mutation_id = uuid.uuid4()
        first = self.patch_note(first_note, mutation_id=mutation_id, title="第一条已更新")

        reused = self.patch_note(second_note, mutation_id=mutation_id, title="不应写入第二条")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(reused.status_code, 409)
        self.assertEqual(reused.json()["code"], "mutation_id_reused")
        second_note.refresh_from_db()
        self.assertEqual(second_note.version, 1)
        self.assertEqual(second_note.title, "第二条")
        self.assertEqual(NoteMutation.objects.filter(user=self.user, mutation_id=mutation_id).count(), 1)

    def test_soft_delete_trash_restore_and_confirmed_purge(self) -> None:
        note = self.create_note()
        deleted = self.delete_json(reverse("notes:note-detail", args=[note.id]))
        self.assertEqual(deleted.status_code, 200)
        note.refresh_from_db()
        self.assertIsNotNone(note.deleted_at)
        self.assertEqual(self.client.get(reverse("notes:note-detail", args=[note.id])).status_code, 404)
        self.assertEqual(self.client.get(reverse("notes:note-list")).json()["notes"], [])

        trash = self.client.get(reverse("notes:search"), {"view": "trash"}).json()["notes"]
        self.assertEqual([item["id"] for item in trash], [str(note.id)])
        restored = self.post_json(reverse("notes:note-restore", args=[note.id]), {})
        self.assertEqual(restored.status_code, 200)
        note.refresh_from_db()
        self.assertIsNone(note.deleted_at)

        self.delete_json(reverse("notes:note-detail", args=[note.id]))
        rejected = self.delete_json(reverse("notes:note-purge", args=[note.id]), {"confirm": False})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.json()["code"], "purge_confirmation_required")
        purged = self.delete_json(reverse("notes:note-purge", args=[note.id]), {"confirm": True})
        self.assertEqual(purged.status_code, 200)
        self.assertFalse(Note.objects.filter(pk=note.id).exists())


class RevisionApiAndServiceTests(NoteApiTestCase):
    def test_extract_note_text_uses_block_list_and_table_separators(self) -> None:
        from backend.apps.notes.services.note_service import extract_note_text

        content = {
            "type": "doc",
            "content": [
                {"type": "heading", "content": [{"type": "text", "text": "标题"}]},
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {"type": "paragraph", "content": [{"type": "text", "text": "条目"}]}
                            ],
                        }
                    ],
                },
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "tableRow",
                            "content": [
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {"type": "paragraph", "content": [{"type": "text", "text": "甲"}]}
                                    ],
                                },
                                {
                                    "type": "tableCell",
                                    "content": [
                                        {"type": "paragraph", "content": [{"type": "text", "text": "乙"}]}
                                    ],
                                },
                            ],
                        }
                    ],
                },
            ],
        }

        self.assertEqual(extract_note_text(content), "标题\n条目\n甲\t乙")

    def test_revision_list_and_restore_create_new_current_version(self) -> None:
        note = self.create_note()
        first = self.patch_note(note, title="版本二", content=doc("正文二"), source="manual")
        self.assertEqual(first.status_code, 200)
        note.refresh_from_db()
        second = self.patch_note(note, title="版本三", content=doc("正文三"), source="manual")
        self.assertEqual(second.status_code, 200)
        revisions = self.client.get(reverse("notes:revision-list", args=[note.id])).json()["revisions"]
        revision_v2 = next(item for item in revisions if item["version"] == 2)

        restored = self.post_json(
            reverse("notes:revision-restore", args=[note.id, revision_v2["id"]]),
            {"baseVersion": 3, "clientMutationId": str(uuid.uuid4())},
        )
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()["note"]["version"], 4)
        self.assertEqual(restored.json()["note"]["title"], "版本二")
        self.assertTrue(NoteRevision.objects.filter(note=note, version=4, source="restore").exists())

    def test_title_change_is_a_meaningful_checkpoint_boundary(self) -> None:
        note = self.create_note()
        NoteRevision.objects.create(
            note=note,
            version=1,
            source=NoteRevision.Source.CHECKPOINT,
            title_snapshot=note.title,
            content_json_snapshot=note.content_json,
            content_text_snapshot=note.content_text,
        )

        response = self.patch_note(note, title="新的章节标题", source="autosave")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(NoteRevision.objects.filter(note=note, version=2, source="checkpoint").exists())

    def test_checkpoint_due_rules_and_retention(self) -> None:
        note = self.create_note()
        now = timezone.now()
        NoteRevision.objects.create(
            note=note,
            version=1,
            source=NoteRevision.Source.CHECKPOINT,
            title_snapshot=note.title,
            content_json_snapshot=note.content_json,
            content_text_snapshot=note.content_text,
        )
        NoteRevision.objects.filter(note=note, version=1).update(created_at=now - timedelta(minutes=14))

        no_checkpoint = self.patch_note(note, title=note.title, source="autosave")
        self.assertEqual(no_checkpoint.status_code, 200)
        self.assertFalse(NoteRevision.objects.filter(note=note, version=2).exists())
        note.refresh_from_db()
        NoteRevision.objects.filter(note=note, version=1).update(created_at=now - timedelta(minutes=16))
        due_checkpoint = self.patch_note(note, source="autosave")
        self.assertEqual(due_checkpoint.status_code, 200)
        self.assertTrue(NoteRevision.objects.filter(note=note, version=3, source="checkpoint").exists())

        note.refresh_from_db()
        manual = self.patch_note(note, source="manual")
        self.assertEqual(manual.status_code, 200)
        note.refresh_from_db()
        ai = self.patch_note(note, source="ai_writeback")
        self.assertEqual(ai.status_code, 200)
        self.assertTrue(NoteRevision.objects.filter(note=note, version=4, source="manual").exists())
        self.assertTrue(NoteRevision.objects.filter(note=note, version=5, source="ai_writeback").exists())

        old_checkpoint = NoteRevision.objects.create(
            note=note,
            version=1000,
            source="checkpoint",
            title_snapshot="old",
            content_json_snapshot=EMPTY_DOC,
        )
        protected_manual = NoteRevision.objects.create(
            note=note,
            version=1001,
            source="manual",
            title_snapshot="protected",
            content_json_snapshot=EMPTY_DOC,
        )
        NoteRevision.objects.filter(pk__in=[old_checkpoint.pk, protected_manual.pk]).update(
            created_at=now - timedelta(days=91)
        )
        checkpoints = []
        for version in range(1100, 1201):
            checkpoints.append(
                NoteRevision(
                    note=note,
                    version=version,
                    source="checkpoint",
                    title_snapshot=str(version),
                    content_json_snapshot=EMPTY_DOC,
                )
            )
        NoteRevision.objects.bulk_create(checkpoints)
        note.version = 2000
        note.save(update_fields={"version"})

        self.patch_note(note, source="manual")

        self.assertFalse(NoteRevision.objects.filter(pk=old_checkpoint.pk).exists())
        self.assertTrue(NoteRevision.objects.filter(pk=protected_manual.pk).exists())
        self.assertLessEqual(NoteRevision.objects.filter(note=note, source="checkpoint").count(), 100)


class SearchAndValidationTests(NoteApiTestCase):
    def test_searches_fields_and_supports_smart_views(self) -> None:
        notebook = Notebook.objects.create(user=self.user, name="高等数学")
        tag = NoteTag.objects.create(user=self.user, name="极限")
        matching = self.create_note(title="导数", content_json=doc("连续函数"), content_text="连续函数", notebook=notebook)
        matching.tags.add(tag)
        old = self.create_note(title="旧笔记", content_json=doc("历史"), content_text="历史")
        Note.objects.filter(pk=old.pk).update(last_edited_at=timezone.now() - timedelta(days=5))
        unorganized = self.create_note(title="未整理")
        attached = self.create_note(title="附件笔记")
        NoteAttachment.objects.create(
            user=self.user,
            note=attached,
            kind=NoteAttachment.Kind.LINK,
            display_name="参考",
            source_url="https://example.com",
        )
        deleted = self.create_note(title="回收站")
        Note.objects.filter(pk=deleted.pk).update(deleted_at=timezone.now())

        for query in ("导数", "连续函数", "极限", "高等数学"):
            with self.subTest(query=query):
                ids = [item["id"] for item in self.client.get(reverse("notes:search"), {"q": query}).json()["notes"]]
                self.assertIn(str(matching.id), ids)
        expected = {
            "recent": matching.id,
            "today": matching.id,
            "unorganized": unorganized.id,
            "attachments": attached.id,
            "trash": deleted.id,
        }
        for view, note_id in expected.items():
            with self.subTest(view=view):
                ids = [item["id"] for item in self.client.get(reverse("notes:search"), {"view": view}).json()["notes"]]
                self.assertIn(str(note_id), ids)

    def test_search_limit_is_capped_and_invalid_view_is_rejected(self) -> None:
        Note.objects.bulk_create([Note(user=self.user, title=f"笔记 {index}") for index in range(105)])
        capped = self.client.get(reverse("notes:search"), {"limit": "1000"})
        self.assertEqual(capped.status_code, 200)
        self.assertEqual(len(capped.json()["notes"]), 100)
        invalid = self.client.get(reverse("notes:search"), {"view": "unknown"})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["code"], "invalid_view")

    def test_recent_view_orders_by_last_edit_not_pinned_model_order(self) -> None:
        now = timezone.now()
        old_pinned = self.create_note(title="旧置顶", is_pinned=True)
        new_unpinned = self.create_note(title="最近编辑", is_pinned=False)
        Note.objects.filter(pk=old_pinned.pk).update(last_edited_at=now - timedelta(days=2))
        Note.objects.filter(pk=new_unpinned.pk).update(last_edited_at=now)

        response = self.client.get(reverse("notes:search"), {"view": "recent"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [item["id"] for item in response.json()["notes"][:2]],
            [str(new_unpinned.id), str(old_pinned.id)],
        )

    def test_invalid_json_and_fields_return_readable_stable_errors(self) -> None:
        note = self.create_note()
        url = reverse("notes:note-detail", args=[note.id])
        cases = (
            (self.client.post, reverse("notes:note-list"), "{", "invalid_json"),
            (self.client.post, reverse("notes:note-list"), "[]", "json_object_required"),
            (
                self.client.patch,
                url,
                json.dumps({"baseVersion": 1, "clientMutationId": "not-a-uuid"}),
                "invalid_mutation_id",
            ),
            (
                self.client.patch,
                url,
                json.dumps({"baseVersion": 1, "clientMutationId": str(uuid.uuid4()), "content": {"type": "text"}}),
                "invalid_note_content",
            ),
            (self.client.post, reverse("notes:note-list"), json.dumps({"title": "x" * 201}), "title_too_long"),
            (
                self.client.patch,
                url,
                json.dumps({"baseVersion": 1, "clientMutationId": str(uuid.uuid4()), "source": "robot"}),
                "unsupported_source",
            ),
        )
        for caller, target, body, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                response = caller(target, data=body, content_type="application/json")
                self.assertEqual(response.status_code, 400)
                payload = response.json()
                self.assertEqual(payload["code"], expected_code)
                self.assertTrue(payload["error"])

    def test_non_standard_json_numbers_are_rejected_before_persistence(self) -> None:
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                response = self.client.post(
                    reverse("notes:note-list"),
                    data=f'{{"title": {constant}, "content": {{"type": "doc", "content": []}}}}',
                    content_type="application/json",
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_json")
        self.assertFalse(Note.objects.filter(user=self.user).exists())

    def test_non_finite_numeric_attrs_are_rejected_without_database_write(self) -> None:
        from backend.apps.notes.services.note_service import NoteServiceError, validate_content

        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                with self.assertRaises(NoteServiceError) as raised:
                    validate_content(
                        {
                            "type": "doc",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {
                                            "type": "image",
                                            "attrs": {
                                                "src": "https://example.com/image.png",
                                                "width": value,
                                            },
                                        }
                                    ],
                                }
                            ],
                        }
                    )
                self.assertEqual(raised.exception.code, "invalid_note_content")

    def test_integer_attrs_are_limited_to_js_safe_integer_range(self) -> None:
        max_safe_integer = (1 << 53) - 1
        valid_content = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "image", "attrs": {"src": "https://example.com/a.png", "width": max_safe_integer}},
                        {
                            "type": "text",
                            "text": "边界",
                            "marks": [{"type": "mark", "attrs": {"index": -max_safe_integer}}],
                        },
                    ],
                }
            ],
        }

        valid = self.post_json(reverse("notes:note-list"), {"title": "安全整数边界", "content": valid_content})

        self.assertEqual(valid.status_code, 201)
        invalid_documents = (
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "image",
                                "attrs": {"src": "https://example.com/a.png", "width": max_safe_integer + 1},
                            }
                        ],
                    }
                ],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "text",
                                "text": "越界",
                                "marks": [{"type": "mark", "attrs": {"index": -max_safe_integer - 1}}],
                            }
                        ],
                    }
                ],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "table",
                        "content": [
                            {
                                "type": "table_row",
                                "content": [
                                    {
                                        "type": "table_cell",
                                        "attrs": {"colwidth": [max_safe_integer + 1]},
                                        "content": [{"type": "paragraph"}],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            },
        )
        for index, content in enumerate(invalid_documents):
            with self.subTest(index=index):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"越界整数 {index}", "content": content},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_content")
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="越界整数").exists())

    def test_marks_and_colwidth_have_per_node_item_limits(self) -> None:
        def table_with_colwidth(count: int) -> dict:
            return {
                "type": "table",
                "content": [
                    {
                        "type": "table_row",
                        "content": [
                            {
                                "type": "table_cell",
                                "attrs": {"colwidth": [120] * count},
                                "content": [{"type": "paragraph"}],
                            }
                        ],
                    }
                ],
            }

        valid_content = {
            "type": "doc",
            "content": [
                table_with_colwidth(100),
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "边界", "marks": [{"type": "strong"}] * 100}],
                },
            ],
        }
        valid = self.post_json(reverse("notes:note-list"), {"title": "列表边界", "content": valid_content})

        self.assertEqual(valid.status_code, 201)
        oversized_documents = (
            {"type": "doc", "content": [table_with_colwidth(101)]},
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "过多标记", "marks": [{"type": "strong"}] * 101}
                        ],
                    }
                ],
            },
        )
        for index, content in enumerate(oversized_documents):
            with self.subTest(index=index):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"列表超限 {index}", "content": content},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "note_document_too_large")
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="列表超限").exists())

    def test_document_resource_limits_return_stable_errors(self) -> None:
        nested = {"type": "paragraph", "content": [{"type": "text", "text": "deep"}]}
        for _ in range(65):
            nested = {"type": "blockquote", "content": [nested]}
        oversized_documents = (
            {"type": "doc", "content": [nested]},
            {"type": "doc", "content": [{"type": "horizontal_rule"} for _ in range(10_001)]},
            {
                "type": "doc",
                "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "x" * 1_000_001}]}
                ],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {
                                "type": "image",
                                "attrs": {"src": "https://example.com/" + "a" * 2_100},
                            }
                        ],
                    }
                ],
            },
            {
                "type": "doc",
                "content": [{"type": "equation", "attrs": {"latex": "x" * 8_193}}],
            },
        )

        for index, content in enumerate(oversized_documents):
            with self.subTest(index=index):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"超限文档 {index}", "content": content},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "note_document_too_large")
                self.assertTrue(response.json()["error"])
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="超限文档").exists())

    def test_unsafe_link_and_image_schemes_are_rejected(self) -> None:
        unsafe_nodes = (
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "危险链接",
                        "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}],
                    }
                ],
            },
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": "本地链接",
                        "marks": [{"type": "link", "attrs": {"href": "file:///etc/passwd"}}],
                    }
                ],
            },
            {
                "type": "paragraph",
                "content": [{"type": "image", "attrs": {"src": "data:image/png;base64,AAAA"}}],
            },
            {
                "type": "paragraph",
                "content": [{"type": "image", "attrs": {"src": "javascript:alert(1)"}}],
            },
            {
                "type": "paragraph",
                "content": [{"type": "image", "attrs": {"src": "https://["}}],
            },
        )
        for index, node in enumerate(unsafe_nodes):
            with self.subTest(index=index):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"危险地址 {index}", "content": {"type": "doc", "content": [node]}},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_content")
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="危险地址").exists())

    def test_safe_link_and_image_schemes_are_accepted(self) -> None:
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "站外",
                            "marks": [{"type": "link", "attrs": {"href": "https://example.com/path"}}],
                        },
                        {
                            "type": "text",
                            "text": "邮件",
                            "marks": [{"type": "link", "attrs": {"href": "mailto:student@example.com"}}],
                        },
                        {
                            "type": "text",
                            "text": "站内",
                            "marks": [{"type": "link", "attrs": {"href": "/a3/notes#today"}}],
                        },
                        {"type": "image", "attrs": {"src": "https://example.com/image.png"}},
                    ],
                }
            ],
        }

        response = self.post_json(reverse("notes:note-list"), {"title": "安全地址", "content": content})

        self.assertEqual(response.status_code, 201)

    def test_unknown_nested_node_is_rejected_without_persisting(self) -> None:
        response = self.post_json(
            reverse("notes:note-list"),
            {
                "title": "非法文档",
                "content": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "script", "attrs": {"html": "<script>bad()</script>"}}],
                        }
                    ],
                },
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "invalid_note_content")
        self.assertTrue(response.json()["error"])
        self.assertFalse(Note.objects.filter(user=self.user, title="非法文档").exists())

    def test_malformed_content_text_and_marks_are_rejected_without_overwrite(self) -> None:
        note = self.create_note()
        malformed_documents = (
            {"type": "doc", "content": {"type": "paragraph"}},
            {
                "type": "doc",
                "content": [{"type": "paragraph", "content": "not-an-array"}],
            },
            {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text"}]}],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "x", "marks": {"type": "strong"}}],
                    }
                ],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "x", "marks": [{"type": "blink"}]}],
                    }
                ],
            },
        )

        for content in malformed_documents:
            with self.subTest(content=content):
                response = self.patch_json(
                    reverse("notes:note-detail", args=[note.id]),
                    {
                        "baseVersion": 1,
                        "clientMutationId": str(uuid.uuid4()),
                        "content": content,
                    },
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_content")
                note.refresh_from_db()
                self.assertEqual(note.version, 1)
                self.assertEqual(note.content_json, doc("矩阵与向量"))
        self.assertFalse(NoteMutation.objects.filter(note=note).exists())

    def test_valid_extended_prosemirror_documents_are_accepted(self) -> None:
        valid_documents = (
            {"type": "doc", "content": []},
            {
                "type": "doc",
                "content": [
                    {
                        "type": "heading",
                        "attrs": {"level": 2, "align": "center"},
                        "content": [
                            {
                                "type": "text",
                                "text": "标题",
                                "marks": [{"type": "strong"}, {"type": "forecolor", "attrs": {"color": "#123456"}}],
                            }
                        ],
                    },
                    {
                        "type": "table",
                        "content": [
                            {
                                "type": "table_row",
                                "content": [
                                    {
                                        "type": "table_header",
                                        "attrs": {"colspan": 1, "rowspan": 1, "colwidth": [120]},
                                        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "列"}]}],
                                    },
                                    {
                                        "type": "table_cell",
                                        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "值"}]}],
                                    },
                                ],
                            }
                        ],
                    },
                ],
            },
            {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "公式："},
                            {"type": "math_inline", "attrs": {"latex": "E=mc^2"}},
                            {"type": "image", "attrs": {"src": "https://example.com/a.png", "alt": "示意图"}},
                            {
                                "type": "attachment_reference",
                                "attrs": {"attachmentId": str(uuid.uuid4()), "label": "讲义.pdf", "kind": "file"},
                            },
                        ],
                    },
                    {"type": "math_display", "attrs": {"latex": "x^2+y^2=z^2"}},
                    {"type": "equation", "attrs": {"latex": "a+b=c"}},
                    {"type": "horizontal_rule"},
                ],
            },
        )

        for index, content in enumerate(valid_documents):
            with self.subTest(index=index):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"合法文档 {index}", "content": content},
                )
                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.json()["note"]["content"], content)

    def test_required_node_attributes_are_rejected_when_missing_empty_or_wrong_type(self) -> None:
        inline_math_types = {"math_inline", "inline_math", "inline_equation"}
        invalid_nodes = [
            {"type": "image"},
            {"type": "image", "attrs": {"src": ""}},
            {"type": "image", "attrs": {"src": 123}},
            {"type": "attachment_reference"},
            {"type": "attachment_reference", "attrs": {"attachmentId": "  "}},
            {"type": "attachment_reference", "attrs": {"attachmentId": 123}},
        ]
        formula_types = (
            "math_inline",
            "math_display",
            "inline_math",
            "block_math",
            "equation",
            "inline_equation",
            "block_equation",
        )
        invalid_nodes.extend({"type": node_type} for node_type in formula_types)
        invalid_nodes.extend(
            [
                {"type": "math_inline", "attrs": {"latex": ""}},
                {"type": "math_inline", "attrs": {"value": 42}},
                {"type": "equation", "attrs": {"text": "   "}},
            ]
        )

        for index, node in enumerate(invalid_nodes):
            with self.subTest(index=index, node=node):
                content = (
                    {"type": "doc", "content": [{"type": "paragraph", "content": [node]}]}
                    if node["type"] in {"image", "attachment_reference", *inline_math_types}
                    else {"type": "doc", "content": [node]}
                )
                response = self.post_json(
                    reverse("notes:note-list"),
                    {"title": f"缺少属性 {index}", "content": content},
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_content")
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="缺少属性").exists())

    def test_required_mark_attributes_are_rejected(self) -> None:
        invalid_marks = (
            {"type": "link"},
            {"type": "link", "attrs": {"href": ""}},
            {"type": "link", "attrs": {"href": 123}},
            {"type": "forecolor"},
            {"type": "backcolor", "attrs": {"backcolor": ""}},
            {"type": "fontsize", "attrs": {"fontsize": None}},
            {"type": "fontname", "attrs": {"fontname": 12}},
        )
        for index, mark in enumerate(invalid_marks):
            with self.subTest(index=index, mark=mark):
                response = self.post_json(
                    reverse("notes:note-list"),
                    {
                        "title": f"非法 mark {index}",
                        "content": {
                            "type": "doc",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "链接", "marks": [mark]}],
                                }
                            ],
                        },
                    },
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_content")
        self.assertFalse(Note.objects.filter(user=self.user, title__startswith="非法 mark").exists())

    def test_valid_required_attributes_and_omitted_defaults_are_accepted(self) -> None:
        content = {
            "type": "doc",
            "content": [
                {"type": "heading", "content": [{"type": "text", "text": "默认一级标题"}]},
                {
                    "type": "ordered_list",
                    "content": [
                        {
                            "type": "list_item",
                            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "有序"}]}],
                        }
                    ],
                },
                {
                    "type": "bullet_list",
                    "content": [
                        {
                            "type": "list_item",
                            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "无序"}]}],
                        }
                    ],
                },
                {
                    "type": "table",
                    "content": [
                        {
                            "type": "table_row",
                            "content": [
                                {
                                    "type": "table_cell",
                                    "content": [
                                        {
                                            "type": "paragraph",
                                            "content": [{"type": "text", "text": "默认单元格"}],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "image", "attrs": {"src": "https://example.com/image.png"}},
                        {"type": "attachment_reference", "attrs": {"attachmentId": str(uuid.uuid4())}},
                        {"type": "math_inline", "content": [{"type": "text", "text": "E=mc^2"}]},
                        {
                            "type": "text",
                            "text": "资料",
                            "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
                        },
                    ],
                },
                {"type": "math_display", "attrs": {"value": "x+y=z"}},
                {"type": "equation", "attrs": {"text": "a=b"}},
            ],
        }

        response = self.post_json(reverse("notes:note-list"), {"title": "有效必填属性", "content": content})

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["note"]["content"], content)

    def test_patch_requires_version_and_mutation_id(self) -> None:
        note = self.create_note()
        for payload in ({"clientMutationId": str(uuid.uuid4())}, {"baseVersion": 1}):
            with self.subTest(payload=payload):
                response = self.patch_json(reverse("notes:note-detail", args=[note.id]), payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "invalid_note_mutation")
