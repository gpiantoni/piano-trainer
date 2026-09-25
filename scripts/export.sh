#!/usr/bin/env bash
# Export a MuseScore file to PDF, MIDI, and MusicXML (into ./export/),
# and print its title, subtitle, composer, and default tempo.
# The MusicXML has its repeats unrolled (written out in playing order) for
# piano-trainer; the PDF and MIDI keep them as written.
#
# Usage: ./export.sh "Song Name"        (".mscz" extension optional)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <filename>[.mscz]" >&2
  exit 1
fi

name="$1"
name="${name%.mscz}"          # strip extension if given
src="${name}.mscz"

if [[ ! -f "$src" ]]; then
  echo "Error: '$src' not found in $DIR" >&2
  exit 1
fi

mkdir -p export

for ext in pdf mid; do
  mscore -o "export/${name}.${ext}" "$src" >/dev/null
done
mscore --unroll-repeats -o "export/${name}.musicxml" "$src" >/dev/null

echo "Exported to export/${name}.{pdf,mid,musicxml}"
if python3 - "$src" <<'EOF'
import re, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
mscx = z.read(next(n for n in z.namelist() if n.endswith(".mscx"))).decode("utf-8")
sys.exit(0 if re.search(r"<(startRepeat|endRepeat|Volta|Jump|Marker)\b", mscx) else 1)
EOF
then
  bars=$(grep -o '<measure number="[^"]*"' "export/${name}.musicxml" | sort -u | wc -l)
  echo "Repeats unrolled in the MusicXML: ${bars} bars in playing order"
fi
echo
python3 "$DIR/mscz_info.py" "$src"
