import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const reactRequire = createRequire(require.resolve('react-dom'))
const dependencies = [
  ['react', require],
  ['react-dom', require],
  ['scheduler', reactRequire],
  ['lucide-react', require],
  ['fflate', require],
  ['@noble/hashes', require],
]
const sections = [
  'Orbitra — Runtime dependency licenses\n\nGenerated from installed packages. Regenerate after updating dependencies with pnpm licenses:generate.\nSee THIRD_PARTY_NOTICES.md for separately bundled mGBA and font licenses.',
]

for (const [name, resolver] of dependencies) {
  let directory = dirname(resolver.resolve(name))
  while (directory !== parse(directory).root) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (pkg.name === name) {
        const license = await readFile(join(directory, 'LICENSE'), 'utf8')
        sections.push(
          `${'='.repeat(72)}\n${name} ${pkg.version}\n${'='.repeat(72)}\n\n${license.trim()}`,
        )
        break
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    directory = dirname(directory)
  }
  if (directory === parse(directory).root) throw new Error(`License not found for ${name}`)
}

const output = new URL('../public/licenses/', import.meta.url)
await mkdir(output, { recursive: true })
await writeFile(new URL('DEPENDENCIES.txt', output), `${sections.join('\n\n')}\n`)
console.log('Updated public/licenses/DEPENDENCIES.txt from installed runtime dependencies.')
