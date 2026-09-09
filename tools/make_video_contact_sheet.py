from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


SOURCE = Path(r"C:\Users\A\Downloads\【边狱巴士】9.5-25 金笠 樱桃 林庆业战斗动画.mp4")
OUT_DIR = Path(r"D:\Users\A\AppData\Local\FoundryVTT\Data\systems\limbusCompany_FVTT\output\slash_effect")
OUT_DIR.mkdir(parents=True, exist_ok=True)

cap = cv2.VideoCapture(str(SOURCE))
fps = cap.get(cv2.CAP_PROP_FPS)
frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
duration = frames / fps

times = np.linspace(0, duration - 0.1, 60)
thumbs = []
font = ImageFont.load_default()
for timestamp in times:
    cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000)
    ok, frame = cap.read()
    if not ok:
        continue
    frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    image = Image.fromarray(frame).resize((320, 180), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image)
    label = f"{timestamp:05.1f}s"
    draw.rectangle((0, 0, 57, 16), fill=(0, 0, 0))
    draw.text((3, 2), label, fill=(255, 255, 255), font=font)
    thumbs.append(image)
cap.release()

cols = 5
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new("RGB", (cols * 320, rows * 180), (30, 30, 30))
for index, thumb in enumerate(thumbs):
    sheet.paste(thumb, ((index % cols) * 320, (index // cols) * 180))
sheet.save(OUT_DIR / "contact_sheet.jpg", quality=92)
print(OUT_DIR / "contact_sheet.jpg")
