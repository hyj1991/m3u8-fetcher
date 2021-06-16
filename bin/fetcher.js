#!/usr/bin/env node
'use strict';

const fetcher = require('../fetcher');
const pkg = require('../package.json');

async function main() {
  const [url, filename] = process.argv.slice(2);
  if (url === '-v') {
    console.log(`${pkg.version}`);
    return;
  }

  if (!url || !filename ||
    (!url.startsWith('http://') && !url.startsWith('https://')) ||
    !url.includes('m3u8')) {
    console.log(`\nUsage: m3u8-fetcher [m3u8 url] [output fimename]\n`);
    return;
  }

  await fetcher(url, filename);
}

main();