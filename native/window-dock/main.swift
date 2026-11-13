import AppKit
import ApplicationServices
import Foundation

// JSON lines over stdio.
// Requests: {"id"?, "type", "pid"?, "windowId"?, ...}.
// Replies: {"id", "type":"result", ...}.
// Events: {"type":"closed","pid","windowId"}, {"type":"frameChanged","pid","windowId","frame"}.

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

struct OwnedWindowEntry {
  let pid: pid_t
  let element: AXUIElement
}

var nextWindowId = 1
var knownWindows: [Int: OwnedWindowEntry] = [:]
let selectionLock = NSLock()

func registerWindow(pid: pid_t, element: AXUIElement) -> Int {
  selectionLock.lock()
  defer { selectionLock.unlock() }
  for (id, entry) in knownWindows where entry.pid == pid && CFEqual(entry.element, element) {
    return id
  }
  let id = nextWindowId
  nextWindowId += 1
  knownWindows[id] = OwnedWindowEntry(pid: pid, element: element)
  return id
}

func appWindows(pid: pid_t) -> [AXUIElement] {
  guard kill(pid, 0) == 0 else { return [] }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.4)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
    let windows = value as? [AXUIElement]
  else { return [] }
  return windows.filter { element in
    var ownerPid: pid_t = 0
    return AXUIElementGetPid(element, &ownerPid) == .success && ownerPid == pid
  }
}

// Resolves ONLY the exact (pid, windowId) previously discovered for that process; never falls back
// to frontmost/focused windows, app names, or other windows of the same process.
func ownedWindow(pid: pid_t, windowId: Int) -> AXUIElement? {
  selectionLock.lock()
  let entry = knownWindows[windowId]
  selectionLock.unlock()
  guard let entry, entry.pid == pid else { return nil }
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(entry.element, &ownerPid) == .success, ownerPid == pid else { return nil }
  let liveWindows = appWindows(pid: pid)
  guard liveWindows.contains(where: { CFEqual($0, entry.element) }) else { return nil }
  return entry.element
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

func boolAttr(_ element: AXUIElement, _ attr: String) -> Bool {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else {
    return false
  }
  return (value as? Bool) == true
}

func stringAttr(_ element: AXUIElement, _ attr: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr as CFString, &value) == .success else {
    return nil
  }
  return value as? String
}

// Size -> Position -> Size avoids macOS clamping size against the old position (when shrinking and
// moving toward the right edge) or position against the old size (when widening).
func setFrame(_ window: AXUIElement, _ rect: CGRect) {
  var origin = rect.origin
  var size = rect.size
  let sizeVal = AXValueCreate(.cgSize, &size)
  let posVal = AXValueCreate(.cgPoint, &origin)
  if let sizeVal { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeVal) }
  if let posVal { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, posVal) }
  if let sizeVal { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeVal) }
}

// Distance from the window top to the page area, when the browser exposes its accessibility tree.
func contentTop(of window: AXUIElement, windowFrame: CGRect) -> Double? {
  var queue: [(AXUIElement, Int)] = [(window, 0)]
  var visited = 0
  while !queue.isEmpty && visited < 400 {
    let (element, depth) = queue.removeFirst()
    visited += 1
    if stringAttr(element, kAXRoleAttribute as String) == "AXWebArea", let f = frame(of: element) {
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

func candidateWindows(pid: pid_t) -> (windows: [[String: Any]], firstElement: AXUIElement?, firstFrame: CGRect?) {
  var list: [[String: Any]] = []
  var firstElement: AXUIElement?
  var firstFrame: CGRect?
  for element in appWindows(pid: pid) {
    guard stringAttr(element, kAXRoleAttribute as String) == "AXWindow" else { continue }
    let subrole = stringAttr(element, kAXSubroleAttribute as String)
    let standard = subrole == (kAXStandardWindowSubrole as String)
    let minimized = boolAttr(element, kAXMinimizedAttribute as String)
    guard let f = frame(of: element) else { continue }
    let wid = registerWindow(pid: pid, element: element)
    if standard && firstElement == nil {
      firstElement = element
      firstFrame = f
    }
    list.append([
      "windowId": wid,
      "pid": Int(pid),
      "standard": standard,
      "minimized": minimized,
      "frame": rectJSON(f),
    ])
  }
  return (list, firstElement, firstFrame)
}

struct WatchKey: Hashable {
  let pid: pid_t
  let windowId: Int
}

var watched: [WatchKey: UUID] = [:]
let watchLock = NSLock()

func startWatching(pid: pid_t, windowId: Int) {
  let key = WatchKey(pid: pid, windowId: windowId)
  watchLock.lock()
  if watched[key] != nil {
    watchLock.unlock()
    return
  }
  let token = UUID()
  watched[key] = token
  watchLock.unlock()
  DispatchQueue.global().async {
    var misses = 0
    var lastFrame: CGRect?
    while true {
      usleep(400_000)
      watchLock.lock()
      let active = watched[key] == token
      watchLock.unlock()
      if !active { return }
      if let window = ownedWindow(pid: pid, windowId: windowId) {
        misses = 0
        let minimized = boolAttr(window, kAXMinimizedAttribute as String)
        if !minimized, let f = frame(of: window) {
          if let previous = lastFrame, !f.equalTo(previous) {
            lastFrame = f
            emit([
              "type": "frameChanged",
              "pid": Int(pid),
              "windowId": windowId,
              "frame": rectJSON(f),
            ])
          } else if lastFrame == nil {
            lastFrame = f
          }
        }
      } else {
        misses += 1
        if misses >= 3 {
          watchLock.lock()
          watched[key] = nil
          watchLock.unlock()
          selectionLock.lock()
          knownWindows[windowId] = nil
          selectionLock.unlock()
          emit(["type": "closed", "pid": Int(pid), "windowId": windowId])
          return
        }
      }
    }
  }
}

func stopWatching(pid: pid_t, windowId: Int?) {
  watchLock.lock()
  if let windowId {
    watched[WatchKey(pid: pid, windowId: windowId)] = nil
  } else {
    for key in watched.keys where key.pid == pid {
      watched[key] = nil
    }
  }
  watchLock.unlock()
  selectionLock.lock()
  if let windowId {
    if knownWindows[windowId]?.pid == pid { knownWindows[windowId] = nil }
  } else {
    for (id, entry) in knownWindows where entry.pid == pid {
      knownWindows[id] = nil
    }
  }
  selectionLock.unlock()
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
  let windowId = request["windowId"] as? Int
  switch request["type"] as? String {
  case "check":
    if request["prompt"] as? Bool == true {
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      reply(["trusted": AXIsProcessTrustedWithOptions(options)])
    } else {
      reply(["trusted": AXIsProcessTrusted()])
    }
  case "find":
    guard let pid else { return reply(["found": false, "windows": []]) }
    guard AXIsProcessTrusted() else {
      return reply(["found": false, "reason": "untrusted", "windows": []])
    }
    let result = candidateWindows(pid: pid)
    guard !result.windows.isEmpty else {
      return reply(["found": false, "windows": []])
    }
    var message: [String: Any] = ["found": true, "windows": result.windows]
    if let firstFrame = result.firstFrame {
      message["frame"] = rectJSON(firstFrame)
      if let firstElement = result.firstElement,
        let top = contentTop(of: firstElement, windowFrame: firstFrame)
      {
        message["contentTop"] = top
      }
    }
    reply(message)
  case "watch":
    if let pid, let windowId { startWatching(pid: pid, windowId: windowId) }
  case "unwatch":
    if let pid { stopWatching(pid: pid, windowId: windowId) }
  case "setFrame":
    guard let pid, let windowId, let window = ownedWindow(pid: pid, windowId: windowId),
      let x = request["x"] as? Double, let y = request["y"] as? Double,
      let w = request["width"] as? Double, let h = request["height"] as? Double
    else { return }
    setFrame(window, CGRect(x: x, y: y, width: w, height: h))
  case "minimize":
    guard let pid, let windowId, let window = ownedWindow(pid: pid, windowId: windowId),
      let minimized = request["minimized"] as? Bool
    else { return }
    AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, minimized as CFBoolean)
  case "raise":
    guard let pid, let windowId, let window = ownedWindow(pid: pid, windowId: windowId) else { return }
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
