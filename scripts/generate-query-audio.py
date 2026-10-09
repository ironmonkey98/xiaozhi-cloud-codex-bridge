#!/usr/bin/env python3
"""Encode a fixed offline query WAV into bounded 16kHz/60ms Opus packets.

On macOS create the input with:
say -v Tingting -r 185 --data-format=LEI16@16000 -o query.wav \
  '请领取待播报通知，播报已经结束的任务结果，不要提交新的任务。'
Supply an installed libopus path; no dependency download is performed.
"""
import argparse
import ctypes as C
from pathlib import Path
import struct
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--libopus", required=True)
    args = parser.parse_args()
    with wave.open(str(args.wav), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            parser.error("Input must be 16kHz mono signed 16-bit PCM WAV")
        pcm = bytes(16000 * 2 * 300 // 1000) + wav.readframes(wav.getnframes())
        pcm += bytes(16000 * 2 * 480 // 1000)
    pcm += bytes((-len(pcm)) % 1920)
    if len(pcm) // 1920 > 334:
        parser.error("Query exceeds firmware's bounded 20-second input")
    lib = C.CDLL(args.libopus)
    lib.opus_encoder_create.argtypes = [C.c_int32, C.c_int, C.c_int, C.POINTER(C.c_int)]
    lib.opus_encoder_create.restype = C.c_void_p
    lib.opus_encode.argtypes = [C.c_void_p, C.POINTER(C.c_int16), C.c_int,
                               C.POINTER(C.c_ubyte), C.c_int32]
    lib.opus_packet_get_nb_samples.argtypes = [C.POINTER(C.c_ubyte), C.c_int32, C.c_int32]
    lib.opus_encoder_destroy.argtypes = [C.c_void_p]
    error = C.c_int()
    encoder = lib.opus_encoder_create(16000, 1, 2048, C.byref(error))
    if not encoder or error.value:
        raise RuntimeError(f"Opus encoder creation failed: {error.value}")
    encoded = bytearray()
    try:
        for offset in range(0, len(pcm), 1920):
            samples = (C.c_int16 * 960).from_buffer_copy(pcm[offset:offset + 1920])
            packet = (C.c_ubyte * 1275)()
            size = lib.opus_encode(encoder, samples, 960, packet, 1275)
            if size <= 0 or lib.opus_packet_get_nb_samples(packet, size, 16000) != 960:
                raise RuntimeError(f"Invalid 60ms packet: {size}")
            encoded.extend(struct.pack("<H", size))
            encoded.extend(bytes(packet[:size]))
    finally:
        lib.opus_encoder_destroy(encoder)
    if len(encoded) > 65536:
        raise RuntimeError("Encoded query exceeds firmware buffer limit")
    rows = ["    " + ", ".join(f"0x{b:02x}" for b in encoded[i:i + 16]) + ","
            for i in range(0, len(encoded), 16)]
    args.output.write_text("#pragma once\n#include <cstdint>\n"
                           "// 16kHz mono Opus, 60ms frames, uint16 LE lengths.\n"
                           "inline constexpr uint8_t kCodexQueryAudio[] = {\n"
                           + "\n".join(rows) + "\n};\n")
    print(f"Encoded {len(pcm) // 1920} frames, {len(encoded)} bytes")


if __name__ == "__main__":
    main()
