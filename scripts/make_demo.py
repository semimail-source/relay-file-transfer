from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
FRAME_DIR = ROOT / "docs" / "demo" / "frames"
OUT = ROOT / "docs" / "relay-demo.gif"
PREVIEW = ROOT / "docs" / "relay-demo-preview.png"

CAPTIONS = [
    ("HOME", "Send or receive from the same page.", "No second-level page is needed."),
    ("SEND", "Choose files. Add a short name.", "Optional verification is separate."),
    ("SHARE", "Share one thing: link, QR, or pickup code.", "A link or QR opens the receiver page directly."),
    ("CONFIRM", "The recipient confirms receipt.", "Only now does the 20-minute window begin."),
    ("RECEIVE", "Review the files, then start the transfer.", "Both browsers stay online while files move."),
    ("DONE", "Original files arrive. Relay stores nothing.", "The sender sees that the transfer completed."),
]

FRAME_NAMES = [
    "01-home.png",
    "02-selected.png",
    "03-share.png",
    "04-confirm.png",
    "05-review.png",
    "06-arrived.png",
]

WIDTH = 960
SCREEN_HEIGHT = 540
BAR_HEIGHT = 108
BACKGROUND = "#0b0b0b"
PRIMARY = "#f7f7f7"
SECONDARY = "#a1a1aa"
MUTED = "#52525b"


def load_font(size: int, mono: bool = False) -> ImageFont.FreeTypeFont:
    names = (
        [
            "/System/Library/Fonts/SFNSMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ]
        if mono
        else [
            "/System/Library/Fonts/SFNS.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    )
    for name in names:
        path = Path(name)
        if path.exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


FONT_MAIN = load_font(24)
FONT_DETAIL = load_font(16)
FONT_META = load_font(15, mono=True)


def make_frame(index: int) -> Image.Image:
    screen = Image.open(FRAME_DIR / FRAME_NAMES[index]).convert("RGB")
    screen = screen.resize((WIDTH, SCREEN_HEIGHT), Image.Resampling.LANCZOS)

    frame = Image.new("RGB", (WIDTH, SCREEN_HEIGHT + BAR_HEIGHT), BACKGROUND)
    frame.paste(screen, (0, 0))
    draw = ImageDraw.Draw(frame)

    segment_gap = 5
    segment_width = (WIDTH - 56 - segment_gap * 5) / 6
    for segment in range(6):
        x1 = 28 + segment * (segment_width + segment_gap)
        color = PRIMARY if segment == index else (SECONDARY if segment < index else MUTED)
        draw.rounded_rectangle(
            (x1, SCREEN_HEIGHT + 12, x1 + segment_width, SCREEN_HEIGHT + 14),
            radius=1,
            fill=color,
        )

    label, title, detail = CAPTIONS[index]
    draw.text((28, SCREEN_HEIGHT + 30), f"[{index + 1:02d}/06] {label}", font=FONT_META, fill=SECONDARY)
    draw.text((166, SCREEN_HEIGHT + 25), title, font=FONT_MAIN, fill=PRIMARY)
    draw.text((166, SCREEN_HEIGHT + 62), detail, font=FONT_DETAIL, fill=SECONDARY)
    draw.text((789, SCREEN_HEIGHT + 70), "relay.xueai.pro", font=FONT_META, fill=SECONDARY)
    return frame


base_frames = [make_frame(index) for index in range(len(FRAME_NAMES))]
durations = [1700, 1900, 2400, 2100, 2100, 2600]

frames: list[Image.Image] = []
frame_durations: list[int] = []
for index, frame in enumerate(base_frames):
    frames.append(frame)
    frame_durations.append(durations[index])
    if index < len(base_frames) - 1:
        for alpha in (0.34, 0.67):
            frames.append(Image.blend(frame, base_frames[index + 1], alpha))
            frame_durations.append(90)

palette_frames = [
    frame.quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    for frame in frames
]
palette_frames[0].save(
    OUT,
    save_all=True,
    append_images=palette_frames[1:],
    duration=frame_durations,
    loop=0,
    optimize=True,
    disposal=1,
)
base_frames[2].save(PREVIEW, optimize=True)

print(f"Created {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")
print(f"Created {PREVIEW}")
