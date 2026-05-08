# Release Guide for bbs-crawler

## How to Create a GitHub Release

### 1. Build the Binary

Run the packaging script on the target platform:

```bash
npm run package
```

Or if you want to build manually:
```bash
npm run build
npx tsx scripts/package/standalone.ts
```

### 2. Test the Binary

Create a clean test directory and verify:

```bash
mkdir test-release
cd test-release

# Copy release files
cp ../release/* .

# Install browser
node install-browser.js

# Copy your .env (for testing only)
cp ../.env .

# Run the binary (just check it starts - will exit since MCP runs via stdio)
# On Windows:
.\bbs-crawler-win-x64.exe
# On Linux/macOS:
./bbs-crawler-xxx-x64
```

For proper MCP testing, use the smoke test script against the binary.

### 3. Prepare Release Files

Gather these files from `release/`:
- Binary executable (`bbs-crawler-win-x64.exe`, `bbs-crawler-linux-x64`, `bbs-crawler-macos-x64`)
- `install-browser.js`
- `README_RELEASE.md` (rename to `README.md` for release)
- `.env.example`

### 4. Create GitHub Release

1. Go to https://github.com/VeinsureLee/BBS_Crawler/releases/new
2. Create a new tag: `v0.1.0` (follow semver)
3. Release title: `bbs-crawler v0.1.0`
4. Description:

```markdown
## What's Changed

- Initial packaged release of bbs-crawler MCP server
- Includes 4 MCP tools: `forum_list_sites`, `forum_list_threads`, `forum_get_thread`, `forum_session_status`
- Auto-initialization on first use
- Playwright-based browser automation with session persistence
- Embedded PGlite database

## Installation

See the included `README.md` for full documentation.

### Quick Start

1. Download the binary for your platform
2. Download `install-browser.js`, `.env.example`, and `README.md`
3. Run `node install-browser.js` to install Playwright Chromium
4. Configure `.env` with your credentials
5. Add to your Claude Desktop config!

## Downloads

| Platform | File |
|----------|------|
| Windows x64 | `bbs-crawler-win-x64.exe` |
| Linux x64 | `bbs-crawler-linux-x64` |
| macOS x64 | `bbs-crawler-macos-x64` |
```

5. Attach all release files
6. Check "Set as a pre-release" if it's not production-ready
7. Click "Publish release"

### 5. Multi-Platform Builds

To build for all platforms, you need to run the packaging script **on each target OS**:

- Windows → build Windows binary
- Linux → build Linux binary
- macOS → build macOS binary

Then upload all 3 binaries to the same GitHub Release.

---

## Optional: GitHub Actions CI (Future)

For automated releases, you could set up a GitHub Actions workflow:

`.github/workflows/release.yml`:
```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - run: npx tsx scripts/package/standalone.ts
      - uses: softprops/action-gh-release@v1
        with:
          files: release/*
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Package Structure Reference

```
bbs-crawler/
├── bbs-crawler-win-x64.exe    (pkg'd binary)
├── bbs-crawler-linux-x64
├── bbs-crawler-macos-x64
├── install-browser.js         (helper to install Playwright Chromium)
├── .env.example               (config template)
└── README.md                  (user guide)
```

User runtime directories (created on first run):
```
./.pgdata/                     (PGlite database)
./.state/                      (cookies + credentials)
```
