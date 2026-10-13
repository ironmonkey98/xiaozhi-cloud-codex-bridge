"""与设备一致的 libopus 编码参数；无需 numpy。"""
import ctypes
import ctypes.util
import struct

SAMPLES = 960
HEADER = struct.Struct('<IH')


class Encoder:
    def __init__(self) -> None:
        name = ctypes.util.find_library('opus')
        if not name:
            raise RuntimeError('找不到 libopus 动态库')
        self.lib = ctypes.CDLL(name)
        self.lib.opus_encoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        self.lib.opus_encoder_create.restype = ctypes.c_void_p
        self.lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
        self.lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int32]
        # ctl 为变参函数，必须声明固定参数（包括 Apple ARM64）。
        self.lib.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int]
        error = ctypes.c_int()
        self.handle = self.lib.opus_encoder_create(16000, 1, 2048, ctypes.byref(error))
        if error.value or not self.handle:
            raise RuntimeError(f'libopus create: {error.value}')
        for request, value in [(4002, 16000), (4006, 1), (4010, 0), (4016, 1)]:
            self.check(self.lib.opus_encoder_ctl(self.handle, request, ctypes.c_int(value)))
        lookahead = ctypes.c_int()
        self.check(self.lib.opus_encoder_ctl(self.handle, 4027, ctypes.byref(lookahead)))
        self.pre_skip = lookahead.value * 3

    @staticmethod
    def check(code: int) -> None:
        if code < 0:
            raise RuntimeError(f'libopus: {code}')

    def encode(self, samples: list[int]) -> bytes:
        if len(samples) != SAMPLES:
            raise ValueError('需要 960 个 PCM 样本')
        pcm = (ctypes.c_int16 * SAMPLES)(*samples)
        out = (ctypes.c_ubyte * 1275)()
        size = self.lib.opus_encode(self.handle, pcm, SAMPLES, out, len(out))
        self.check(size)
        return bytes(out[:size])

    def close(self) -> None:
        if self.handle:
            self.lib.opus_encoder_destroy(self.handle)
            self.handle = None

    def __enter__(self) -> 'Encoder':
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
