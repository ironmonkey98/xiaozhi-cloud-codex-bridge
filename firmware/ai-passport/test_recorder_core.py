import json
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HEADER = ROOT / 'firmware/ai-passport'


def sanitizers():
    """ASan when it works here; Apple clang 17 on this macOS hangs even an empty ASan binary."""
    with tempfile.TemporaryDirectory() as directory:
        source, binary = Path(directory) / 'probe.cpp', Path(directory) / 'probe'
        source.write_text('int main() { return 0; }\n')
        try:
            subprocess.run(['c++', '-fsanitize=address', str(source), '-o', str(binary)],
                           check=True, capture_output=True, timeout=60)
            subprocess.run([str(binary)], check=True, capture_output=True, timeout=10)
            return '-fsanitize=address,undefined'
        except (subprocess.SubprocessError, OSError):
            print('note: AddressSanitizer unusable here, testing with UBSan only')
            return '-fsanitize=undefined'


SANITIZERS = sanitizers()


class RecorderCoreTests(unittest.TestCase):
    def run_cpp(self, code, directory, args=()):
        source = Path(directory) / 'test.cpp'
        binary = Path(directory) / 'test'
        source.write_text('#include "recorder_core.h"\n#include <cassert>\n'
                          '#include <fstream>\n#include <iostream>\n#include <vector>\n'
                          'using namespace Recorder;\n' + code)
        subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        SANITIZERS, '-fno-sanitize-recover=all', '-I', str(HEADER),
                        str(source), '-o', str(binary)], check=True, capture_output=True, timeout=60)
        return subprocess.run([str(binary), *map(str, args)], check=True,
                              capture_output=True, text=True, timeout=30).stdout

    def test_crc(self):
        samples = [b'', b'123456789', bytes(range(256)), b'\x00' * 768,
                   bytes((i * 73 + 19) % 256 for i in range(4097))]
        code = 'int main() {\n'
        for sample in samples:
            values = ','.join(map(str, sample)) or '0'
            code += ('{ const uint8_t b[] = {' + values + '}; std::cout << '
                     f'Crc32(b, {len(sample)}) << "\\n"; }}\n')
        code += '}'
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_cpp(code, directory)
        self.assertEqual(list(map(int, result.split())), [zlib.crc32(s) for s in samples])

    def test_packetizer_and_typescript_contract(self):
        code = r'''
struct Output { std::ofstream file; unsigned count = 0; bool accept = true; };
bool Save(void* context, PacketView p) {
    auto& o = *static_cast<Output*>(context);
    if (!o.accept) return false;
    assert(p.size <= 768 && Get32(p.data + 20) == o.count++);
    const uint8_t n[] = {uint8_t(p.size), uint8_t(p.size >> 8)};
    o.file.write(reinterpret_cast<const char*>(n), 2);
    o.file.write(reinterpret_cast<const char*>(p.data), p.size);
    return true;
}
int main(int argc, char** argv) {
    assert(argc == 2);
    Id id{}; for (unsigned i = 0; i < 16; ++i) id[i] = i;
    Output o{std::ofstream(argv[1], std::ios::binary)};
    Packetizer p(id, Save, &o);
    assert(p.AddFrame(0, nullptr, 0) == PackResult::Ok);
    const uint8_t a[] = {1, 2, 255};
    assert(p.AddFrame(1, a, 3) == PackResult::Ok);
    assert(p.AddFrame(4, nullptr, 0) == PackResult::Ok);
    for (unsigned i = 5; i <= 20; ++i) assert(p.AddFrame(i, nullptr, 0) == PackResult::Ok);
    uint8_t large[730]{}; for (unsigned i = 0; i < 730; ++i) large[i] = uint8_t(i);
    assert(p.AddFrame(21, large, 730) == PackResult::Ok);
    assert(p.AddFrame(22, a, 3) == PackResult::Ok);
    assert(p.AddFrame(23, large, 731) == PackResult::InvalidFrame);
    assert(p.AddFrame(21, nullptr, 0) == PackResult::InvalidFrame);
    o.accept = false;
    assert(p.Flush() == PackResult::SinkFull);
    assert(p.highest_sealed_seq() == 4);
    o.accept = true;
    assert(p.Flush() == PackResult::Ok && p.Flush() == PackResult::Ok);
    assert(o.count == 5);
    Packetizer bad(id, Save, &o, 37);
    assert(bad.AddFrame(0, nullptr, 0) == PackResult::InvalidFrame);
    Packetizer small(id, Save, &o, 40);
    assert(small.AddFrame(0, a, 3) == PackResult::InvalidFrame);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            packets = Path(directory) / 'packets.bin'
            self.run_cpp(code, directory, [packets])
            script = Path(directory) / 'contract.ts'
            script.write_text('import { parseAudioPacket } from ' +
                              json.dumps((ROOT / 'src/recording/protocol.ts').as_uri()) + ';\n' + r'''
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const b = readFileSync(process.argv[2]);
const expected = [
 {first: 0, frames: [[], [1,2,255]]},
 {first: 4, frames: Array.from({length:16}, () => [])},
 {first: 20, frames: [[]]},
 {first: 21, frames: [Array.from({length:730}, (_, i) => i % 256)]},
 {first: 22, frames: [[1,2,255]]},
];
let at = 0, seq = 0;
while (at < b.length) {
 const n = b.readUInt16LE(at); at += 2;
 const p = parseAudioPacket(b.subarray(at, at+n)); at += n;
 assert.notEqual(typeof p, 'string');
 if (typeof p === 'string') throw new Error(p);
 assert.equal(p.sessionId, '000102030405060708090a0b0c0d0e0f');
 assert.equal(p.seq, seq);
 assert.equal(p.firstFrame, expected[seq].first);
 assert.deepEqual(p.frames.map(f => Array.from(f)), expected[seq].frames);
 seq++;
}
assert.equal(seq, 5);
assert.equal(at, b.length);
''')
            subprocess.run(['node', str(script), str(packets)], check=True, capture_output=True, timeout=60)

    def test_window(self):
        with tempfile.TemporaryDirectory() as directory:
            self.run_cpp(r'''
std::array<uint8_t,38> Packet(uint32_t seq) {
 std::array<uint8_t,38> p{}; std::memcpy(p.data(), "APR1",4); Put32(p.data()+20,seq); return p;
}
int main() {
 SendWindow w(120); auto a=Packet(0), b=Packet(1), c=Packet(2), d=Packet(3);
 assert(w.valid()); assert(!SendWindow(65537).valid());
 assert(w.Push({a.data(),a.size()})); assert(w.Push({b.data(),b.size()}));
 assert(w.Push({c.data(),c.size()})); assert(!w.Push({d.data(),d.size()}));
 assert(w.storage_bytes()==120 && w.in_flight_bytes()==114);
 w.OnAck(2,0); assert(w.acknowledged_seq()==-1);
 assert(Get32(w.Next(100).data+20)==0);
 assert(Get32(w.Next(100).data+20)==1);
 assert(Get32(w.Next(100).data+20)==2); assert(!w.Next(3099).data);
 assert(Get32(w.Next(3100).data+20)==0);
 assert(Get32(w.Next(3100).data+20)==1);
 assert(Get32(w.Next(3100).data+20)==2); assert(w.retransmissions()==3);
 w.OnAck(0,3200); assert(w.in_flight_bytes()==76);
 assert(w.Push({d.data(),d.size()})); // Wrap the byte ring.
 assert(Get32(w.Next(3200).data+20)==3);
 w.OnAck(-1,5000); w.OnAck(0,6000); w.OnAck(99,6000);
 assert(w.acknowledged_seq()==0 && !w.Next(6199).data);
 assert(Get32(w.Next(6200).data+20)==1);
 w.OnAck(1,6201);
 assert(Get32(w.Next(6201).data+20)==2);
 assert(Get32(w.Next(6201).data+20)==3);
 assert(w.retransmissions()==6);
 w.OnAck(3,6300); assert(w.in_flight_bytes()==0 && !w.Next(10000).data);
 assert(w.highest_sealed_seq()==3 && w.acknowledged_seq()==3);
 auto e=Packet(4); assert(w.Push({e.data(),e.size()}));
 assert(Get32(w.Next(20000).data+20)==4); assert(!w.Next(22999).data);
 assert(Get32(w.Next(23000).data+20)==4);
}
''', directory)

    def test_state_and_control_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = self.run_cpp(r'''
Ack Start(Id request, Id session) {
 Ack a; a.has_request=a.has_session=true; a.request_id=request; a.session_id=session; return a;
}
int main() {
 Id request{}, session{}; request.fill(0xab); session.fill(0xcd);
 auto ack=Start(request,session);
 RecorderState s; assert(s.Toggle(0,request).send_start);
 auto start=s.StartJson(); std::cout << start.data.data() << '\n';
 assert(!s.Frame(0));
 auto wrong=ack; wrong.request_id.fill(1); s.OnAck(wrong,1);
 assert(s.state()==State::StartRequested);
 assert(s.OnAck(ack,2).state==State::Recording);
 assert(s.Frame(0)); assert(s.Frame(3)); assert(!s.Frame(3)); s.Dropped(2);
 Ack chunk; chunk.type=AckType::Chunk; chunk.has_session=true; chunk.session_id=session; chunk.persisted_seq=0;
 assert(s.OnAck(chunk,3).apply_ack);
 assert(s.Toggle(4).flush_and_stop);
 auto stop=s.StopJson(1); std::cout << stop.data.data() << '\n';
 assert(!s.Frame(4));
 Ack finish=chunk; finish.type=AckType::Finish; finish.state=FinishState::Saved;
 wrong=finish; wrong.session_id.fill(1); s.OnAck(wrong,5); assert(s.state()==State::Finishing);
 assert(s.OnAck(finish,6).state==State::Saved); assert(s.Toggle(7).state==State::Idle);
 RecorderState timeout; timeout.Toggle(0,request); assert(timeout.Tick(4999).state==State::StartRequested);
 assert(timeout.OnAck(ack,5000).state==State::Failed); assert(!timeout.Frame(0));
 RecorderState busy; busy.Toggle(0,request); auto err=ack; err.type=AckType::Error; err.code=ErrorCode::Busy;
 assert(busy.OnAck(err,1).error==ErrorCode::Busy && busy.state()==State::Failed);
 RecorderState waiting; waiting.Toggle(0,request); waiting.OnAck(ack,1); waiting.Frame(0); waiting.Toggle(2);
 assert(waiting.Tick(30001).state==State::Finishing); assert(waiting.Tick(30002).state==State::Failed);
 waiting.OnAck(finish,30003); assert(waiting.state()!=State::Saved);
 RecorderState partial; partial.Toggle(0,request); partial.OnAck(ack,1); partial.Toggle(2);
 finish.state=FinishState::Partial; assert(partial.OnAck(finish,3).state==State::Partial);
 RecorderState overflow; overflow.Toggle(0,request); overflow.OnAck(ack,1);
 auto action=overflow.Overflow(2); assert(action.flush_and_stop && action.reason==Reason::QueueOverflow);
 std::cout << overflow.StopJson(-1).data.data() << '\n';
 finish.state=FinishState::Saved; assert(overflow.OnAck(finish,3).state==State::Partial);
 RecorderState network(1000); network.Toggle(0,request); network.OnAck(ack,1); network.Network(false,2);
 network.Network(true,500); assert(network.Tick(1002).state==State::Recording);
 network.Network(false,1003); assert(network.Tick(2002).state==State::Recording);
 action=network.Network(true,2003); assert(action.flush_and_stop && action.reason==Reason::Network);
 RecorderState maximum(1000,1); maximum.Toggle(0,request); maximum.OnAck(ack,1);
 assert(maximum.Tick(1001).reason==Reason::MaxDuration);
 std::cout << sizeof(Packetizer) << ' ' << sizeof(SendWindow) << ' ' << sizeof(RecorderState) << '\n';
}
''', directory)
        lines = output.splitlines()
        start, stop, overflow = map(json.loads, lines[:3])
        self.assertEqual(start, {'v': 1, 'type': 'start', 'request_id': 'ab' * 16,
                                'format': {'codec': 'opus', 'sample_rate': 16000,
                                           'channels': 1, 'frame_ms': 60, 'dtx': True},
                                'max_duration_s': 7200})
        self.assertEqual(stop, {'v': 1, 'type': 'stop', 'session_id': 'cd' * 16,
                               'last_seq': 1, 'frames': 2, 'duration_ms': 240,
                               'dropped_frames': 2, 'reason': 'user'})
        self.assertEqual(overflow['reason'], 'queue_overflow')
        self.assertEqual(overflow['last_seq'], -1)
        print('host sizeof(Packetizer, SendWindow, RecorderState):', lines[3])


if __name__ == '__main__':
    unittest.main()
