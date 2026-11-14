"""Windows operations for a game controlled only through window messages."""
import mmap
import subprocess

from PIL import Image


class Win32:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w

        self.c, self.w = c, w
        self.u, self.g = c.windll.user32, c.windll.gdi32
        c.windll.shcore.SetProcessDpiAwareness(2)
        self.processes = {}
        self.enum_window = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        self.enum_monitor = c.WINFUNCTYPE(w.BOOL, w.HANDLE, w.HDC, c.POINTER(w.RECT), w.LPARAM)
        # Explicit pointer widths matter on a 64 bit host.
        signatures = [
            (self.u, 'EnumWindows', [self.enum_window, w.LPARAM], w.BOOL),
            (self.u, 'EnumDisplayMonitors', [w.HDC, c.c_void_p, self.enum_monitor, w.LPARAM], w.BOOL),
            (self.u, 'GetMonitorInfoW', [w.HANDLE, c.c_void_p], w.BOOL),
            (self.u, 'GetWindowThreadProcessId', [w.HWND, c.POINTER(w.DWORD)], w.DWORD),
            (self.u, 'GetWindowRect', [w.HWND, c.POINTER(w.RECT)], w.BOOL),
            (self.u, 'IsWindowVisible', [w.HWND], w.BOOL),
            (self.u, 'GetWindowTextW', [w.HWND, w.LPWSTR, c.c_int], c.c_int),
            (self.u, 'GetForegroundWindow', [], w.HWND),
            (self.u, 'GetCursorPos', [c.POINTER(w.POINT)], w.BOOL),
            (self.u, 'GetLastInputInfo', [c.c_void_p], w.BOOL),
            (self.u, 'ShowWindow', [w.HWND, c.c_int], w.BOOL),
            (self.u, 'SetWindowPos', [w.HWND, w.HWND, c.c_int, c.c_int, c.c_int, c.c_int, w.UINT], w.BOOL),
            (self.u, 'IsHungAppWindow', [w.HWND], w.BOOL),
            (self.u, 'PostMessageW', [w.HWND, w.UINT, w.WPARAM, w.LPARAM], w.BOOL),
            (self.u, 'MapVirtualKeyW', [w.UINT, w.UINT], w.UINT),
            (self.u, 'GetDC', [w.HWND], w.HDC),
            (self.u, 'ReleaseDC', [w.HWND, w.HDC], c.c_int),
            (self.u, 'PrintWindow', [w.HWND, w.HDC, w.UINT], w.BOOL),
            (self.g, 'CreateCompatibleDC', [w.HDC], w.HDC),
            (self.g, 'CreateCompatibleBitmap', [w.HDC, c.c_int, c.c_int], w.HBITMAP),
            (self.g, 'SelectObject', [w.HDC, w.HANDLE], w.HANDLE),
            (self.g, 'GetDIBits', [w.HDC, w.HBITMAP, w.UINT, w.UINT, c.c_void_p, c.c_void_p, w.UINT], c.c_int),
            (self.g, 'DeleteObject', [w.HANDLE], w.BOOL),
            (self.g, 'DeleteDC', [w.HDC], w.BOOL),
        ]
        for library, name, args, result in signatures:
            function = getattr(library, name)
            function.argtypes, function.restype = args, result

    def monitors(self):
        c, w = self.c, self.w

        class Info(c.Structure):
            _fields_ = [('size', w.DWORD), ('monitor', w.RECT), ('work', w.RECT),
                        ('flags', w.DWORD), ('device', w.WCHAR * 32)]

        found = {}
        def visit(handle, dc, rect, data):
            info = Info()
            info.size = c.sizeof(info)
            if self.u.GetMonitorInfoW(handle, c.byref(info)):
                r = info.monitor
                found[info.device] = (r.left, r.top, r.right, r.bottom)
            return True
        if not self.u.EnumDisplayMonitors(None, None, self.enum_monitor(visit), 0):
            raise OSError('could not enumerate monitors')
        return found

    def start(self, args, cwd, env):
        process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        self.processes[process.pid] = process
        return process.pid

    def poll(self, pid):
        return self.processes[pid].poll()

    def alive(self, pid):
        return self.poll(pid) is None

    def stop(self, pid):
        if self.alive(pid):
            self.processes[pid].terminate()

    def wait(self, pid, timeout):
        return self.processes[pid].wait(timeout=timeout)

    def windows(self, pid):
        found = []
        def visit(handle, data):
            owner = self.w.DWORD()
            self.u.GetWindowThreadProcessId(handle, self.c.byref(owner))
            if owner.value == pid:
                found.append(handle)
            return True
        if not self.u.EnumWindows(self.enum_window(visit), 0):
            raise OSError('could not enumerate windows')
        return found

    def rect(self, handle):
        rect = self.w.RECT()
        if not self.u.GetWindowRect(handle, self.c.byref(rect)):
            raise OSError('could not read window rectangle')
        return rect.left, rect.top, rect.right, rect.bottom

    def visible(self, handle):
        return bool(self.u.IsWindowVisible(handle))

    def title(self, handle):
        text = self.c.create_unicode_buffer(1024)
        self.u.GetWindowTextW(handle, text, len(text))
        return text.value

    def foreground(self, handle):
        return self.u.GetForegroundWindow() == handle

    def cursor(self):
        point = self.w.POINT()
        if not self.u.GetCursorPos(self.c.byref(point)):
            raise OSError('could not read pointer')
        return point.x, point.y

    def last_input(self):
        class Info(self.c.Structure):
            _fields_ = [('size', self.w.UINT), ('tick', self.w.DWORD)]
        info = Info()
        info.size = self.c.sizeof(info)
        if not self.u.GetLastInputInfo(self.c.byref(info)):
            raise OSError('could not read last input')
        return info.tick

    def show(self, handle):
        self.u.ShowWindow(handle, 4)

    def move(self, handle, x, y):
        if not self.u.SetWindowPos(handle, None, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010):
            raise OSError('could not move game window')

    def responding(self, handle):
        return not self.u.IsHungAppWindow(handle)

    def mouse_memory(self, pid):
        return mmap.mmap(-1, 8, tagname=f'pt_input_mouse_{pid}', access=mmap.ACCESS_WRITE)

    def post(self, handle, message, wparam, lparam):
        if not self.u.PostMessageW(handle, message, wparam, lparam):
            raise OSError('could not post game input')

    def scan(self, vk):
        return self.u.MapVirtualKeyW(vk, 0)

    def capture(self, handle, size):
        c, w = self.c, self.w
        class Header(c.Structure):
            _fields_ = [('size', w.DWORD), ('width', w.LONG), ('height', w.LONG),
                        ('planes', w.WORD), ('bits', w.WORD), ('compression', w.DWORD),
                        ('image_size', w.DWORD), ('xppm', w.LONG), ('yppm', w.LONG),
                        ('used', w.DWORD), ('important', w.DWORD)]
        width, height = size
        screen = self.u.GetDC(None)
        dc = bitmap = old = None
        try:
            dc = self.g.CreateCompatibleDC(screen)
            bitmap = self.g.CreateCompatibleBitmap(screen, width, height)
            if not screen or not dc or not bitmap:
                raise OSError('could not allocate capture bitmap')
            old = self.g.SelectObject(dc, bitmap)
            if not self.u.PrintWindow(handle, dc, 3):
                raise OSError('PrintWindow failed')
            self.g.SelectObject(dc, old)
            old = None
            header = Header(c.sizeof(Header), width, -height, 1, 32)
            pixels = c.create_string_buffer(width * height * 4)
            if self.g.GetDIBits(dc, bitmap, 0, height, pixels, c.byref(header), 0) != height:
                raise OSError('GetDIBits failed')
            return Image.frombytes('RGB', size, pixels.raw, 'raw', 'BGRX')
        finally:
            if old: self.g.SelectObject(dc, old)
            if bitmap: self.g.DeleteObject(bitmap)
            if dc: self.g.DeleteDC(dc)
            if screen: self.u.ReleaseDC(None, screen)
