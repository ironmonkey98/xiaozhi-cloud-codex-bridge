"""将录音帧日志原子封装为 Ogg/Opus。"""
import argparse
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
from typing import BinaryIO, Iterator

from opus_encoder import Encoder, HEADER, SAMPLES

FFPROBE = os.environ.get('FFPROBE') or shutil.which('ffprobe') or 'ffprobe'


class InvalidInput(ValueError):
    pass


def records(source: BinaryIO) -> Iterator[tuple[int, bytes]]:
    previous = -1
    while header := source.read(HEADER.size):
        if len(header) != HEADER.size:
            raise InvalidInput('帧日志头截断')
        index, length = HEADER.unpack(header)
        if index <= previous or length > 1275:
            raise InvalidInput('帧序号不递增或长度超过 1275')
        packet = source.read(length)
        if len(packet) != length:
            raise InvalidInput('帧日志数据截断')
        yield index, packet
        previous = index


def metadata(session: Path) -> dict:
    try:
        meta = json.loads((session / 'meta.json').read_text())
        required = {'version', 'session_id', 'device_id', 'request_id', 'created_at', 'format', 'state', 'persisted_seq', 'frames_persisted', 'last_frame_index', 'stop', 'result'}
        if not isinstance(meta, dict) or not required <= meta.keys():
            raise InvalidInput('meta 缺少必填字段')
        fmt = meta['format']
        if not isinstance(fmt, dict) or any(type(fmt.get(k)) is not type(v) or fmt[k] != v for k, v in {'codec': 'opus', 'sample_rate': 16000, 'channels': 1, 'frame_ms': 60}.items()) or type(fmt.get('dtx')) is not bool:
            raise InvalidInput('format 必须为 opus/16000/1/60 且含布尔 dtx')
        if type(meta['version']) is not int or meta['version'] != 1:
            raise InvalidInput('不支持的 meta version')
        if not isinstance(meta['session_id'], str) or not re.fullmatch('[0-9a-f]{32}', meta['session_id']):
            raise InvalidInput('session_id 必须为 32 位小写 hex')
        if type(meta['last_frame_index']) is not int or not 0 <= meta['last_frame_index'] <= 0xffffffff:
            raise InvalidInput('last_frame_index 无效或会话为空')
        if type(meta['frames_persisted']) is not int or meta['frames_persisted'] < 1:
            raise InvalidInput('frames_persisted 无效或会话为空')
        return meta
    except (OSError, UnicodeError, ValueError) as error:
        raise InvalidInput(str(error)) from error


def validate_output(path: Path, duration_ms: int) -> None:
    result = subprocess.run([FFPROBE, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)], capture_output=True, text=True, timeout=60, check=True)
    info = json.loads(result.stdout)
    streams = info['streams']
    duration = float(info['format']['duration']) * 1000
    if len(streams) != 1 or streams[0]['codec_name'] != 'opus' or streams[0]['channels'] != 1 or not math.isfinite(duration) or abs(duration - duration_ms) > 60.000001:
        raise RuntimeError('ffprobe 编码、声道或时长验证失败')


def finalize(session: Path, out: Path) -> dict:
    meta = metadata(session)
    total = meta['last_frame_index'] + 1
    # 保持同一个文件描述符，先完整校验，再封装；调用方须停止追加日志。
    try:
        source = (session / 'frames.bin').open('rb')
    except OSError as error:
        raise InvalidInput(str(error)) from error
    with source:
        audio = dtx = count = 0
        next_index = 0
        missing_ranges = []
        try:
            for index, packet in records(source):
                if index >= total:
                    raise InvalidInput('帧序号超过 last_frame_index')
                if index > next_index:
                    missing_ranges.append([next_index, index - 1])
                next_index = index + 1
                count += 1
                audio += bool(packet)
                dtx += not packet
            if count != meta['frames_persisted']:
                raise InvalidInput('frames_persisted 与日志不一致')
            if next_index < total:
                missing_ranges.append([next_index, total - 1])
            source.seek(0)
        except OSError as error:
            raise InvalidInput(str(error)) from error
        target = out / f"{meta['session_id']}.ogg"
        part = target.with_suffix('.ogg.part')
        try:
            import av

            out.mkdir(parents=True, exist_ok=True)
            with Encoder() as encoder:
                silence = encoder.encode([0] * SAMPLES)
                head = struct.pack('<8sBBHIhB', b'OpusHead', 1, 1, encoder.pre_skip, 16000, 0, 0)
            with av.open(str(part), 'w', format='ogg') as container:
                stream = container.add_stream('libopus', rate=16000)
                stream.layout = 'mono'
                stream.codec_context.options = {'frame_duration': '60', 'application': 'voip'}
                stream.codec_context.open()
                stream.codec_context.extradata = head
                stream.time_base = Fraction(1, 48000)
                current = iter(records(source))
                record = next(current, None)
                for index in range(total):
                    data = silence
                    if record is not None and record[0] == index:
                        data = record[1] or silence
                        record = next(current, None)
                    packet = av.Packet(data)
                    packet.stream = stream
                    packet.time_base = Fraction(1, 48000)
                    packet.pts = packet.dts = index * 2880
                    packet.duration = 2880
                    container.mux(packet)
            validate_output(part, total * 60)
            os.replace(part, target)
        finally:
            if part.exists():
                part.unlink()
    return {'ok': True, 'path': str(target.resolve()), 'duration_ms': total * 60, 'frames_total': total, 'frames_audio': audio, 'frames_dtx': dtx, 'frames_missing': total - count, 'missing_ranges': missing_ranges}


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise InvalidInput(message)


def main() -> int:
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('--session-dir', type=Path, required=True)
        parser.add_argument('--out-dir', type=Path, required=True)
        args = parser.parse_args()
        result = finalize(args.session_dir, args.out_dir)
        code = 0
    except InvalidInput as error:
        result, code = {'ok': False, 'error': str(error)}, 2
    except Exception as error:
        result, code = {'ok': False, 'error': str(error)}, 3
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return code


if __name__ == '__main__':
    sys.exit(main())
