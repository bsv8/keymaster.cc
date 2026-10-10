import { createServer } from "node:http";

/** 主机链信息测试源：真实 HTTP，仅返回测试向量的完整交易；不签名、不广播。 */
export async function openTransactionEvidenceServer(transactions) {
  const server = createServer((request, response) => {
    const match = /^\/bsv\/(main|test)\/tx\/([0-9a-f]{64})\/hex$/u.exec(request.url ?? "");
    const raw = match && transactions.get(match[2]);
    response.writeHead(raw ? 200 : 404, { "Content-Type": "text/plain" });
    response.end(raw || "Unknown transaction evidence");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP evidence source failed to listen");
  return { endpoint: `http://127.0.0.1:${address.port}/bsv`, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
