import {build,version} from 'esbuild'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
const require=createRequire(import.meta.url)
const sdk=JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'),'utf8'))
if(sdk.version!=='0.2.0-rc.2'||version!=='0.25.12')throw Error('Reviewed surface bundle requires pinned SDK/compiler versions')
import {writeFile} from 'node:fs/promises'
// Consume the official public subpath. Never import a package-private file.
await build({stdin:{contents:"export { foldSurface } from '@deepseek-ai/dsh-session/surface'",resolveDir:process.cwd(),sourcefile:'official-session-surface-entry.js'},bundle:true,format:'esm',platform:'node',target:'node22',outfile:'lib/vendor/session-surface.js',metafile:true,legalComments:'inline',banner:{js:'// Official @deepseek-ai/dsh-session/surface 0.2.0-rc.2, MIT.\n// Generated bundle; rebuild with scripts/build-session-surface.mjs.'}}).then(async r=>{await writeFile('lib/vendor/session-surface.metafile.json',JSON.stringify(r.metafile,null,2)+'\n')})
