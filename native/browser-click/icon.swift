import AppKit

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let dir = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
func png(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let r = NSRect(x: 0, y: 0, width: px, height: px).insetBy(dx: CGFloat(px) * 0.06, dy: CGFloat(px) * 0.06)
  let path = NSBezierPath(roundedRect: r, xRadius: CGFloat(px) * 0.22, yRadius: CGFloat(px) * 0.22)
  NSGradient(starting: NSColor(red: 0.98, green: 0.55, blue: 0.13, alpha: 1), ending: NSColor(red: 0.93, green: 0.30, blue: 0.10, alpha: 1))!.draw(in: path, angle: -90)
  if let sym = NSImage(systemSymbolName: "cursorarrow.click.2", accessibilityDescription: nil)?
    .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: CGFloat(px) * 0.5, weight: .semibold).applying(.init(paletteColors: [.white]))) {
    let s = sym.size
    sym.draw(in: NSRect(x: (CGFloat(px) - s.width) / 2, y: (CGFloat(px) - s.height) / 2, width: s.width, height: s.height))
  }
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}
for s in sizes {
  try! png(s).write(to: URL(fileURLWithPath: "\(dir)/icon_\(s)x\(s).png"))
  if s <= 512 { try! png(s * 2).write(to: URL(fileURLWithPath: "\(dir)/icon_\(s)x\(s)@2x.png")) }
}
