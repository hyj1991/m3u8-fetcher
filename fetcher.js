'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const access = promisify(fs.access);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const urllib = require('urllib');
const pMap = require('p-map');
const AESDecryptor = require('./decryptor');

let finishNum = 0;
let mediaFileLength = 0;
let mediaFileList = [];

async function downloadM3u8(url) {
  const { data } = await urllib.curl(url);
  return data.toString();
}

function applyURL(targetURL, baseURL) {
  if (targetURL.indexOf('http') === 0) {
    return targetURL
  } else if (targetURL[0] === '/') {
    let domain = baseURL.split('/')
    return domain[0] + '//' + domain[2] + targetURL
  } else {
    let domain = baseURL.split('/')
    domain.pop()
    return domain.join('/') + '/' + targetURL
  }
}

function parseM3u8(m3u8Str, url) {
  const tsUrlList = [], finishList = [];
  m3u8Str.split('\n').forEach((item) => {
    if (item.toLowerCase().indexOf('.ts') > -1) {
      const segUrl = applyURL(item, url);
      tsUrlList.push(segUrl);
      finishList.push({
        url: segUrl,
        done: false
      });
    }
  });
  return {
    tsUrlList, finishList: finishList.map((item, index) => {
      item.index = index;
      return item;
    })
  };
}

async function getAesConf(aesConf) {
  const key = await urllib.curl(aesConf.uri);
  aesConf.key = key
  aesConf.decryptor = new AESDecryptor()
  aesConf.decryptor.constructor()
  aesConf.decryptor.expandKey(key);
}

async function prepareDownload(tsUrlList, m3u8Str, url) {
  const aesConf = {
    method: '',
    uri: '',
    iv: '',
    key: '',
    decryptor: null,
    stringToBuffer: function (str) {
      return new TextEncoder().encode(str)
    }
  };

  if (m3u8Str.indexOf('#EXT-X-KEY') > -1) {
    aesConf.method = (m3u8Str.match(/(.*METHOD=([^,\s]+))/) || ['', '', ''])[2]
    aesConf.uri = (m3u8Str.match(/(.*URI="([^"]+))"/) || ['', '', ''])[2]
    aesConf.iv = (m3u8Str.match(/(.*IV=([^,\s]+))/) || ['', '', ''])[2]
    aesConf.iv = aesConf.iv ? aesConf.stringToBuffer(aesConf.iv) : ''
    aesConf.uri = applyURL(aesConf.uri, url)

    await getAesConf(aesConf);
  }

  if (tsUrlList.length === 0) {
    console.error('M3u8 is empty, please check url.');
  }

  return { aesConf };
}

function aesDecrypt(data, index, aesConf) {
  let iv = aesConf.iv || new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, index])
  return aesConf.decryptor.decrypt(data, 0, iv.buffer || iv, true)
}

async function downloadTsSeg(index, progress, aesConf, tsUrlList, finishList, filename, progressFile) {
  if (finishList[index] && !finishList[index].done) {
    try {
      const { data: file } = await urllib.curl(tsUrlList[index], { timeout: 5 * 60 * 1000 });
      const data = aesConf.uri ? aesDecrypt(file, index, aesConf) : file;
      mediaFileList[index] = data;
      mediaFileLength += data.length;
      finishList[index].done = true;
      console.log(`[${finishNum + 1}/${tsUrlList.length}] ${filename}_${index}.ts download success，segment ${index}.`);
      progress.list = finishList;
      await writeFile(progressFile, JSON.stringify(progress));
      await writeFile(path.join(path.dirname(progressFile), `${filename}_${index}.ts`), data);

      if (++finishNum === tsUrlList.length) {
        await downloadFile(filename);
        await clearSegDir(progressFile);
      }
    } catch (err) {
      console.error(`-------- Error: the ${index} segment [${tsUrlList[index]}] download failed，will retry...: ${err}`);
      setTimeout(() => downloadTsSeg(index, progress, aesConf, tsUrlList, finishList, filename, progressFile), 100);
    }
  }
}

async function downloadFile(filename = 'x') {
  const buffer = Buffer.concat(mediaFileList, mediaFileLength);
  await writeFile(`${filename}.ts`, buffer);
  console.log(`done.`);
}

async function clearSegDir(progressFile) {
  const dir = path.dirname(progressFile);
  for (const file of await readdir(dir)) {
    await unlink(path.join(dir, file));
  }
  await rmdir(dir);
}

async function initProgress(tsSegmentDir, progressFile) {
  try {
    await access(tsSegmentDir);
  } catch (err) {
    await mkdir(tsSegmentDir, { recursive: true });
  }

  try {
    await access(progressFile);
  } catch (err) {
    await writeFile(progressFile, JSON.stringify(
      {
        list: []
      }
    ));
  }
}

async function start(url, filename) {
  const tsSegmentDir = path.join(process.cwd(), filename);
  const progressFile = path.join(process.cwd(), filename, 'progress.json');
  await initProgress(tsSegmentDir, progressFile);

  let m3u8 = '', tsUrlList = [], finishList = [];

  const progress = JSON.parse(await readFile(progressFile, 'utf8')) || { m3u8: '', list: [] };
  if (progress.list.length && progress.m3u8) {
    tsUrlList = progress.list.map(({ url }) => url);
    finishList = progress.list;
    m3u8 = progress.m3u8;
    for (const { index, done } of finishList) {
      if (!done) {
        continue;
      }
      finishNum++;
      mediaFileList[index] = await readFile(path.join(tsSegmentDir, `${filename}_${index}.ts`));
    }
  } else {
    m3u8 = await downloadM3u8(url);
    ({ tsUrlList, finishList } = parseM3u8(m3u8, url));
    progress.m3u8 = m3u8;
    progress.list = finishList;
    await writeFile(progressFile, JSON.stringify(progress));
  }

  const { aesConf } = await prepareDownload(tsUrlList, finishList, m3u8, url);
  await pMap(tsUrlList, async tsUrl => {
    const index = tsUrlList.indexOf(tsUrl);
    await downloadTsSeg(index, progress, aesConf, tsUrlList, finishList, filename, progressFile);
  }, { concurrency: 10 });
}

module.exports = start;