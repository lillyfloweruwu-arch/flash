// Where feedback goes, and what counts as sendable. Shared by the renderer
// (which enables the Send button) and the main process (which refuses anything
// that does not match before it leaves the machine).

export const FEEDBACK_ENDPOINT = 'https://lubuntuserver.tail857ab5.ts.net:10000/flash-feedback'
export const FEEDBACK_MIN_LENGTH = 3
export const FEEDBACK_MAX_LENGTH = 2000

// Length is measured after trimming, so whitespace alone never passes.
export function validateFeedback(message: unknown): string | null {
  if (typeof message !== 'string') return 'Message must be text.'
  const length = message.trim().length
  if (length < FEEDBACK_MIN_LENGTH) return 'Message is too short.'
  if (length > FEEDBACK_MAX_LENGTH) return 'Message is too long.'
  return null
}
