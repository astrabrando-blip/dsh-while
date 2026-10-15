/** Controlled QA deployment: this is an allowlist, never a fabricated Session ID.
 * The persisted muse-qa identity must independently map to this already known root.
 * Production opt-in requires a separately reviewed policy/configuration handoff.
 */
export const approvedQaImRoot = 'bebb8366-0969-489a-b361-ea82d9ec3827'
export const qaImAllowed = (muse,root) => root === approvedQaImRoot && muse.ownsQaRoot?.(root) === true
export function requireQaIm(muse,root) {
  if(!qaImAllowed(muse,root))throw Error('New IM protocol is restricted to the approved persisted QA identity')
}

/** Configuration is opt-in; identity still comes exclusively from persisted Muse. */
export function createImPolicy(muse,{formalImOptIn=false}={}) {
  const isFormal=root=>muse.ownsFormalRoot?.(root)===true
  const allowed=root=>qaImAllowed(muse,root)||(formalImOptIn===true&&isFormal(root))
  return{isFormal,allowed,requireRoot(root){if(!allowed(root))throw Error('New IM protocol is restricted to approved persisted QA identity or explicitly opted-in persisted Muse identity')}}
}
