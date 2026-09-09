from pathlib import Path
import argparse
import subprocess
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg


SOURCE = Path(r"C:\Users\A\Downloads\【边狱巴士】9.5-25 金笠 樱桃 林庆业战斗动画.mp4")
OUT_DIR = Path(r"D:\Users\A\AppData\Local\FoundryVTT\Data\systems\limbusCompany_FVTT\output\slash_effect")


def estimate_background(frame: np.ndarray) -> np.ndarray:
    """Estimate the flat stage colour from low-detail border samples."""
    h, w = frame.shape[:2]
    strips = np.concatenate(
        [
            frame[int(h * 0.14):int(h * 0.82):24, 8:int(w * 0.12):24].reshape(-1, 3),
            frame[int(h * 0.14):int(h * 0.82):24, int(w * 0.88):w - 8:24].reshape(-1, 3),
            frame[int(h * 0.12):int(h * 0.28):24, int(w * 0.2):int(w * 0.8):24].reshape(-1, 3),
        ],
        axis=0,
    )
    return np.median(strips, axis=0).astype(np.float32)


def clean_components(mask: np.ndarray, strict: bool = False) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = np.zeros_like(mask)
    for label in range(1, n):
        x, y, w, h, area = stats[label]
        longest = max(w, h)
        shortest = max(1, min(w, h))
        aspect = longest / shortest
        keep = area >= 55 and (longest >= 28 or area >= 180)
        if strict:
            keep = area >= 90 and longest >= 36 and (aspect >= 1.65 or area >= 850)
        if keep:
            out[labels == label] = 255
    return out


def effect_layer(frame: np.ndarray, strict: bool = False) -> tuple[np.ndarray, np.ndarray]:
    h, w = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.float32)
    val = hsv[:, :, 2].astype(np.float32)
    bg = estimate_background(frame)
    bg_val = float(np.max(bg))
    diff = np.linalg.norm(frame.astype(np.float32) - bg[None, None, :], axis=2)

    # Saturated energy colours, pale cyan/blue rims, and hot white cores.
    coloured = (sat > 58) & (diff > 42) & (val > 58)
    pale_energy = (sat > 22) & (diff > 32) & (val > max(125.0, bg_val + 14.0))
    white_core = (sat < 72) & (diff > 52) & (val > max(188.0, bg_val + 38.0))
    mask = ((coloured | pale_energy | white_core) * 255).astype(np.uint8)

    if strict:
        # Skin in the source is moderately saturated warm red/orange. True red
        # slash energy is substantially more saturated and survives this cut.
        blue = frame[:, :, 0].astype(np.float32)
        green = frame[:, :, 1].astype(np.float32)
        red = frame[:, :, 2].astype(np.float32)
        warm_skin = (
            (hsv[:, :, 0] < 23)
            & (sat > 24)
            & (sat < 183)
            & (val < 246)
            & (red > blue + 12)
            & (red > green * 1.035)
        )
        mask[warm_skin] = 0

    # Remove source watermark/title zones and thin border artefacts.
    mask[: max(62, int(h * 0.10)), :] = 0
    mask[:, :4] = 0
    mask[:, -4:] = 0
    mask[-8:, :] = 0

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    mask = clean_components(mask, strict=strict)
    mask = cv2.dilate(mask, kernel, iterations=1)

    # Feathered core plus a restrained two-scale glow.
    core = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), 0.8)
    glow_near = cv2.GaussianBlur(core, (0, 0), 4.0) * 0.42
    glow_far = cv2.GaussianBlur(core, (0, 0), 12.0) * 0.16
    alpha = np.clip(np.maximum(core, glow_near + glow_far), 0.0, 1.0)

    # Lightly lift colour and whites without changing the original blade palette.
    effect = frame.astype(np.float32)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    effect = gray[:, :, None] + (effect - gray[:, :, None]) * 1.18
    effect = np.clip(effect * 1.06 + 3.0, 0, 255)
    return effect, alpha


def effect_strip(frame: np.ndarray, width: int, strict: bool = False) -> tuple[np.ndarray, np.ndarray]:
    h, w = frame.shape[:2]
    scale = width / w
    resized_h = max(1, int(round(h * scale)))
    frame = cv2.resize(frame, (width, resized_h), interpolation=cv2.INTER_AREA)
    effect, alpha = effect_layer(frame, strict=strict)
    bg_value = 142.0
    if float(np.mean(alpha > 0.2)) > 0.22:
        alpha *= 0.0
    comp = np.full_like(effect, bg_value)
    comp = comp * (1.0 - alpha[:, :, None]) + effect * alpha[:, :, None]
    return comp.astype(np.uint8), alpha


def composite_square(frame: np.ndarray, size: int = 1024) -> np.ndarray:
    comp, alpha = effect_strip(frame, size, strict=False)
    resized_h = comp.shape[0]
    bg_value = 142.0
    canvas = np.full((size, size, 3), int(bg_value), dtype=np.uint8)
    y = (size - resized_h) // 2
    canvas[y:y + resized_h] = comp
    return canvas


def stable_square(
    frame: np.ndarray,
    size: int,
    tracked_shift: np.ndarray,
    blank_frames: int,
) -> tuple[np.ndarray, np.ndarray, int]:
    # A smaller strip provides room for stabilization without clipping wide arcs.
    strip_width = int(round(size * 0.86))
    comp, alpha = effect_strip(frame, strip_width, strict=True)
    h, w = comp.shape[:2]
    base_x = (size - w) // 2
    base_y = (size - h) // 2

    ys, xs = np.where(alpha > 0.22)
    enough_effect = len(xs) >= 80
    if enough_effect:
        weights = np.square(alpha[ys, xs]).astype(np.float64)
        cx = float(np.average(xs, weights=weights))
        cy = float(np.average(ys, weights=weights))
        desired = np.array(
            [size * 0.5 - (base_x + cx), size * 0.5 - (base_y + cy)],
            dtype=np.float32,
        )
        desired[0] = np.clip(desired[0], -64.0, 64.0)
        desired[1] = np.clip(desired[1], -48.0, 48.0)
        if blank_frames > 12:
            tracked_shift = desired
        else:
            delta = np.clip(desired - tracked_shift, -3.2, 3.2)
            tracked_shift = tracked_shift + delta * 0.72
        blank_frames = 0
    else:
        blank_frames += 1

    x = int(round(base_x + tracked_shift[0]))
    y = int(round(base_y + tracked_shift[1]))
    canvas = np.full((size, size, 3), 142, dtype=np.uint8)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(size, x + w), min(size, y + h)
    if x1 > x0 and y1 > y0:
        canvas[y0:y1, x0:x1] = comp[y0 - y:y1 - y, x0 - x:x1 - x]
    return canvas, tracked_shift, blank_frames


def render(size: int = 1024) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUT_DIR / "刀光提取_灰底_方形_1024.mp4"
    cap = cv2.VideoCapture(str(SOURCE))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-y",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "bgr24",
        "-s", f"{size}x{size}",
        "-r", f"{fps:.6f}",
        "-i", "-",
        "-an",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        square = composite_square(frame, size)
        process.stdin.write(square.tobytes())
        index += 1
        if index % 300 == 0:
            print(f"processed {index}/{total}", flush=True)
    cap.release()
    process.stdin.close()
    status = process.wait()
    if status != 0:
        raise RuntimeError(f"ffmpeg exited with status {status}")
    print(output)


def render_stable(size: int = 1024) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUT_DIR / "刀光提取_灰底_方形_稳定净化版_1024.mp4"
    cap = cv2.VideoCapture(str(SOURCE))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{size}x{size}", "-r", f"{fps:.6f}", "-i", "-", "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    tracked_shift = np.zeros(2, dtype=np.float32)
    blank_frames = 999
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        square, tracked_shift, blank_frames = stable_square(
            frame, size, tracked_shift, blank_frames
        )
        process.stdin.write(square.tobytes())
        index += 1
        if index % 300 == 0:
            print(f"processed {index}/{total}", flush=True)
    cap.release()
    process.stdin.close()
    status = process.wait()
    if status != 0:
        raise RuntimeError(f"ffmpeg exited with status {status}")
    print(output)


def preview(stable: bool = False) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(SOURCE))
    times = [1.7, 3.4, 8.6, 15.5, 20.7, 32.7, 41.4, 50.0, 56.9, 62.0, 70.6, 72.4, 75.8, 79.3, 84.4, 89.6, 91.3, 93.1]
    thumbs = []
    font = ImageFont.load_default()
    for timestamp in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        if stable:
            square, _, _ = stable_square(
                frame, 512, np.zeros(2, dtype=np.float32), 999
            )
        else:
            square = composite_square(frame, 512)
        image = Image.fromarray(cv2.cvtColor(square, cv2.COLOR_BGR2RGB)).resize((256, 256), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 55, 16), fill=(0, 0, 0))
        draw.text((3, 2), f"{timestamp:04.1f}s", fill=(255, 255, 255), font=font)
        thumbs.append(image)
    cap.release()

    cols = 6
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 256, rows * 256), (142, 142, 142))
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % cols) * 256, (index // cols) * 256))
    path = OUT_DIR / ("effect_preview_stable.jpg" if stable else "effect_preview.jpg")
    sheet.save(path, quality=94)
    print(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["preview", "preview_stable", "render", "stable"], default="preview", nargs="?")
    args = parser.parse_args()
    if args.mode == "preview":
        preview()
    elif args.mode == "preview_stable":
        preview(stable=True)
    elif args.mode == "render":
        render()
    else:
        render_stable()
