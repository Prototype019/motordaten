"""Read-only UDS over BMW HSFZ (ENET): only 22 <DID> and OBD 01/09 <PID>."""
import socket, struct, sys, time, json
GW, PORT, TESTER = '169.254.239.129', 6801, 0xF4
ALLOWED = {0x22: 2, 0x01: 1, 0x09: 1}

class Link:
    def __init__(self):
        # the Mac's own link-local address toward the car (it changes when the adapter is plugged in again)
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.connect((GW, 6811)); local = u.getsockname()[0]; u.close()
        self.s = socket.create_connection((GW, PORT), timeout=8, source_address=(local, 0))
        self.buf = b''
    def _recv_frame(self, timeout):
        self.s.settimeout(timeout)
        while True:
            if len(self.buf) >= 6:
                n = struct.unpack('>I', self.buf[:4])[0]
                if len(self.buf) >= 6 + n:
                    ctrl = struct.unpack('>H', self.buf[4:6])[0]
                    body = self.buf[6:6 + n]; self.buf = self.buf[6 + n:]
                    return ctrl, body
            d = self.s.recv(4096)
            if not d: raise EOFError('closed')
            self.buf += d
    def read(self, tgt, req, timeout=3.0):
        if req[0] not in ALLOWED or len(req) != 1 + ALLOWED[req[0]] or tgt != 0x12:
            raise ValueError('read-only guard: refused %r' % req)
        body = bytes([TESTER, tgt]) + bytes(req)
        self.s.sendall(struct.pack('>IH', len(body), 0x0001) + body)
        end = time.time() + timeout
        while time.time() < end:
            try: ctrl, b = self._recv_frame(max(0.05, end - time.time()))
            except socket.timeout: break
            if ctrl != 0x0001 or len(b) < 3 or b[0] != tgt: continue
            u = list(b[2:])
            if u[0] == 0x7F and u[1] == req[0] and u[2] == 0x78: end = time.time() + 10; continue
            if (u[0] == req[0] + 0x40 and u[1:len(req)] == list(req[1:])) or (u[0] == 0x7F and u[1] == req[0]):
                return u
        return None

if __name__ == '__main__':
    L = Link()
    out = {}
    for line in sys.stdin.read().split():
        req = [int(x, 16) for x in line.split(',')]
        try: u = L.read(0x12, req)
        except Exception as e: u = 'ERR %s' % e
        out[line] = u if not isinstance(u, list) else ' '.join('%02X' % x for x in u)
        time.sleep(0.03)
    print(json.dumps(out, indent=0))
