import * as fs from 'fs';
import * as path from 'path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: tsx scripts/format-html.ts <html-file>');
  process.exit(1);
}

const html = fs.readFileSync(inputPath, 'utf-8');

// 简单格式化：在标签前后换行
let formatted = html
  .replace(/></g, '>\n<')  // 标签间换行
  .replace(/\n\s*\n/g, '\n'); // 移除空行

const outputPath = inputPath.replace(/\.html$/, '.formatted.html');
fs.writeFileSync(outputPath, formatted, 'utf-8');

console.log(`Formatted HTML saved to: ${outputPath}`);
