import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const releaseDir = path.resolve(projectRoot, 'release');

async function main() {
  console.log('=== bbs-crawler Packaging ===\n');

  if (fs.existsSync(releaseDir)) {
    console.log('Cleaning previous release...');
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(releaseDir, { recursive: true });

  console.log('\n1. Building TypeScript...');
  execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });

  const platform = process.platform;
  let target: string;
  let outputName: string;

  switch (platform) {
    case 'win32':
      target = 'node20-win-x64';
      outputName = 'bbs-crawler-win-x64.exe';
      break;
    case 'darwin':
      target = 'node20-macos-x64';
      outputName = 'bbs-crawler-macos-x64';
      break;
    case 'linux':
      target = 'node20-linux-x64';
      outputName = 'bbs-crawler-linux-x64';
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  console.log(`\n2. Packaging for ${platform} (${target})...`);
  const outputPath = path.join(releaseDir, outputName);

  execSync(`npx pkg dist/index.js --target ${target} --output "${outputPath}"`, {
    stdio: 'inherit',
    cwd: projectRoot
  });

  console.log('\n3. Creating helper scripts...');
  const installBrowserScript = `
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Installing Playwright Chromium...');
console.log('This may take a few minutes...\\n');

try {
  execSync('npx playwright@1.46.0 install chromium', { stdio: 'inherit' });
  console.log('\\n✅ Done! Playwright Chromium installed successfully.');
  console.log('You can now run the bbs-crawler binary.');
} catch (e) {
  console.error('\\n❌ Failed to install Playwright Chromium:', e.message);
  process.exit(1);
}
`;

  fs.writeFileSync(path.join(releaseDir, 'install-browser.js'), installBrowserScript.trim());

  const readmeContent = `# bbs-crawler Release

A packaged binary distribution of the BBS Crawler MCP server.

## Quick Start

### 1. Install Playwright Chromium

The binary requires the Playwright Chromium browser. Install it first:

\`\`\`bash
node install-browser.js
\`\`\`

Or manually:
\`\`\`bash
npx playwright@1.46.0 install chromium
\`\`\`

### 2. Configure Environment

Copy the example config and fill in your credentials:

\`\`\`bash
cp .env.example .env
# Then edit .env with your SCHOOL_BBS_USERNAME, SCHOOL_BBS_PASSWORD, SCHOOL_BBS_BASE_URL
\`\`\`

### 3. Run the Server

#### Windows
\`\`\`bash
bbs-crawler-win-x64.exe
\`\`\`

#### Linux
\`\`\`bash
chmod +x bbs-crawler-linux-x64
./bbs-crawler-linux-x64
\`\`\`

#### macOS
\`\`\`bash
chmod +x bbs-crawler-macos-x64
./bbs-crawler-macos-x64
\`\`\`

## Claude Desktop Configuration

Add this to your \`claude_desktop_config.json\`:

\`\`\`json
{
  "mcpServers": {
    "bbs-crawler": {
      "command": "/absolute/path/to/bbs-crawler-binary",
      "env": {
        "SCHOOL_BBS_USERNAME": "your_username",
        "SCHOOL_BBS_PASSWORD": "your_password",
        "SCHOOL_BBS_BASE_URL": "https://your-bbs.example.com"
      }
    }
  }
}
\`\`\`

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| \`PGDATA_DIR\` | PGlite storage directory | \`./.pgdata\` |
| \`STORAGE_STATE_DIR\` | Session storage directory | \`./.state\` |
| \`BROWSER_HEADLESS\` | Run browser in headless mode | \`true\` |
| \`CRED_KEY\` | AES key for credential encryption | Hostname-derived |
| \`LOG_LEVEL\` | Log level (\`debug\`, \`info\`, \`warn\`, \`error\`) | \`info\` |
| \`SCHOOL_BBS_USERNAME\` | BBS login username | Required |
| \`SCHOOL_BBS_PASSWORD\` | BBS login password | Required |
| \`SCHOOL_BBS_BASE_URL\` | BBS base URL | Required |

## Notes

- The binary will create \`.pgdata/\` and \`.state/\` directories in the **current working directory** where you run it.
- To persist data across runs, always run the binary from the same directory.
- On first use, the MCP server will automatically initialize the forum structure.
- For debugging, set \`LOG_LEVEL=debug\` to enable failure screenshots in \`.state/debug/\`.

## Troubleshooting

### \`Could not find executable\` / Browser issues
Make sure you ran \`node install-browser.js\` first.

### Session expired
The binary uses the same session persistence as the source version. If your cookies expire, either:
1. Delete \`.state/<siteKey>.json\` and restart the binary (you'll need to re-login via the source repo's login script)
2. Or use the source repo to re-login, then copy the \`.state/\` directory to where you run the binary.

## Included Tools

- \`forum_list_sites\` - List available sites
- \`forum_list_threads\` - Crawl threads from a board
- \`forum_get_thread\` - Get a single thread with replies
- \`forum_session_status\` - Check login status

## Source Repository

https://github.com/VeinsureLee/BBS_Crawler
`;

  fs.writeFileSync(path.join(releaseDir, 'README_RELEASE.md'), readmeContent.trim());

  const envExampleSrc = path.join(projectRoot, '.env.example');
  if (fs.existsSync(envExampleSrc)) {
    fs.copyFileSync(envExampleSrc, path.join(releaseDir, '.env.example'));
  } else {
    console.warn('Warning: .env.example not found');
  }

  const gitignoreRelease = `
# Data and state (generated at runtime)
.pgdata/
.state/
.env
*.log
`;
  fs.writeFileSync(path.join(releaseDir, '.gitignore'), gitignoreRelease.trim());

  console.log(`\n✅ Packaging complete!`);
  console.log(`\nOutput directory: ${releaseDir}`);
  console.log(`\nFiles created:`);
  console.log(`  - ${outputName}`);
  console.log(`  - install-browser.js`);
  console.log(`  - README_RELEASE.md`);
  console.log(`  - .env.example`);
  console.log(`  - .gitignore`);

  console.log(`\nNext steps for releasing:`);
  console.log(`  1. Test the binary locally (run from a clean directory)`);
  console.log(`  2. Create a GitHub Release`);
  console.log(`  3. Upload the binary, install-browser.js, README_RELEASE.md, and .env.example`);
  console.log(`  4. For multi-platform support, build on each target OS and upload all binaries`);
}

main().catch((err) => {
  console.error('\n❌ Packaging failed:', err);
  process.exit(1);
});
