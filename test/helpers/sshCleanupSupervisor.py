"""Bound synthetic probes and reap test orphans; rescue is never adapter success."""
import ctypes
import json
import os
import signal
import subprocess
import sys
import time


def exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


def kill_adopted(deadline):
    # After worker exit the subreaper owns every orphan, even if metadata was
    # never published. Prove unreaped child ownership before each exact kill.
    reaped = 0
    with os.scandir('/proc') as entries:
        for index, entry in enumerate(entries):
            if index >= 16384 or time.monotonic() >= deadline:
                raise TimeoutError('test rescue process scan exceeded bound')
            if not entry.name.isdecimal():
                continue
            pid = int(entry.name)
            try:
                with open(entry.path + '/stat', 'rb') as stream:
                    fields = stream.read(4096).rsplit(b')', 1)[1].split()
                if int(fields[1]) != os.getpid():
                    continue
                observed, _ = os.waitpid(pid, os.WNOHANG)
                if observed:
                    reaped += 1
                else:
                    os.kill(pid, signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError, ChildProcessError,
                    PermissionError, ValueError, IndexError):
                pass
    return reaped


def main():
    directory = sys.argv[3]
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('test subreaper unavailable')
    worker = subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True)
    group = None
    verified_group = False
    deadline = time.monotonic() + 12
    try:
        while worker.poll() is None:
            if group is None:
                try:
                    with open(os.path.join(directory, 'group'), encoding='ascii') as stream:
                        group = int(stream.read())
                    # Accept only the Node worker's own detached bridge child.
                    with open('/proc/%s/stat' % group, 'rb') as stream:
                        fields = stream.read(4096).rsplit(b')', 1)[1].split()
                    verified_group = [int(v) for v in fields[1:4]] == [worker.pid, group, group]
                    if not verified_group:
                        raise RuntimeError('unexpected fixture ownership')
                    with open(os.path.join(directory, 'group-verified'), 'w', encoding='ascii'):
                        pass
                except FileNotFoundError:
                    group = None
            if time.monotonic() >= deadline:
                raise TimeoutError('synthetic worker deadline')
            time.sleep(.01)
        if worker.returncode != 0 or not verified_group:
            raise RuntimeError('synthetic worker failed')
        with open(os.path.join(directory, 'result'), encoding='utf-8') as stream:
            report = json.load(stream)
        report['rescueNeeded'] = exists(group)
    finally:
        # End the still-unreaped worker, then rescue only our adopted children.
        # Never signal a stored bridge PGID after Node may have reaped its leader.
        if worker.poll() is None:
            os.killpg(worker.pid, signal.SIGKILL)
        worker.wait(timeout=2)
        reaped = 0
        reap_deadline = time.monotonic() + 3
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid:
                reaped += 1
            elif time.monotonic() >= reap_deadline:
                raise TimeoutError('test supervisor failed to reap')
            else:
                reaped += kill_adopted(reap_deadline)
                time.sleep(.01)
        if verified_group and exists(group):
            raise RuntimeError('test group survived rescue')
    report['rescuedChildren'] = reaped
    print(json.dumps(report, separators=(',', ':')))


if __name__ == '__main__':
    main()
