#!/usr/bin/env bash
# Export a MuseScore file to PDF, MIDI, and MusicXML (into export/ next to the
# score), and print its title, subtitle, composer, and default tempo.
# The MusicXML has its repeats unrolled (written out in playing order) for
# piano-trainer; the PDF and MIDI keep them as written.
#
# Usage: export.sh "path/to/Song Name"   (".mscz" extension optional)
#
# The score folder can hold a symlink to this script, so that
# ./export.sh "Song Name" works there.

set -euo pipefail

# The real location, through a symlink: mscz_info.py sits next to it.
SCRIPTS="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path/to/score>[.mscz]" >&2
  exit 1
fi

src="${1%.mscz}.mscz"         # extension optional
name="$(basename -- "$src" .mscz)"
out="$(dirname -- "$src")/export"

if [[ ! -f "$src" ]]; then
  echo "Error: '$src' not found" >&2
  exit 1
fi

mkdir -p "$out"

for ext in pdf mid; do
  mscore -o "${out}/${name}.${ext}" "$src" >/dev/null
done
mscore --unroll-repeats -o "${out}/${name}.musicxml" "$src" >/dev/null

echo "Exported to ${out}/${name}.{pdf,mid,musicxml}"
if python3 - "$src" <<'EOF'
import re, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
mscx = z.read(next(n for n in z.namelist() if n.endswith(".mscx"))).decode("utf-8")
sys.exit(0 if re.search(r"<(startRepeat|endRepeat|Volta|Jump|Marker)\b", mscx) else 1)
EOF
then
  bars=$(grep -o '<measure number="[^"]*"' "${out}/${name}.musicxml" | sort -u | wc -l)
  echo "Repeats unrolled in the MusicXML: ${bars} bars in playing order"
fi
echo
python3 "$SCRIPTS/mscz_info.py" "$src"
