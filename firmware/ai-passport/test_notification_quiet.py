import pathlib, subprocess, tempfile, unittest

class NotificationQuietTest(unittest.TestCase):
    def test_listening_yield_requires_fresh_quiet_input_and_no_cloud_reply(self):
        root=pathlib.Path(__file__).resolve().parents[2]
        source=r'''
#include "audio/input_quiet.h"
#include <cassert>
int main() {
 using namespace InputQuiet;
 int16_t silence[160]={}; assert(!HasSoundActivity(silence,160,1));
 int16_t dc[160]; for(auto& v:dc)v=2000; assert(!HasSoundActivity(dc,160,1));
 int16_t background[160]; for(int i=0;i<160;++i)background[i]=i%2?150:-150;
 assert(!HasSoundActivity(background,160,1));
 int16_t quiet_speech[160]; for(int i=0;i<160;++i)quiet_speech[i]=i%2?300:-300;
 assert(HasSoundActivity(quiet_speech,160,1));
 int16_t sound[160]; for(int i=0;i<160;++i)sound[i]=i%2?400:-400; assert(HasSoundActivity(sound,160,1));
 assert(CanYield(30000,10000,29999,14000,false,false,true));
 assert(!CanYield(30000,10000,29999,29000,false,false,true));
 assert(!CanYield(30000,10000,29000,14000,false,false,true));
 assert(!CanYield(30000,10000,29999,14000,true,false,true));
 assert(!CanYield(30000,10000,29999,14000,false,true,true));
 assert(!CanYield(30000,10000,29999,14000,false,false,false));
 assert(!CanYield(30000,20000,29999,14000,false,false,true));
}
'''
        with tempfile.TemporaryDirectory() as d:
            cpp=pathlib.Path(d)/'test.cc';exe=pathlib.Path(d)/'test';cpp.write_text(source)
            subprocess.run(['c++','-std=c++17','-I',str(root/'main'),str(cpp),'-o',str(exe)],check=True,capture_output=True)
            subprocess.run([str(exe)],check=True)
