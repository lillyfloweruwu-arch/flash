// A clip nobody has renamed is named for the moment it was saved, and the
// library turned that filename straight into a title: "2026 09 13 02 45 12".
// That is six numbers in a row with no separators to read them by, on every
// card, and the card already says "6d ago" underneath it — so the one thing the
// title could usefully carry, which of today's clips this is, was the hardest
// part to find in it.
//
// Only the auto-generated shape is touched. Anything the user has named is
// their title and is shown exactly as they typed it.
const AUTO_NAME = /^(\d{4}) (\d{2}) (\d{2}) (\d{2}) (\d{2}) (\d{2})$/

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function clipDisplayTitle(title: string, now = new Date()): string {
  const match = AUTO_NAME.exec(title.trim())
  if (!match) return title

  const [, year, month, day, hour24, minute, second] = match.map(Number) as unknown as number[]
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour24 > 23 || minute > 59 || second > 59) {
    return title
  }

  // Seconds are kept because two clips a minute apart are common and two clips
  // a second apart are what happens when the hotkey is pressed twice.
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12
  const pad = (value: number) => String(value).padStart(2, '0')
  const clock = `${hour}:${pad(minute)}:${pad(second)} ${hour24 < 12 ? 'AM' : 'PM'}`
  // The year is noise for everything saved this year, which is nearly all of it.
  const date = year === now.getFullYear() ? `${day} ${MONTHS[month - 1]}`
                                          : `${day} ${MONTHS[month - 1]} ${year}`
  return `${date} · ${clock}`
}
