"""Private PTY relay. No transcript or input is written to disk or logs."""
import errno
import fcntl
import os
import pty
import selectors
import signal
import sys
import termios
import time

master, slave = pty.openpty()
settings = termios.tcgetattr(slave)
settings[3] &= ~(termios.ECHO | termios.ECHONL)
termios.tcsetattr(slave, termios.TCSANOW, settings)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.execvp(sys.argv[1], sys.argv[1:])

os.close(slave)
stopping = None

def terminate(*_):
    global stopping
    if stopping is None:
        stopping = time.monotonic()
        signal.alarm(2)  # Also bounds a blocked output write during cancellation.
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

def force_stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    os._exit(1)

signal.signal(signal.SIGALRM, force_stop)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
selector.register(0, selectors.EVENT_READ)
status = None
try:
    while True:
        if stopping is not None and time.monotonic() - stopping > 1:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for key, _ in selector.select(0.05):
            try:
                data = os.read(key.fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                selector.unregister(key.fd)
                if key.fd == 0:
                    terminate()
                continue
            target = 1 if key.fd == master else master
            # os.write can be short, especially when relaying a pasted line.
            while data:
                data = data[os.write(target, data):]
        ended, value = os.waitpid(pid, os.WNOHANG)
        if ended:
            status = value
            break
finally:
    # Tools/processes spawned by the login command share its process group.
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if status is None:
        _, status = os.waitpid(pid, 0)
    # Drain final terminal output (including success text) after child exit.
    os.set_blocking(master, False)
    while True:
        try:
            data = os.read(master, 4096)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break
    os.close(master)
    selector.close()
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 1)
