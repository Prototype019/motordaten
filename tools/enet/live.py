"""Live-Werte der DME über ENET (HSFZ), nur lesend. Strg+C beendet.

    python3 -I tools/enet/live.py
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hsfz import Link

def u16(b): return (b[0] << 8) | b[1]
def s16(b): v = u16(b); return v - 0x10000 if v & 0x8000 else v

# (Name, DID, Umrechnung der Datenbytes, Einheit, Nachkommastellen) – DME8FF_R
DIDS = [
    ('Öl nach Filter',  0x4402, lambda b: u16(b) * 0.75 - 48, '°C', 0),
    ('Öl im Sumpf',     0x4425, lambda b: s16(b) * 0.1, '°C', 1),
    ('Kühlmittel',      0x4300, lambda b: s16(b) * 0.1 - 273.14, '°C', 1),
    ('Ansaugluft',      0x580F, lambda b: b[0] * 0.75 - 48, '°C', 1),
    ('Ladeluft vor DK', 0x59D4, lambda b: u16(b) * 0.0234375 - 273.15, '°C', 1),
    ('Ladedruck abs.',  0x4205, lambda b: u16(b) * 0.078125 / 1000, 'bar', 2),
    ('Ladedruck Soll',  0x4AB0, lambda b: u16(b) * 0.0390625 / 1000, 'bar', 2),
    ('Umgebungsdruck',  0x4201, lambda b: u16(b) * 0.0390625 / 1000, 'bar', 3),
    ('Öldruck abs.',    0x4436, lambda b: u16(b) / 1000, 'bar', 2),
]

def main():
    L = Link()
    peak = {}
    t0 = time.time(); n = 0
    while True:
        v = {}
        u = L.read(0x12, [0x01, 0x0C])
        v['Drehzahl'] = ((u[2] << 8) | u[3]) / 4 if u and u[0] == 0x41 and len(u) >= 4 else None
        for name, did, f, unit, d in DIDS:
            r = L.read(0x12, [0x22, did >> 8, did & 0xFF])
            v[name] = f(r[3:]) if r and r[0] == 0x62 else None
        amb = v['Umgebungsdruck']
        v['Ladedruck'] = v['Ladedruck abs.'] - amb if None not in (v['Ladedruck abs.'], amb) else None
        v['Öldruck'] = v['Öldruck abs.'] - amb if None not in (v['Öldruck abs.'], amb) else None
        for k in ('Drehzahl', 'Ladedruck', 'Öldruck'):
            if v[k] is not None:
                peak[k] = max(peak.get(k, v[k]), v[k])
        n += 1
        rows = [('Drehzahl', 'U/min', 0)] + [(name, unit, d) for name, _, _, unit, d in DIDS] + \
               [('Ladedruck', 'bar', 2), ('Öldruck', 'bar', 2)]
        out = ['\033[H\033[2J  G87 M2 · DME live (nur lesend) · %.1f Updates/s · Strg+C = Ende\n' % (n / (time.time() - t0))]
        for name, unit, d in rows:
            s = '–' if v[name] is None else '%.*f' % (d, v[name])
            pk = '   max %.*f' % (d, peak[name]) if name in peak else ''
            out.append('  %-16s %9s %-6s%s' % (name + (' (rel.)' if name in ('Ladedruck', 'Öldruck') else ''), s, unit, pk))
        sys.stdout.write('\n'.join(out) + '\n'); sys.stdout.flush()

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nBeendet.')
