import type { FlashAPI } from '../preload/preload'

declare global {
  interface Window {
    flash: FlashAPI
  }
}
