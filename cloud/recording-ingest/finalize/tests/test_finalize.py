import io
import shutil
import json
from pathlib import Path
import struct
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import finalize as module
from make_fixture import make_fixture
from opus_encoder import HEADER

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def session(tmp_path):
    session = tmp_path / 'session'
    session.mkdir()
    make_fixture(1.2, session / 'frames.bin')
    meta = {'version': 1, 'session_id': 'a' * 32, 'device_id': 'passport-01', 'request_id': 'b' * 32, 'created_at': '2026-10-12T08:00:00.000Z', 'format': {'codec': 'opus', 'sample_rate': 16000, 'channels': 1, 'frame_ms': 60, 'dtx': True}, 'state': 'finishing', 'persisted_seq': 0, 'frames_persisted': 20, 'last_frame_index': 19, 'stop': None, 'result': None}
    (session / 'meta.json').write_text(json.dumps(meta))
    return session, tmp_path / 'out'


def run(session, expected=0):
    source, out = session
    before = (source / 'meta.json').read_bytes()
    result = subprocess.run([sys.executable, str(ROOT / 'finalize.py'), '--session-dir', str(source), '--out-dir', str(out)], capture_output=True, text=True)
    assert result.returncode == expected, (result.stdout, result.stderr)
    assert len(result.stdout.splitlines()) == 1
    assert (source / 'meta.json').read_bytes() == before
    assert not list(out.glob('*.part'))
    return json.loads(result.stdout)


def rewrite(session, entries):
    source, _ = session
    (source / 'frames.bin').write_bytes(b''.join(HEADER.pack(i, len(p)) + p for i, p in entries))
    meta = json.loads((source / 'meta.json').read_text())
    meta['frames_persisted'] = len(entries)
    (source / 'meta.json').write_text(json.dumps(meta))


def entries(session):
    return list(module.records(io.BytesIO((session[0] / 'frames.bin').read_bytes())))


def check_media(result):
    path = result['path']
    probe = subprocess.run([module.FFPROBE, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    assert info['streams'][0]['codec_name'] == 'opus'
    assert info['streams'][0]['channels'] == 1
    assert abs(float(info['format']['duration']) * 1000 - result['duration_ms']) <= 60
    decoded = subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'], capture_output=True, check=True)
    assert not decoded.stderr
    data = Path(path).read_bytes()
    pos = data.index(b'OpusHead')
    _, version, channels, skip, rate, gain, mapping = struct.unpack('<8sBBHIhB', data[pos:pos + 19])
    assert (version, channels, rate, gain, mapping) == (1, 1, 16000, 0, 0)
    assert 0 < skip < 2880


@pytest.mark.parametrize('removed,dtx', [(set(), set()), (set(), {2, 4, 8}), ({3, 4, 7, 18, 19}, {8}), ({0, 1, 2}, set()), (set(), set(range(20)))])
def test_sessions(session, removed, dtx):
    rewrite(session, [(i, b'' if i in dtx else p) for i, p in entries(session) if i not in removed])
    result = run(session)
    assert result['frames_total'] == 20
    assert result['frames_missing'] == len(removed)
    assert result['frames_dtx'] == len(dtx)
    assert result['frames_audio'] == 20 - len(removed) - len(dtx)
    covered = {i for start, end in result['missing_ranges'] for i in range(start, end + 1)}
    assert covered == removed
    if 3 in removed:
        assert result['missing_ranges'] == [[3, 4], [7, 7], [18, 19]]
    check_media(result)


@pytest.mark.parametrize('bad', ['header', 'payload', 'large', 'duplicate', 'reverse', 'beyond', 'empty', 'count'])
def test_bad_log(session, bad):
    source, _ = session
    rows = entries(session)
    data = {'header': b'\x00', 'payload': HEADER.pack(0, 10) + b'x', 'large': HEADER.pack(0, 1276) + b'x' * 1276, 'empty': b''}.get(bad)
    if data is not None:
        (source / 'frames.bin').write_bytes(data)
    elif bad == 'count':
        (source / 'frames.bin').write_bytes((source / 'frames.bin').read_bytes()[:-6])
    else:
        if bad == 'reverse':
            rows[0] = (1, rows[0][1])
        rows[1] = ({'duplicate': 0, 'reverse': 0, 'beyond': 20}[bad], rows[1][1])
        rewrite(session, rows)
    assert run(session, 2)['ok'] is False


@pytest.mark.parametrize('field', ['version', 'session_id', 'device_id', 'request_id', 'created_at', 'format', 'state', 'persisted_seq', 'frames_persisted', 'last_frame_index', 'stop', 'result'])
def test_missing_meta_field(session, field):
    path = session[0] / 'meta.json'
    meta = json.loads(path.read_text())
    del meta[field]
    path.write_text(json.dumps(meta))
    run(session, 2)


@pytest.mark.parametrize('field,value', [('codec', 'aac'), ('sample_rate', 48000), ('channels', 2), ('frame_ms', 20), ('dtx', None)])
def test_bad_format(session, field, value):
    path = session[0] / 'meta.json'
    meta = json.loads(path.read_text())
    meta['format'][field] = value
    path.write_text(json.dumps(meta))
    run(session, 2)


@pytest.mark.parametrize('value', ['{', '[]', 'null'])
def test_bad_json(session, value):
    (session[0] / 'meta.json').write_text(value)
    run(session, 2)


def test_probe_failure_cleans_part(session, monkeypatch):
    def fail(path, duration):
        assert path.exists()
        raise RuntimeError('模拟验证失败')
    monkeypatch.setattr(module, 'validate_output', fail)
    with pytest.raises(RuntimeError):
        module.finalize(*session)
    assert not list(session[1].iterdir())


def test_failure_exit_code(session):
    session[1].write_text('阻止创建输出目录')
    run(session, 3)


def test_fixture_dtx(tmp_path):
    path = tmp_path / 'fixture.bin'
    make_fixture(4.8, path)
    rows = list(module.records(io.BytesIO(path.read_bytes())))
    assert [i for i, _ in rows] == list(range(80))
    assert any(0 < len(p) <= 2 for _, p in rows)
    make_fixture(0.6, path, 2)
    assert sum(not p for _, p in module.records(io.BytesIO(path.read_bytes()))) == 5


def test_missing_directory(tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / 'finalize.py'), '--session-dir', str(tmp_path / 'absent'), '--out-dir', str(tmp_path / 'out')], capture_output=True, text=True)
    assert result.returncode == 2
    assert json.loads(result.stdout)['ok'] is False


def test_single_frame(session):
    rewrite(session, entries(session)[:1])
    path = session[0] / 'meta.json'
    meta = json.loads(path.read_text())
    meta['last_frame_index'] = 0
    path.write_text(json.dumps(meta))
    check_media(run(session))


@pytest.mark.parametrize('field,value', [('session_id', '../unsafe'), ('last_frame_index', -1), ('last_frame_index', True), ('frames_persisted', 0), ('version', 2)])
def test_bad_meta_values(session, field, value):
    path = session[0] / 'meta.json'
    meta = json.loads(path.read_text())
    meta[field] = value
    path.write_text(json.dumps(meta))
    run(session, 2)


def test_mux_failure_cleans_part(session, monkeypatch):
    import av
    real_open = av.open

    def broken_open(path, *args, **kwargs):
        Path(path).write_bytes(b'partial')
        raise RuntimeError('模拟 mux 失败')

    monkeypatch.setattr(av, 'open', broken_open)
    with pytest.raises(RuntimeError):
        module.finalize(*session)
    assert not list(session[1].iterdir())
    monkeypatch.setattr(av, 'open', real_open)


def test_probe_rejects_wrong_media(session, monkeypatch):
    monkeypatch.setattr(module.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess([], 0, json.dumps({'streams': [{'codec_name': 'aac', 'channels': 1}], 'format': {'duration': '1.2'}})))
    with pytest.raises(RuntimeError):
        module.finalize(*session)
    assert not list(session[1].iterdir())


def test_real_dtx_decodes(session):
    source, _ = session
    make_fixture(4.8, source / 'frames.bin')
    path = source / 'meta.json'
    meta = json.loads(path.read_text())
    meta.update(frames_persisted=80, last_frame_index=79)
    path.write_text(json.dumps(meta))
    result = run(session)
    assert result['frames_audio'] == 80
    assert result['frames_dtx'] == 0
    check_media(result)


def test_cli_arguments():
    result = subprocess.run([sys.executable, str(ROOT / 'finalize.py')], capture_output=True, text=True)
    assert result.returncode == 2
    assert len(result.stdout.splitlines()) == 1
    assert json.loads(result.stdout)['ok'] is False
