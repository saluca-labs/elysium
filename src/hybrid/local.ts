/**
 * LocalHybridProvider — node-llama-cpp backed embedding, HyDE generation, and reranking.
 *
 * Runs entirely on-device via GGUF models. No API keys, no network calls.
 *
 * Inspired by QMD's LLM abstraction (github.com/tobi/qmd):
 *   - Embedding: same node-llama-cpp createEmbeddingContext pattern
 *   - HyDE: LlamaChatSession generation of a hypothetical memory (QMD does doc generation;
 *     we adapt the same technique for short agent memory strings)
 *   - Reranking: model.createRankingContext() + rankAll() — QMD's approach, which uses
 *     node-llama-cpp's native cross-encoder API rather than log-prob heuristics
 *
 * Models are lazy-loaded — only the embedding model is mandatory. Generator and
 * reranker load on first use if their model paths are provided.
 *
 * Usage:
 *   const provider = new LocalHybridProvider({
 *     modelPath:         '/path/to/nomic-embed-text-v1.5.Q4_K_M.gguf',  // required
 *     generatorModelPath: '/path/to/Qwen3-0.6B-Q8_0.gguf',              // for HyDE
 *     rerankModelPath:    '/path/to/Qwen3-Reranker-0.6B-Q8_0.gguf',     // for rerank
 *   })
 *   await provider.init()
 */

import type { HybridProvider, ScoredMemory } from '../types.js'

export interface LocalHybridProviderOptions {
  /**
   * Path to GGUF embedding model.
   * Recommended: nomic-embed-text-v1.5.Q4_K_M.gguf (274 MB, CPU-friendly, 384 dims)
   * HuggingFace: nomic-ai/nomic-embed-text-v1.5-GGUF
   */
  modelPath: string

  /** Number of dimensions the model produces. Default: 384. */
  dims?: number

  /**
   * Optional persona prefix prepended to every embed() call.
   * Anchors queries in the semantic space of persona-scoped memories.
   * Example: "alfred butler"
   */
  personaPrefix?: string

  /**
   * Path to a GGUF instruction-following model for HyDE generation.
   * Any small instruct model works — Qwen3-0.6B is a good default.
   * HuggingFace: ggml-org/Qwen3-0.6B-GGUF / Qwen3-0.6B-Q8_0.gguf
   * Required for hybridSearch({ hyde: true }).
   */
  generatorModelPath?: string

  /**
   * Path to a GGUF cross-encoder ranking model.
   * HuggingFace: ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF (same default as QMD)
   * Required for hybridSearch({ rerank: true }).
   */
  rerankModelPath?: string

  /**
   * GPU layers to offload. Default: 0 (CPU only).
   * Increase if you have a compatible GPU.
   */
  gpuLayers?: number
}

// node-llama-cpp is an optional peer dep — all types erased at runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LlamaAny = any

/** Max tokens to generate for a HyDE hypothetical memory. */
const HYDE_MAX_TOKENS = 120

/** Max tokens per document fed to the reranker (prevents context overflow). */
const RERANK_MAX_DOC_TOKENS = 512

export class LocalHybridProvider implements HybridProvider {
  readonly dims: number
  private readonly opts: LocalHybridProviderOptions

  // Embedding model (required)
  private llama: LlamaAny = null
  private embedModel: LlamaAny = null
  private embeddingContext: LlamaAny = null

  // Generation model (lazy — loaded on first generate() call)
  private generateModel: LlamaAny = null
  private generateModelLoadPromise: Promise<LlamaAny> | null = null

  // Rerank model (lazy — loaded on first rerank() call)
  private rerankModel: LlamaAny = null
  private rerankModelLoadPromise: Promise<LlamaAny> | null = null
  private rankingContext: LlamaAny = null

  constructor(opts: LocalHybridProviderOptions) {
    this.opts = opts
    this.dims = opts.dims ?? 384
  }

  /** Load node-llama-cpp at runtime (optional peer dep). */
  private requireLlamaCpp(): LlamaAny {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      return require('node-llama-cpp') as LlamaAny
    } catch {
      throw new Error(
        'node-llama-cpp is required for LocalHybridProvider. ' +
        'Install it: npm install node-llama-cpp'
      )
    }
  }

  /**
   * Initialize the llama runtime and load the embedding model.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    const { getLlama } = this.requireLlamaCpp()
    this.llama = await getLlama({ gpu: this.opts.gpuLayers ? 'auto' : false })
    this.embedModel = await this.llama.loadModel({
      modelPath: this.opts.modelPath,
      gpuLayers: this.opts.gpuLayers ?? 0,
    })
    this.embeddingContext = await this.embedModel.createEmbeddingContext()
  }

  // ── Embedding ──────────────────────────────────────────────────────────────

  /**
   * Embed text into a float vector.
   * Applies persona prefix when configured (biases embedding toward persona context).
   */
  async embed(text: string): Promise<number[]> {
    if (!this.embeddingContext) {
      throw new Error('LocalHybridProvider not initialized — call init() first')
    }
    const input = this.opts.personaPrefix
      ? `${this.opts.personaPrefix}: ${text}`
      : text
    const result = await this.embeddingContext.getEmbeddingFor(input)
    return Array.from(result.vector as Float32Array)
  }

  // ── HyDE generation ────────────────────────────────────────────────────────

  /**
   * Generate a hypothetical memory that would match the given search query.
   *
   * HyDE (Hypothetical Document Embeddings) technique: instead of embedding the
   * query directly, generate a plausible document/memory that answers the query,
   * then embed that. Dramatically improves recall for vague or abstract queries
   * because the generated text lives in the same embedding space as stored memories.
   *
   * Adapted from QMD's expandQuery(), simplified for the single-shot memory use case.
   * QMD generates multiple typed queries (lex/vec/hyde); we generate one hypothetical
   * memory string since our stored units are already short and uniform.
   */
  async generate(query: string): Promise<string> {
    const model = await this.ensureGenerateModel()
    const llamaCpp = this.requireLlamaCpp()
    const { LlamaChatSession } = llamaCpp

    const context = await model.createContext({ contextSize: 512 })
    const session = new LlamaChatSession({ contextSequence: context.getSequence() })

    try {
      const prompt = `Write a single brief memory note (1–2 sentences) that would be a perfect match for this search: "${query}". Write only the memory text, no labels or explanation.`
      return await session.prompt(prompt, {
        maxTokens: HYDE_MAX_TOKENS,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        repeatPenalty: { lastTokens: 64, presencePenalty: 0.4 },
      })
    } finally {
      await context.dispose()
    }
  }

  // ── Reranking ──────────────────────────────────────────────────────────────

  /**
   * Re-score top candidate memories using a cross-encoder ranking model.
   *
   * Uses node-llama-cpp's createRankingContext() + rankAll() — the same approach
   * as QMD's reranker. Cross-encoders jointly attend to both the query and each
   * candidate, producing a calibrated relevance score that significantly outperforms
   * bi-encoder similarity alone on precision@k.
   *
   * Model default: Qwen3-Reranker-0.6B (same as QMD, 600M params, Q8 ~600MB).
   */
  async rerank(query: string, memories: ScoredMemory[]): Promise<ScoredMemory[]> {
    if (memories.length === 0) return memories

    const model = await this.ensureRerankModel()

    // Truncate documents that would exceed context. Tokenize to count, then trim.
    const texts = memories.map(m => {
      const tokens = model.tokenize(m.content)
      if (tokens.length <= RERANK_MAX_DOC_TOKENS) return m.content
      return model.detokenize(tokens.slice(0, RERANK_MAX_DOC_TOKENS)) as string
    })

    // Reuse a single ranking context across calls (lazy-created)
    if (!this.rankingContext) {
      this.rankingContext = await model.createRankingContext()
    }

    const scores: number[] = await this.rankingContext.rankAll(query, texts)

    return memories
      .map((m, i) => ({ ...m, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.rankingContext?.dispose?.()
    await this.embeddingContext?.dispose?.()
    await this.embedModel?.dispose?.()
    await this.generateModel?.dispose?.()
    await this.rerankModel?.dispose?.()
    await this.llama?.dispose?.()

    this.rankingContext   = null
    this.embeddingContext = null
    this.embedModel       = null
    this.generateModel    = null
    this.rerankModel      = null
    this.llama            = null
    this.generateModelLoadPromise = null
    this.rerankModelLoadPromise   = null
  }

  // ── Private: lazy model loaders ───────────────────────────────────────────

  private async ensureGenerateModel(): Promise<LlamaAny> {
    if (this.generateModel) return this.generateModel

    if (!this.opts.generatorModelPath) {
      throw new Error(
        'generatorModelPath is required for HyDE generation. ' +
        'Recommended: Qwen3-0.6B-Q8_0.gguf from ggml-org/Qwen3-0.6B-GGUF'
      )
    }

    if (this.generateModelLoadPromise) return this.generateModelLoadPromise

    this.generateModelLoadPromise = (async () => {
      const model = await this.llama.loadModel({
        modelPath: this.opts.generatorModelPath!,
        gpuLayers: this.opts.gpuLayers ?? 0,
      })
      this.generateModel = model
      return model
    })()

    const model = await this.generateModelLoadPromise
    this.generateModelLoadPromise = null
    return model
  }

  private async ensureRerankModel(): Promise<LlamaAny> {
    if (this.rerankModel) return this.rerankModel

    if (!this.opts.rerankModelPath) {
      throw new Error(
        'rerankModelPath is required for LLM reranking. ' +
        'Recommended: Qwen3-Reranker-0.6B-Q8_0.gguf from ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF'
      )
    }

    if (this.rerankModelLoadPromise) return this.rerankModelLoadPromise

    this.rerankModelLoadPromise = (async () => {
      const model = await this.llama.loadModel({
        modelPath: this.opts.rerankModelPath!,
        gpuLayers: this.opts.gpuLayers ?? 0,
      })
      this.rerankModel = model
      return model
    })()

    const model = await this.rerankModelLoadPromise
    this.rerankModelLoadPromise = null
    return model
  }
}
