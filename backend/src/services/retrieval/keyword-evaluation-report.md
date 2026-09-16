# Chinese keyword baseline evaluation

This is a fixed local regression corpus, not a production-library or model-quality benchmark. It calls no model, embedding service or reranker.

`keywordEvaluationCases.ts` preserves the initial 30 independent literal-lookup questions, each paired with its expected source and one frozen narrative passage. Half of the passages also have a cited fact entry; the other half must be found in the accepted body blocks. These independent passages alone do not evaluate cross-chapter state transitions or identity ambiguity.

`keywordTemporalEvaluationCases.ts` adds 20 fixed expectations over one continuing 13-chapter story. It contains two characters both named 林青 but with separate stable IDs and aliases, two early promises queried much later, a key held by 甲 in chapter 5 and transferred to 乙 in chapter 10, a thread opened in chapter 4 and closed in chapter 11, and a withdrawn chapter-6 account replaced by a new acceptance. Expected source, result kind, time boundary and, where relevant, acceptance revision are specified before retrieval. Historical body hits cannot satisfy a current-state query. The matrix also requires no hits for withdrawn/future secrets and rejection of another client or project scope.

Run:

```text
npm test -- src/services/retrieval/KeywordMemoryRetrieval.test.ts
```

Observed on 2026-09-15:

| Fixed matrix | Cases | Positive expected-source Top-5 | Expected empty | Scope rejection | Scanned UTF-16 characters | Measured retrieval time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Independent literal baseline | 30 | 30/30 | 0 | 0 | 57,930 | 75.123 ms |
| Continuing-story matrix | 20 | 16/16 | 2/2 | 2/2 | 13,068 | 17.441 ms |
| Total | 50 | **46/46 (100%)** | **2/2** | **2/2** | **70,998** | **92.564 ms** |

The continuing-story cases comprise 5 same-name/ID queries, 2 alias queries, 2 distant-promise queries, 4 before/after transfer queries, 2 before/after thread-closure queries, 2 withdrawal queries, and 3 future/scope-isolation queries. Positive zero-recall questions: **0/46**. Across the matrix, returned future, withdrawn, foreign-scope or superseded state/thread entries: **0**; citation mismatches: **0**. Exact source-block UTF-16 quote positions and output budgets are checked for every returned hit. The two intentionally empty lookups are excluded from the positive recall denominator. Scope rejection happens before retrieval and is excluded from scan/timing totals. These are real local measurements, vary by machine/load, and are excluded from writing-brief fingerprints.

Separate unit regressions additionally prove adding a future source cannot change historical hit scores or scan counts, exercise UTF-16 emoji citations and budget exhaustion, and preserve unverified references. Metadata matches are explained as lookup aids, never cited as body evidence. Author notes appear in a separate `origin: author` result collection without a manufactured acceptance ID or quote. These unit cases are not counted as additional fixed-matrix questions.

The baseline combines native Chinese word segmentation, overlapping Chinese bigrams and deterministic keyword weighting. It supports literal discovery and ID lookup; it cannot establish semantic entailment or reliably retrieve paraphrases sharing no keywords. Quoted body passages remain historical observations, while current state/fact search uses the effective accepted-source view. Missing citations remain unverified.

Scan and output limits report actual characters processed/returned and exhaustion flags. The composer caps the whole memory section at 16,000 characters, preserves matched fact/state and explicit author requirements in full, and fails clearly when mandatory inputs do not fit. The latest past accepted body's tail (at most 1,200 characters) is included as a budgeted historical observation even without query matches; duplicated retrieved body passages are skipped. This is not a limit on the entire model prompt. Optional vector search or reranking should only be considered after a representative user-corpus evaluation shows a measurable gain; this baseline does not claim such a gain.
