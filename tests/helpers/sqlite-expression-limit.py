"""Prepare the actual recovery statements at Cloudflare D1's expression limit."""
import ctypes
import ctypes.util
import json
import os
import pathlib
import sys

lib = ctypes.CDLL(ctypes.util.find_library('sqlite3'))
ptr = ctypes.c_void_p
lib.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ptr)]
lib.sqlite3_exec.argtypes = [ptr, ctypes.c_char_p, ptr, ptr, ptr]
lib.sqlite3_limit.argtypes = [ptr, ctypes.c_int, ctypes.c_int]
lib.sqlite3_prepare_v2.argtypes = [ptr, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(ptr), ptr]
lib.sqlite3_finalize.argtypes = [ptr]
lib.sqlite3_errmsg.argtypes = [ptr]
lib.sqlite3_errmsg.restype = ctypes.c_char_p
lib.sqlite3_close.argtypes = [ptr]

db = ptr()
if lib.sqlite3_open(b':memory:', ctypes.byref(db)):
    raise RuntimeError('sqlite open failed')
try:
    root = pathlib.Path(__file__).resolve().parents[2]
    # Same schema as tests/helpers/migration-files.mjs: release files, then local-only drafts.
    dirs = ['migrations'] if os.environ.get('MALIPANG_TEST_SCHEMA') == 'release' else ['migrations', 'migrations-draft']
    for migration in sorted((path for d in dirs for path in (root / d).glob('*.sql')), key=lambda path: path.name):
        if lib.sqlite3_exec(db, migration.read_bytes(), None, None, None):
            raise RuntimeError('migration failed: ' + migration.name)
    # SQLITE_LIMIT_EXPR_DEPTH = 3. D1 rejects expression trees deeper than 100.
    lib.sqlite3_limit(db, 3, 100)
    for index, sql in enumerate(json.load(sys.stdin)):
        statement = ptr()
        data = ('EXPLAIN ' + sql).encode()
        if lib.sqlite3_prepare_v2(db, data, -1, ctypes.byref(statement), None):
            raise RuntimeError('statement %d: %s' % (index, lib.sqlite3_errmsg(db).decode()))
        lib.sqlite3_finalize(statement)
finally:
    lib.sqlite3_close(db)
