# Changelog

## [1.0.1] - 2026-08-26
### Fixed
- **P0 Fix**: 修复了 `maidbot-access.log` 无法生成的问题。
- **Root Cause**: `dotenvx` 库拦截了 `console.log` 输出，且 `rotating-file-stream` 初始化路径存在隐患。
- **Solution**: 
  1. 重写 `utils/logger.js`，使用原生 `fs.createWriteStream` 替代第三方库。
  2. 强制使用绝对路径 `/home/ubuntu/maidbot/logs`。
  3. 使用 `process.stdout.write` 绕过环境变量库的控制台拦截。
- **Verification**: Bot 成功启动并建立 WebSocket 连接，日志文件正常写入。

### Changed
- 清理了 `index.js` 中的临时调试代码。
- 规范化了启动流程的日志输出格式。
