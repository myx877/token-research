// 只读探测 opencode 本地 SQLite 的用量字段(R7 研究门禁 / 故障诊断用)。
// 安全边界:始终以 readOnly 打开;只打印表名、列名、字段名与数字汇总,
// 绝不输出会话标题、目录路径、消息正文或凭证内容。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveDbPath() {
  const candidates = [
    process.env.OPENCODE_DB,
    path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function columnsOf(db, table) {
  try {
    return db.prepare('select name, type from pragma_table_info(?)').all(table)
      .map((c) => c.name + ':' + c.type);
  } catch (e) {
    return ['<读取失败>'];
  }
}

function safe(statement, db) {
  try {
    return db.prepare(statement).all();
  } catch (e) {
    return null;
  }
}

function main() {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.log('未找到 opencode.db(可用 OPENCODE_DB 指定路径)');
    return;
  }
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    console.log('当前 Node 无 node:sqlite(需 Node >= 22.5),无法探测。');
    return;
  }
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    ['session', 'session_v2', 'message'].forEach((table) => {
      console.log('[' + table + '] 列 = ' + columnsOf(db, table).join(', '));
    });

    const sessionTotals = safe(
      'select count(*) as n, sum(cost) as cost, sum(tokens_input) as ti,'
      + ' sum(tokens_output) as t_o, sum(tokens_reasoning) as tr,'
      + ' sum(tokens_cache_read) as tcr from session', db);
    console.log('[session 汇总]', JSON.stringify(sessionTotals && sessionTotals[0]));
    const v2Totals = safe('select count(*) as n, sum(cost) as cost from session_v2', db);
    console.log('[session_v2 汇总]', JSON.stringify(v2Totals && v2Totals[0]));

    const roles = safe("select json_extract(data,'$.role') as role, count(*) as n"
      + ' from message group by role', db);
    console.log('[message role 分布]', JSON.stringify(roles));

    const newest = safe('select time_created from message order by time_created desc limit 1', db);
    const oldest = safe('select time_created from message order by time_created asc limit 1', db);
    console.log('[message time_created 范围]', JSON.stringify({
      oldest: oldest && oldest[0] && oldest[0].time_created,
      newest: newest && newest[0] && newest[0].time_created
    }));

    // 只取字段名与数值,不打印任何正文。
    const sample = safe("select data from message where json_extract(data,'$.role')='assistant'"
      + ' order by time_created desc limit 1', db);
    if (sample && sample[0] && sample[0].data) {
      let parsed = null;
      try {
        parsed = JSON.parse(sample[0].data);
      } catch (e) {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        console.log('[assistant data 顶层字段]', Object.keys(parsed).join(', '));
        console.log('[assistant tokens 字段]',
          parsed.tokens && typeof parsed.tokens === 'object' ? Object.keys(parsed.tokens).join(', ') : '(无 tokens)');
        if (parsed.tokens && parsed.tokens.cache) {
          console.log('[assistant tokens.cache 字段]', Object.keys(parsed.tokens.cache).join(', '));
        }
        console.log('[assistant 数值字段]', JSON.stringify({
          cost: parsed.cost,
          input: parsed.tokens && parsed.tokens.input,
          output: parsed.tokens && parsed.tokens.output,
          reasoning: parsed.tokens && parsed.tokens.reasoning,
          cacheRead: parsed.tokens && parsed.tokens.cache && parsed.tokens.cache.read,
          cacheWrite: parsed.tokens && parsed.tokens.cache && parsed.tokens.cache.write,
          timeCreated: parsed.time && parsed.time.created,
          hasModelID: typeof parsed.modelID === 'string',
          hasProviderID: typeof parsed.providerID === 'string'
        }));
      }
    }

    const costSum = safe("select sum(json_extract(data,'$.cost')) as cost, count(*) as n"
      + " from message where json_extract(data,'$.role')='assistant'", db);
    console.log('[assistant cost 合计]', JSON.stringify(costSum && costSum[0]));
    console.log('DB_PATH_KIND', path.basename(dbPath));
  } finally {
    db.close();
  }
}

main();
