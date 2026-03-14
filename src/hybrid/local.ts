/**
 * LocalHybridProvider — node-llama-cpp backed embedding + reranking.
 *
 * Runs entirely on-device via GGUF models. No API keys, no network calls.
 *
 * Inspired by QMD's LLM abstraction (github.com/tobi/qmd), adapted for
 * the agent memory context: shorter texts, persona-prefixed queries,
 * and session-level model lifecycle management.
 *
 * Usage:
 *   const provider = new LocalHybridProvider({ modelPath: '/path/to/nomic-embed.gguf' })
 *   await provider.init()
 *   const memory = new Asphodel(new SQLiteAdapter(), { hybrid: provider })
 */

import type { HybridProvider } from '../types.js'

export interface LocalHybridProviderOptions {
  /**
   * Path to GGUF embedding model.
   * Recommended: nomic-embed-text-v1.5.Q4_K_M.gguf (274 MB, CPU-friendly, 384 dims)
   * Available at: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF
   */
  modelPath: string

  /** Number of dimensions the model produces. Default: 384. */
  dims?: number

  /**
   * Optional persona prefix prepended to every query before embedding.
   * Helps embed queries in the same semantic space as persona-scoped memories.
   * Example: "alfred butler"
   */
  personaPrefix?: string

  /**
   * GPU layers to offload. Default: 0 (CPU only).
   * Increase if you have a compatible GPU.
   */
  gpuLayers?: number
}

// node-llama-cpp is a peer dep — only imported if this class is used
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LlamaAny = any

export class LocalHybridProvider implements HybridProvider {
  readonly dims: number
  private readonly opts: LocalHybridProviderOptions

  private llama: LlamaAny = null
  private model: LlamaAny = null
  private embeddingContext: LlamaAny = null

  constructor(opts: LocalHybridProviderOptions) {
    this.opts = opts
    this.dims = opts.dims ?? 384
  }

  /**
   * Initialize the llama instance and load the embedding model.
   * Must be called before embed() or rerank().
   */
  async init(): Promise<void> {
    let getLlama: LlamaAny
    try {
      // node-llama-cpp is an optional peer dependency — require at runtime only
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      getLlama = (require('node-llama-cpp') as { getLlama: LlamaAny }).getLlama
    } catch {
      throw new Error(
        'node-llama-cpp is required for LocalHybridProvider. ' +
        'Install it: npm install node-llama-cpp'
      )
    }
    this.llama = await (getLlama as LlamaAny)({
      gpu: this.opts.gpuLayers ? 'auto' : false,
    })

    this.model = await this.llama.loadModel({
      modelPath: this.opts.modelPath,
      gpuLayers: this.opts.gpuLayers ?? 0,
    })

    this.embeddingContext = await this.model.createEmbeddingContext()
  }

  /**
   * Embed text into a float vector.
   * Applies persona prefix to queries when configured.
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

  async close(): Promise<void> {
    await this.embeddingContext?.dispose?.()
    await this.model?.dispose?.()
    await this.llama?.dispose?.()
    this.embeddingContext = null
    this.model = null
    this.llama = null
  }
}
