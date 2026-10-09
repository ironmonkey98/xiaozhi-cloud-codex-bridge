#!/usr/bin/env python3
"""Pre-flash regression guard: preserve the actual user's renderer, pixels, pins and UI selection."""
from pathlib import Path
import argparse, hashlib, re
p=argparse.ArgumentParser();p.add_argument('baseline');p.add_argument('candidate');args=p.parse_args()
a,b=Path(args.baseline),Path(args.candidate)
try:
    ui=list((a/'main/display/muse_style').glob('*'))
    assert ui, 'Original Muse UI source missing'
    ui += [a/'main/boards/folotoy/ai-passport/config.h']
    for original in ui:
        if original.is_file():
            candidate=b/original.relative_to(a)
            assert candidate.is_file() and original.read_bytes()==candidate.read_bytes(), str(original.relative_to(a))
    def init(root):
        source=(root/'main/boards/folotoy/ai-passport/ai_passport_board.cc').read_text()
        start=source.index('    void InitializeDisplay()');end=source.index('\npublic:',start)
        return source[start:end]
    assert init(a)==init(b), 'Display initialization changed'
    config=(b/'sdkconfig').read_text()
    for line in ['CONFIG_BOARD_TYPE_FOLOTOY_AI_PASSPORT=y','CONFIG_AI_PASSPORT_MUSE_STYLE_UI=y',
                 'CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y','CONFIG_CUSTOM_BASE_MAC=""']:
        assert line in config.splitlines(), line
    print('PASS: original UI renderer, pixel art, display initialization, pins and Muse selection preserved')
except (AssertionError, OSError, ValueError) as e:
    p.exit(1, f'FAIL: original UI is not preserved: {e}\n')
