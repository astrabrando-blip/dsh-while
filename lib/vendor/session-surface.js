// Official @deepseek-ai/dsh-session/surface 0.2.0-rc.2, MIT.
// Generated bundle; rebuild with scripts/build-session-surface.mjs.

// Bundled official DSH session surface module
function brandNumber(value) {
  return value;
}

// Bundled official DSH session surface module
function SessionSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionSeq must be a non-negative safe integer, got ${String(value)}`);
  }
  return brandNumber(value);
}
function SessionLogOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`SessionLogOffset must be a non-negative safe integer, got ${String(value)}`);
  }
  return brandNumber(value);
}

// Bundled official DSH session surface module
var KNOWN_SESSION_EVENT_TYPES = /* @__PURE__ */ new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "assistant/attempt",
  "assistant/message",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "deliverables/presented",
  "developer/message",
  "feedback/message-delete",
  "feedback/message-put",
  "feedback/record",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "image/offload",
  "llm/retry",
  "llm/retry-started",
  "model/selection",
  "permission/preset",
  "plan/mode",
  "request/context",
  "request/header",
  "sandbox/mode",
  "schedule/change",
  "session-log-deepseek/delivery-accepted",
  "session/end-seed",
  "session/title",
  "session/title-llm-request",
  "step/end",
  "step/start",
  "subagent/catalog",
  "subagent/descriptor",
  "subagent/model-selection-policy",
  "system/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "todo/write",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "tool/call",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "tool/result",
  "turn/end",
  "turn/start",
  "user/message",
  "web/deepseek-search-llm-request",
  "workspace/changes"
]);
var MESSAGE_PROJECTION_EVENT_TYPES = /* @__PURE__ */ new Set([
  "image/offload"
]);

// Bundled official DSH session surface module
var SURFACE_EVENT_TYPES = /* @__PURE__ */ new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result"
]);
function isSurfaceEligibleType(type) {
  return SURFACE_EVENT_TYPES.has(type);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateSessionEventData(event, subject) {
  const data = event.data;
  if (SURFACE_EVENT_TYPES.has(event.type) && isRecord(data)) {
    const message = event.type === "user/message" ? data : data["message"];
    if (isRecord(message)) {
      if (event.type === "developer/message" !== (message["role"] === "developer")) {
        throw new Error(`${subject} developer/message and developer role must occur together`);
      }
      if (message["role"] !== "developer" && Array.isArray(message["content"]) && message["content"].some((block) => isRecord(block) && (block["type"] === "tool-addition" || block["type"] === "tool-removal"))) {
        throw new Error(`${subject} tool-change blocks require developer role`);
      }
      if (event.type === "developer/message" && Array.isArray(message["content"])) {
        let hasAdditions = false;
        for (const block of message["content"]) {
          if (!isRecord(block) || block["type"] !== "tool-addition" && block["type"] !== "tool-removal")
            continue;
          if (typeof block["toolName"] !== "string" || block["toolName"].length === 0) {
            throw new Error(`${subject} ${block["type"]} requires a nonempty toolName`);
          }
          if (block["type"] === "tool-addition") {
            hasAdditions = true;
            if (Object.hasOwn(block, "tool"))
              throw new Error(`${subject} tool-addition must omit inline tool definitions`);
          }
        }
        if (hasAdditions ? !isEventSeq(data["headerSeq"]) : Object.hasOwn(data, "headerSeq")) {
          throw new Error(`${subject} requires headerSeq exactly when tool additions are present`);
        }
      }
    }
  }
  if (event.type === "request/header") {
    if (!isRecord(data))
      throw new Error(`${subject} data must be an object`);
    const header = data["header"];
    if (!isRecord(header))
      throw new Error(`${subject} header must be an object`);
    if (Object.hasOwn(header, "system"))
      throw new Error(`${subject} must omit header.system; use system/message`);
    if (Array.isArray(header["tools"]) && header["tools"].length === 0) {
      throw new Error(`${subject} must omit empty tools`);
    }
    const defaults = header["adapterDefaults"];
    if (isRecord(defaults) && Object.keys(defaults).length === 0) {
      throw new Error(`${subject} must omit empty adapterDefaults`);
    }
  } else if (event.type === "tool/result") {
    if (!isRecord(data))
      throw new Error(`${subject} data must be an object`);
    if (data["error"] === void 0)
      return;
    const message = data["message"];
    if (!isRecord(message) || message["isError"] !== true) {
      throw new Error(`${subject} error requires message.isError === true`);
    }
  }
}
function createFoldState() {
  return { nodes: [], replaceGeneration: 0, contentGeneration: 0, projectedMessages: /* @__PURE__ */ new Map(), projections: /* @__PURE__ */ new Set() };
}
function isEventSeq(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function isReplaceOp(value) {
  const op = value;
  return Object.keys(op).length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "startSeq") && Object.hasOwn(op, "endSeq") && op["op"] === "replace" && isEventSeq(op["startSeq"]) && isEventSeq(op["endSeq"]);
}
function surfaceOpOf(event) {
  const raw = event;
  if (!isSurfaceEligibleType(event.type)) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true)
      return;
    if (raw.surfaceOp !== void 0) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
    }
    if (raw.sourceEventSeqs !== void 0) {
      throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
    }
    return;
  }
  const op = raw.surfaceOp;
  if (op === void 0) {
    throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
  }
  if (op === "append")
    return op;
  if (op === null || typeof op !== "object" || Array.isArray(op)) {
    throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
  }
  if (!isReplaceOp(op)) {
    throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
  }
  return op;
}
function assertSourceEventReferences(event, shadowedSeqs) {
  const raw = event.sourceEventSeqs;
  if (event.type === "assistant/message" && raw !== void 0) {
    throw new Error("assistant/message embeds its source stream and cannot carry sourceEventSeqs");
  }
  const sources = /* @__PURE__ */ new Set();
  if (raw !== void 0) {
    if (!Array.isArray(raw)) {
      throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`);
    }
    if (raw.length === 0) {
      throw new Error("sourceEventSeqs must not be empty");
    }
    let nonEarlierSource;
    for (const source of raw) {
      if (!isEventSeq(source)) {
        throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`);
      }
      sources.add(source);
      if (nonEarlierSource === void 0 && source >= event.seq)
        nonEarlierSource = source;
    }
    if (sources.size !== raw.length) {
      throw new Error("sourceEventSeqs must not contain duplicates");
    }
    if (nonEarlierSource !== void 0) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`);
    }
  }
  const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
  if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
  }
}
function assertDeveloperHeader(event, events, baseSeq) {
  if (event.type !== "developer/message")
    return;
  validateSessionEventData(event, `developer/message at seq ${event.seq}`);
  if (event.data.headerSeq === void 0)
    return;
  const headerSeq = event.data.headerSeq;
  const headerEvent = events[headerSeq - baseSeq];
  if (headerSeq >= event.seq || headerEvent?.type !== "request/header") {
    throw new Error("developer/message headerSeq must reference an earlier request/header");
  }
  for (const block of event.data.message.content) {
    if (block.type !== "tool-addition")
      continue;
    const definitions = headerEvent.data.header.tools?.filter((tool) => tool.name === block.toolName) ?? [];
    if (definitions.length !== 1) {
      throw new Error(`developer/message tool-addition "${block.toolName}" must name exactly one tool in headerSeq ${headerSeq}`);
    }
    const definition = definitions[0];
    if (typeof definition.description !== "string" || !isRecord(definition.parameters)) {
      throw new Error(`developer/message tool-addition "${block.toolName}" requires a complete tool definition in headerSeq ${headerSeq}`);
    }
    if (Object.hasOwn(definition, "deferLoading") && definition.deferLoading !== true) {
      throw new Error("developer/message referenced tool deferLoading must be true when present");
    }
  }
}
function validateSurfaceMetadata(event) {
  const op = surfaceOpOf(event);
  if (op !== void 0 && op !== "append" && (op.startSeq >= event.seq || op.endSeq >= event.seq)) {
    throw new Error(`surface replace at seq ${event.seq}: startSeq and endSeq must reference earlier events`);
  }
  if (op !== void 0)
    assertSourceEventReferences(event, []);
  return op;
}
function replacementRange(state, op) {
  const startIdx = state.nodes.indexOf(op.startSeq);
  if (startIdx === -1) {
    throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
  }
  const endIdx = state.nodes.indexOf(op.endSeq);
  if (endIdx === -1) {
    throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
  }
  if (startIdx > endIdx) {
    throw new Error(`surface replace: start seq ${op.startSeq} (index ${startIdx}) is after end seq ${op.endSeq} (index ${endIdx})`);
  }
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1)
  };
}
function isDeepEqualJson(a, b) {
  if (a === b)
    return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, i) => isDeepEqualJson(item, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  const aKeys = Object.keys(a);
  const bRecord = b;
  if (aKeys.length !== Object.keys(b).length)
    return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], bRecord[key]));
}
function assertToolResultRewrite(event, shadowedSeqs, events, baseSeq) {
  if (event.type !== "tool/result")
    return;
  if (shadowedSeqs.length !== 1) {
    throw new Error("tool/result surface replacement must rewrite exactly one current node");
  }
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq];
    if (original?.type !== "tool/result") {
      throw new Error("tool/result surface replacement must target a current tool/result");
    }
    const originalRest = { ...original.data };
    const replacementRest = { ...event.data };
    originalRest["message"] = {
      ...original.data.message,
      content: null
    };
    replacementRest["message"] = {
      ...event.data.message,
      content: null
    };
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      throw new Error("tool/result surface replacement may change only content");
    }
  }
}
function assertSystemHeadRewrite(event, state, startIdx, shadowedSeqs, events, baseSeq) {
  if (startIdx !== 0)
    return;
  const head = events[state.nodes[0] - baseSeq];
  if (head?.type !== "system/message")
    return;
  if (event.type !== "system/message" || shadowedSeqs.length !== 1) {
    throw new Error("surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node");
  }
}
function planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections) {
  if (event.seq !== expectedSeq) {
    throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
  }
  const surfaceOp = validateSurfaceMetadata(event);
  assertDeveloperHeader(event, events, baseSeq);
  const projection = projections.find((item) => item.type === event.type);
  if (projection !== void 0) {
    return { kind: "project", projection, messages: projection.project(event, {
      nodes: state.nodes,
      events,
      baseSeq,
      messages: state.projectedMessages
    }) };
  }
  if (MESSAGE_PROJECTION_EVENT_TYPES.has(event.type)) {
    throw new Error(`session event "${event.type}" requires a message projection; load its owning plugin or supply its projection definition`);
  }
  if (surfaceOp === void 0)
    return;
  if (surfaceOp === "append") {
    return { kind: "append", seq: event.seq };
  }
  const range = replacementRange(state, surfaceOp);
  assertSourceEventReferences(event, range.shadowedSeqs);
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);
  assertSystemHeadRewrite(event, state, range.startIdx, range.shadowedSeqs, events, baseSeq);
  return {
    kind: "replace",
    seq: event.seq,
    start: surfaceOp.startSeq,
    end: surfaceOp.endSeq,
    ...range
  };
}
function applySurfaceEvent(state, event, expectedSeq, events, baseSeq, projections) {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, projections);
  return applySurfacePlan(state, plan);
}
function applySurfacePlan(state, plan) {
  if (plan?.kind === "append") {
    state.nodes.push(plan.seq);
  } else if (plan?.kind === "replace") {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
    state.replaceGeneration += 1;
    state.contentGeneration += 1;
  } else if (plan?.kind === "project") {
    for (const [seq, message] of plan.messages)
      state.projectedMessages.set(seq, message);
    state.projections.add(plan.projection);
    state.contentGeneration += 1;
  }
  if (plan?.kind !== "replace")
    return;
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs
  };
}
function foldSurface(events, projections = []) {
  const state = createFoldState();
  const replacements = [];
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(state, event, SessionSeq(index), events, SessionLogOffset(0), projections);
    if (replacement !== void 0)
      replacements.push(replacement);
  }
  return { nodes: [...state.nodes], replacements, projectedMessages: new Map(state.projectedMessages) };
}
export {
  foldSurface
};
