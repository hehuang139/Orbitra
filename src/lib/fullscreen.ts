type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitExitFullscreen?: () => Promise<void> | void
}

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void
}

type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>
}

export function fullscreenElement(doc: Document = document): Element | null {
  const webkit = doc as WebkitDocument
  return doc.fullscreenElement ?? webkit.webkitFullscreenElement ?? null
}

export function fullscreenSupported(element: HTMLElement, doc: Document = document): boolean {
  const webkit = doc as WebkitDocument
  return Boolean(
    (doc.fullscreenEnabled !== false && element.requestFullscreen) ||
    (webkit.webkitFullscreenEnabled !== false &&
      (element as WebkitElement).webkitRequestFullscreen),
  )
}

export async function enterFullscreen(element: HTMLElement): Promise<void> {
  if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' })
  else {
    const request = (element as WebkitElement).webkitRequestFullscreen
    if (!request) throw new Error('Fullscreen API is unavailable')
    await request.call(element)
  }
  const orientation = screen.orientation as LockableOrientation | undefined
  await orientation?.lock?.('landscape').catch(() => {})
}

export async function exitFullscreen(doc: Document = document): Promise<void> {
  if (doc.exitFullscreen) await doc.exitFullscreen()
  else {
    const exit = (doc as WebkitDocument).webkitExitFullscreen
    if (!exit) throw new Error('Fullscreen API is unavailable')
    await exit.call(doc)
  }
  try {
    screen.orientation?.unlock()
  } catch {
    /* Orientation unlock is optional and not exposed by every browser. */
  }
}

export function watchFullscreen(callback: () => void, doc: Document = document): () => void {
  doc.addEventListener('fullscreenchange', callback)
  doc.addEventListener('webkitfullscreenchange', callback as EventListener)
  return () => {
    doc.removeEventListener('fullscreenchange', callback)
    doc.removeEventListener('webkitfullscreenchange', callback as EventListener)
  }
}
