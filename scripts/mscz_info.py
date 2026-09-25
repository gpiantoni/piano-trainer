#!/usr/bin/env python3
"""Print title, subtitle, composer, and default tempo from a .mscz file."""
import sys
import re
import zipfile


def main():
    if len(sys.argv) != 2:
        print("Usage: mscz_info.py <file.mscz>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    with zipfile.ZipFile(path) as z:
        mscx_name = next(n for n in z.namelist() if n.endswith(".mscx"))
        data = z.read(mscx_name).decode("utf-8")

    def meta(tag):
        m = re.search(rf'<metaTag name="{tag}">(.*?)</metaTag>', data)
        return m.group(1).strip() if m and m.group(1).strip() else None

    title = meta("workTitle")
    subtitle = meta("subtitle")
    composer = meta("composer")

    tempo_match = re.search(r"<Tempo>.*?</Tempo>", data, re.S)
    tempo = None
    if tempo_match:
        block = tempo_match.group()
        bpm_match = re.search(r"=\s*(\d+)", block)
        if bpm_match:
            tempo = f"{bpm_match.group(1)} BPM"
        else:
            val_match = re.search(r"<tempo>([\d.]+)</tempo>", block)
            if val_match:
                tempo = f"{round(float(val_match.group(1)) * 60)} BPM"

    print(f"Title:    {title or '(none)'}")
    print(f"Subtitle: {subtitle or '(none)'}")
    print(f"Composer: {composer or '(none)'}")
    print(f"Tempo:    {tempo or '(none)'}")


if __name__ == "__main__":
    main()
