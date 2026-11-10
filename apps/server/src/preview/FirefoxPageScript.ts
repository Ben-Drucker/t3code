// Page programs stay strings because the server intentionally compiles without DOM types.
const DOM_HELPERS = `
const roots = (root) => {
  const result = [root];
  for (const el of root.querySelectorAll('*')) if (el.shadowRoot) result.push(...roots(el.shadowRoot));
  return result;
};
const all = (selector) => roots(document).flatMap(root => [...root.querySelectorAll(selector)]);
const visible = (el) => {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert],[aria-hidden="true"]');
};
const name = (el) => {
  const labelled = el.getAttribute('aria-labelledby');
  return (labelled ? labelled.split(/\\s+/).map(id => el.getRootNode().getElementById(id)?.textContent ?? '').join(' ') :
    (el.getAttribute('aria-label') ?? [...(el.labels ?? [])].map(label => label.textContent).join(' ')) ||
    el.getAttribute('alt') || el.getAttribute('title') || (el.tagName === 'INPUT' ? el.getAttribute('placeholder') ?? '' : el.textContent) || '').trim();
};
const role = (el) => el.getAttribute('role') ?? ({
  A: el.hasAttribute('href') ? 'link' : null, BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox',
  INPUT: ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',range:'slider',number:'spinbutton',hidden:null})[el.type] ?? 'textbox',
  H1:'heading', H2:'heading', H3:'heading', H4:'heading', H5:'heading', H6:'heading', IMG:'img',
  NAV:'navigation', MAIN:'main', FORM:'form', UL:'list', OL:'list', LI:'listitem', TABLE:'table',
  TH:'columnheader', TD:'cell', TR:'row', IFRAME:'iframe', FRAME:'iframe', OPTION:'option'
})[el.tagName] ?? (el.isContentEditable ? 'textbox' : null);
const find = (selector) => {
  if (selector.startsWith('aria-ref=')) {
    const entry = globalThis.t3Refs?.get(selector.slice(9));
    if (!entry || !entry.isConnected) throw new Error('T3_STALE_REF');
    return [entry];
  }
  if (selector.startsWith('text=')) {
    const raw = selector.slice(5); let text = raw; let exact = false;
    if (raw.startsWith('"')) { text = JSON.parse(raw); exact = true; }
    const matches = all('*').filter(el => visible(el) && (exact ? el.textContent.trim() === text : el.textContent.includes(text)));
    return matches.filter(el => !matches.some(child => child !== el && el.contains(child)));
  }
  const match = /^role=([\\w-]+)(?:\\[name=("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\]]*)\\])?$/.exec(selector);
  if (match) {
    const wanted = match[2] === undefined ? null : (match[2].startsWith('"') ? JSON.parse(match[2]) : match[2].replace(/^'|'$/g, ''));
    return all('*').filter(el => visible(el) && role(el) === match[1] && (wanted === null || name(el) === wanted));
  }
  if (/^[\\w-]+=/.test(selector) && !selector.startsWith('css=')) throw new Error('T3_UNSUPPORTED_SELECTOR');
  return all(selector.replace(/^css=/, ''));
};
`;

export const COLLECT = `${DOM_HELPERS}
globalThis.t3Refs = new Map();
const prefix = arguments[0];
const elements = [];
const tree = [];
const passwords = all('input[type=password]').map(el => el.value).filter(Boolean);
const mask = value => passwords.reduce((text, password) => text.split(password).join('[redacted]'), String(value));
for (const el of all('*')) {
  if (elements.length >= 300 || !visible(el)) continue;
  const r = role(el);
  if (!r && el.tabIndex < 0) continue;
  const ref = prefix + '-' + elements.length;
  globalThis.t3Refs.set(ref, el);
  const box = el.getBoundingClientRect();
  const label = mask(name(el)).slice(0, 1000);
  const flags = ['disabled','checked','selected','expanded','pressed'].filter(flag => el[flag] === true || el.getAttribute('aria-' + flag) === 'true');
  tree.push('- ' + (r ?? 'generic') + ' ' + JSON.stringify(label) + ' [ref=' + ref + ']' + flags.map(flag => ' [' + flag + ']').join(''));
  elements.push({ tag: el.tagName.toLowerCase(), role: r, name: label, selector: 'aria-ref=' + ref,
    x: box.x, y: box.y, width: box.width, height: box.height });
}
return { url: location.href, title: mask(document.title), loading: document.readyState !== 'complete',
  visibleText: mask(document.body?.innerText ?? '').slice(0,20000), interactiveElements: elements, accessibilityTree: tree.join('\\n'),
  frames: all('iframe,frame'), width: innerWidth, height: innerHeight };`;

export const RESOLVE = `${DOM_HELPERS}
const matches = find(arguments[0]);
if (matches.length > 1) throw new Error('T3_AMBIGUOUS_SELECTOR');
return matches[0] ?? null;`;

export const WAIT = `${DOM_HELPERS}
const [input, timeout, done] = arguments;
let observer;
let timer;
let urlTimer;
let finished = false;
const finish = result => { if (finished) return; finished = true; observer?.disconnect(); clearTimeout(timer); clearInterval(urlTimer); removeEventListener('popstate', check); removeEventListener('hashchange', check); document.removeEventListener('readystatechange',check); done(result); };
const check = () => {
  try {
    const target = input.locator ?? input.selector;
    if ((!target || find(target).length > 0) && (input.text === undefined || (document.body?.innerText ?? '').includes(input.text)) &&
        (input.urlIncludes === undefined || location.href.includes(input.urlIncludes)) &&
        (!input.readyState || document.readyState === input.readyState || (input.readyState === 'interactive' && document.readyState === 'complete'))) finish(true);
  } catch (error) { finish({ error: String(error) }); }
};
observer = new MutationObserver(check);
for (const root of roots(document)) observer.observe(root, { subtree:true, childList:true, attributes:true, characterData:true });
addEventListener('popstate', check); addEventListener('hashchange', check);
document.addEventListener('readystatechange', check, { once: true });
timer = setTimeout(() => finish(false), timeout);
if (input.urlIncludes !== undefined) urlTimer = setInterval(check,100);
check();`;
