// The marker can only ever turn autostart ON, never OFF. Once a user has acted on the
// installer's request, the marker is consumed and autostart is left as-is.

export function decideAutostart(input: {
  installerRequested: boolean
  markerConsumed: boolean
  currentlyEnabled: boolean
  packaged: boolean
}): { apply: boolean; consumeMarker: boolean } {
  if (!input.packaged) {
    return { apply: false, consumeMarker: false }
  }
  if (!input.installerRequested) {
    return { apply: false, consumeMarker: false }
  }
  if (input.markerConsumed) {
    return { apply: false, consumeMarker: false }
  }
  if (input.currentlyEnabled) {
    return { apply: false, consumeMarker: true }
  }
  return { apply: true, consumeMarker: true }
}
