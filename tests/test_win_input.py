import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="somente Windows")


@pytest.mark.parametrize("origin,size", [(0, 1920), (0, 1080), (-1920, 3840), (0, 2560), (0, 1366), (-1280, 4480)])
def test_absolute_mapping_is_exact(origin, size):
    from deslizae.win_input import to_absolute

    # O Windows converte de volta com: pixel = norm * size / 65536 (truncado).
    for pixel in range(origin, origin + size):
        norm = to_absolute(pixel, origin, size)
        assert 0 <= norm <= 65535
        assert origin + (norm * size) // 65536 == pixel


def test_input_struct_size():
    import ctypes

    from deslizae.win_input import INPUT

    assert ctypes.sizeof(INPUT) == (40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28)
