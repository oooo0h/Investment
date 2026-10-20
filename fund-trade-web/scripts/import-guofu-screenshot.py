"""OCR an explicitly selected screenshot locally and update encrypted data only.

Recognized text, pixels, crops and plaintext account records remain in memory.
Only validation counts are printed. Passwords are read from stdin or getpass.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import getpass
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata


EXPECTED_DATES = [
    '10-15', '10-14', '10-13', '10-12', '10-09', '10-08', '09-30', '09-29',
    '09-28', '09-28', '08-18', '08-17', '08-14', '08-13', '08-12', '08-11',
    '08-10', '08-07', '08-05', '07-31', '07-30', '07-29', '07-28', '07-27',
]
SCRIPT_DIR = Path(__file__).resolve().parent
DATE_RE = re.compile(r'(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[:：]\s*(\d{2})')
MONEY_RE = re.compile(r'(?<![\d.])(?:\d{1,3}(?:[,，]\d{3})+|\d+)\s*[.．]\s*\d{2}(?!\d)')
# A human inspected the source in this chat. These limited corrections store
# only row identifiers, date/time, and equality relationships, never amounts.
VERIFIED_TIMESTAMPS = {17: '2026-08-10 12:01:17', 20: '2026-07-31 12:00:35'}
VERIFIED_EQUAL_AMOUNT_ROWS = {11: 12, 13: 12, 16: 14}
VERIFIED_EQUAL_GROUPS = [list(range(1, 11)) + list(range(21, 25)), [11, 12, 13], list(range(14, 20))]


def run_ocr(image: Path, scale: float, left_fraction=0):
    legacy = Path('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
    result = subprocess.run([
        str(legacy), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', str(SCRIPT_DIR / 'ocr-in-memory.ps1'), '-ImagePath', str(image),
        '-Scale', str(scale), '-LeftFraction', str(left_fraction),
    ], capture_output=True, encoding='utf-8', errors='strict')
    if result.returncode:
        raise ValueError('Local OCR was unable to process the image')
    payload = json.loads(result.stdout.lstrip('\ufeff'))
    lines = []
    seen = set()
    for line in payload['lines']:
        words = line.get('words', [])
        if not words:
            continue
        y = min(word['y'] for word in words)
        x = min(word['x'] for word in words)
        text = line['text'].strip()
        marker = (text, round(y / 8))
        if marker in seen:
            continue
        seen.add(marker)
        lines.append({'text': text, 'y': y, 'x': x})
    return sorted(lines, key=lambda line: (line['y'], line['x']))


def parse_timeline(lines):
    dated_lines = [line for line in lines if re.search(r'20\d{2}', line['text'])]
    if len(dated_lines) != 24:
        raise ValueError('The recognized application count is not the expected count')
    timeline = []
    for index, line in enumerate(dated_lines, start=1):
        if index in VERIFIED_TIMESTAMPS:
            stamp = VERIFIED_TIMESTAMPS[index]
        else:
            compact = re.sub(r'\s', '', unicodedata.normalize('NFKC', line['text']))
            time = re.search(r'(\d{1,2})[:：](\d{2})[:：](\d{2})', compact)
            if time is None:
                raise ValueError(f'Uncertain application timestamp at row {index}')
            date_digits = re.sub(r'\D', '', compact[:time.start()])
            month, day = map(int, EXPECTED_DATES[index - 1].split('-'))
            possible_dates = {f'2026{a}{b}' for a in (str(month), f'{month:02}') for b in (str(day), f'{day:02}')}
            if date_digits not in possible_dates:
                raise ValueError(f'Uncertain application date at row {index}')
            hour, minute, second = map(int, time.groups())
            stamp = datetime(2026, month, day, hour, minute, second).strftime('%Y-%m-%d %H:%M:%S')
        timeline.append({'submittedAt': stamp, 'y': line['y']})
    return timeline


def extract_amount_candidates(lines, timeline):
    found = [set() for _ in timeline]
    for line in lines:
        text = re.sub(r'\s', '', unicodedata.normalize('NFKC', line['text']))
        text = text.translate(str.maketrans({'O': '0', 'o': '0', '。': '.'}))
        for amount in MONEY_RE.finditer(text):
            value = float(amount.group().replace(',', '').replace('，', '').replace('．', '.'))
            nearest = min(range(len(timeline)), key=lambda i: abs(timeline[i]['y'] - line['y']))
            if value > 0 and abs(timeline[nearest]['y'] - line['y']) < 65:
                found[nearest].add(value)
    return found


def read_verified_records(image):
    full = run_ocr(image, 1)
    timeline = parse_timeline(full)
    # All crops and scaled bitmaps exist only inside the OCR process memory.
    variants = [full, run_ocr(image, 1, 0.5), run_ocr(image, 1.4, 0.5),
                run_ocr(image, 2, 0.5), run_ocr(image, 1, 0.65)]
    counters = [Counter() for _ in timeline]
    for lines in variants:
        for counter, candidates in zip(counters, extract_amount_candidates(lines, timeline)):
            counter.update(candidates)
    anchors = {}
    for index, counter in enumerate(counters, start=1):
        best = counter.most_common()
        if best and best[0][1] >= 2 and (len(best) == 1 or best[0][1] > best[1][1]):
            anchors[index] = best[0][0]
    for target, source in VERIFIED_EQUAL_AMOUNT_ROWS.items():
        if source not in anchors:
            raise ValueError(f'The manually verified reference row {source} lacks an OCR anchor')
        if target in anchors and anchors[target] != anchors[source]:
            raise ValueError(f'The manually verified equality conflicts at row {target}')
        anchors[target] = anchors[source]
    if len(anchors) != 24:
        uncertain = ','.join(str(i) for i in range(1, 25) if i not in anchors)
        raise ValueError(f'Uncertain application amount rows: {uncertain}')
    for group in VERIFIED_EQUAL_GROUPS:
        if len({anchors[index] for index in group}) != 1:
            raise ValueError('A manually verified equality group does not match')
    if abs(anchors[20] * 10 - anchors[21]) > 0.001:
        raise ValueError('The manually verified application ratio does not match')
    transactions = []
    for index, record in enumerate(timeline):
        cancelled = index == 9
        transactions.append({
            'id': f'006373-application-{index + 1}', 'date': '',
            'submittedAt': record['submittedAt'], 'type': 'buy' if index in (8, 18) else 'sip',
            'amount': anchors[index + 1], 'nav': None, 'shares': None, 'fee': None,
            'status': 'cancelled' if cancelled else 'pending',
            'sourceStatus': 'cancelled' if cancelled else 'processing' if index < 2 else 'unverified',
        })
    return sorted(transactions, key=lambda tx: tx['submittedAt'])


def main():
    parser = argparse.ArgumentParser(description='Import application-only screenshot into an encrypted ledger.')
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--ledger', type=Path, default=SCRIPT_DIR.parent / 'data' / 'ledger.enc.json')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    original = read_verified_records(args.image.resolve())
    print('006373: validated applications=24; processing=2; cancelled=1; unverified=21; human-verified equalities=3; corrected timestamps=2')
    if args.verify_only:
        return
    password = getpass.getpass('Ledger password: ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
    if not password:
        raise ValueError('A nonempty password is required')
    spec = importlib.util.spec_from_file_location('ledger_encoder', SCRIPT_DIR / 'encrypt-workbooks.py')
    encoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(encoder)
    payload = encoder.decrypt_payload(args.ledger.resolve(), password)
    payload['funds']['006373'] = {
        'incomplete': True,
        'sourceNote': '仅记录本次截图可见申请。缺少成交净值、确认份额及实际手续费，收益暂不计算。',
        'transactions': original, 'mode': 'profit-first',
    }
    encoder.validate_funds(payload['funds'])
    encoder.encrypt_funds(payload['funds'], password, args.ledger.resolve())
    print('006373: encrypted applications updated; other funds retained')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Screenshot import failed validation. No recognized text or account values were emitted.', file=sys.stderr)
        sys.exit(1)
