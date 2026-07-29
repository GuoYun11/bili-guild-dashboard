// export_cookies.js — 本地导出 B站登录 Cookie（仅本机有登录态时可用）
// 用途：GitHub Actions 云端没有本地登录态，需要把 Cookie 导成仓库密钥 BILI_COOKIES。
//       当云端抓取报 BILI_NOT_LOGGED_IN（Cookie 过期）时，重新跑一次本脚本即可。
// 用法: cd bili-guild-monitor && node scraper/export_cookies.js
//       导出后：gh secret set BILI_COOKIES --repo GuoYun11/bili-guild-dashboard --body-file scraper/cookies.json
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const PROFILE = process.env.CHROME_PROFILE || 'C:/Users/win10/WorkBuddy/2026-07-21-19-34-42/.chrome_profile_login';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = ctx.pages[0] || await ctx.newPage();
  await page.goto('https://live.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
  const cookies = await ctx.cookies();
  const out = path.join(__dirname, 'cookies.json');
  fs.writeFileSync(out, JSON.stringify(cookies, null, 2));
  console.log('已导出', cookies.length, '条 Cookie ->', out);
  console.log('请将其内容设为仓库密钥 BILI_COOKIES（或本地用 COOKIES_FILE 指向该文件）。');
  await ctx.close().catch(() => {});
})().catch(e => { console.error('导出失败:', e.message); process.exit(1); });
