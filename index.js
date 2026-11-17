/**
 * Translation tools for MTool-style manual translation files.
 *
 * The target format is the MTool "ManualTransFile.json" convention used by
 * RPG Maker MV / Tyrano game translation workflows: a JSON object where each
 * key is the original text shown by the game and the value is its translation
 * (untranslated entries have value === key). Similar key→value translation
 * JSON files work too.
 *
 * Provides:
 *   mtrans_info      - analyze the file (engine meta, counts, source language)
 *   mtrans_prepare   - classify text keys and split them into chunk files
 *   mtrans_apply     - merge translated chunk files back and save (.bak backup)
 *   mtrans_translate - fully automatic translation via a registered LLM
 *                      provider (Japanese→Chinese and English→Chinese)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const inject = ['tools']

const textRender = (_args, value) => [{ type: 'text', text: value }]

// ---- classification -----------------------------------------------------

/** Tyrano variable assignment keys (f.xxx=1, sf.xxx==0, ...) are script code. */
const CODE_RE = /^(f|sf|tf|mp)\./
/** Engine source code / CSS / JS chunks that merely contain CJK characters. */
const JUNK_RE = /(require\(|::-webkit|^var\s|^\/\*|\bfunction\s*\(|\.css\b)/

function isJaTextKey(key) {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(key) && !key.startsWith('MTool_Meta') && !CODE_RE.test(key) && !JUNK_RE.test(key)
}

/** English-side filter: keep human text, drop paths, code, variables, numbers. */
function isEnTextKey(key) {
  if (key.startsWith('MTool_Meta') || CODE_RE.test(key) || JUNK_RE.test(key)) return false
  if (!/[A-Za-z]{2}/.test(key)) return false
  if (/^\s*$/.test(key)) return false
  if (/^(true|false|null|undefined|nan)$/i.test(key)) return false
  if (/^[\d\s.,:%+\-*/=()<>[\]{}|&^!?'"@#$~`;]+$/.test(key)) return false
  if (/^[a-z]:[\\/]/i.test(key) || /^\.{0,2}[\\/]/.test(key)) return false
  if (/\.(js|css|ks|json|png|jpe?g|gif|mp3|ogg|wav|mp4|webm|txt|ini|xml|html?|dll|exe|bin|dat|sav|pak)(["'\s\\/)]|$)/i.test(key)) return false
  if (/^[a-z_]+\.(js|css|ks)(:|$)/i.test(key)) return false
  if (key.includes('://') || key.includes('function(') || key.includes('=>') || key.includes('require(')) return false
  if (/^[{}\[\]"']*\{[^}]*\}[{}\[\]"']*$/.test(key)) return false
  return true
}

function detectLanguage(keys) {
  let kana = 0, cjk = 0, latin = 0
  for (const k of keys) {
    if (/[\u3040-\u30ff]/.test(k)) kana++
    if (/[\u4e00-\u9fff]/.test(k)) cjk++
    if (/[A-Za-z]{2}/.test(k)) latin++
  }
  if (kana > 0) return 'ja'
  if (cjk > keys.length * 0.5) return 'ja'
  if (latin > keys.length * 0.3) return 'en'
  return 'unknown'
}

function textKeysFor(fileData, sourceLang) {
  const keys = Object.keys(fileData)
  const lang = sourceLang === 'auto' ? detectLanguage(keys) : sourceLang
  const isText = lang === 'en' ? isEnTextKey : isJaTextKey
  const textKeys = keys.filter(isText)
  return { lang, textKeys }
}

// ---- chunking -----------------------------------------------------------

function chunkKeys(keys, maxKeys, maxChars) {
  const chunks = []
  let cur = [], curChars = 0
  for (const k of keys) {
    cur.push(k)
    curChars += k.length
    if (cur.length >= maxKeys || curChars >= maxChars) {
      chunks.push(cur)
      cur = []
      curChars = 0
    }
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

function readJson(file) {
  if (!existsSync(file)) throw new Error(`file not found: ${file}`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ---- LLM helpers --------------------------------------------------------

async function* collectText(chunks) {
  for await (const c of chunks) {
    if (c.type === 'text-delta') yield c.text
  }
}

async function completeText(llm, options) {
  let out = ''
  for await (const t of collectText(llm.stream(options))) out += t
  return out
}

function stripFences(text) {
  let t = text.trim()
  t = t.replace(/^```(?:json|JSON)?\s*/m, '').replace(/\s*```\s*$/, '')
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return t
}

async function resolveRoute(llm, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  for (const p of llm.listProviders()) {
    let models
    try { models = await llm.listModels(p.id) } catch { continue }
    if (models.length) return { provider: p.id, model: models[0].id }
  }
  throw new Error('no registered LLM provider with models found; set provider/model in the plugin config')
}

const JA_SYSTEM = `你是专业的日语→简体中文翻译,负责翻译一款 18 禁游戏(性长看护健康检查)的显示文本。要求:
- 译文自然流畅,忠实原文;成人性描写照实直译,不回避不删减。
- { xxx } 等花括号占位符、\\n、\\t 原样保留;[xxx] 标签(如 [emb exp="..."])只译可见文字。
- 保留数字、英文、文件名与路径;日语「」改为中文“”。
- 术语:花鈴→花铃;せんせい→老师;健診/健康診断→体检;診察→检查;問診→问诊;カルテ→病历;えっち→色色/做爱(视语境);おっぱい→奶子;おまんこ→小穴;ちんぽ→肉棒;イく→高潮;中出し→内射;性長→性长;みまもり→看护。
- UI 短标签简洁(最大値→最大值、信頼→信赖、残り時間→剩余时间)。
- 每条都翻译,不得返回原样。只输出 JSON 字符串数组,第 i 个元素对应输入第 i 条,长度必须相同,不要输出任何解释。`

const EN_SYSTEM = `You are a professional English→Simplified Chinese translator for a game's displayed text. Rules:
- Natural, faithful translation; adult content translated plainly without censorship.
- Keep { xxx } placeholders, \\n, \\t, %s, %d and [xxx] tags verbatim; translate only visible text.
- Keep numbers, file names and paths; convert straight quotes to Chinese “”.
- UI labels stay concise (Save→保存, Load→读取, Settings→设置, Exit→退出, New Game→新游戏).
- Translate every entry, never return the original. Output ONLY a JSON array of strings where element i is the translation of input entry i, same length, no explanations.`

// ---- plugin -------------------------------------------------------------

export function apply(ctx, config = {}) {
  const defaults = {
    provider: typeof config.provider === 'string' ? config.provider : '',
    model: typeof config.model === 'string' ? config.model : '',
    parallelism: typeof config.parallelism === 'number' && config.parallelism >= 1 ? Math.min(8, Math.trunc(config.parallelism)) : 4,
  }

  ctx.effect(() => ctx.tools.register({
    name: 'mtrans_info',
    description: 'Analyze an MTool-style manual translation JSON (ManualTransFile.json format: keys are original game text, values are translations). Reports the engine meta, source language guess, text-key counts, untranslated counts, and samples. Use before mtrans_prepare or mtrans_translate.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the ManualTransFile.json or similar key→translation JSON' },
      sourceLang: { type: 'string', enum: ['auto', 'ja', 'en'], description: 'Source language; default auto-detect' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const file = args.file
      const data = readJson(file)
      const keys = Object.keys(data)
      const { lang, textKeys } = textKeysFor(data, args.sourceLang ?? 'auto')
      let untranslated = 0
      for (const k of textKeys) if (String(data[k] ?? '') === '' || data[k] === k) untranslated++
      const metaKey = keys.find((k) => k.startsWith('MTool_Meta'))
      return JSON.stringify({
        file,
        keys: keys.length,
        engineMeta: metaKey ? String(data[metaKey]).slice(0, 220) : null,
        detectedSourceLang: lang,
        textKeys: textKeys.length,
        otherKeys: keys.length - textKeys.length,
        untranslatedTextKeys: untranslated,
        translatedTextKeys: textKeys.length - untranslated,
        samples: textKeys.slice(0, 8),
      }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Analyze translation file', kind: 'read', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'mtrans_prepare',
    description: 'Classify the text keys of an MTool-style translation JSON and split them into chunk files (chunkNN.json = arrays of original texts) plus a meta.json, ready for translation by subagents or an LLM. Code-like keys (variables, paths, engine messages) are excluded. mtrans_apply merges the results back.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the ManualTransFile.json' },
      outDir: { type: 'string', required: true, description: 'Directory to write chunk files into' },
      sourceLang: { type: 'string', enum: ['auto', 'ja', 'en'], description: 'Source language; default auto-detect' },
      maxKeys: { type: 'number', description: 'Max keys per chunk; default 1200' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const file = args.file
      const outDir = args.outDir
      const data = readJson(file)
      const { lang, textKeys } = textKeysFor(data, args.sourceLang ?? 'auto')
      const maxKeys = Math.min(5000, Math.max(50, Math.trunc(args.maxKeys ?? 1200)))
      const chunks = chunkKeys([...textKeys].sort(), maxKeys, 40000)
      mkdirSync(outDir, { recursive: true })
      const files = []
      for (let i = 0; i < chunks.length; i++) {
        const name = `chunk${String(i).padStart(2, '0')}.json`
        writeFileSync(path.join(outDir, name), JSON.stringify(chunks[i], null, 2), 'utf8')
        files.push({ file: name, keys: chunks[i].length })
      }
      writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ sourceLang: lang, targetLang: 'zh', chunks: files.length, totalTextKeys: textKeys.length, note: 'Translate chunkNN.json arrays of original texts into outNN.json arrays of Chinese translations, same order and length.' }, null, 2), 'utf8')
      return JSON.stringify({ file, outDir, detectedSourceLang: lang, totalTextKeys: textKeys.length, chunks: files.length, files }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Prepare translation chunks', kind: 'execute', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'mtrans_apply',
    description: 'Merge translated chunk files (outNN.json arrays, same order and length as chunkNN.json) back into the MTool-style translation JSON, backup the previous file (.bak), and save. Entries whose translation is empty or unchanged are left untouched. Validates lengths per chunk and reports problems.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the ManualTransFile.json' },
      outDir: { type: 'string', required: true, description: 'Directory holding chunkNN.json and outNN.json' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const file = args.file
      const outDir = args.outDir
      const data = readJson(file)
      const raw = readFileSync(file, 'utf8')
      const pretty = raw.slice(0, 200).includes('\n  ')
      let applied = 0, skipped = 0, missingKeys = 0
      const problems = []
      for (let i = 0; i < 100; i++) {
        const nn = String(i).padStart(2, '0')
        const chunkFile = path.join(outDir, `chunk${nn}.json`)
        const outFile = path.join(outDir, `out${nn}.json`)
        if (!existsSync(chunkFile)) break
        if (!existsSync(outFile)) { problems.push(`missing ${outFile}`); continue }
        const keys = JSON.parse(readFileSync(chunkFile, 'utf8'))
        const outs = JSON.parse(readFileSync(outFile, 'utf8'))
        if (!Array.isArray(outs)) { problems.push(`${outFile} is not an array`); continue }
        if (outs.length !== keys.length) { problems.push(`${outFile}: length ${outs.length} != keys ${keys.length}`); continue }
        for (let j = 0; j < keys.length; j++) {
          const k = keys[j]
          const v = outs[j]
          if (!(k in data)) { missingKeys++; continue }
          if (typeof v !== 'string' || v === '' || v === k) { skipped++; continue }
          data[k] = v
          applied++
        }
      }
      copyFileSync(file, `${file}.bak`)
      const out = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
      writeFileSync(file, out, 'utf8')
      return JSON.stringify({ saved: file, backup: `${file}.bak`, applied, skipped, missingKeys, problems }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Apply translations', kind: 'edit', rawInput: args }),
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'mtrans_translate',
    description: 'Fully automatic translation of an MTool-style translation JSON (ManualTransFile.json) using a registered LLM provider: classifies text keys, skips code/path entries, translates in parallel batches, merges, backs up (.bak) and saves. Supports Japanese→Chinese and English→Chinese (sourceLang auto/ja/en). Requires at least one registered LLM provider; provider/model can be fixed in the plugin config.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to the ManualTransFile.json' },
      sourceLang: { type: 'string', enum: ['auto', 'ja', 'en'], description: 'Source language; default auto-detect' },
      provider: { type: 'string', description: 'LLM provider id; default: config value or first registered provider' },
      model: { type: 'string', description: 'Model id; default: config value or first model of the provider' },
      parallelism: { type: 'number', description: 'Parallel batches, 1-8; default from config (4)' },
      onlyUntranslated: { type: 'boolean', description: 'Only translate entries whose value equals the key; default true' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    timeoutMs: 60 * 60 * 1000,
    async execute(args, exec) {
      const llm = ctx.get('llm')
      if (!llm) throw new Error('the llm service is not available in this profile')
      const file = args.file
      const data = readJson(file)
      const raw = readFileSync(file, 'utf8')
      const pretty = raw.slice(0, 200).includes('\n  ')
      const { lang, textKeys } = textKeysFor(data, args.sourceLang ?? 'auto')
      let pending = textKeys
      if (args.onlyUntranslated !== false) pending = pending.filter((k) => data[k] === k || String(data[k]).trim() === '')
      const route = await resolveRoute(llm, { provider: args.provider ?? defaults.provider, model: args.model ?? defaults.model })
      const parallelism = Math.min(8, Math.max(1, Math.trunc(args.parallelism ?? defaults.parallelism)))
      const system = lang === 'en' ? EN_SYSTEM : JA_SYSTEM
      const chunks = chunkKeys(pending, 60, 4000)
      const results = new Array(chunks.length)
      let failed = 0
      let idx = 0
      const workers = Array.from({ length: Math.min(parallelism, chunks.length) }, async () => {
        for (;;) {
          const i = idx++
          if (i >= chunks.length) return
          const chunk = chunks[i]
          const payload = JSON.stringify(chunk)
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const text = await completeText(llm, {
                  provider: route.provider,
                  model: route.model,
                  system,
                  messages: [{ role: 'user', content: [{ type: 'text', text: `Input JSON array of ${chunk.length} original strings; translate each element, return a JSON array with the SAME length and order:\n${payload}` }] }],
                  temperature: 0.3,
                  maxTokens: 8192,
                  signal: exec.signal,
                })
                const parsed = JSON.parse(stripFences(text))
                if (Array.isArray(parsed) && parsed.length === chunk.length) {
                  results[i] = parsed
                  break
                }
                throw new Error(`bad array length ${Array.isArray(parsed) ? parsed.length : 'n/a'}`)
              } catch (e) {
                if (attempt === 1) { failed++; results[i] = null }
              }
            }
          } catch { failed++; results[i] = null }
        }
      })
      await Promise.all(workers)
      let applied = 0
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const outs = results[i]
        if (!outs) continue
        for (let j = 0; j < chunk.length; j++) {
          const k = chunk[j]
          const v = outs[j]
          if (typeof v === 'string' && v !== '' && v !== k) {
            data[k] = v
            applied++
          }
        }
      }
      copyFileSync(file, `${file}.bak`)
      const out = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
      writeFileSync(file, out, 'utf8')
      return JSON.stringify({
        file,
        backup: `${file}.bak`,
        sourceLang: lang,
        llm: route,
        totalTextKeys: textKeys.length,
        translatedNow: applied,
        batches: chunks.length,
        failedBatches: failed,
      }, null, 2)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Translate file via LLM', kind: 'execute', rawInput: args }),
  }))
}

export { textKeysFor, isJaTextKey, isEnTextKey, detectLanguage, chunkKeys }
