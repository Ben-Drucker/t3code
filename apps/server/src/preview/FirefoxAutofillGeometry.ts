export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface Point {
  readonly x: number;
  readonly y: number;
}

export function bannerScreenPoint(input: {
  readonly screen: Point;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frame: Rect;
  readonly banner: { readonly width: number; readonly height: number };
  readonly label: Rect;
}): Point {
  const { screen, viewport, frame, banner, label } = input;
  if (
    ![
      ...Object.values(screen),
      ...Object.values(viewport),
      ...Object.values(frame),
      ...Object.values(banner),
      ...Object.values(label),
    ].every(Number.isFinite) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    banner.width <= 0 ||
    banner.height <= 0 ||
    label.width <= 0 ||
    label.height <= 0 ||
    label.x < 0 ||
    label.y < 0 ||
    label.x + label.width > banner.width ||
    label.y + label.height > banner.height
  )
    throw new Error("The 1Password banner has no measurable click target.");
  const x = frame.x + ((label.x + label.width / 2) * frame.width) / banner.width;
  const y = frame.y + ((label.y + label.height / 2) * frame.height) / banner.height;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
    throw new Error("The 1Password click target is outside the tab.");
  return { x: screen.x + x, y: screen.y + y };
}

export interface AutofillEntry {
  readonly title: string;
  readonly username: string;
  readonly index: number;
}
export function selectAutofillEntry(
  entries: ReadonlyArray<AutofillEntry>,
  hint: { readonly username?: string | undefined; readonly title?: string | undefined },
) {
  const matching = entries.filter(
    (entry) =>
      (!hint.username || entry.username === hint.username) &&
      (!hint.title || entry.title === hint.title),
  );
  if (matching.length > 1)
    throw new Error("More than one 1Password entry matches. Specify an exact username and title.");
  return matching[0];
}

export function notificationArguments(command: "post" | "remove", id: string) {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error("Invalid notification identifier.");
  return [
    command,
    id,
    ...(command === "post"
      ? [
          "T3 Code browser automation",
          "Automation clicking in 5 seconds. Typing and clicking may be briefly disturbed.",
        ]
      : []),
  ];
}
