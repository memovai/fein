# FE!N

**世界上第一个本地与云端混合、让人上瘾的 agent harness。**

[English](./README.md) · [日本語](./README.ja.md) · [Español](./README.es.md) · 中文

---

大多数 agent harness 把循环里的每一部分都从同一个昂贵的供应商买。决定下一步做什么、
压缩 3000 行测试日志、拦住一条危险命令 —— 被当成一件事、按一件事计价、发给同一个模型。

FE!N 把循环拆成 **slot**,让你给每个 slot 绑不同的模型:前沿模型负责思考,
你笔记本上的 3B 模型负责阅读。TypeScript,**零运行时依赖**,160 个测试。

```ts
import { Agent, Router, AnthropicPort, OllamaPort, defaultTools } from "fein";

const cloud = new AnthropicPort({ id: "cloud", model: "claude-sonnet-5",
                                  apiKey: process.env.ANTHROPIC_API_KEY,
                                  costPerMTokIn: 3, costPerMTokOut: 15 });
const local = new OllamaPort({ id: "local", model: "qwen2.5:3b" });

const router = new Router()
  .bind("driver",   cloud)                          // 决定发生什么
  .bind("digester", local, { fallbacks: [cloud] })  // 压缩观测结果
  .bind("verifier", cloud);                         // 拦截子 agent 的写操作

await new Agent({ router, tools: defaultTools() }).run("测试为什么挂了?");
```

换绑定时循环代码一行不动。同一个 harness,可以全云端、全本地、或任意混合 ——
并且有一本账告诉你差别究竟花了多少钱。

## 30 秒试一下

不需要 key、不需要 GPU、不需要联网 —— demo 里所有模型都是脚本化的,
所以你看到的就是 harness 本身。

```bash
npm install && npm run demo
```

```
bindings
  driver      cloud/sonnet-sim [cloud]
  digester    local/qwen3b-sim [local] -> cloud/sonnet-sim

[2] driver · cloud/sonnet-sim cloud
是个 TypeScript 项目。跑测试套件来定位失败。
  tool shell(command: "npm test") via driver
       ok $ npm test ok 1 - unit/parser handles case 1 …
  digest shell: 3100 → 43 tok (99% smaller · local/qwen3b-sim)
  cache: prefix stable — 3 msg reused, 2 new

ledger
calls 4  ·  $0.0024  ·  0.2s
  local    1 calls   $0.0000
  cloud    3 calls   $0.0024
  cache  hit 10.1%   saved $0.0011
```

决定跑 `npm test` 的是 driver **自己** —— 它的权威没有被动过 —— 但它从没见过那 330 行日志。
一个本地模型先把它压成了 43 个 token。这份节省在剩下的每一轮里持续生效,
夺回了上下文窗口,而且原始日志从未离开这台机器。

## 那些 slot

| Slot | 职责 | 为什么可以拆出来 |
|---|---|---|
| `driver` | 决定下一步做什么 | 最难的推理。留给前沿模型 |
| `digester` | 在 driver 看到之前压缩大块输出 | 输出小于输入;节省会累积;原始数据不出本机 |
| `verifier` | 拦截子 agent 改变世界的调用 | 触发得少,所以可以贵 |
| `titler` | 给会话起名字 | 无关紧要 |

任何 slot 都能放任何模型。每个 slot 都能配回退链,所以本地 runtime 挂掉只会让那个 slot
降级到云端,而不是让整个会话停摆。

**曾经有第五个 slot,我们把它删了。** `toolformer` 负责把 driver 一句话的意图变成
具体的工具参数。实测下来,它**每次调用多花 11 到 15 个 driver 输出 token,节省为零** ——
意图必须原样携带参数,所以它在结构上永远是被替换物的超集。带数字的完整记录在
[DESIGN.md](./DESIGN.md)。教训是:**只有当被委派方能产出多于它所收到的东西,
或者知道委派方不知道的事,委派才成立。**

## 子 agent 还是 slot?

两者不是竞争关系,区别在于**你交出多少控制权**:

| | 单位 | 固定开销 | 你交出了什么 |
|---|---|---|---|
| **子 agent** | 一整个任务 | 每次启动约 600–900 token,全新上下文,冷缓存 | 中间的每一个决策 |
| **slot** | 一个决策里的一个环节 | 约 150 token | 什么都不交 |

读四十个文件找一个符号 → **子 agent**。「跑**这一条**命令,而它的输出有 2 万 token」
→ **slot**;你没法把它交给子 agent 而不同时交出「跑哪条命令」的决定权。
几次自己就能做完的工具调用 → **两个都不用**。

## 让缓存保持温热

混合执行带来一个纯云端 harness 没有的风险:通过改写供应商已经缓存的历史,
**很容易「省」出更高的账单**。FE!N 把前缀稳定性当作不变量,不是努力目标:

- **渲染单调性** —— 每次渲染都严格延长上一次。`PrefixGuard` 对每次渲染做哈希,
  一旦断裂立刻报告,并指名是哪个 slot 造成的。缓存未命中从一张账单变成一个可复现的 bug。
- **被检查的 prompt 分段** —— 系统提示由带「易变性」声明的具名分段组装,
  `SectionGuard` 会抓住一个声明为「冻结」却变了的分段。`PrefixGuard` 说
  *前缀在第 4 条消息断了*,`SectionGuard` 说 *`identity` 分段在两轮之间变了*。
  后者才是你能动手的那个。
- **考虑回溯窗口的锚点** —— 一个断点只能向后找 **20 个 content block**,
  而一轮里有六个并行工具调用就是十三个 block。两轮这样的回合,上一个锚点就出了射程,
  然后你会永远、而且悄无声息地付全价。
- **追加而非编辑** —— `registerDeferred` + `surfaceTool()` 能在会话中途加工具而
  不碰工具块;`injectContext()` 用 system 角色消息追加上下文,而不是改写系统提示。
- **用 epoch,不用滑动窗口** —— 丢掉旧消息会让其后每个 token 位移,
  于是**之后每一轮**都永久未命中。
- **有序并发** —— 并行工具的结果按**调用顺序**追加,绝不按完成顺序,
  这样 transcript 永远不依赖机器的时序。

## 给观测结果设上界

两个机制,刻意分层,因为免费的那个应该先跑。

**Spill**(不用模型):超大的工具输出写进 `.fein/spill/`,替换成首尾预览
加一个模型可以 `grep` 的路径。无损、幂等、不超上限、绝不变大。

**Digest**(一次推理):本地模型对全文做语义压缩。

两者互补,测试夹具能证明:332 行日志、唯一的失败在第 241 行 ——
预览**看不到它**,digester 找得到。所以两个都跑,而 lens 按
`digest → preview → raw` 的顺序取用。spill 还修好了 digester 最糟的性质:
丢了细节的摘要,现在有一条回到原文的路。

Digest 会**按 digester 的上下文窗口分块**,而分块上限取决于 locality ——
本地 digester 读 16 块(边际成本只是自家硬件上的墙钟时间),
云端 digester 则**直接拒绝**分块工作,因为 spill 已经免费把损失兜住了。
这个常量就是混合论点的微缩版。

## ReAct

本地模型可以**驾驶**,不只是辅助。`ReactPort` 包住任何纯文本模型,
对外呈现原生工具调用接口,所以循环从不知道 ReAct 的存在 ——
它把工具挪进提示词、把历史改写成模型说的 Thought/Action/Observation 形式、
在模型能编造自己的 `Observation:` 之前停止生成、并在本地修复格式错误的输出。

最后这点是 ReAct 的经典失败,而且是**无声的**:放着不管,模型会心安理得地写下
`Observation: 文件内容是……`,然后基于一个任何工具都没产生过的结果继续推理。
解决办法是机械的 —— 一个停止序列 —— 而不是礼貌的请求。

## 中途干预

它干活的时候你可以直接打字。你那行会在**下一个 turn 边界**送达,绝不在 turn 中间:
插在 Action 和 Observation 之间,等于在该出现工具结果的位置塞给模型一条用户消息。
第二个并发的 `run()` 会被拒绝,因为两个写入者在 transcript 上交错,
会让消息顺序取决于调度 —— 那会让缓存以间歇且无法调试的方式损坏。

## 循环卫生

ReAct 循环很少以崩溃告终,它是**继续**着死的 —— 调同一个工具、得到同一个答案、
再对它推理一遍。每一轮单看都合理,疯的只是那个序列,
而模型从内部看不见自己的循环。

`LoopGuard` 会抓重复、震荡(A→B→A→B)和停滞。判据是**同样的调用、同样的结果** ——
答案会变的重复调用是正当的(轮询构建、重试不稳定的测试),所以它不会在真实工作中误报。
每个问题只警告一次;一个重复自己的守卫,本身也是另一个循环。

轮数用尽时,会**不提供任何工具**地强制要一个真答案,而不是返回一段残留片段。
拿掉能力是保证,开口请求只是请求。

## 循环之外

全部从工作区自动发现,不需要任何配置文件。

**持久会话**(`node:sqlite`,零依赖)。`fein chat --resume <id>` 可重放。
压缩是一次 **fork**:epoch 以摘要为种子生出子会话,父会话保留全部事件,
两者的连接被记录下来。「被压缩」意味着**被转移**,不是**丢失**。
在工具调用和它的结果之间被中断的会话会在恢复时修好 ——
否则它不只是降级,而是**永久无法恢复**,因为所有供应商都拒收没有应答的工具调用。

**回忆** —— 对所有历史会话做 FTS5 检索,以 `session_search` 的形式交给模型,
而不是背着模型自动注入。工具输出刻意不建索引,所以回忆返回的是决策,不是日志行。

**身份与约定** —— `~/.fein/SOUL.md` 写的是这个 agent 是谁;它是**你的**,所以可信。
仓库里的 `SOUL.md` 会像其他项目文件一样被围起来,
因为信任边界取决于**谁能写这个文件**,而不是它叫什么名字。

**技能** —— 用 Markdown 写的可复用流程。**索引**常驻在冻结的提示词里,
**正文**按需加载。一次性把所有正文读进来,既为用不到的技能付了 token,
又意味着每写一个技能就让所有已缓存的对话失效。

**钩子** —— `.fein/hooks/<event>/` 下的函数或可执行文件。`beforeTool` **可以拒绝**;
一个只能观察的钩子是日志系统,不是安全机制。观测类钩子抛异常会被忽略,
而 `beforeTool` 抛异常会**倒向拒绝**。

**子 agent** —— 深度上限**由代码强制**,并且 `SpawnBudget` 在整棵树上按引用共享。
每个 agent 各自的上限不是上限:按 breadth^depth 增长,实测「上限 3」产生了 40 个 agent。

**定时任务** —— 持久化的 POSIX cron,跑在与交互式工作**同一套**权限机制下,
不传 `--write` 就是只读。不补跑:合着盖过了一夜的笔记本醒来时是零个待执行,不是十一个。

```bash
fein chat [--resume <id>]     fein run "<prompt>"     fein demo
fein sessions list | show <id> | search <q> | lineage <id>
fein skills list | show <name>          fein hooks
fein cron list | add | rm | enable | disable | runs | run | serve
```

## 工作区

```
~/.fein/SOUL.md                     agent 是谁(可信,第 1 层)
.fein/sessions.db  .fein/jobs.db    持久会话 + 定时任务
.fein/skills/  .fein/hooks/<event>/ 技能 + 生命周期钩子
.fein/spill/                        大块工具输出(可检索)
AGENTS.md | CLAUDE.md | SOUL.md     项目上下文(带围栏,第 2 层)
```

## 目录结构

```
src/
  core/        types · transcript(只追加日志)· loop · guards · steering
  context/     lens + PrefixGuard · spill · repair
  models/      router · react-port · providers/{anthropic,openai,ollama,scripted}
  steps/       digester · verifier · subagent · react · prompts · sections
  tools/       registry · builtin · edit/glob/grep
  cache/       limits(断点、回溯窗口、最小前缀)· keeper
  session/     store (SQLite+FTS5) · persist · search-tool
  skills/      hooks/      schedule/      telemetry/ledger
  config/      profiles · workspace        cli/       bench/
```

边界为什么这么划见 [ARCHITECTURE.md](./ARCHITECTURE.md);
每条规则背后的推理、以及**尚未解决问题的诚实清单**见 [DESIGN.md](./DESIGN.md)。

## 测试与基准

```bash
npm test               # 160 个测试
npm run bench          # 离线、确定性、免费 —— 机制本身的成本
npm run bench:live     # 真实模型 —— 回答正确性问题
```

基准会把每个机制和对照组比较,任务是特意挑的:每个机制都有一个它该赢的场景,
和一个它只会增加成本的场景。实测:digester 在它擅长的场景**便宜 88%**,
在帮不上忙的场景**贵 43%**,四个任务合计 **−58%**。
它上线后立刻回本 —— 抓到了一个 digester 被执行、被计费、
输出却被悄悄丢弃的 bug。

需要 Node ≥ 22.5(内置 `node:sqlite`)。

---

## 参考项目

FE!N 是在并排读完四个开源 harness 之后建起来的。四个都是 MIT 许可。
**没有复制任何代码** —— 有价值的是设计判断,每一处采纳都是带自己不变量和测试的全新实现。
拿了什么、拒绝了什么、什么经受住检验没有改变,都记录在
[COMPARISON.md](./COMPARISON.md)。

- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** ——
  「一切皆插件」。教会我们 **spill**(不用模型的有界预览 + 检索定位符)、
  不用模型的结果剪枝、循环卫生守卫,以及「顺序必须是规范的,因为它是缓存前缀」这条原则。
- **[pi](https://github.com/earendil-works/pi)** —— 分层的 agent 包。
  教会我们**把 turn 当作一等概念**(一次 assistant 响应加上它的所有工具调用),
  以及嵌套的事件分类。
- **[nanobot](https://github.com/HKUDS/nanobot)** —— 刻意做小、可读的内核。
  教会我们**中途干预**(用队列做 turn 中消息注入,而不是让第二个 run 去抢),
  带类型的 turn,以及让持久化历史可安全重放的那些防御性处理 ——
  正是最后这点让我们发现了一个真 bug:被中断的会话会永久无法恢复。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** ——
  把会话当基础设施,深度的上下文工程。教会我们**具名 prompt 分段**
  (它把我们自己最看重的那个不变量从约定变成了被检查的东西)、
  从压缩血缘根推导的**抗轮换缓存作用域**、用供应商上报的真实用量而不是字符估算、
  以及给错误响应体的读取设上界。

`src/cache/limits.ts` 里编码的断点数、回溯窗口、TTL 和最小前缀规则,
还参考了 Anthropic 的 prompt caching 文档,以及 Claude Code 和 Codex 的公开行为。

## 许可

MIT © Ziboyan Wang
