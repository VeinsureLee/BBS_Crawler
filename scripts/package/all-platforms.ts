import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const releaseDir = path.resolve(projectRoot, 'release');

const targets = [
  { platform: 'win32', target: 'node20-win-x64', output: 'bbs-crawler-win-x64.exe' },
  { platform: 'linux', target: 'node20-linux-x64', output: 'bbs-crawler-linux-x64' },
  { platform: 'darwin', target: 'node20-macos-x64', output: 'bbs-crawler-macos-x64' },
];

async function main() {
  console.log('=== bbs-crawler Cross-Platform Packaging ===\n');

  if (fs.existsSync(releaseDir)) {
    console.log('Cleaning previous release...');
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(releaseDir, { recursive: true });

  console.log('1. Building TypeScript...');
  execSync('npm run build', { stdio: 'inherit', cwd: projectRoot });

  const currentPlatform = process.platform;
  console.log(`\nCurrent platform: ${currentPlatform}`);
  console.log(`Note: pkg can only build for the current platform without cross-compilation setup.\n`);

  const currentTarget = targets.find(t => t.platform === currentPlatform);
  if (!currentTarget) {
    console.error(`No target configured for platform: ${currentPlatform}`);
    process.exit(1);
  }

  console.log(`2. Packaging for ${currentPlatform}...`);
  const outputPath = path.join(releaseDir, currentTarget.output);

  execSync(`npx pkg dist/index.js --target ${currentTarget.target} --output "${outputPath}"`, {
    stdio: 'inherit',
    cwd: projectRoot
  });

  console.log('\n3. Creating common files...');

  const installBrowserScript = `
const { execSync } = require('child_process');
console.log('Installing Playwright Chromium...');
execSync('npx playwright@1.46.0 install chromium', { stdio: 'inherit' });
console.log('Done!');
`;
  fs.writeFileSync(path.join(releaseDir, 'install-browser.js'), installBrowserScript.trim());

  const readme = `# bbs-crawler Release

## Installation

1. Install Playwright Chromium:
   \`\`\`bash
   node install-browser.js
   \`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in your credentials.

3. Run the binary for your platform:
   - Windows: \`bbs-crawler-win-x64.exe\`
   - Linux: \`./bbs-crawler-linux-x64\` (chmod +x first)
   - macOS: \`./bbs-crawler-macos-x64\` (chmod +x first)

## Claude Desktop Config

\`\`\`json
{
  "mcpServers": {
    "bbs-crawler": {
      "command": "/path/to/binary",
      "env": {
        "SCHOOL_BBS_USERNAME": "...",
        "SCHOOL_BBS_PASSWORD": "...",
        "SCHOOL_BBS_BASE_URL": "..."
      }
    }
  }
}
\`\`\`

See README_RELEASE.md in the full release for detailed documentation.
`;
  fs.writeFileSync(path.join(releaseDir, 'README_RELEASE.md'), readme.trim());

  const envExamplePath = path.join(projectRoot, '.env.example');
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, path.join(releaseDir, '.env.example'));
  }

  fs.writeFileSync(path.join(releaseDir, '.gitignore'), '.pgdata/\n.state/\n.env\n*.log\n');

  console.log(`\n✅ Packaging done for ${currentPlatform}!`);
  console.log(`\nTo build for other platforms, run this script on each target OS.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
