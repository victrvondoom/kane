"""Simulate colour vision on screenshots without changing the game."""
import io

import numpy as np
from PIL import Image


MODES = ("normal", "deuteranopia", "protanopia", "tritanopia", "low-contrast")
REPORT_NOTE = ('\nReport anything on screen you cannot tell apart (two things that look the same)'
               ' with report_bug as a normal report whose title starts "Hard to see:".')

# Machado, Oliveira and Fernandes (2009), A Physiologically-based Model for
# Simulation of Color Vision Deficiency, IEEE TVCG 15(6), 1291 to 1298.
# Published severity 1.0 matrices, applied to column vectors in linear RGB:
# https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
# The rows below are the published matrix values, without interpolation.
MATRICES = {
    "deuteranopia": ((0.367322, 0.860646, -0.227968),
                     (0.280085, 0.672501, 0.047413),
                     (-0.011820, 0.042940, 0.968881)),
    "protanopia": ((0.152286, 1.052583, -0.204868),
                   (0.114503, 0.786281, 0.099216),
                   (-0.003882, -0.048116, 1.051998)),
    "tritanopia": ((1.255528, -0.076749, -0.178779),
                   (-0.078411, 0.930809, 0.147602),
                   (0.004733, 0.691367, 0.303900)),
}


def srgb_to_linear(rgb):
    """Decode sRGB values in the range 0 to 1 using the sRGB transfer curve."""
    rgb = np.asarray(rgb, dtype=float)
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def filter_screenshot(data, mode="normal"):
    """Return original bytes for normal, or a filtered JPEG for another mode.

    Low contrast blends 60 percent toward sRGB mid grey (128, 128, 128).
    JPEG uses quality 100 and no chroma subsampling to limit colour loss.
    """
    if mode not in MODES:
        raise ValueError("Unknown vision mode: " + str(mode))
    if mode == "normal":
        return data
    with Image.open(io.BytesIO(data)) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=float) / 255
    if mode == "low-contrast":
        rgb = rgb * 0.4 + (128 / 255) * 0.6
    else:
        linear = np.clip(srgb_to_linear(rgb) @ np.asarray(MATRICES[mode]).T, 0, 1)
        rgb = np.where(linear <= 0.0031308, linear * 12.92,
                       1.055 * linear ** (1 / 2.4) - 0.055)
    pixels = np.rint(np.clip(rgb, 0, 1) * 255).astype(np.uint8)
    output = io.BytesIO()
    Image.fromarray(pixels).save(output, format="JPEG", quality=100, subsampling=0)
    return output.getvalue()
