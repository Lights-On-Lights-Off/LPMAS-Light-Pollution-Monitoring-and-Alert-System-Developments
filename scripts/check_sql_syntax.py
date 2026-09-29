#!/usr/bin/env python3
"""
Parses every migration with pglast to catch SQL syntax errors.

This is a syntax check only. It does NOT connect to a database, so it cannot
tell you that a migration runs, that a policy is correct, or that a function
compiles. It catches the cheap class of error — an unclosed paren, a bad
keyword — without needing Postgres installed.

Requires: pip install pglast
"""
import glob
import os
import sys

try:
    from pglast import parse_sql
    from pglast.parser import ParseError
except ImportError:
    print("pglast is not installed. Run: pip install pglast", file=sys.stderr)
    sys.exit(2)

failures = 0

# Migration 0008 was committed without a .sql suffix, so globbing on the
# extension alone would silently skip it. Take every regular file in the
# directory instead.
files = sorted(
    path
    for path in glob.glob("supabase/migrations/*")
    if os.path.isfile(path)
)

if not files:
    print("no migrations found", file=sys.stderr)
    sys.exit(1)

for path in files:
    with open(path, encoding="utf-8") as handle:
        sql = handle.read()

    try:
        statements = parse_sql(sql)
        print(f"OK   {path}  ({len(statements)} statements)")
    except ParseError as error:
        failures += 1
        print(f"FAIL {path}\n     {error}")

print()
if failures:
    print(f"{failures} file(s) failed to parse.")
    sys.exit(1)

print(f"All {len(files)} migration file(s) parse as valid SQL.")
print("NOTE: parsed, not executed. A parse says nothing about runtime behaviour.")
