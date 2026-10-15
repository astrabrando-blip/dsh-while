import {readFile,readdir,stat} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const pkg=JSON.parse(await readFile('package.json','utf8'))
assert.equal(pkg.name,'dsh-while')
assert.ok((await readFile('cordis.patch.yml','utf8')).includes('name: '+pkg.name))
assert.ok(pkg.dsh.bundle.patch)
for(const script of ['prepare','install','postinstall'])assert.ok(!pkg.scripts[script],`Unexpected lifecycle script: ${script}`)
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;assert.ok(!e.isSymbolicLink(),`No local symlink: ${p}`);out.push(...(e.isDirectory()?await walk(p):[p]))}return out}
const files=[...await walk('lib'),...await walk('agent')]
for(const f of files){const s=await readFile(f,'utf8');assert.ok(!/\/Users\/|\/private\/tmp\/|\/var\/folders\//.test(s),`Local path in ${f}`);assert.ok(!/-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(s),`Credential in ${f}`);if(f.endsWith('.js'))assert.equal(spawnSync(process.execPath,['--check',f]).status,0,`Syntax: ${f}`)}
const client=await readFile('lib/client.js','utf8');assert.ok(!client.includes('@dsh-local/muse-desktop'))
for(const entry of Object.values(pkg.exports))await stat(entry)
console.log(`Release validation passed: ${files.length} runtime files; manifest, entrypoints, syntax, local-path and credential-marker checks.`)
