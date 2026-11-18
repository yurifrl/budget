/**
 * Release changelog: generate the CHANGELOG.md section for one release.
 *
 * Input is the commit range from the previous `vYYYY.MM.DD[-NN]` tag to
 * HEAD. When OPENROUTER_API_KEY is set, an LLM condenses the commits into
 * a title plus user-facing bullets; without it (or on any API failure) a
 * plain commit-list section is emitted instead, so the release pipeline
 * never blocks on the AI. `--dry` prints the section without touching
 * CHANGELOG.md — CI runs this for real between the api/VERSION validation and
 * the tag creation (see .github/workflows/version.yml).
 *
 * Zero runtime dependencies: `bun scripts/release-changelog.ts` runs with
 * nothing installed — fetch is global, git is invoked via child_process.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TAG_PATTERN = /^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}(-[0-9]{2})?$/;
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
const FALLBACK_MODEL = 'deepseek/deepseek-chat';
const MAX_COMMITS = 40;

const args = process.argv.slice(2);
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const version = argOf('--version');
if (!version) {
  console.error('usage: release-changelog.ts --version YYYY.MM.DD[-NN] [--from TAG] [--model ID] [--dry]');
  process.exit(1);
}
const dry = args.includes('--dry');
const model = argOf('--model') ?? DEFAULT_MODEL;

/** Newest existing release-style tag (excludes the current version's own). */
function previousTag(): string | undefined {
  const tags = execSync("git tag -l 'v20*' --sort=-creatordate", { encoding: 'utf8' })
    .split('\n')
    .filter((t) => TAG_PATTERN.test(t) && t !== `v${version}`);
  return tags[0];
}

const fromTag = argOf('--from') ?? previousTag();
const range = fromTag ? `${fromTag}..HEAD` : 'HEAD';

const commits = execSync(`git log ${range} --no-merges --pretty=%s`, { encoding: 'utf8' })
  .split('\n')
  .filter((s) => s.trim() && !s.startsWith('Merge '))
  .slice(0, MAX_COMMITS);

/** Commit subjects the changelog must not surface (bookkeeping noise). */
const NOISE = /^(chore\(task\)|chore: bump version|docs: release notes|deploy: images)/;

async function aiSection(): Promise<string | undefined> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || commits.length === 0) return undefined;

  const meaningful = commits.filter((s) => !NOISE.test(s));
  if (meaningful.length === 0) return undefined;

  const prompt = [
    'Repo: budget — a personal budgeting app (Expo client for iOS and web, a',
    'Bun + Hono + Postgres API and a jobs admin SPA). Its CHANGELOG.md records',
    'each release as one section: an `## <release> <Title>` heading followed',
    'by `### Changed` / `### Fixed` / `### Added` blocks of terse bullets',
    'describing the outcome for the user, not the implementation.',
    '',
    `Write the section for release v${version} from these commit subjects`,
    '(skip bookkeeping commits like task records and version bumps):',
    '',
    meaningful.join('\n'),
    '',
    'Reply with ONLY the markdown section — heading `## v' + version + ' <Title>`',
    'first line, then the blocks. Max 6 bullets, one line each, no hashes,',
    'no mention of AI or this prompt.',
  ].join('\n');

  const call = async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        models: [model, FALLBACK_MODEL],
        max_tokens: 800,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a terse technical release-notes writer. Output markdown only.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim();
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const content = await call();
      if (content && content.startsWith(`## v${version}`)) return `${content}\n`;
      console.error(`Unexpected AI output shape (attempt ${attempt})`);
    } catch (err) {
      console.error(`AI changelog attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return undefined;
}

/** Plain list of commit subjects — the no-AI fallback section body. */
function fallbackSection(): string {
  const lines = commits.filter((s) => !NOISE.test(s)).map((s) => `- ${s}`);
  const date = new Date().toISOString().slice(0, 10);
  const body = lines.length > 0 ? `### Changed\n\n${lines.join('\n')}` : '_No user-facing changes._';
  return `## v${version} ${date} release\n\n${body.trim()}\n`;
}

const generated = (await aiSection()) ?? fallbackSection();

if (dry) {
  process.stdout.write(generated);
  process.exit(0);
}

const CHANGELOG = 'CHANGELOG.md';
const current = readFileSync(CHANGELOG, 'utf8');
// Insert right under the `# Changelog` title, above the newest section.
const marker = '# Changelog\n';
const at = current.indexOf(marker);
if (at < 0) throw new Error(`${CHANGELOG} has no "${marker.trim()}" heading`);
const next = current.slice(0, at + marker.length) + '\n' + generated + '\n' + current.slice(at + marker.length).replace(/^\n+/, '\n');
writeFileSync(CHANGELOG, next);
console.log(`wrote ${CHANGELOG} section v${version} (from ${fromTag ?? 'repo start'}, ${commits.length} commits)`);
