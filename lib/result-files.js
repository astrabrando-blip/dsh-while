import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

// Only explicit file references in returned results; never infer files from requests.
export async function withResultFiles(results = []) {
  return Promise.all((Array.isArray(results) ? results : []).map(async result => {
    if (!result || typeof result.text !== 'string') return result
    const paths = new Set()
    const text = result.text.slice(0, 100000)
    for (const match of text.matchAll(/`(\/[^`\n]+)`|\]\((\/[^)\n]+)\)|(?:^|\n)\s*(\/[^\n]+?)(?=\s*$)/gm)) paths.add(match[1] || match[2] || match[3])
    const files = []
    for (const path of [...paths].slice(0, 30)) {
      try { if ((await stat(path)).isFile()) files.push({ path, name: basename(path) }) } catch {}
    }
    return { ...result, files }
  }))
}
