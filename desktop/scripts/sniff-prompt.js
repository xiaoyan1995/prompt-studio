const { chromium } = require('playwright');

(async () => {
  const userDataDir = process.env.LOCALAPPDATA + '\\Playwright-NanoPhoto';
  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'msedge',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();

  // 拦截所有网络请求
  const captured = [];
  await page.route('**/*', async route => {
    const req = route.request();
    const method = req.method();
    const url = req.url();
    const postData = req.postData();

    if (postData && (url.includes('api') || url.includes('openai') || url.includes('gemini') || url.includes('anthropic') || url.includes('analyze') || url.includes('reverse') || url.includes('prompt'))) {
      console.log('\n========== 捕获到请求 ==========');
      console.log('URL:', url);
      console.log('Method:', method);
      console.log('Body:', postData.slice(0, 3000));
      captured.push({ url, method, body: postData });
    }

    await route.continue();
  });

  // 监听响应
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('api') || url.includes('openai') || url.includes('gemini') || url.includes('analyze') || url.includes('reverse') || url.includes('prompt')) {
      try {
        const text = await response.text();
        if (text && text.includes('system')) {
          console.log('\n========== 响应含 system ==========');
          console.log('URL:', url);
          console.log('Response:', text.slice(0, 3000));
        }
      } catch (_) {}
    }
  });

  await page.goto('https://nanophoto.ai/video-reverse-prompt');
  console.log('页面已打开，请在浏览器中输入一个 YouTube 视频 URL 并点击分析，控制台会自动捕获请求...');
  console.log('（按 Ctrl+C 结束）');

  console.log('（完成后直接关闭浏览器，或按 Ctrl+C 结束）');
  // 等待页面被关闭
  await new Promise(resolve => browser.on('close', resolve));
})();
