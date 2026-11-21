# Primary-Source Dissection: Google's Self-Improvement Memory (SIM) & Continual Recursive Self-Improvement (arXiv:2611.18856)

## Metadata & Primary Sources

- **Title**: *Self-Improvement Memory Enables Continual Recursive Self-Improvement*
- **Authors**: Xin Yu (Google Cloud AI, The Pennsylvania State University), Fei Xia, Jiaqi Pan, Youbao Tang, Chengzhi Liu (Google Cloud AI), Adams Yu, Sicong Jiang (Google DeepMind), Yanfei Chen (Google Cloud AI Research), Lingzhou Xue (Penn State), Ting Yu (Google Cloud AI)
- **Publication**: arXiv preprint `2611.18856` (Submitted 13 Nov 2026)
- **Primary URLs**:
  - Abstract: https://arxiv.org/abs/2611.18856
  - Full HTML: https://arxiv.org/html/2611.18856v1
- **Core Thesis**: Existing agent harness optimization (Recursive Self-Improvement, RSI) assumes a frozen policy model $M$ and fixed benchmark $\mathcal{X}$. When either shifts—which is the normal lifecycle of multi-model and continually evolving agents—**harness-only continuation** fails because the evolved harness code $H_S$ strips away *why* each modification was made, *what* it was predicted to fix, and *how* it performed. **Self-Improvement Memory (SIM)** equips the *outer-loop harness optimizer* (not the task policy) with a problem-grouped ledger of rationales, predicted-vs-observed deltas, and provenance, enabling **Continual Recursive Self-Improvement (CRSI)**.

### Headline Empirical Takeaways

1. **Beats Harness-Only Continuation Across Every Tested Regime**: With matched starting harnesses $H_S$, round counts ($N=10$), candidate budgets ($k=5$), and rollout budgets ($5$ per task), **Full SIM** outperforms both Harness Transfer (no SIM) and Problem-Only Memory (root causes without edit outcomes/provenance) in **6/6 cross-dataset transitions** ($+2.43$ to $+4.35$ pts over Harness Transfer) and **4/4 Opus 5.5 $\to$ Gemini 3.8 Flash cross-model transfers** ($+3.60$ to $+11.33$ pts over Harness Transfer).
2. **Eliminates Catastrophic Cross-Model Negative Transfer**: An Opus-evolved harness starts **below Gemini's un-evolved seed** in all 4 domains ($-0.60$ to $-5.48$ pts), and Harness Transfer still finishes below Cold Start in 3/4 domains. Full SIM recovers and finishes highest in all 4 (e.g., Workspace: $68.41 \to 84.75$ vs. $73.42$ Harness Transfer).
3. **Statistically Significant Paired Gains**: Across $10$ independent Terminus-2 coding source runs (TB2.1 $\to$ TB4), paired continuation with SIM outperforms No-SIM in **9 of 10 runs** by a mean of **$+2.36$ points** ($95\%$ CI $[1.05, 3.68]$, paired $t(9)=4.06$, $p=0.003$, $d_z=1.28$).
4. **Source Retention Without Freezing**: On TB2.1 $\to$ TB4 (AHE seed), Full SIM loses only $3/225$ held-out source rollouts ($90.22 \to 88.89$) vs. $6/225$ for Harness Transfer ($87.56$), while gaining $+6.67$ on TB4.

---

## 1. Problem Formulation: From Fixed-Setting RSI to CRSI (§3.1)

### 1.1 Single-Setting Harness RSI

Following Meta-Harness ([Lee et al., 2026](https://arxiv.org/abs/2603.28052)), an agent system pairs a frozen policy model $M$ with an executable harness $H$ controlling context assembly, tools, middleware, parsing, and execution flow (§1, §3.1). A setting is $\sigma = (M, \mathcal{X})$ with disjoint evolve and held-out splits $\mathcal{X}^{\mathrm{evo}}$ and $\mathcal{X}^{\mathrm{eval}}$, scored by $J(H; M, \mathcal{X})$.

In an $N$-round RSI run ($t = 0, \dots, N-1$), the evaluator executes $H_t$ exclusively on $\mathcal{X}^{\mathrm{evo}}$ to return scores, traces, and errors $F_t$ (held-out splits stay strictly outside the optimization loop). Given run history $\mathcal{D}_t$ (earlier feedback and code diffs), two LLM-based harness-engineering roles—**Proposer $P$** and **Selector $\mathcal{S}$**—iterate via Equation (1):

$$\mathcal{C}_t = P(H_t, F_t, \mathcal{D}_t), \qquad H_{t+1} = \mathcal{S}(H_t, F_t, \mathcal{C}_t, F_t^{\mathcal{C}})$$

where $\mathcal{C}_t$ are $k$ candidate harnesses, $\mathcal{S}$ pre-screens proposals before costly rollouts and scores survivors ($F_t^{\mathcal{C}}$) weighing performance, complexity, domain specificity, and regression risk, and $H_{t+1} = H_t$ if none is accepted.

### 1.2 Continual Recursive Self-Improvement (CRSI)

After source RSI in $\sigma_S = (M_S, \mathcal{X}_S)$ yields a retained harness $H_S$, CRSI resumes optimization from $H_S$ in a new target setting $\sigma_T = (M_T, \mathcal{X}_T)$ under a shared executable harness interface (§3.1):

- **Cross-Dataset CRSI** ($\mathcal{X}_S \neq \mathcal{X}_T$, $M_S = M_T$): Policy stays fixed while task distribution, verifier contracts, or grading rubrics shift (e.g., Terminal-Bench 2.1 $\to$ Terminal-Bench 4).
- **Cross-Model CRSI** ($M_S \neq M_T$, $\mathcal{X}_S = \mathcal{X}_T$): Benchmark and splits stay fixed while the underlying policy switches—covering both **model-family transfer** (e.g., Claude Opus 5.5 $\to$ Gemini 3.8 Flash), **generational upgrades** (Gemini 2.5 Flash $\to$ 3.5 $\to$ 3.8 $\to$ 4 Argon), and **multi-model shared serving** (Grok 4.20 Reasoning + Opus 5.5 + Gemini 3.8 Flash).

**Why naive transfer breaks (§1, §4.2–4.3)**: Source gains ($+2.75$ to $+6.41$ pts across all 6 source runs, Appendix E.1) do not guarantee a better target start. In Text Classification (`FewShotAll`), the source-evolved harness starts at $72.92$ vs. seed $75.72$. Across model families (Opus $\to$ Gemini), the Opus-evolved harness underperforms Gemini's un-evolved seed in **every single domain** ($-0.60$ to $-5.48$ pts). Without knowing *why* inherited harness code exists, target optimization either **reverts useful invariant principles** (Engineering §F.5.4) or **blindly re-edits complex gates into deadlocks** (Coding Fig. 10b, §F.3).

---

## 2. Self-Improvement Memory (SIM): Architecture, Schema & Loop (§3.2–3.3, Appendix D)

A decisive architectural boundary separates SIM from task-agent memories (such as Reflexion, Voyager, ExpeL, ReasoningBank, ACE, or Text Classification's evaluation-time `FewShotAll` example store, Appendix A.3 & B.4): **SIM serves the harness optimizer $(P, \mathcal{S})$, not the task-solving policy $M$.**

### 2.1 Problem-Grouped Memory Representation (Eq. 2 & Appendix D.3)

SIM ($\mathcal{M}_t = \{m_i\}$) organizes evolutionary history by **recurring harness problem / root-cause hypothesis $c_i$** (e.g., `P5: "premature completion without execution verification"`):

$$m_i = \Big(c_i,\; \big[(a_{ij}, o_{ij}, p_{ij})\big]_j\Big)$$

where $j$ indexes sequential attempts addressing $c_i$:
1. **$a_{ij}$ (Modification & Rationale)**: `what` (natural-language edit intent and reasoning), `files` modified, and `accepted` (whether $\mathcal{S}$ promoted the candidate).
2. **$o_{ij}$ (Predicted vs. Observed Outcomes)**: Pre-evaluation `predicted` task IDs expected to be fixed, audited afterward against `fixed` (realized), `missed` (unresolved predictions), and overall evolve-set `passed / total` counts.
3. **$p_{ij}$ (Provenance & Eval Context)**: `domain` / benchmark, policy model, `round`, `sample`, and cross-run lineage (`carried_from`, `backfilled`, `aliases`).

In JSON storage (Appendix D.3, Figures 8 & 9), each problem entry uses `{ id, name, opened_round, attempts[], carried_from?, aliases? }` and each attempt uses `{ round, sample, accepted, backfilled, what, files, predicted, fixed, missed, passed, total, domain }`.

### 2.2 Conditioned Proposer–Selector Loop & Deterministic Update (Eq. 3, Appendix D.1)

At round $t$, both $P$ and $\mathcal{S}$ receive the **entire SIM JSON in their system prompts without embedding retrieval or truncation** (§3.2, Appendix D.1):

$$\mathcal{C}_t = P(H_t, F_t, \mathcal{D}_t;\; \mathcal{M}_t), \qquad H_{t+1} = \mathcal{S}(H_t, F_t, \mathcal{C}_t, F_t^{\mathcal{C}};\; \mathcal{M}_t)$$

- **Entry Matching (Appendix D.1)**: No separate similarity model is used. Before evaluation, the Proposer explicitly declares in the round's change manifest whether a diagnosis maps to an existing `id` or opens a new problem entry. Entries with identical root-cause text merge deterministically while preserving all attempts and recording merged IDs in `aliases` (e.g., `P6 -> P5`).
- **Update Rule (§3.2)**: Only the selected candidate is appended as $e_t$ via $\mathcal{M}_{t+1} = U(\mathcal{M}_t, e_t)$ (if $\mathcal{S}$ accepts nothing, $e_t = \emptyset$ and $\mathcal{M}_{t+1} = \mathcal{M}_t$). Crucially, **regression or failed predictions on an accepted edit are still recorded** (`missed: [...]`), and **replaced edits are never deleted from SIM** (e.g., `P8` round 4 blocking logic was later reverted in the final harness, yet its attempt and unresolved outcome stay visible in SIM, Appendix F.2 & F.6).

### 2.3 Eight Prompt Principles for Cross-Regime Adaptation (Appendix D.2)

During CRSI, $P$ and $\mathcal{S}$ follow eight explicit guidelines when reading $\mathcal{M}_S$:
1. Treat SIM entries as prior experience, retaining freedom to choose a different edit.
2. Always inspect the provenance (`domain`, benchmark, policy model) behind each entry.
3. Start from an existing diagnosis $c_i$ whenever it explains the current failure.
4. **Reuse the rationale while reassessing the implementation** after a benchmark or model change.
5. Revise, replace, or override an inherited edit when new target evidence warrants it.
6. Revisit a previously failed/tried direction only when new evidence justifies another attempt.
7. Open a new problem entry when existing diagnoses cannot explain a target failure.
8. **Weight task-specific outcome evidence higher in similar settings, and discount it when both benchmark and model change.**

---

## 3. Benchmarks, Baselines & Empirical Results (§4, Appendices B–E)

### 3.1 Experimental Protocol & Benchmarks (Appendix B, Table 4 & Appendix C)

Every run uses $N=10$ rounds, $k=5$ candidate proposals/round, and $5$ rollouts/task on disjoint ~50/50 unstratified evolve/held-out splits (Gemini 3.8 Flash as Proposer & Selector in main runs; one coding round takes ~4 hours, Appendix C.1). Four controlled transfer conditions share identical budgets (Figure 5, §3.3):
- **Cold Start** $(H_0, \emptyset)$: starts from un-evolved seed harness, no SIM.
- **Harness Transfer** $(H_S, \emptyset)$: starts from source-evolved harness $H_S$, no SIM (retains only target run history $\mathcal{D}_t$).
- **Problem-Only Memory** $(H_S, \mathcal{M}_S^c)$: starts from $H_S$ with root-cause labels $c_i$ only (strips edits, outcomes, provenance).
- **Full SIM** $(H_S, \mathcal{M}_S)$: starts from $H_S$ with full SIM, updated throughout target RSI.

| Domain | Source ($\mathcal{X}_S$) & Seed $H_0$ | Target ($\mathcal{X}_T$) | Tasks (Evo / Eval) | Scoring Metric |
| :--- | :--- | :--- | :--- | :--- |
| **Coding** | Terminal-Bench 2.1 (89 tasks) — AHE seed & Terminus-2 | Terminal-Bench 4 (66 tasks) | 33/165 evo, 33/165 eval | `pass@1` (0–100) |
| **Text Cls.** | 3-dataset suite: LawBench, Symptom2Disease, USPTO-50k (412 ex) — `NoMemory` & `FewShotAll` | 8-dataset suite: AG News, GoEmotions, Banking77, Financial PhraseBank, SciCite, TweetEval-Hate, Amazon5, SciTail (1,000 ex) | 500/2,500 evo, 500/2,500 eval | Pooled accuracy |
| **Workspace** | Harvey LAB (160 tasks) — RRSI ReAct toolbelt (6 files, 1,743 lines) | Equal-weight mean of JobBench (65), GDPval (220), APEX-Agents (480) = 765 tasks | 382/1,910 evo, 383/1,915 eval | Rubric / Win-rate / `pass@1` (Gemini 3.8 Flash judge) |
| **Engineering** | EngDesign (67 tasks) — ReAct + bare prompt/wrapper (7 files, 1,857 lines) | Frontier-Eng (47 tasks; 7 overlapping sub-problems scored 0 in denominator) | 24/120 evo, 23/115 eval | Frozen verifier medal score (`1.00`/`0.67`/`0.33`) |

### 3.2 Cross-Dataset & Cross-Model CRSI (Tables 5 & 6, Figures 2 & 3)

**Cross-Dataset CRSI (Fixed policy: Gemini 3.8 Flash, Table 5)**: Held-out target scores before $\to$ after target RSI:

| Domain / Seed | Cold Start | Harness Transfer | Problem-Only | **Full SIM (ours)** | SIM Gain vs. Harness Transfer |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Coding / AHE | $16.36 \to 19.39$ | $18.18 \to 20.61$ | $18.18 \to 18.79$ | $18.18 \to \mathbf{24.85}$ | **$+4.24$** |
| Coding / Terminus-2 | $18.18 \to 19.39$ | $19.39 \to 19.39$ | $19.39 \to 20.61$ | $19.39 \to \mathbf{21.82}$ | **$+2.43$** |
| Text Cls. / `NoMemory` | $68.60 \to 72.00$ | $71.40 \to 71.00$ | $71.40 \to 73.40$ | $71.40 \to \mathbf{73.60}$ | **$+2.60$** |
| Text Cls. / `FewShotAll` | $75.72 \to 75.92$ | $72.92 \to 74.12$ | $72.92 \to 75.52$ | $72.92 \to \mathbf{77.92}$ | **$+3.80$** |
| Workspace / ReAct | $73.89 \to 82.98$ | $74.93 \to 85.07$ | $74.93 \to 85.54$ | $74.93 \to \mathbf{87.89}$ | **$+2.82$** |
| Engineering / ReAct | $39.13 \to 40.87$ | $39.13 \to 42.61$ | $39.13 \to 42.61$ | $39.13 \to \mathbf{46.96}$ | **$+4.35$** |

**Cross-Model CRSI (Claude Opus 5.5 source $\to$ Gemini 3.8 Flash target, fixed target benchmarks, Table 6)**:

| Domain / Seed | Cold Start (Gemini) | Harness Transfer | Problem-Only | **Full SIM (ours)** | SIM Gain vs. Harness Transfer |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Coding / AHE | $16.36 \to 19.39$ | $13.94 \to 18.18$ | $13.94 \to 20.61$ | $13.94 \to \mathbf{21.82}$ | **$+3.64$** |
| Text Cls. / `FewShotAll` | $78.32 \to 82.72$ | $77.72 \to 80.20$ | $77.72 \to 81.32$ | $77.72 \to \mathbf{83.80}$ | **$+3.60$** |
| Workspace / ReAct | $73.89 \to 82.98$ | $68.41 \to 73.42$ | $68.41 \to 79.22$ | $68.41 \to \mathbf{84.75}$ | **$+11.33$** |
| Engineering / ReAct | $39.13 \to 40.87$ | $34.78 \to 42.61$ | $34.78 \to 46.96$ | $34.78 \to \mathbf{50.43}$ | **$+7.82$** |

Key finding: **Problem-Only Memory is unreliable**—ranging from $-1.82$ below Harness Transfer (Coding/AHE) to $+2.40$ above (Text/`NoMemory`). Knowing *what problem occurred* without *what edit was attempted, what it predicted, and whether it worked* is insufficient; **Full SIM wins 10/10 settings**.
### 3.3 Generational Upgrades, Shared Multi-Model Harness & Statistical Validation (§4.3.2–4.4, Appendix E)

- **Generational Chain on TB2.1 (Table 1, §4.3.2 & C.5)**: Carrying $(H, \mathcal{M})$ sequentially across Gemini generations vs. Fresh RSI from seed:
  - `Gemini 2.5 Flash`: Seed $17.8$ | Fresh RSI $21.4$ | CRSI $\mathbf{22.4}$ ($+1.0$, tests SIM within initial run)
  - `Gemini 3.5 Flash`: Seed $70.2$ | Fresh RSI $73.3$ | CRSI $\mathbf{76.8}$ ($+3.5$)
  - `Gemini 3.8 Flash`: Seed $87.2$ | Fresh RSI $88.9$ | CRSI $\mathbf{90.5}$ ($+1.6$)
  - `Gemini 4 Argon`: Seed $89.7$ | Fresh RSI $\mathbf{95.6}$ | CRSI $94.8$ ($-0.8$) — an instructive boundary case showing that large base-capability leaps can temporarily favor fresh search over inherited constraints.
- **One Shared Harness for Multiple Models (Table 2, §4.3.3 & C.6)**: On the 8-dataset text-classification suite evaluated equally across **Grok 4.20 Reasoning, Claude Opus 5.5, and Gemini 3.8 Flash**:
  - `B1` (Per-model separate harnesses): $77.40$ evolve / $75.20$ held-out ($76.30$ all)
  - `B2` (Shared seed): $72.36$ evolve / $73.28$ held-out ($72.82$ all)
  - `S1` (Sequential CRSI: Grok $\to$ Gemini $\to$ Opus): $76.72$ evolve / $74.20$ held-out ($75.46$ all)
  - `S2` (**Unified synthesis** pooling feedback from all 3 models per round): $\mathbf{78.92}$ evolve / $\mathbf{75.24}$ held-out ($\mathbf{77.08}$ all — matches per-model specialization with a *single* harness!)
  - `S3` (Naive single-model harness transfer across the 3 models): Grok-evolved collapses to $66.84$ held-out; Gemini-evolved $71.24$; Opus-evolved $72.24$.
- **10-Pair Coding Replication (Table 3, §4.4 & Fig. 4c)**: Ten independent Terminus-2 source runs on TB2.1 each branched into paired 10-round TB4 runs (No SIM vs. SIM) from the exact same $H_S$ (mean start $18.36$). **SIM wins 9 of 10 pairs** (only Run 8 is $-0.61$):
  - Mean final: **$21.70$ (SIM)** vs. **$19.33$ (No SIM)** $\implies$ mean paired $\Delta = \mathbf{+2.36}$ ($95\%$ CI $[1.05, 3.68]$, two-sided paired $t(9)=4.06$, $p=0.003$, signed-rank $p=0.006$, $d_z=1.28$).
  - Speed & source retention: SIM surpasses the strongest control's final score ($20.61$) by **Round 5** (AHE) and **Round 2** (Terminus-2). On AHE held-out TB2.1 retention (Figure 7, Appendix E.3), Full SIM drops only $3/225$ rollouts ($90.22 \to 88.89$) vs. $4/225$ for Problem-Only ($88.44$) and $6/225$ for Harness Transfer ($87.56$, dipping to $86.67$ at round 2).
- **Optimizer-Model Ablation (Table 7, Appendix E.4.2)**: Swapping Proposer/Selector from Gemini 3.8 Flash to Opus 5.5 during TB2.1 source RSI improves held-out score by $+1.06$ on AHE ($90.22 \to 91.28$) and $+0.05$ on Terminus-2 ($91.56 \to 91.61$).

---

## 4. Mechanistic Case Studies & Transferability Taxonomy (Appendix F)

### 4.1 Why Harness-Only Continuation Fails in Practice (Figures 8–11, §F.2–F.4)

1. **Premature Completion vs. Solution Quality (`P5` $\to$ `P8`, §F.2 & §F.3)**:
   - On TB2.1 (`P5`, `coding_enriched`), `Terminus-2` originally allowed `task_complete: true` without execution evidence (`configure-git-webserver` failed SSH because `user` was never created). Over source rounds `r6`, `r8`, `r10`, RSI built `execution_gating_interlock.py` (growing to 275 lines, 4 rejection paths), lifting `configure-git-webserver` and `circuit-fibsqrt` from $1/5$ to $5/5$.
   - On TB4 (`photonic-waveguide-routing`, `P8`), the agent ran `check_routing.py`, satisfied all constraints (passing P5's 4 checks), yet stopped at a **feasible but suboptimal** route cost.
   - **With SIM**: In target R2, Proposer read `P5` (understanding *why* the gate existed), preserved its 4 execution invariants, and opened `P8` to check feasibility vs. theoretical bounds (`detect_optimization_feasibility_notice`), later escalating to a block in R4 and adjusting to warning+infeasibility block. Even though R2 & R4 did not solve `photonic-waveguide-routing` (`fixed: []`, `missed: [...]`), SIM retained both attempts so later rounds did not regress or re-try blind blocks.
   - **Without SIM (Figure 10b)**: The optimizer misattributed the inherited gate to its own R1 edit, modified the gate **four separate times**, introduced completion deadlocks, and spent R3 and R7 repairing self-inflicted deadlocks.
2. **Accumulating Evidence Across Settings (`P3`, Figure 11, §F.4)**: Under root cause *"deliverable internally valid yet violates verifier's external schema/contract"*, TB2.1 R4 (`1/4` fixed: `gpt2-codegolf`), TB4 R5 (`0/2` fixed), and TB4 R6 (`1/2` fixed: `embedding-drift-monitor`) append under one shared diagnosis, tracking unresolved predictions across shifts.
3. **Preventing Blind Reverts (Engineering, §F.5.4)**: Harness Transfer reverted inherited source prompt guidelines in R1, whereas Full SIM retained and extended them because their rationale remained documented.
### 4.2 What Transfers vs. What Breaks Across Shifts (Table 8, §F.5–F.6)

The paper's cross-domain audit (§F.5, Table 8) separates **harness invariants** from **model- or setting-bound hacks**—a taxonomy directly actionable for multi-model desktop agents:

| Transfer Behavior | Dataset Shift Examples | Policy-Model Shift Examples (Opus $\leftrightarrow$ Gemini) |
| :--- | :--- | :--- |
| **Reused Directly** | Container/shell execution layer; BM25 indexing; soft-gate hook point before `final_answer`; central tool-registry interception point | Process/interlock accounting; indexing & query sanitization; system-prompt injection pipeline; deliverable tracker |
| **Adapted / Recalibrated** | Paste-buffer key normalization & foreground detection; BM25 top-$k$ & class quotas; FS probe $\to$ tool invocation probe; deliverable check $\to$ checkpointing | Retrieval budgets ($k$); budget-triggered sparse interventions (Opus `600s` wall-clock $\times 3$ vs. Gemini `0.75`/`0.80` step-ratio; zero-score rates $0.09\%$ vs. $4.49\%$) |
| **Inherited & Extended** | Completion contract predicates (adding optimality/schema checks); routing skeleton; context truncation budgets | Lifecycle control & interception heuristics; rubric taxonomy with counterexamples; composable soft-gate predicates |
| **Setting- / Model-Specific (Fragile)** | Source-only predicates; SMILES normalization; evaluator-specific `write_file` registration assumptions | **JSON/quote parser repairs** tuned to one model's syntax quirks (§F.1.2, §F.5.1); **answer-first decoding schema** for Gemini truncated reasoning; model failure-rate thresholds |

---

## 5. Comparison Against Prior Self-Improving Agent Paradigms

| Paradigm | Representative Work | What Evolves & Selection Signal | Cross-Shift Memory / Provenance | Why It Falls Short in CRSI (Model/Task Shifts) |
| :--- | :--- | :--- | :--- | :--- |
| **Programmatic Meta-Search** | [ADAS](https://arxiv.org/abs/2408.08435) (Hu et al., 2024) | Meta-agent programs agent workflows in Python from scratch using a linear archive of code + scalar scores | Linear code/score archive on a single benchmark | Retains *code + final score* without root-cause grouping, rationale, or predicted-vs-observed deltas across regimes |
| **Textual Backpropagation** | [TextGrad](https://arxiv.org/abs/2406.07496) (Yuksekgonul et al., 2024) | Static computation-graph nodes (prompts, code, molecules) via LLM textual gradients | Ephemeral gradients within one optimization pass | No persistent problem-clustered edit history or provenance for re-evaluating edits after model/data swap |
| **Open-Ended Self-Rewriting** | [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) (Zhang et al., 2025); [Hyperagents](https://arxiv.org/abs/2603.19461) (Zhang et al., 2026) | Agent codebase (and meta-editor in Hyperagents) mutated in a phylogenetic tree, gated by coding benchmarks | Lineage tree of agent snapshots + benchmark scores | Preserves *ancestry of snapshots*, not why specific harness predicates exist or which predictions failed under prior models |
| **Algorithmic Evolutionary Search** | [AlphaEvolve](https://arxiv.org/abs/2506.13131) (DeepMind, 2025) | Target algorithms/kernels mutated by Gemini against automated formal evaluators (evolutionary database) | Population database of candidate programs + scores | Optimizes target problem artifacts under a stationary evaluator; does not curate cross-model harness rationale |
| **Fixed-Setting Harness RSI (Harness-Only)** | [Meta-Harness](https://arxiv.org/abs/2603.28052); [AHE](https://arxiv.org/abs/2604.25850); [RRSI](https://arxiv.org/abs/2609.24972) | Full harness code/middleware via rich trace filesystem (`Meta-Harness`) or regularized diffs (`RRSI`) | Run-local diffs/traces $\mathcal{D}_t$ (not carried as structured problem memory) | In CRSI, **Harness Transfer** loses *why* $H_S$ edits exist, causing deadlocks (Fig. 10b), blind reverts (§F.5.4), and negative transfer (Table 6) |
| **Root-Cause-Only Continuation** | Ablation $\mathcal{M}_S^c$ in `2611.18856` (§4.2, §E.4.1) | Same $H_S$ + list of root-cause strings $c_i$ | Problem names only (no $a_{ij}, o_{ij}, p_{ij}$) | Unstable ($-1.82$ to $+2.40$ vs. Harness Transfer): knowing a bug existed without what failed/worked invites redundant edits |
| **Task-Policy Experiential Memory** | Reflexion (2023); Voyager (2024); ACE; ReasoningBank (2026) | Inference-time playbooks, skills, or verbal reflections consumed by the *task policy $M$* | Task-level lessons / skill library | Helps $M$ execute tasks, not the *outer optimizer $(P, \mathcal{S})$* decide whether to keep, revise, or prune harness code |
| **CRSI + Full SIM (This Paper)** | Yu et al. (`2611.18856`, Nov 2026) | Outer-loop harness $H$ around changing $(M, \mathcal{X})$ | Problem-clustered $(c_i, [(a_{ij}, o_{ij}, p_{ij})])$ including unresolved & replaced edits | Carries diagnosis, rationale, prediction-vs-reality delta, and provenance—enabling principled reuse, adaptation, or retirement |

Note also adjacent continual-harness memory works cited in `2611.18856` §2 & §A.3: [Causal Improvement Graph](https://arxiv.org/abs/2610.05039) (links evidence, hypotheses, interventions, outcomes), [HarnessBank](https://arxiv.org/abs/2607.13683) (groups candidate harnesses by component/failure), [SkillHone](https://aclanthology.org/2026.emnlp-industry.105/) (persistent skill decision history), and [PluginRSI](https://arxiv.org/abs/2609.32423) (reusable plugin library). SIM's distinct contribution is proving under controlled matched-budget CRSI protocols across 4 domains that **retaining full problem-grouped edit rationale + predicted-vs-observed deltas + provenance** decisively beats both harness-only and problem-only continuation when models or distributions shift.

---

## 6. Strategic Bullseye for Sugent: Why a BYOK Multi-Model Workbench Needs SIM

Sugent is *structurally* a continual multi-model, multi-domain CRSI system in production—even when a single user runs it on one laptop:

### 6.1 Sugent Faces Three Simultaneous CRSI Shifts by Construction

1. **Continuous BYOK Cross-Model Switching ($M_S \neq M_T$)**:
   - [`gateway.ts`](../../src/sugent/gateway.ts) (`resolveSugentGatewayConfig`, `selectModelForRole`, `DEFAULT_ROLE_ROUTING`) and [`provider-registry.ts`](../../src/sugent/provider-registry.ts) (`LLM_PROVIDER_PRESETS`, `ProviderRegistry`) decouple Sugent across 10 provider modes (`openai`, `anthropic`, `deepseek`, `gemini`, `gemini-web2api`, `openrouter`, `ollama`, `cowork`, `custom-openai`, `modelflare-legacy`) and `GatewayProviderMode` (`"byok" | "subscription" | "modelflare" | "external"`).
   - A user who crystallizes workflow skills or Cordis plugins while `executor` runs `anthropic/claude-sonnet-4-5` will routinely switch `executor` to `deepseek/deepseek-chat`, Gemini, GPT, or local Ollama—or upgrade model generations (`Table 1` regime).
   - **Empirical risk proven by `2611.18856` Table 6**: An evolved harness transferred between model families (`Opus 5.5 -> Gemini 3.8 Flash`) started **below the raw seed harness in 4/4 domains** and finished **below Cold Start in 3/4 domains** without SIM (`73.42` vs. `82.98` Cold Start on Workspace; `84.75` with Full SIM). Prompt patches, JSON-parsing repairs, and step-budget warnings evolved for Claude become **toxic baggage** on DeepSeek or local models if Sugent lacks SIM provenance.
2. **Heterogeneous Multi-Role Co-Serving (§4.3.3 `S2` Unified Synthesis Regime)**:
   - Sugent's [`gateway.ts`](../../src/sugent/gateway.ts) (`ModelRole` in [`types.ts`](../../src/sugent/types.ts)) routes one harness across **four distinct models at the same time**: `assessor` (`deepseek/deepseek-chat`), `executor` (`anthropic/claude-sonnet-4-5`), `computer_use`, and `steward` (`deepseek/deepseek-chat`).
   - Any shared harness artifact—a `SKILL.md` SOP, a Cordis `.mjs` plugin in `dsh-runtime/plugins/` or `<dataDir>/self-repo/extensions/plugins/`, or `ProactiveRulePolicy`—is executed or judged by *different* models across roles, matching Table 2 (`S2: Unified synthesis` vs. `S3: Single-model collapse`).
3. **Personal Multi-Source Domain Drift ($\mathcal{X}_S \neq \mathcal{X}_T$)**:
   - [`types.ts`](../../src/sugent/types.ts) defines 8 personal trigger sources (`PersonalSourceKindId`: `github`, `im_channel`, `schedule`, `filesystem`, `mail_calendar`, `webhook`, `cowork_hitl`, `antigravity`). A completion gate or skill crystallized during coding (`github`/`antigravity`) can mis-fire on office deliverables (`mail_calendar`/`im_channel`), reproducing the exact `P5` (execution check) $\to$ `P8` (feasible $\neq$ optimal / rubric mismatch) shift documented in `2611.18856` Appendix F.2.

### 6.2 Why Sugent's Current Self-Evolution Is "Harness-Only Continuation"

[`self-evolution.ts`](../../src/sugent/self-evolution.ts) implements a strong **safety perimeter**, not an **epistemic evolution ledger**:
- **Dual-mode execution**: Full-Source Git Mode (`src/sugent/`, `ui/`, `dsh-runtime/plugins/`, `skills/`, verified by `npm run verify:sugent`) vs. Packaged `app.asar` Overlay Mode (`getOverlayRepoDir(dataDir)` $\to$ `<dataDir>/self-repo/extensions/{plugins/*.mjs, skills/*/SKILL.md}`, enforced at runtime by [`amb-self-edit-gate.mjs`](../../dsh-runtime/plugins/amb-self-edit-gate.mjs) via Cordis `tools/pre-execute`).
- **Missing SIM fields**: `SelfEvolutionPlan` (`goal`, `baseCommit`, `touchedFiles`, `assessments`, `overallRisk`, `verificationCommand`) and `SelfEvolutionPluginManifest` (`{ id, apiVersion, name?, version? }`, `SUGENT_PLUGIN_API_VERSION = 1`) check **which files can be touched** (`autonomous | requires_approval | forbidden`), **not why an edit was introduced (`c_i`), what concrete failure it predicted fixing (`predicted`), whether observed runs confirmed it (`fixed`/`missed`), or under which `(role, modelId)` from `gateway.ts` it was validated (`p_ij`)**.
- **Blunt rollback**: Without SIM provenance, packaged mode falls back to `resetSelfEvolutionOverlay(dataDir)`, which archives the *entire* `extensions/` directory to `self-repo.backup-<ts>`—wiping healthy invariant skills alongside broken model-specific patches instead of selectively revising or retiring offending edits.

---

## 7. Direct Architectural Mapping: SIM Schema $\to$ Sugent Core Modules

### 7.1 One-to-One Schema Mapping Table

| Google SIM Concept (`2611.18856` §3.2, App. D.3) | Target Sugent Module(s) | Exact Existing Primitives & Current Gap | Required SIM Augmentation (Zero-Intrusion in `src/sugent/`) |
| :--- | :--- | :--- | :--- |
| **1. Recurring Harness Problem Cluster ($c_i$)** (`id`, `name`, `opened_round`, `aliases`) | [`knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts) & [`stewardship-ledger.ts`](../../src/sugent/stewardship-ledger.ts) | `SugentKnowledgeGraph` stores `KGNode` (`workflow`, `tool`, `concept` + `reinforcements`), temporal edge tombstones (`KGEdge.supersededAt`), and crystallizes `SKILL.md` at `SKILL_CRYSTALLIZE_THRESHOLD = 3` (`crystallizeSkillsToDir`). Explicit falsification tombstones (`ValueGuardrail.kind === "tombstone"`) live in `StewardshipLedger` (and `TOMBSTONES.md` in `antigravity-bridge.ts`), **but neither links to failed harness-edit clusters**. | Bind each problem cluster `problemId` (`P#`) to: (a) target `workflow`/`SKILL.md` or `sugent-ext-*` node; (b) `KGEdge.supersededAt` when a superseded edit retires; and (c) `ValueGuardrail` (`kind: "tombstone"`) when an edit fails/regresses (`missed` / owner-rejected), keeping P8-style failed-attempt history visible so new models do not repeat falsified fixes (`证伪墓碑防重犯`). |
| **2. Edit Rationale & Hypothesis ($a_{ij}$)** (`what`, `files`, `accepted`, `carried_from`) | [`self-evolution.ts`](../../src/sugent/self-evolution.ts) & [`amb-self-edit-gate.mjs`](../../dsh-runtime/plugins/amb-self-edit-gate.mjs) | `SelfEvolutionPlan` (`goal`, `baseCommit`, `touchedFiles`, `overallRisk`) and `SelfEvolutionPluginManifest` (`id`, `apiVersion`) track *file risk* only; `SKILL.md` templates carry only `name`/`description`/steps. | Extend `SelfEvolutionPlan` / plugin sidecar / `SKILL.md` metadata with `problemId`, `rationale`, `hypothesis`, and `portabilityClass` (`"interface_invariant" \| "threshold_tunable" \| "model_specific"` per Paper Table 8). Enable per-entry deprecation instead of nuclear `resetSelfEvolutionOverlay()`. |
| **3. Predicted vs. Observed Outcome Delta ($o_{ij}$)** (`predicted`, `fixed`, `missed`, `passed`, `total`) | [`causal-ledger.ts`](../../src/sugent/causal-ledger.ts) | `CausalLedger` writes SHA-256 hash-chained `CausalFactRecord` JSONL (`round_triggered`, `gate_evaluated`, `worker_claimed`, `approval_requested`, `approval_decided`, `round_completed`, `circuit_broken`) and renders `explainWhy(roundId)`. **No pre-edit `predicted` field or post-edit delta check exists.** | Add optional `simAttemptRef` (`problemId`, `attemptId`, `predictedOutcomes[]`) and post-round observation reconciliation (`fixed`, `missed`, `regressionDetected`, `ownerApproved: boolean` from `approval_decided`). In a personal OS without unit tests for every life task, **owner rejection (`approved === false`), `circuit_broken` (`hopCount > 8`), and post-edit retries** serve as frozen empirical failure signals. |
| **4. Model & Eval Provenance ($p_{ij}$)** (`domain`, `benchmark`, `policy`, `round`) | [`gateway.ts`](../../src/sugent/gateway.ts), [`provider-registry.ts`](../../src/sugent/provider-registry.ts) & [`kernel.ts`](../../src/sugent/kernel.ts) | `CausalFactInput` records `modelRole` and `source` (`PersonalSourceKindId`), **but omits the resolved model ID** returned by `selectModelForRole(config, role)` (e.g., `deepseek/deepseek-chat` vs. `anthropic/claude-sonnet-4-5`) and `ProviderRecord.preset`. | Persist exact `(modelRole, resolvedModelId, providerPreset, sourceKind, ruleVersion)` on every `CausalFactRecord` and SIM attempt. When `gateway.ts` / `ProviderRegistry` switches models for any role, mark `model_specific` and `threshold_tunable` edits from $M_{\text{old}}$ as `needs_revalidation` and inject SIM rationale into `buildSelfEvolutionPromptSection()` / `steward` review. |

### 7.2 Actionable Architectural Takeaways for Sugent's Next-Gen Autonomy Loop

1. **Keep SIM as an Optimizer-Side Store (`SugentSIMStore`), Separate from Task Memory**: Following `2611.18856` §3.2, keep `SugentSIMStore` (`<dataDir>/self-evolution-sim.json` + hash-linked entries in `CausalLedger`) scoped to the *evolution / reflection loop* (`self-evolution.ts` and the planned `memory-gardener.ts` in [2026-11-20-jarvis-personal-os-and-antigravity-bridge.md](../../docs/plans/2026-11-20-jarvis-personal-os-and-antigravity-bridge.md#L377)), never polluting routine task-answering context windows unless self-editing or re-validating after a model switch.
2. **Adopt Prompt-Injected Full SIM Before Adding Embedding Retrieval**: `2611.18856` §D.1 proves that for compact problem-clustered edit ledgers (typically 5–30 recurring harness issues), injecting the full structured SIM JSON directly into Proposer/Selector (`steward` / `executor`) beats similarity retrieval and avoids external vector-DB dependencies—aligning with `AGENTS.md` (*Few concepts. Few settings.*) and `mode: "none"` 100% local offline sovereignty.
3. **Use Table 8 Portability Tagging to Triage BYOK Model Switches**: Whenever `ProviderRegistry` switches `executor` or `assessor` (e.g., Claude $\leftrightarrow$ DeepSeek $\leftrightarrow$ Gemini $\leftrightarrow$ Ollama), preserve `interface_invariant` predicates (like `kernel.ts` `DEFAULT_MAX_HOPS = 8` or `security-envelope.ts` isolation), auto-flag `model_specific` parser/prompt hacks for re-evaluation, and apply `S2 Unified Synthesis` (Table 2) when evolving shared `SKILL.md` rules consumed by multiple roles simultaneously.
4. **Integrate Falsification Tombstones Directly Into the Evolution Loop**: Never purge reverted or failed `SKILL.md` / `sugent-ext-*.mjs` attempts from history; downgrade the artifact (`supersededAt` in `SugentKnowledgeGraph`) while keeping the `(c_i, a_{ij}, o_{ij}, p_{ij})` failure record in `SugentSIMStore` + `StewardshipLedger` (`kind: "tombstone"`) so future model swaps inherit *why* that path failed.

---

## References

- Yu, X., Xia, F., Pan, J., Tang, Y., Liu, C., Yu, A., Jiang, S., Chen, Y., Xue, L., & Yu, T. (2026). *Self-Improvement Memory Enables Continual Recursive Self-Improvement*. arXiv:2611.18856 — https://arxiv.org/abs/2611.18856 | https://arxiv.org/html/2611.18856v1
- Hu, S., Lu, C., & Clune, J. (2024). *Automated Design of Agentic Systems*. arXiv:2408.08435 — https://arxiv.org/abs/2408.08435
- Yuksekgonul, M., et al. (2024). *TextGrad: Automatic "Differentiation" via Text*. arXiv:2406.07496 — https://arxiv.org/abs/2406.07496
- Zhang, J., Hu, S., Lu, C., Lange, R., et al. (2025). *Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents*. arXiv:2505.22954 — https://arxiv.org/abs/2505.22954
- Novikov, A., et al. / Google DeepMind (2025). *AlphaEvolve: A coding agent for scientific and algorithmic discovery*. arXiv:2506.13131 — https://arxiv.org/abs/2506.13131
- Lee, Y., et al. (2026). *Meta-Harness: End-to-End Optimization of Model Harnesses*. arXiv:2603.28052 — https://arxiv.org/abs/2603.28052
- Zhang, J., Zhao, B., Yang, W., Foerster, J., et al. (2026). *Hyperagents*. arXiv:2603.19461 — https://arxiv.org/abs/2603.19461
- Lin, J., et al. (2026). *Agentic Harness Engineering (AHE)*. arXiv:2604.25850 — https://arxiv.org/abs/2604.25850
- Xia, P., et al. (2026). *RRSI: Regularized Recursive Self-Improvement of Agent Harnesses*. arXiv:2609.24972 — https://arxiv.org/abs/2609.24972
- Zhang, J., Liu, S., Wang, H., Lin, T., et al. (2026). *Causal Improvement Graph for Agentic Harness Optimization*. arXiv:2610.05039 — https://arxiv.org/abs/2610.05039
- Luo, X., et al. (2026). *HarnessBank: Semantic Gene-Bank Search with Gated Verification*. arXiv:2607.13683 — https://arxiv.org/abs/2607.13683
- Li, Z., & Hu, Y. (2026). *SkillHone: A Harness for Continual Agent Skill Evolution Through Persistent Decision History*. EMNLP 2026 — https://aclanthology.org/2026.emnlp-industry.105/
- Shi, Y., et al. (2026). *PluginRSI: Recursive Improvement of Agent Harnesses with Reusable Plugins*. arXiv:2609.32423 — https://arxiv.org/abs/2609.32423
