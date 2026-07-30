import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

// Guards against committing things that are supposed to be ignored — in
// particular a SYMLINKED node_modules.
//
// WHY THIS EXISTS: git worktrees do not get their own node_modules, so the
// practical fix is to symlink the main checkout's. `.gitignore` had
// `**/node_modules/`, and a trailing slash matches DIRECTORIES ONLY — a symlink
// is a file, so it walked straight past and `git add -A` staged it. Twice. The
// second time it reached origin, where checking it out replaced the real
// directory with a symlink pointing at itself; ten test files then failed to
// resolve their imports, which reads as a code regression and is not.
//
// The .gitignore pattern is fixed, but a pattern is only as good as the next
// person's `git add -f` or the next ignored directory nobody thought about.
// This asserts the property directly: nothing tracked is a symlink, and nothing
// tracked lives under a dependency directory.
//
// Reads the INDEX (`git ls-files`), not HEAD, so it fails while the bad entry is
// still merely staged rather than after it has been committed.

const IGNORED_DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']

function git(args) {
  // Tests also run inside the deployed container, which has no git and is not a
  // repo. Absent git means "cannot check here", not "check failed".
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

const repoRoot = git(['rev-parse', '--show-toplevel'])?.trim() || null

function trackedEntries() {
  if (!repoRoot) return null
  // `-s` prints the mode; 120000 is a symlink.
  const out = git(['-C', repoRoot, 'ls-files', '-s'])
  if (out == null) return null
  return out.split('\n').filter(Boolean).map(line => {
    const [meta, path] = line.split('\t')
    return { mode: meta.split(' ')[0], path }
  })
}

test('no tracked file is a symlink', () => {
  const entries = trackedEntries()
  if (!entries) {
    console.log('  (skipped — git unavailable or not a repository)')
    return
  }
  const symlinks = entries.filter(e => e.mode === '120000').map(e => e.path)
  assert.deepEqual(
    symlinks, [],
    `Tracked symlink(s) found: ${symlinks.join(', ')}.\n`
    + 'A symlinked node_modules has been committed twice this way. If a symlink is\n'
    + 'genuinely required, add it to this test\'s allowlist deliberately rather than\n'
    + 'relaxing the check.',
  )
})

test('no tracked path lives under a dependency directory', () => {
  const entries = trackedEntries()
  if (!entries) {
    console.log('  (skipped — git unavailable or not a repository)')
    return
  }
  const pattern = new RegExp(`(^|/)(${IGNORED_DEPENDENCY_DIRS.join('|')})(/|$)`)
  const offenders = entries.map(e => e.path).filter(p => pattern.test(p))
  assert.deepEqual(
    offenders, [],
    `Tracked path(s) under an ignored dependency directory: ${offenders.slice(0, 10).join(', ')}`,
  )
})

test('gitignore catches a node_modules symlink, not just a directory', () => {
  if (!repoRoot) {
    console.log('  (skipped — git unavailable or not a repository)')
    return
  }
  // check-ignore exits non-zero when the path is NOT ignored, so git() returns
  // null. A directory-only pattern (`**/node_modules/`) does not match a path
  // git treats as a file, which is exactly the hole that let this through.
  const ignored = git(['-C', repoRoot, 'check-ignore', 'Infrastructure/server/node_modules'])
  assert.ok(
    ignored,
    'Infrastructure/server/node_modules is not gitignored. A worktree symlink at '
    + 'that path will be staged by `git add -A`. The pattern needs a form without '
    + 'a trailing slash so it matches the symlink too.',
  )
})
