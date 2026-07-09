console.error('`npm run ingest` 已停用：audit-logger-agent 不再扫描其他 agent 的本地日志目录。');
console.error('请让所有上游 agent 主动 POST 审计事件到 `POST /v1/ingest`，由服务端写入本机 spool。');
process.exit(1);
