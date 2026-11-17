# dsh-mtrans

A [DeepSeek Harness](https://github.com/deepseek-ai) Host plugin for translating
**MTool-style manual translation files** (`ManualTransFile.json`: a JSON object whose
keys are the original game text and whose values are the translations; untranslated
entries have `value === key`). Similar key-to-translation JSON files work too.

## Tools

| Tool | Purpose |
| --- | --- |
| `mtrans_info` | Analyze the file: engine meta, source language, text-key and untranslated counts |
| `mtrans_prepare` | Classify text keys, write chunk files (`chunkNN.json` + `meta.json`) for agent/subagent translation |
| `mtrans_apply` | Merge `outNN.json` translations back, back up (`.bak`) and save |
| `mtrans_translate` | Fully automatic translation through a registered LLM provider (parallel batches) |

`mtrans_translate` supports **Japanese to Chinese** and **English to Chinese**
(`sourceLang: auto/ja/en`), skips code-like keys (Tyrano variables such as `f.xxx=1`,
file paths, CSS/JS snippets), keeps `{ placeholders }`, `\n`, and engine tags intact,
and writes a `.bak` of the previous file before saving.

## Install

Requires DeepSeek Harness 0.2 or newer.

```bash
# from GitHub
plugin_manager install_bundle target=github:AmahaHanasaki/dsh-mtrans

# or from a local checkout
plugin_manager install_bundle target=<path-to-this-repo>
```

If your installer does not accept `github:` specs, download the `.tgz` from the
release page and install that file path instead, or publish it to npm first
(`npm publish --access public`) and install `@amahahanasaki/dsh-mtrans`.

## Configuration

Edit the plugin row config in the profile:

| Key | Meaning |
| --- | --- |
| `provider` / `model` | Fix the LLM route; when empty, the first registered provider with models is used |
| `parallelism` | Parallel translation batches (1-8, default 4) |

## Workflow

1. `mtrans_info` on the translation file to see what you are dealing with.
2. Either `mtrans_translate` for a one-shot run, or `mtrans_prepare` + translate the
   chunks with agents + `mtrans_apply` when you want control over the wording.
3. The previous file is always backed up to `.bak` before writing.

## License

MIT
