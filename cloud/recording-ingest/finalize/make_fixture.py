"""生成小端帧日志；libopus VBR、DTX、complexity=0。"""
import argparse
import math
from pathlib import Path

from opus_encoder import Encoder, HEADER, SAMPLES


def make_fixture(seconds: float, out: Path, silence_every: int | None = None) -> None:
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('seconds 必须为有限正数')
    if silence_every is not None and silence_every < 1:
        raise ValueError('silence-every 必须为正整数')
    count = math.ceil(seconds / 0.06)
    with Encoder() as encoder, out.open('wb') as target:
        for index in range(count):
            # 每 4 秒有 2 秒静音，足够让 libopus 进入 DTX。
            samples = []
            for offset in range(SAMPLES):
                t = (index * SAMPLES + offset) / 16000
                value = 0 if t % 4 >= 2 else int(10000 * math.sin(2 * math.pi * (180 * t + 35 * t * t)) * (0.6 + 0.4 * math.sin(2 * math.pi * 3 * t)))
                samples.append(value)
            packet = encoder.encode(samples)
            # 可选注入协议的零长度静音帧；其余保留真实 DTX 包。
            if silence_every and (index + 1) % silence_every == 0:
                packet = b''
            target.write(HEADER.pack(index, len(packet)) + packet)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--silence-every', type=int, help='每 N 帧输出一个 len=0 协议静音帧')
    args = parser.parse_args()
    try:
        make_fixture(args.seconds, args.out, args.silence_every)
    except (ValueError, OSError, RuntimeError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
