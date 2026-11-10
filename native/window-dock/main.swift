import AppKit
import ApplicationServices
import Foundation

// JSON lines over stdio. Requests: {"id"?, "type", ...}. Replies: {"id", "type":"result", ...}. Events: {"type":"closed","pid"}.

setvbuf(stdout, nil, _IOLBF, 0)

let output = DispatchQueue(label: "window-dock.output")
func emit(_ object: [String: Any]) {
  output.sync {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
      let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
  }
}

func axWindow(pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.4)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
    let windows = value as? [AXUIElement]
  else { return nil }
  return windows.first
}

func frame(of element: AXUIElement) -> CGRect? {
  var p: CFTypeRef?
  var s: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &p) == .success,
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &s) == .success
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}

func setFrame(_ window: AXUIElement, _ rect: CGRect) {
  var origin = rect.origin
  var size = rect.size
  if let p = AXValueCreate(.cgPoint, &origin) {
    AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, p)
  }
  if let s = AXValueCreate(.cgSize, &size) {
    AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, s)
  }
}

// Distance from the window top to the page area, when Chrome exposes its accessibility tree.
func contentTop(of window: AXUIElement, windowFrame: CGRect) -> Double? {
  var queue: [(AXUIElement, Int)] = [(window, 0)]
  var visited = 0
  while !queue.isEmpty && visited < 400 {
    let (element, depth) = queue.removeFirst()
    visited += 1
    var role: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
      (role as? String) == "AXWebArea", let f = frame(of: element)
    {
      return Double(f.minY - windowFrame.minY)
    }
    if depth >= 8 { continue }
    var children: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
      let list = children as? [AXUIElement]
    {
      for child in list { queue.append((child, depth + 1)) }
    }
  }
  return nil
}

func rectJSON(_ r: CGRect) -> [String: Double] {
  ["x": Double(r.minX), "y": Double(r.minY), "width": Double(r.width), "height": Double(r.height)]
}

var watched: [pid_t: Bool] = [:]
let watchLock = NSLock()

func startWatching(pid: pid_t) {
  watchLock.lock()
  if watched[pid] != nil {
    watchLock.unlock()
    return
  }
  watched[pid] = true
  watchLock.unlock()
  DispatchQueue.global().async {
    var misses = 0
    while true {
      usleep(400_000)
      watchLock.lock()
      let active = watched[pid] != nil
      watchLock.unlock()
      if !active { return }
      let alive = kill(pid, 0) == 0
      let hasWindow = alive && axWindow(pid: pid) != nil
      misses = hasWindow ? 0 : misses + 1
      if misses >= 3 {
        watchLock.lock()
        watched[pid] = nil
        watchLock.unlock()
        emit(["type": "closed", "pid": Int(pid)])
        return
      }
    }
  }
}

func handle(_ request: [String: Any]) {
  let id = request["id"]
  func reply(_ fields: [String: Any]) {
    var message = fields
    message["type"] = "result"
    if let id { message["id"] = id }
    emit(message)
  }
  let pid = (request["pid"] as? Int).map { pid_t($0) }
  switch request["type"] as? String {
  case "check":
    if request["prompt"] as? Bool == true {
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      reply(["trusted": AXIsProcessTrustedWithOptions(options)])
    } else {
      reply(["trusted": AXIsProcessTrusted()])
    }
  case "find":
    guard let pid else { return reply(["found": false]) }
    guard AXIsProcessTrusted() else { return reply(["found": false, "reason": "untrusted"]) }
    guard let window = axWindow(pid: pid), let f = frame(of: window) else {
      return reply(["found": false])
    }
    var message: [String: Any] = ["found": true, "frame": rectJSON(f)]
    if let top = contentTop(of: window, windowFrame: f) { message["contentTop"] = top }
    reply(message)
  case "watch":
    if let pid { startWatching(pid: pid) }
  case "unwatch":
    if let pid {
      watchLock.lock()
      watched[pid] = nil
      watchLock.unlock()
    }
  case "setFrame":
    guard let pid, let window = axWindow(pid: pid),
      let x = request["x"] as? Double, let y = request["y"] as? Double,
      let w = request["width"] as? Double, let h = request["height"] as? Double
    else { return }
    setFrame(window, CGRect(x: x, y: y, width: w, height: h))
  case "minimize":
    guard let pid, let window = axWindow(pid: pid), let minimized = request["minimized"] as? Bool
    else { return }
    AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, minimized as CFBoolean)
  case "raise":
    guard let pid, let window = axWindow(pid: pid) else { return }
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  default:
    reply(["error": "unknown command"])
  }
}

// Commands run serially on one queue so a frame is never applied after a later raise.
let work = DispatchQueue(label: "window-dock.work")
DispatchQueue.global().async {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
      let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { continue }
    work.async { handle(request) }
  }
  work.async { exit(0) }
}
dispatchMain()
