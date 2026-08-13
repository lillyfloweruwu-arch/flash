export type PerGameSettings = Record<string, { quality?: string; bufferLength?: number }>

export function resolveGameSettings(
  perGame: PerGameSettings,
  game: string | null,
  globals: { quality: string; bufferLength: number },
) {
  const override = game ? perGame[game] : undefined
  return {
    quality: override?.quality ?? globals.quality,
    bufferLength: override?.bufferLength ?? globals.bufferLength,
  }
}
