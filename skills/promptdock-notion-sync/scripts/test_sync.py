import copy
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
import importlib.util
spec = importlib.util.spec_from_file_location('promptdock_sync', Path(__file__).with_name('sync.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


TEST_TARGET = '11111111111111111111111111111111'


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.p = {'id': 'test-id', 'title': '测试', 'content': '原文\n第二行',
                  'tags': ['B', 'A'], 'usageNote': '', 'favorite': False,
                  'useCount': 2, 'createdAt': '2026-08-01T00:00:01Z',
                  'updatedAt': '2026-08-02T00:00:02Z', 'variants': [], 'imageRefs': []}
        self.prepared = {'targetDatabase': TEST_TARGET, 'sourceHash': 'backup', 'deletedIds': [],
                         'prompts': [self.entry(self.p)]}
        self.remote = {'entries': [self.remote_entry(self.p)]}
        self.state = sync.commit(self.prepared, self.remote,
                                 {'targetDatabase': TEST_TARGET, 'entries': {}}, ['test-id'])

    @staticmethod
    def entry(p):
        managed = sync.desired(p, [])
        return {'sourceId': p['id'], 'sourceUpdatedAt': p['updatedAt'],
                'fingerprint': sync.digest(managed), 'managed': managed, 'prompt': p}

    @staticmethod
    def remote_entry(p):
        managed = sync.desired(p, [])
        return {'sourceId': p['id'], 'pageUrl': 'https://app.notion.com/p/test',
                'readable': True, 'managed': managed, 'fingerprint': sync.digest(managed)}

    def action(self, prepared=None, remote=None, state=None):
        return sync.plan(prepared or self.prepared, remote or self.remote,
                         state or self.state)['actions'][0]['action']

    def changed_source(self, when='2026-08-03T00:00:00Z'):
        p = copy.deepcopy(self.p); p['content'] = '新内容'; p['updatedAt'] = when
        result = copy.deepcopy(self.prepared); result['prompts'] = [self.entry(p)]
        return result

    def test_explicit_target_normalization(self):
        dashed = '11111111-1111-1111-1111-111111111111'
        self.assertEqual(sync.normalize_target(dashed), TEST_TARGET)
        self.assertEqual(sync.normalize_target('https://app.notion.com/p/' + TEST_TARGET + '?v=' + '2' * 32), TEST_TARGET)
        self.assertEqual(sync.normalize_target('https://www.notion.so/My-Library-' + TEST_TARGET), TEST_TARGET)

    def test_invalid_target_is_rejected(self):
        for value in ('', None, 'a title', 'https://evil.example/' + TEST_TARGET,
                      'http://notion.so/' + TEST_TARGET, TEST_TARGET + '-' + '2' * 32):
            with self.subTest(value=value), self.assertRaises(ValueError):
                sync.normalize_target(value)

    def test_different_destination_blocks_plan_and_commit(self):
        wrong = {'targetDatabase': '2' * 32, 'entries': {}}
        for operation in (lambda: sync.plan(self.prepared, self.remote, wrong),
                          lambda: sync.commit(self.prepared, self.remote, wrong, ['test-id'])):
            with self.assertRaises(ValueError): operation()

    def test_state_is_bound_to_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            self.assertEqual(sync.load_state(path, TEST_TARGET)['targetDatabase'], TEST_TARGET)
            sync.write_json(path, self.state)
            with self.assertRaises(ValueError): sync.load_state(path, '2' * 32)

    def test_same_backup_is_noop(self):
        self.assertEqual(self.action(), 'skip')

    def test_source_change_updates(self):
        self.assertEqual(self.action(self.changed_source()), 'update')

    def test_old_snapshot_not_overwritten(self):
        self.assertEqual(self.action(self.changed_source('2026-08-01T00:00:00Z')), 'stale')

    def test_seconds_are_checked_for_old_source(self):
        self.assertEqual(self.action(self.changed_source('2026-08-02T00:00:01Z')), 'stale')

    def test_notion_only_preserved(self):
        p = copy.deepcopy(self.p); p['content'] = 'Notion 改动'
        self.assertEqual(self.action(remote={'entries': [self.remote_entry(p)]}), 'notion_only')

    def test_both_changed_conflicts(self):
        p = copy.deepcopy(self.p); p['content'] = 'Notion 改动'
        self.assertEqual(self.action(self.changed_source(), {'entries': [self.remote_entry(p)]}), 'conflict')

    def test_missing_baseline_is_conservative(self):
        empty = {'targetDatabase': TEST_TARGET, 'entries': {}}
        self.assertEqual(self.action(state=empty), 'adopt')
        self.assertEqual(self.action(self.changed_source(), state=empty), 'conflict')

    def test_duplicate_remote_blocks_write(self):
        duplicate = {'entries': self.remote['entries'] * 2}
        self.assertEqual(self.action(remote=duplicate), 'duplicate_remote')

    def test_deleted_and_missing_are_not_deleted(self):
        source = {'targetDatabase': TEST_TARGET, 'sourceHash': 'new', 'prompts': [], 'deletedIds': ['test-id']}
        plan = sync.plan(source, self.remote, self.state)
        self.assertEqual(plan['actions'], [])
        self.assertEqual(plan['missingNotDeleted'], ['test-id'])

    def test_commit_refuses_mismatch(self):
        with self.assertRaises(ValueError):
            sync.commit(self.changed_source(), self.remote, self.state, ['test-id'])

    def raw(self, props_extra=None, body_extra=''):
        props = {'名称': '测试', '标签': ['A', 'B'], '收藏': '__NO__', '使用次数': 2,
                 '使用说明': '', '图片数量': 0, '变体数量': 0, 'Prompt Dock ID': 'test-id',
                 'date:原始创建时间:start': '2026-08-01T00:00:00Z',
                 'date:原始修改时间:start': '2026-08-02T00:00:00Z'}
        props.update(props_extra or {})
        body = '## Prompt\n```plain text\n原文\n第二行\n```' + body_extra
        return {'url': 'https://app.notion.com/p/test',
                'text': '<properties>\n' + json.dumps(props) + '\n</properties>\n<content>\n' + body + '\n</content>'}

    def test_notion_notes_are_ignored(self):
        a = sync.snapshot([self.raw()])
        b = sync.snapshot([self.raw({'Notion 备注': '私人备注'})])
        self.assertEqual(a['entries'][0]['fingerprint'], b['entries'][0]['fingerprint'])
        self.assertEqual(a['entries'][0]['fingerprint'], self.prepared['prompts'][0]['fingerprint'])

    def test_extra_body_is_detected(self):
        altered = sync.snapshot([self.raw(body_extra='\n人工笔记')])
        self.assertEqual(self.action(remote=altered), 'notion_only')

    def test_unknown_blocks_are_unreadable(self):
        raw = self.raw(); raw['unknown_block_count'] = 1
        self.assertEqual(self.action(remote=sync.snapshot([raw])), 'unreadable')

    def test_signed_images_stable_and_order_checked(self):
        raw = self.raw(); h = 'a' * 64
        raw['text'] = raw['text'].replace('## Prompt', '![](https://files.example/' + h + '.png?Expires=1)\n## Prompt')
        first = sync.snapshot([raw])['entries'][0]
        raw['text'] = raw['text'].replace('Expires=1', 'Expires=999')
        second = sync.snapshot([raw])['entries'][0]
        self.assertEqual(first['fingerprint'], second['fingerprint'])
        self.assertEqual(first['managed']['body']['order'], ['image', 'heading', 'code'])
        raw['text'] = raw['text'].replace('files.example/', 'files.example/replacement/')
        replaced = sync.snapshot([raw])['entries'][0]
        self.assertEqual(first['contentFingerprint'], replaced['contentFingerprint'])
        self.assertNotEqual(first['fingerprint'], replaced['fingerprint'])

    def test_prepare_rejects_duplicate_and_bad_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'test.promptdock'; out = Path(tmp) / 'out'
            def archive(prompts, images=None):
                with zipfile.ZipFile(file, 'w') as z:
                    z.writestr('manifest.json', json.dumps({'format': 'prompt-dock', 'formatVersion': 4, 'prompts': prompts}))
                    for name, data in (images or {}).items(): z.writestr(name, data)
            archive([self.p, self.p])
            with self.assertRaises(ValueError): sync.prepare(file, out, TEST_TARGET)
            bad = copy.deepcopy(self.p); bad['imageRefs'] = ['images/' + 'a' * 64 + '.png']
            archive([bad], {bad['imageRefs'][0]: b'wrong'})
            with self.assertRaises(ValueError): sync.prepare(file, out, TEST_TARGET)
            good = copy.deepcopy(self.p); h = hashlib.sha256(b'image').hexdigest()
            good['imageRefs'] = ['images/' + h + '.png']
            archive([good], {good['imageRefs'][0]: b'image'})
            before = file.read_bytes(); result = sync.prepare(file, out, TEST_TARGET)
            self.assertEqual(result['active'], 1)
            self.assertEqual(file.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
