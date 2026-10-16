// Print aria2's active and recently stopped downloads (gid, status, bytes, error, path).
//   node tools/probe/aria2-status.js
// Uses the local RPC from Start aria2 download.bat.
const call = async (method, params = []) =>
  (
    await (
      await fetch('http://127.0.0.1:6800/jsonrpc', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params: ['token:linkswift-local-check', ...params] }),
      })
    ).json()
  ).result;

(async () => {
  const keys = ['gid', 'status', 'totalLength', 'completedLength', 'errorCode', 'errorMessage', 'files'];
  const rows = [...(await call('aria2.tellActive', [keys])), ...(await call('aria2.tellStopped', [0, 10, keys]))];
  for (const row of rows) row.files = row.files.map((file) => file.path);
  console.log(JSON.stringify(rows, null, 1));
})();
