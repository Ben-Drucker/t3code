import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import UserNotifications

@_silgen_name("_AXUIElementGetWindow")
func windowID(_ element: AXUIElement, _ result: UnsafeMutablePointer<CGWindowID>) -> AXError

struct Window: Equatable, Codable { let id: CGWindowID; let pid: pid_t }
struct Point: Codable { let x: Double; let y: Double }
struct RestoreInput: Codable { let before: [Window]; let after: [Window]; let cursor: Point }
struct RestoreOutput: Codable { let windows: [Window]; let cursor: Point }
func restorePlan(_ before: [Window], _ after: [Window]) -> [Window] {
  let wanted = before.filter { after.contains($0) }
  let current = after.filter { wanted.contains($0) }
  guard let last = wanted.indices.last(where: { wanted[$0] != current[$0] }) else { return [] }
  return Array(wanted[0...last].reversed())
}
func windows() -> [Window] {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return list.compactMap { item in
    guard item[kCGWindowLayer as String] as? Int == 0,
      let id = item[kCGWindowNumber as String] as? UInt32,
      let pid = item[kCGWindowOwnerPID as String] as? Int32 else { return nil }
    return Window(id: id, pid: pid)
  }
}
func raise(_ target: Window) -> Bool {
  let app = AXUIElementCreateApplication(target.pid)
  AXUIElementSetMessagingTimeout(app, 0.4)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
    let list = value as? [AXUIElement] else { return false }
  for element in list {
    var id: CGWindowID = 0
    if windowID(element, &id) == .success && id == target.id {
      return AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success
    }
  }
  return false
}
func mouse(_ type: CGEventType, _ point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func fail() -> Never { print("failed"); exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail() }
if command == "plan" {
  guard args.count == 2, let data = args[1].data(using: .utf8),
    let input = try? JSONDecoder().decode(RestoreInput.self, from: data),
    let output = try? JSONEncoder().encode(RestoreOutput(windows: restorePlan(input.before, input.after), cursor: input.cursor)),
    let text = String(data: output, encoding: .utf8) else { fail() }
  print(text)
} else if command == "click" {
  guard args.count == 4, let pid = Int32(args[1]), pid > 0,
    let x = Double(args[2]), let y = Double(args[3]), x.isFinite, y.isFinite,
    AXIsProcessTrusted(), let browser = NSRunningApplication(processIdentifier: pid),
    browser.bundleIdentifier == "org.mozilla.firefox" || browser.bundleIdentifier == "org.mozilla.nightly",
    let previous = NSWorkspace.shared.frontmostApplication,
    let cursor = CGEvent(source: nil)?.location else { fail() }
  let before = windows()
  let point = CGPoint(x: x, y: y)
  var restored = true
  var clicked = false
  do {
    defer {
      mouse(.mouseMoved, cursor)
      if !previous.activate(options: [.activateIgnoringOtherApps]) { restored = false }
      usleep(100_000)
      let after = windows()
      let wanted = before.filter { after.contains($0) }
      for window in restorePlan(before, after) {
          if !raise(window) { restored = false }
          usleep(40_000)
      }
      mouse(.mouseMoved, cursor)
      if CGEvent(source: nil)?.location != cursor { restored = false }
      if NSWorkspace.shared.frontmostApplication?.processIdentifier != previous.processIdentifier { restored = false }
      let final = windows().filter { wanted.contains($0) }
      if final != wanted { restored = false }
    }
    let activated = browser.activate(options: [.activateIgnoringOtherApps])
    usleep(150_000)
    if activated && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
      for index in 1...12 {
      let t = Double(index) / 12
      let eased = t * t * (3 - 2 * t)
      mouse(.mouseMoved, CGPoint(x: cursor.x + (point.x - cursor.x) * eased, y: cursor.y + (point.y - cursor.y) * eased))
      usleep(12_000)
      }
      mouse(.leftMouseDown, point)
      usleep(70_000)
      mouse(.leftMouseUp, point)
      clicked = true
    }
  }
  guard restored && clicked else { fail() }
  print("restored")
} else {
  guard (command == "post" && args.count == 4) || (command == "remove" && args.count == 2),
    args[1].range(of: "^[a-zA-Z0-9-]{1,128}$", options: .regularExpression) != nil else { fail() }
  let center = UNUserNotificationCenter.current()
  let done = DispatchSemaphore(value: 0)
  var success = false
  if command == "post" {
    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
      guard granted && error == nil else { done.signal(); return }
      let content = UNMutableNotificationContent()
      content.title = args[2]
      content.body = args[3]
      content.interruptionLevel = .timeSensitive
      center.add(UNNotificationRequest(identifier: args[1], content: content, trigger: nil)) { error in
        success = error == nil
        done.signal()
      }
    }
  } else {
    center.removeDeliveredNotifications(withIdentifiers: [args[1]])
    center.removePendingNotificationRequests(withIdentifiers: [args[1]])
    center.getDeliveredNotifications { notifications in
      success = !notifications.contains { $0.request.identifier == args[1] }
      done.signal()
    }
  }
  guard done.wait(timeout: .now() + 10) == .success && success else { fail() }
  print(command == "post" ? "posted" : "removed")
}
