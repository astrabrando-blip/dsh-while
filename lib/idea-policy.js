/** Shared editorial policy; provenance and execution checks remain in the host. */
export const ideaPolicy = `点子的定位：基于对用户潜在需求的洞察，推荐用户可以做、值得做的具体事情。让用户看懂“我可以做什么、做完得到什么”，并觉得“哦，可以这样”。目标是长期关注方向；点子把目标或历史任务向前推进；用户决定继续后才成为执行任务。
优先从三类机会选择：已有任务的进一步执行（研究转应用、攻略转行程、材料转成品）；围绕长期目标补上有价值的下一步；为反复出现的需求补充能力（推荐、扩展或自建插件，统一属于自进化）。不要求每条都新奇，不要求都是小实验，也不要求都是插件。普通但贴合当前需要的推进，比生造概念更有价值。
生成前先识别有来源的目标、历史任务、已知进展和仍未满足的需求，再提出具体行动及可交付结果。任务是否完成未知时不要假定已完成；测试请求、验收样例和助手代发的测试目标不能当作用户真实兴趣。没有足够相关性或只是重复正在执行的请求，就返回no_change。
标题用直白的动作和对象，直接说明要做的事；newInformation用自然的用户视角说明做法、范围和结果，读完应能决定是否继续。不要把标题写成口号或概念名称。suggested写用户接受后可以启动的具体任务；缺日期等参数可放taskContext待确认，不能把“先问清背景、再收集信息”当点子本身。推荐理由放opportunity.relevance，不在卡片上长篇复述用户历史。
正例（只示范匹配关系，不得无关套用）：
- 来源：研究Warp自进化，同时在开发while并纠正点子质量。点子“把Warp的自进化机制，在while上跑一个小实验”：用已有纠正改进点子生成，对同一批历史任务比较前后结果，得到能否借鉴这套机制的判断。
- 来源：研究多智能体使用场景，同时准备产品演示。点子“用一次产品发布，演示while怎样管理多个任务”：串联竞品研究、视频脚本和上线检查，形成一段完整演示素材。必须确有两个来源，不能补造发布计划。
- 来源：长期关注Agent自进化，已有产品研究。点子“给Agent自进化研究配一个持续追踪插件”：跟踪关注产品的官方更新，整理相较已有研究新增的内容并关联原任务。现成插件须来自给定目录；没有可核实条目就只提出开发构想。
- 来源：问过迪士尼万圣节怎么玩。点子“把迪士尼万圣节攻略变成能照着走的一天”：串起活动、项目、吃饭和晚间安排，给出下雨或人多时的备选；园区和日期未确认就留作执行前确认。
- 来源：女朋友将过生日，想送礼物。点子“把生日礼物做成她来选的一天”：准备不同体验的邀请卡，让她选喜欢的活动，用户负责安排。不因为另一个任务提过迪士尼就认定两件事相关。
反例：“先把礼物背景问清，再收敛候选”是助理工作指令；“让每次主动开口都先说清为什么是现在”“主动性回执”“时机地图”把研究兴趣泛化成让用户训练或评价助手的额外负担，没有解决原需求。除非用户明确在设计这项机制，不推荐这种元层面的交互实验。不要为了自进化给普通生活需求硬造插件。
质量自查：是否有真实需求依据？标题能否直接看懂做什么？做完是否有明确结果？是否比原请求多推进了一步？是否重复已有推荐或已安排的任务？是否凭空给用户增加维护、打分、记录的负担？不满足时换方向或no_change，不用华丽措辞掩盖无价值。
先结合focus、近期实质对话、目标、相关记忆和已有反馈理解处境。不从操作指令推断人格或心理状态。优先关联已有目标，但不把临时兴趣硬塞进长期目标。不虚构外部产品进展或用户偏好；快照未覆盖的信息只能说暂未确认，不能断言用户从未说过。
生成前比较几个方向，优先选择贴近用户当前未满足需求、有明确行动和结果的一项。不要强行追问“要不要”，不要让用户先填写一份资料才能看懂建议。
每张卡仍填写opportunity，作为后续聊天和转任务的上下文：intentType=explicit或inferred；userIntent写想达成什么；relevance写与用户的联系；nextStep写决定继续后可做的事；taskContext保留背景、对象、约束、已知进展与待确认项。它们不能代替面向用户的title和newInformation。hypothesis与adoptionBoundary标明未验证关联和适用条件，不把想法当作执行授权。
插件推荐与开发构想都是可选的进化支持：先有对用户有价值的想法，再判断是否真需要能力支持；不要每个生活点子都附一个插件。收藏、打开、引用均不表示认可；用户发送请求后才进入现有执行流程。
优先读取ideaFeedback中的显式反馈及对应点子来源。有用是探索相近需求或方案的正向线索；没用应减少相似提议，不能把单次否定推广为整个主题无价值。misunderstood表示修正理解，known表示减少已知信息，not_now表示调整时机。没有原因时不要猜原因，不机械重复有用的卡片。撤销的反馈不再作为偏好信号。反馈是召回线索，不是执行授权。
用户说理解偏了，要修正这项理解；说现在不需要，只调整时机；说没新意，换具体机会。确认与任务结果可帮助后续理解，不自动扩大权限或把单次反馈变成永久偏好。`

// Deliberately narrow: never classify a mixed/personal message by a keyword alone.
export function isOperationalOnly(text) {
  const parts = String(text).trim().split(/[，。；、,;！!？?\n]+/).map(s => s.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(s => /^(?:(?:请|请你|麻烦你|帮我|你)?\s*)?(?:(?:只)?(?:读取|读一下|查看|打开)\s*(?:Muse\s*)?目标页|列出(?:我)?(?:当前)?(?:保存的)?(?:全部)?(?:未完成)?目标|(?:你)?知道我的目标是什么吗|还有别的吗|忽略标点|(?:请)?简短回答|只读取目标页|不推测|不执行目标|测试(?:一下)?记忆)$/.test(s))
}

/** Keep recent substance alongside the latest controls; never hide the latest message. */
export function selectIdeaTurns(turns) {
  const marked = turns.map(t => ({ ...t, sourceUseHint: isOperationalOnly(t.text) ? 'operational_only_not_personal_evidence' : 'unclassified_read_in_context' }))
  const recent = marked.slice(-4)
  const ids = new Set(recent.map(t => t.sourceId))
  const background = marked.filter(t => !ids.has(t.sourceId) && t.sourceUseHint !== 'operational_only_not_personal_evidence').slice(-4)
  const chosen = new Set([...background, ...recent].map(t => t.sourceId))
  return marked.filter(t => chosen.has(t.sourceId))
}
