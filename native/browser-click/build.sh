#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app=$1
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$source_dir/Info.plist" "$app/Contents/Info.plist"
if [ "$#" -gt 1 ]; then
  swiftc -O -target "$2" "$source_dir/main.swift" -o "$app/Contents/MacOS/notify"
else
  swiftc -O "$source_dir/main.swift" -o "$app/Contents/MacOS/notify"
fi
swift "$source_dir/icon.swift" "$app/Contents/Resources/AppIcon.iconset"
iconutil -c icns "$app/Contents/Resources/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
rm -r "$app/Contents/Resources/AppIcon.iconset"
