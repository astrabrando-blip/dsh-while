import { z } from 'zod'
import { requireQaIm } from './im-policy.js'
export const imDomainSpec = { name: 'muse_im_v1', version: 1, tables: { conversations: { valueSchema: z.unknown() } } }
/** Separate additive domain: never rewrite the legacy transcript or discovery journal. */
export function createImJournal(muse,requireRoot=root=>requireQaIm(muse,root)) {
  let opening, handle, closed=false;const shared=typeof muse.openImDomain==='function'
  const table = async () => {
    opening ||= (shared?muse.openImDomain():muse.ctx.storageDomain.open(imDomainSpec)).then(domain => {
      handle=domain
      if(!shared)muse.ctx.effect(() => () => close(), 'muse.im-domain-close')
      return domain.table('conversations')
    })
    return opening
  }
  const close=async()=>{if(closed)return;closed=true;await opening?.catch(()=>{});if(!shared)await handle?.close()}
  return {
    close,
    async load(root) { requireRoot(root); if (!muse.ownsRoot(root)) throw Error('Exact Muse conversation required'); const value=(await table()).get(root); return value ? structuredClone(value) : null },
    async save(value) { requireRoot(value.root); if (!muse.ownsRoot(value.root)) throw Error('Exact Muse conversation required'); await (await table()).put(value.root, structuredClone(value)) }
  }
}
