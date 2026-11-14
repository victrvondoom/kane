"""Refuse outside sockets and name lookups for one run."""
import socket


class Guard:
    def __init__(self, allowed=("127.0.0.1", "::1", "localhost")):
        self.allowed = set(allowed)
        self.blocked = 0
        self.hosts = set()
        self.local = 0
        self._original = None

    def _check(self, host, connection=False):
        if isinstance(host, bytes):
            host = host.decode('ascii', errors='replace')
        host = str(host).lower()
        if host not in self.allowed:
            self.blocked += 1
            self.hosts.add(host)
            raise OSError(f"offline guard: {host}")
        if connection:
            self.local += 1

    def install(self):
        if self._original is not None:
            return
        cls = socket.socket
        connect, connect_ex, lookup = cls.connect, cls.connect_ex, socket.getaddrinfo
        self._original = cls, connect, connect_ex, lookup

        def guarded_connect(sock, address):
            self._check(address[0] if isinstance(address, tuple) else address, True)
            return connect(sock, address)

        def guarded_connect_ex(sock, address):
            self._check(address[0] if isinstance(address, tuple) else address, True)
            return connect_ex(sock, address)

        def guarded_lookup(host, *args, **kwargs):
            self._check(host)
            return lookup(host, *args, **kwargs)

        cls.connect = guarded_connect
        cls.connect_ex = guarded_connect_ex
        socket.getaddrinfo = guarded_lookup

    def uninstall(self):
        if self._original is None:
            return
        cls, connect, connect_ex, lookup = self._original
        cls.connect, cls.connect_ex, socket.getaddrinfo = connect, connect_ex, lookup
        self._original = None

    def report(self):
        return {"blocked_connections": self.blocked, "hosts": sorted(self.hosts),
                "allowed_local_connections": self.local}
