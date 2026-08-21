/**
 * FE!N public API.
 *
 * Grouped the way the source tree is grouped, so that the export list doubles
 * as a map of the system: core (what an agent *is*), context (what a model
 * *sees*), models (who does the work), tools, telemetry, cache, config.
 */

// ── core: the IR, the log, the loop ─────────────────────────────────────────
export * from "./core/types.js";
export { Transcript } from "./core/transcript.js";
export { Agent, type AgentOptions, type FeinTrace, type RunResult, type TurnKind } from "./core/loop.js";
export { LoopGuard, stableJson, type LoopSignal, type GuardOptions } from "./core/guards.js";
export { SteeringQueue, formatSteers, type Steer } from "./core/steering.js";

// ── context: what a given binding actually sees, and the cache guarantee ─────
export { MainLens, PrefixGuard, messageHash, type PrefixReport } from "./context/lens.js";
export {
  repairTranscript,
  findUnpairedCalls,
  findOrphanResults,
  INTERRUPTED_RESULT,
  type RepairReport,
} from "./context/repair.js";
export {
  spill,
  headTail,
  FileSpillStore,
  sweepSpill,
  SPILL_MAX_AGE_DAYS,
  DEFAULT_SPILL_POLICY,
  type SpillPolicy,
  type SpillOutcome,
  type SpillStore,
} from "./context/spill.js";

// ── models: the plugin surface, routing, and transports ─────────────────────
export { Router, SlotUnboundError, type RouteOutcome } from "./models/router.js";
export { escalateOnStuck, escalateOnReject, rightSize } from "./models/policy.js";
export { AnthropicPort, type AnthropicOptions } from "./models/providers/anthropic.js";
export {
  OpenAICompatPort,
  parseJsonToolCalls,
  type OpenAICompatOptions,
} from "./models/providers/openai.js";
export { OllamaPort, type OllamaOptions } from "./models/providers/ollama.js";
export { ReactPort, asReact, toReactTranscript, type ReactPortOptions } from "./models/react-port.js";
export {
  reactProtocol,
  parseReact,
  reactCorrection,
  REACT_STOP,
  FINAL_ANSWER_MARKER,
  type ReactStep,
} from "./steps/react.js";
export {
  ScriptedPort,
  estimateTokens,
  type ScriptedOptions,
} from "./models/providers/scripted.js";

// ── steps: the swappable stages of the loop ─────────────────────────────────
export { digest, DEFAULT_DIGEST_POLICY, type DigestPolicy } from "./steps/observe.js";
export { verify, type Verdict } from "./steps/verify.js";
export * from "./steps/prompts.js";
export {
  SystemPromptBuilder,
  SectionGuard,
  scanForVolatileContent,
  type PromptSection,
  type SectionFingerprint,
  type SectionDrift,
  type Volatility,
} from "./steps/sections.js";

// ── tools: registry, validation, and the default toolset ────────────────────
export {
  ToolRegistry,
  validateArgs,
  type Tool,
  type ToolContext,
} from "./tools/registry.js";
export {
  defaultTools,
  readFileTool,
  writeFileTool,
  listDirTool,
  shellTool,
  safePath,
} from "./tools/builtin.js";
export { editTool, globTool, grepTool } from "./tools/edit.js";

// ── cache: policy constants and TTL upkeep ──────────────────────────────────
export {
  MAX_CACHE_BREAKPOINTS,
  CACHE_LOOKBACK_BLOCKS,
  CACHE_MINIMUM_TOKENS,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  cacheMinimumFor,
  breakEvenReads,
  type CacheTtl,
} from "./cache/limits.js";
export { CacheKeeper, type CacheKeeperOptions } from "./cache/keeper.js";

// ── telemetry: where the claims get checked ─────────────────────────────────
export { Ledger, type CallRecord, type LedgerSummary } from "./telemetry/ledger.js";

// ── session: durability, lineage, and recall ────────────────────────────────
export { SessionStore, sanitizeFtsQuery, type SessionRow, type SearchHit } from "./session/store.js";
export { PersistentSession } from "./session/persist.js";
export { sessionSearchTool, sessionLineageTool } from "./session/search-tool.js";

// ── skills: accumulated procedural knowledge ────────────────────────────────
export {
  SkillLibrary,
  skillTools,
  readSkillTool,
  writeSkillTool,
  parseFrontmatter,
  type Skill,
} from "./skills/skill.js";

// ── hooks: lifecycle interception, in-process and filesystem ────────────────
export {
  HookRunner,
  HOOK_EVENTS,
  type Hooks,
  type HookContext,
  type ToolDecision,
} from "./hooks/hooks.js";

// ── subagents: bounded recursive delegation ─────────────────────────────────
export {
  subagentTool,
  DEFAULT_SUBAGENT_OPTIONS,
  type SubagentOptions,
} from "./steps/subagent.js";

// ── schedule: durable cron ──────────────────────────────────────────────────
export {
  JobStore,
  parseCron,
  cronMatches,
  nextRun,
  type Job,
  type JobRun,
  type CronFields,
} from "./schedule/cron.js";
export { Scheduler, describeJob, type JobExecutor, type SchedulerOptions } from "./schedule/runner.js";

// ── config: profiles and workspace assembly ─────────────────────────────────
export {
  buildPort,
  buildRouter,
  hybridProfile,
  cloudOnlyProfile,
  localOnlyProfile,
  type FeinConfig,
  type PortConfig,
  type BindTarget,
  type PolicyConfig,
} from "./config/profiles.js";
export {
  openWorkspace,
  CONTEXT_FILES,
  type Workspace,
  type WorkspaceOptions,
} from "./config/workspace.js";
