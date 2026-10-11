"""Local SMS operations. Only the explicit test subcommand sends a message."""
import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timezone
import app
import local_sms


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    sub.add_parser('health')
    sub.add_parser('sync', help='Fetch and persist the current cloud configuration')
    test = sub.add_parser('test', help='Send exactly one test SMS through the local phone')
    test.add_argument('--to', required=True)
    args = parser.parse_args()
    app.init_db()
    if args.command == 'sync':
        app.run_supabase_sync()
    conn = app.get_db()
    try:
        if args.command in ('status','sync'):
            print(json.dumps(local_sms.status(conn, app.LOCAL_SMS), indent=2))
            return 0
        gateway = local_sms.Gateway(app.LOCAL_SMS)
        if args.command == 'health':
            gateway.health()
            print('Local SMSGate reachable; no SMS sent')
            return 0
        phone = local_sms.normalize_phone(args.to)
        if not phone:
            raise ValueError('A valid Philippine mobile number is required')
        if not local_sms.clock_ready(app.LOCAL_SMS):
            raise ValueError('Pi clock is not trusted')
        if local_sms.saved_config(conn).get('mode') != 'local':
            raise ValueError('Synchronize confirmed local cloud ownership before sending')
        gateway.health()
        uid = str(uuid.uuid4())
        now = time.time()
        conn.execute('BEGIN IMMEDIATE')
        local_sms.enqueue(conn, uid, 'test', 1, phone, '[LPMAS] Local SMS test. Confirm receipt on your handset.', now, now)
        conn.execute("UPDATE local_sms_jobs SET status='unknown',attempts=1,attempted_at=?,gateway_id=id,detail='Test submission outcome unconfirmed',version=version+1 WHERE id=(SELECT id FROM local_sms_jobs WHERE episode_uid=?)", (now,uid))
        job = dict(conn.execute('SELECT * FROM local_sms_jobs WHERE episode_uid=?', (uid,)).fetchone())
        conn.commit()
        try:
            outcome = local_sms.interpret(gateway.send(job), job)
        except Exception:
            outcome = ('unknown','Test submission outcome unconfirmed; automatic resend disabled')
        local_sms.finish(conn, job, outcome, now)
        print(json.dumps({'message_id':job['id'],'status':outcome[0],'detail':outcome[1]}))
        return 0 if outcome[0] in ('accepted','sent','delivered') else 1
    finally:
        conn.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Credentials and upstream responses never enter output.
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        else:
            print('Local operation failed; check gateway, ownership and configuration', file=sys.stderr)
        sys.exit(1)
