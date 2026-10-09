"""Read-only preparation and three-way sync planning. Notion mutations use MCP."""
import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path

MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024



def normalize_target(value):
    """Normalize an explicit database ID or official Notion database URL."""
    value = str(value or '').strip()
    if not value:
        raise ValueError('An explicit target database is required')
    if '://' in value:
        url = urllib.parse.urlsplit(value)
        if (url.scheme != 'https' or url.hostname not in
                ('notion.so', 'www.notion.so', 'app.notion.com', 'notion.com', 'www.notion.com')
                or url.username or url.password or url.port):
            raise ValueError('Expected an official HTTPS Notion database URL')
        value = urllib.parse.unquote(url.path).rstrip('/').rsplit('/', 1)[-1]
    matches = re.findall(r'(?<![a-fA-F0-9])(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})(?![a-fA-F0-9])', value)
    if len(matches) != 1:
        raise ValueError('Expected one unambiguous Notion database ID')
    return matches[0].replace('-', '').lower()


def validate_destination(prepared, state):
    target = normalize_target(prepared.get('targetDatabase'))
    if target != normalize_target(state.get('targetDatabase')):
        raise ValueError('Prepared data and state belong to different destinations')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def text(value):
    return str(value or '').replace('\r\n', '\n').replace('\r', '\n')


def plain(value):
    value = text(value).replace('<br>', '\n').replace('<br/>', '\n').replace('<br />', '\n')
    return re.sub(r'\\([\\*~`$\[\]<>{}|^])', r'\1', value)


def minute(value):
    if not value:
        return ''
    stamp = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=dt.timezone.utc)
    return stamp.astimezone(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()


def timestamp(value):
    stamp = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return stamp.replace(tzinfo=dt.timezone.utc) if stamp.tzinfo is None else stamp


def desired(prompt, image_hashes):
    return {'properties': {
        'title': text(prompt['title']), 'tags': sorted(set(prompt.get('tags', []))),
        'usageNote': text(prompt.get('usageNote')), 'favorite': bool(prompt.get('favorite')),
        'useCount': prompt.get('useCount', 0), 'variantCount': len(prompt.get('variants', [])),
        'imageCount': len(image_hashes), 'createdAt': minute(prompt['createdAt']),
        'updatedAt': minute(prompt['updatedAt']), 'id': prompt['id']},
        'body': {'images': image_hashes,
                 'headings': ['Prompt'] + [text(v['title']) for v in prompt.get('variants', [])],
                 'blocks': [text(prompt['content'])] + [text(v['content']) for v in prompt.get('variants', [])],
                 'extra': [], 'order': ['image'] * len(image_hashes) + ['heading', 'code'] * (1 + len(prompt.get('variants', [])))}}


def prepare(source, out, target):
    target = normalize_target(target)
    source, out = Path(source).resolve(), Path(out).resolve()
    if source.suffix.lower() != '.promptdock':
        raise ValueError('Expected a .promptdock file')
    if source == out or source.is_relative_to(out):
        raise ValueError('Output must be separate from the source file')
    original = source.read_bytes()
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if len({i.filename for i in members}) != len(members):
            raise ValueError('Duplicate archive member')
        if sum(i.file_size for i in members) > MAX_ARCHIVE_BYTES:
            raise ValueError('Archive exceeds safe extraction limit')
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('format') != 'prompt-dock' or manifest.get('formatVersion') != 4:
            raise ValueError('Unsupported backup format/version; do not import partially')
        prompts, removed, ids, images = [], [], set(), {}
        for p in manifest['prompts']:
            source_id = p.get('id')
            if not isinstance(source_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', source_id):
                raise ValueError('Invalid source ID')
            if source_id in ids:
                raise ValueError('Duplicate source ID: ' + source_id)
            ids.add(source_id)
            if p.get('deletedAt'):
                removed.append(source_id)
                continue
            if p.get('images') and not p.get('imageRefs'):
                raise ValueError('Unexpected image representation; compatibility review required')
            hashes = []
            for ref in p.get('imageRefs', []):
                m = re.fullmatch(r'images/([a-f0-9]{64})\.(png|jpe?g|webp|gif)', ref, re.I)
                if not m:
                    raise ValueError('Unsafe or unsupported image path')
                data = archive.read(ref)
                content_hash = hashlib.sha256(data).hexdigest()
                if content_hash != m[1].lower():
                    raise ValueError('Image digest mismatch')
                hashes.append(content_hash)
                if ref not in images:
                    dest = out / ref
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    images[ref] = {'hash': content_hash, 'path': str(dest), 'size': len(data)}
            managed = desired(p, hashes)
            prompts.append({'sourceId': source_id, 'sourceUpdatedAt': p['updatedAt'],
                            'fingerprint': digest(managed), 'managed': managed,
                            'prompt': p, 'images': [images[r] for r in p.get('imageRefs', [])]})
    result = {'version': 1, 'targetDatabase': target,
              'sourceHash': hashlib.sha256(original).hexdigest(),
              'prompts': prompts, 'deletedIds': removed,
              'vocabularyCount': len(manifest.get('vocabulary', {}).get('entries', []))}
    if hashlib.sha256(source.read_bytes()).hexdigest() != result['sourceHash']:
        raise ValueError('Source changed during preparation')
    write_json(out / 'prepared.json', result)
    return {'active': len(prompts), 'trashSkipped': len(removed),
            'images': len(images), 'vocabularySkipped': result['vocabularyCount']}


def snapshot(raw):
    result = []
    required = ['名称', '使用次数', '图片数量', '变体数量', '收藏',
                'date:原始创建时间:start', 'date:原始修改时间:start']
    for item in raw:
        if isinstance(item, str):
            item = json.loads(item)
        entry = {'pageUrl': item.get('url', ''), 'sourceId': '', 'readable': False}
        try:
            page = item['text']
            props = json.loads(re.search(r'<properties>\n([\s\S]*?)\n</properties>', page)[1])
            entry['sourceId'] = props.get('Prompt Dock ID', '')
            if not entry['sourceId']:
                continue  # Not owned by this workflow.
            if item.get('truncated') or item.get('unknown_block_count'):
                raise ValueError('Truncated or unknown blocks')
            if any(k not in props for k in required):
                raise ValueError('Missing managed properties')
            body = re.search(r'<content>\n([\s\S]*?)\n</content>', page)[1]
            tokens = re.compile(r'(?P<code>^(?P<fence>`{3,})(?:plain text|text)?\n(?P<value>[\s\S]*?)\n(?P=fence)$)|(?P<image>^!\[[^\n]*?\]\((?P<url>[^\n]+)\).*$)|(?P<heading>^## (?P<name>[^\n]+)$)', re.M)
            blocks, image_hashes, image_origins, headings, order, extras = [], [], [], [], [], []
            last = 0
            for token in tokens.finditer(body):
                extra = body[last:token.start()].strip()
                if extra:
                    extras.append(extra)
                last = token.end()
                if token['code']:
                    blocks.append(text(token['value']))
                    order.append('code')
                elif token['image']:
                    filename = Path(urllib.parse.unquote(urllib.parse.urlsplit(token['url']).path)).name
                    match = re.fullmatch(r'([a-f0-9]{64})\.(png|jpe?g|gif|webp)', filename, re.I)
                    image_hashes.append(match[1].lower() if match else 'unknown:' + filename)
                    location = urllib.parse.urlsplit(token['url'])
                    image_origins.append(location.scheme + '://' + location.netloc + location.path)
                    order.append('image')
                else:
                    headings.append(plain(token['name']))
                    order.append('heading')
            if body[last:].strip():
                extras.append(body[last:].strip())
            tags = props.get('标签', [])
            if isinstance(tags, str):
                tags = json.loads(tags)
            managed = {'properties': {
                'title': plain(props['名称']), 'tags': sorted(set(tags or [])),
                'usageNote': plain(props.get('使用说明')), 'favorite': props['收藏'] in ('__YES__', True),
                'useCount': props['使用次数'], 'variantCount': props['变体数量'],
                'imageCount': props['图片数量'], 'createdAt': minute(props['date:原始创建时间:start']),
                'updatedAt': minute(props['date:原始修改时间:start']), 'id': entry['sourceId']},
                'body': {'images': image_hashes, 'blocks': blocks, 'headings': headings,
                         'order': order, 'extra': extras}}
            content_fingerprint = digest(managed)
            remote_fingerprint = digest({'managed': managed, 'imageOrigins': image_origins}) if image_origins else content_fingerprint
            entry.update(readable=True, fingerprint=remote_fingerprint,
                         contentFingerprint=content_fingerprint, managed=managed)
        except (KeyError, TypeError, ValueError, IndexError, json.JSONDecodeError) as error:
            entry['error'] = str(error)
        result.append(entry)
    return {'entries': result}


def load_state(path, target):
    target = normalize_target(target)
    state = read_json(path) if Path(path).exists() else {'targetDatabase': target, 'entries': {}}
    if normalize_target(state.get('targetDatabase')) != target:
        raise ValueError('State belongs to a different destination')
    return state


def plan(prepared, remote, state):
    validate_destination(prepared, state)
    groups = {}
    for r in remote['entries']:
        groups.setdefault(r['sourceId'], []).append(r)
    actions = []
    for p in prepared['prompts']:
        sid, group = p['sourceId'], groups.get(p['sourceId'], [])
        action = {'sourceId': sid, 'title': p['prompt']['title']}
        base = state['entries'].get(sid)
        if len(group) > 1:
            kind = 'duplicate_remote'
        elif not group:
            kind = 'remote_missing' if base else 'create'
        else:
            r = group[0]
            action['pageUrl'] = r['pageUrl']
            if not r['readable']:
                kind = 'unreadable'
            elif base and p['fingerprint'] == base['sourceFingerprint'] and r['fingerprint'] != base['remoteFingerprint']:
                kind = 'notion_only'
            elif p['fingerprint'] == r.get('contentFingerprint', r['fingerprint']):
                kind = 'skip' if base and base['sourceFingerprint'] == p['fingerprint'] and base['remoteFingerprint'] == r['fingerprint'] else 'adopt'
            elif not base:
                kind = 'conflict'
            else:
                source_changed = p['fingerprint'] != base['sourceFingerprint']
                remote_changed = r['fingerprint'] != base['remoteFingerprint']
                if source_changed and timestamp(p['sourceUpdatedAt']) < timestamp(base['sourceUpdatedAt']):
                    kind = 'stale'
                elif source_changed and remote_changed:
                    kind = 'conflict'
                elif source_changed:
                    kind = 'update'
                elif remote_changed:
                    kind = 'notion_only'
                else:
                    kind = 'conflict'  # Inconsistent state must not be overwritten.
        action['action'] = kind
        actions.append(action)
    active = {p['sourceId'] for p in prepared['prompts']}
    missing = sorted((set(groups) | set(state['entries'])) - active)
    counts = {kind: sum(a['action'] == kind for a in actions) for kind in sorted({a['action'] for a in actions})}
    return {'actions': actions, 'counts': counts, 'missingNotDeleted': missing,
            'trashIds': prepared['deletedIds'], 'sourceHash': prepared['sourceHash']}


def commit(prepared, remote, state, verified_ids):
    validate_destination(prepared, state)
    groups = {}
    for r in remote['entries']:
        groups.setdefault(r['sourceId'], []).append(r)
    src = {p['sourceId']: p for p in prepared['prompts']}
    updates = {}
    for sid in verified_ids:
        p, group = src[sid], groups.get(sid, [])
        if len(group) != 1 or not group[0]['readable'] or group[0].get('contentFingerprint', group[0]['fingerprint']) != p['fingerprint']:
            raise ValueError('Cannot commit an unverified or conflicting entry: ' + sid)
        updates[sid] = {'sourceFingerprint': p['fingerprint'], 'remoteFingerprint': group[0]['fingerprint'],
                        'sourceUpdatedAt': p['sourceUpdatedAt'], 'pageUrl': group[0]['pageUrl']}
    state['entries'].update(updates)
    state['version'] = 1
    state['lastVerifiedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    state['lastSourceHash'] = prepared['sourceHash']
    return state


def upload(file, ticket):
    url = urllib.parse.urlsplit(ticket['upload_url'])
    if url.scheme != 'https' or url.netloc != 'api.notion.com' or not re.fullmatch(r'/v1/mcp/file_uploads/[a-f0-9-]+/send', url.path):
        raise ValueError('Unexpected upload destination')
    data = Path(file).read_bytes()
    if len(data) > 20 * 1024 * 1024:
        raise ValueError('Image exceeds single-part upload limit')
    boundary = 'PromptDock' + uuid.uuid4().hex
    filename = Path(file).name
    if any(c in filename for c in '\r\n"'):
        raise ValueError('Invalid multipart filename')
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {ticket.get("content_type", "application/octet-stream")}\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
    headers = dict(ticket['upload_headers'])
    headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
    request = urllib.request.Request(ticket['upload_url'], data=body, headers=headers, method='POST')
    # Do not follow redirects with credentials or retry a one-use ticket.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('source'); p.add_argument('--out', required=True); p.add_argument('--target', required=True)
    p = sub.add_parser('snapshot'); p.add_argument('--raw', required=True); p.add_argument('--out', required=True)
    for name in ('plan', 'commit'):
        p = sub.add_parser(name)
        for arg in ('prepared', 'remote', 'state', 'target'):
            p.add_argument('--' + arg, required=True)
        p.add_argument('--out', required=True) if name == 'plan' else p.add_argument('--ids', required=True)
    p = sub.add_parser('upload'); p.add_argument('--file', required=True); p.add_argument('--ticket-json', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        result = prepare(args.source, args.out, args.target)
    elif args.command == 'snapshot':
        result = snapshot(read_json(args.raw)); write_json(args.out, result)
        result = {'entries': len(result['entries']), 'unreadable': sum(not e['readable'] for e in result['entries'])}
    elif args.command == 'plan':
        result = plan(read_json(args.prepared), read_json(args.remote), load_state(args.state, args.target))
        write_json(args.out, result); result = {'counts': result['counts'], 'missing': len(result['missingNotDeleted'])}
    elif args.command == 'commit':
        result = commit(read_json(args.prepared), read_json(args.remote), load_state(args.state, args.target), read_json(args.ids))
        write_json(args.state, result); result = {'baselineEntries': len(result['entries'])}
    else:
        result = upload(args.file, json.loads(args.ticket_json))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Upload errors must not echo a ticket or credential-bearing URL.
        message = 'Upload failed; create a new ticket before retrying.' if 'upload' in sys.argv[1:2] else str(error)
        print(json.dumps({'error': message}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
