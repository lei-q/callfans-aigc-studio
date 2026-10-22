import { startMockCloud } from './index';

/* 开发 / 演示用：pnpm --filter @aigc/cloud-mock dev [--port 5790] */
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5790;
startMockCloud({ port, jobMs: process.env.MOCK_JOB_MS ? Number(process.env.MOCK_JOB_MS) : 900 }).then((h) => {
  console.log(`Mock 云端已启动：${h.url}`);
  console.log('  登录页 /login?code=… 与收银台 /pay?order=… 由客户端流程自动打开');
});
