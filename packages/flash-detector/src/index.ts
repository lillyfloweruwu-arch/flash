import { execFile } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

interface GameEntry {
  processName: string
  displayName: string
}

interface DetectedGame {
  name: string
  processName: string
  pid: number
}

// Load game database
const gamesDb: GameEntry[] = JSON.parse(
  readFileSync(join(__dirname, 'games.json'), 'utf-8')
).games

// Build lookup map (lowercase process name -> display name)
const gameMap = new Map<string, string>()
for (const entry of gamesDb) {
  gameMap.set(entry.processName.toLowerCase(), entry.displayName)
}

// Scan running processes and match against game database
export function detectGames(): Promise<DetectedGame[]> {
  return new Promise((resolve, reject) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], (error, stdout) => {
      if (error) {
        reject(error)
        return
      }

      const detected: DetectedGame[] = []
      const seen = new Set<string>()

      for (const line of stdout.split('\n')) {
        // CSV format: "process.exe","PID","Session","Session#","Mem Usage"
        const match = line.match(/"([^"]+)","(\d+)"/)
        if (!match) continue

        const processName = match[1].toLowerCase()
        const pid = parseInt(match[2], 10)

        const gameName = gameMap.get(processName)
        if (gameName && !seen.has(gameName)) {
          seen.add(gameName)
          detected.push({
            name: gameName,
            processName: match[1],
            pid,
          })
        }
      }

      resolve(detected)
    })
  })
}

// Poll for game detection at interval
export class GameDetector {
  private interval: ReturnType<typeof setInterval> | null = null
  private currentGame: DetectedGame | null = null
  private onChange: ((game: DetectedGame | null) => void) | null = null

  start(pollMs = 3000, onChange?: (game: DetectedGame | null) => void) {
    this.onChange = onChange ?? null
    this.poll() // immediate first check

    this.interval = setInterval(() => this.poll(), pollMs)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  getCurrentGame(): DetectedGame | null {
    return this.currentGame
  }

  private async poll() {
    try {
      const games = await detectGames()
      const topGame = games[0] ?? null

      const changed =
        (topGame === null && this.currentGame !== null) ||
        (topGame !== null && this.currentGame === null) ||
        (topGame !== null && this.currentGame !== null && topGame.name !== this.currentGame.name)

      if (changed) {
        this.currentGame = topGame
        this.onChange?.(topGame)
      }
    } catch {
      // tasklist failed — ignore, try again next poll
    }
  }
}

// ponytail: Node tasklist scan replaces C# service. Add C# when perf matters (>100 games in DB).
