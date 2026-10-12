"""Task-owned Xvfb only: capture public crash UI, then press its native Restore.
No application URLs, credentials, browser preferences or session files are read.
The caller verifies NTP + screenshot + private operator acknowledgement first.
"""
import ctypes
import ctypes.util
import os
import re
import sys

ERROR_CODES = {
    "task_owned_display_required", "absolute_screenshot_path_required", "native_restore_coordinate_invalid",
    "native_display_unavailable", "native_window_inventory_failed", "unique_native_new_tab_window_required",
    "native_restore_coordinate_outside_display", "native_pointer_move_failed", "native_pointer_press_failed",
    "native_pointer_release_failed", "native_action_not_allowed", "native_window_geometry_unavailable",
    "native_restore_coordinate_outside_window",
}


def safe_error_code(error):
    code = str(error)
    return code if code in ERROR_CODES else "native_gui_operation_failed"


class WindowAttributes(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
               ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p),
               ("root", ctypes.c_ulong), ("window_class", ctypes.c_int), ("bit_gravity", ctypes.c_int),
               ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
               ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
               ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
               ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
               ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
               ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int),
               ("screen", ctypes.c_void_p)]


def native_window_matches(title, map_state, width, height):
    # Chromium 153 publishes the visible NTP title in UTF-8 _NET_WM_NAME;
    # WM_NAME "chrome" belongs to a hidden dummy widget, not the browser.
    # NTP identity is independently checked through CDP before capture/input.
    allowed = title in {b"New Tab - Chromium", b"New Tab - Google Chrome", b"New Tab - Google Chrome for Testing"}
    return allowed and map_state == 2 and width > 1 and height > 1


def read_native_title(x11, connection, selected):
    pointer = ctypes.c_void_p
    atom = x11.XInternAtom(connection, b"_NET_WM_NAME", True)
    utf8 = x11.XInternAtom(connection, b"UTF8_STRING", True)
    if atom and utf8:
        actual_type, actual_format = ctypes.c_ulong(), ctypes.c_int()
        count, remaining, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.POINTER(ctypes.c_ubyte)()
        status = x11.XGetWindowProperty(connection, selected, atom, 0, 256, False, utf8,
                                         ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(count),
                                         ctypes.byref(remaining), ctypes.byref(data))
        try:
            if status == 0 and actual_type.value == utf8 and actual_format.value == 8 and remaining.value == 0 and count.value <= 1024:
                if data and count.value:
                    # Values remain local for comparison; none are emitted.
                    return ctypes.string_at(data, count.value)
        finally:
            if data:
                x11.XFree(ctypes.cast(data, pointer))
    name = ctypes.c_char_p()
    if x11.XFetchName(connection, selected, ctypes.byref(name)) and name:
        try:
            return name.value or b""
        finally:
            x11.XFree(ctypes.cast(name, pointer))
    return b""


def display_argument(value):
    if not re.fullmatch(r":(?:[7-9][0-9]|1[0-9]{2})", value):
        raise ValueError("task_owned_display_required")
    return value


def capture(display, path):
    from PIL import ImageGrab
    if not os.path.isabs(path):
        raise ValueError("absolute_screenshot_path_required")
    image = ImageGrab.grab(xdisplay=display)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        image.save(target, format="PNG")


def restore(display_name, x, y):
    if not (0 <= x < 10000 and 0 <= y < 10000):
        raise ValueError("native_restore_coordinate_invalid")
    x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
    xtest = ctypes.CDLL(ctypes.util.find_library("Xtst"))
    pointer, window = ctypes.c_void_p, ctypes.c_ulong
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = pointer
    x11.XDefaultRootWindow.argtypes = [pointer]
    x11.XDefaultRootWindow.restype = window
    x11.XQueryTree.argtypes = [pointer, window, ctypes.POINTER(window), ctypes.POINTER(window),
                              ctypes.POINTER(ctypes.POINTER(window)), ctypes.POINTER(ctypes.c_uint)]
    x11.XFetchName.argtypes = [pointer, window, ctypes.POINTER(ctypes.c_char_p)]
    x11.XInternAtom.argtypes = [pointer, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XGetWindowProperty.argtypes = [pointer, window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int,
                                      ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
                                      ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                      ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    x11.XGetWindowAttributes.argtypes = [pointer, window, ctypes.POINTER(WindowAttributes)]
    x11.XTranslateCoordinates.argtypes = [pointer, window, window, ctypes.c_int, ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(window)]
    x11.XFree.argtypes = [pointer]
    x11.XDefaultScreen.argtypes = [pointer]
    x11.XDefaultScreen.restype = ctypes.c_int
    x11.XDisplayWidth.argtypes = [pointer, ctypes.c_int]
    x11.XDisplayWidth.restype = ctypes.c_int
    x11.XDisplayHeight.argtypes = [pointer, ctypes.c_int]
    x11.XDisplayHeight.restype = ctypes.c_int
    x11.XSync.argtypes = [pointer, ctypes.c_bool]
    x11.XCloseDisplay.argtypes = [pointer]
    xtest.XTestFakeMotionEvent.argtypes = [pointer, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeButtonEvent.argtypes = [pointer, ctypes.c_uint, ctypes.c_bool, ctypes.c_ulong]
    connection = x11.XOpenDisplay(display_name.encode("ascii"))
    if not connection:
        raise RuntimeError("native_display_unavailable")
    try:
        root, parent, children, count = window(), window(), ctypes.POINTER(window)(), ctypes.c_uint()
        if not x11.XQueryTree(connection, x11.XDefaultRootWindow(connection), ctypes.byref(root),
                              ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
            raise RuntimeError("native_window_inventory_failed")
        candidates = []
        try:
            for index in range(count.value):
                attributes = WindowAttributes()
                if not x11.XGetWindowAttributes(connection, children[index], ctypes.byref(attributes)):
                    continue
                if attributes.map_state != 2 or attributes.width <= 1 or attributes.height <= 1:
                    continue
                title = read_native_title(x11, connection, children[index])
                if native_window_matches(title, attributes.map_state, attributes.width, attributes.height):
                    candidates.append((children[index], attributes.width, attributes.height))
        finally:
            if children:
                x11.XFree(ctypes.cast(children, pointer))
        if len(candidates) != 1:
            raise RuntimeError("unique_native_new_tab_window_required")
        selected, width, height = candidates[0]
        origin_x, origin_y, child_window = ctypes.c_int(), ctypes.c_int(), window()
        if not x11.XTranslateCoordinates(connection, selected, x11.XDefaultRootWindow(connection), 0, 0,
                                          ctypes.byref(origin_x), ctypes.byref(origin_y), ctypes.byref(child_window)):
            raise RuntimeError("native_window_geometry_unavailable")
        if not (origin_x.value <= x < origin_x.value + width and origin_y.value <= y < origin_y.value + height):
            raise ValueError("native_restore_coordinate_outside_window")
        screen = x11.XDefaultScreen(connection)
        if x >= x11.XDisplayWidth(connection, screen) or y >= x11.XDisplayHeight(connection, screen):
            raise ValueError("native_restore_coordinate_outside_display")
        # The operator selected this point in the exact captured public
        # Restore bubble. Do not refocus/raise a window or synthesize a
        # keyboard shortcut: either could dismiss or target another surface.
        if not xtest.XTestFakeMotionEvent(connection, screen, x, y, 0):
            raise RuntimeError("native_pointer_move_failed")
        if not xtest.XTestFakeButtonEvent(connection, 1, True, 0):
            raise RuntimeError("native_pointer_press_failed")
        if not xtest.XTestFakeButtonEvent(connection, 1, False, 0):
            raise RuntimeError("native_pointer_release_failed")
        x11.XSync(connection, False)
    finally:
        x11.XCloseDisplay(connection)


if __name__ == "__main__":
    try:
        action, display = sys.argv[1], display_argument(sys.argv[2])
        if action == "capture" and len(sys.argv) == 4:
            capture(display, sys.argv[3])
        elif action == "restore" and len(sys.argv) == 5:
            if not re.fullmatch(r"[0-9]{1,4}", sys.argv[3]) or not re.fullmatch(r"[0-9]{1,4}", sys.argv[4]):
                raise ValueError("native_restore_coordinate_invalid")
            restore(display, int(sys.argv[3]), int(sys.argv[4]))
        else:
            raise ValueError("native_action_not_allowed")
    except Exception as error:
        # No traceback, path, title, display contents or exception text.
        sys.stderr.write(safe_error_code(error) + "\n")
        sys.exit(1)
