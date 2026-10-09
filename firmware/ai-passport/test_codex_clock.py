import unittest, subprocess, tempfile
from pathlib import Path

class NotificationClockTests(unittest.TestCase):
    def test_deadlines_use_utc_while_the_screen_clock_stays_local(self):
        root=Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'clock.cpp'; binary=Path(directory)/'clock'
            source.write_text('''#include "wall_clock.h"
#include <cassert>
int main() {
 const int64_t utc=1791545272242LL;
 // Before the fix an Asia/Shanghai local epoch makes a fresh signal look 8h expired.
 const int64_t local=utc+480LL*60000;
 assert(local>utc+900000);
 assert(WallClock::ToUtcMilliseconds(local,480)==utc);
 assert(WallClock::ToUtcMilliseconds(utc-420LL*60000,-420)==utc);
 assert(WallClock::ToUtcMilliseconds(utc,0)==utc);
}
''')
            subprocess.run(['c++','-std=c++17','-I',str(root/'main'),str(source),'-o',str(binary)],check=True,capture_output=True)
            subprocess.run([str(binary)],check=True)
