'use strict';

// A watch-triggered tick scans only the client whose root fired and reuses the
// anchor's partitions for every other client. When that targeted scan comes
// back unusable, the tick discards the reuse and rebuilds *all* partitions from
// one full snapshot (hasUnsafeTargetedResult in collector.js) — and that is
// where a local adapter's rows can disappear, because tokscale contributes
// nothing of its own for them: `pi`'s whole total comes from the Pi Desktop
// store and `liveagent`'s from its own database. The partition then reads zero
// for the rest of the tick and month/allTime absorb the same loss through
// applyPeriodDelta, so the displayed DAY total flips back and forth as watch
// events alternate between the reuse and the rebuild path.
//
// The local reads are therefore deliberately not gated on the target set.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

const CLAUDE_TOKENS = 10_000_000;
const PI_TOKENS = 143_000_000;
const LIVEAGENT_TOKENS = 7_000_000;

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-local-adapter-'));

  const piDir = path.join(home, '.pi-desktop');
  fs.mkdirSync(piDir, { recursive: true });
  const piDb = new sqlite.DatabaseSync(path.join(piDir, 'pi.sqlite'));
  piDb.exec(`CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    status TEXT,
    model_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    usage_json TEXT,
    started_at INTEGER,
    ended_at INTEGER
  )`);
  const now = Date.now();
  piDb.prepare('INSERT INTO turns (id, session_id, status, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'session-1', 'completed', 'deepseek-v4.1-flash', PI_TOKENS, 0, null, now - 60_000, now - 30_000);
  piDb.close();

  const liveAgentDir = path.join(home, '.liveagent');
  fs.mkdirSync(liveAgentDir, { recursive: true });
  const liveAgentDb = new sqlite.DatabaseSync(path.join(liveAgentDir, 'chat-history.sqlite3'));
  liveAgentDb.exec(`CREATE TABLE chatHistorySegment (
    conversation_id TEXT,
    segment_index INTEGER,
    segment_id TEXT,
    messages_json TEXT,
    updated_at INTEGER
  )`);
  liveAgentDb.prepare('INSERT INTO chatHistorySegment (conversation_id, segment_index, segment_id, messages_json, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('conversation-1', 0, 'segment-1', JSON.stringify([{
      id: 'assistant-1',
      role: 'assistant',
      model: 'glm-5.3',
      timestamp: new Date().toISOString(),
      usage: { input: LIVEAGENT_TOKENS, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: LIVEAGENT_TOKENS }
    }]), now);
  liveAgentDb.close();

  return home;
}

function clientPeriod(client, totalTokens) {
  const { emptyPeriod } = require('../../src/shared/usage');
  return { ...emptyPeriod(), totalTokens, clients: { [client]: totalTokens } };
}

function combinedPeriod(clientTokens) {
  const { emptyPeriod } = require('../../src/shared/usage');
  return {
    ...emptyPeriod(),
    totalTokens: Object.values(clientTokens).reduce((sum, value) => sum + value, 0),
    clients: { ...clientTokens }
  };
}

function tokscaleRows(clientTokens) {
  return {
    entries: Object.entries(clientTokens).map(([client, input]) => ({
      client,
      sessionId: `${client}-session`,
      model: `${client}-model`,
      input,
      output: 0,
      cost: 0
    }))
  };
}

const baseOptions = {
  codexLocalUsageEnabled: false,
  clients: 'claude,pi,liveagent',
  allTimeSince: '2024-01-01',
  commandTimeoutMs: 1000,
  deviceId: 'test-device',
  agentVersion: 'test',
  limitsEnabled: false,
  historyEnabled: false,
  projectsEnabled: false
};

test('a targeted tick that falls back to a full snapshot keeps the local adapters in every window', async (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const previousPiDb = process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
  const previousLiveAgentDb = process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
  delete process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
  delete process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
  const home = makeHome();
  try {
    const { collectUsageOnce, localTodayKey } = freshCollector();
    const anchorClients = { claude: CLAUDE_TOKENS, pi: PI_TOKENS, liveagent: LIVEAGENT_TOKENS };
    const anchor = {
      dateKey: localTodayKey(),
      today: combinedPeriod(anchorClients),
      month: combinedPeriod(anchorClients),
      allTime: combinedPeriod(anchorClients),
      todayPartitions: {
        claude: clientPeriod('claude', CLAUDE_TOKENS),
        pi: clientPeriod('pi', PI_TOKENS),
        liveagent: clientPeriod('liveagent', LIVEAGENT_TOKENS)
      }
    };

    const calls = [];
    const summary = await collectUsageOnce({
      ...baseOptions,
      homeDir: home,
      targetClients: ['claude'],
      todayOnlyAnchor: anchor,
      runTokscale: async ({ clients }) => {
        calls.push(clients);
        // The targeted scan attributes a row to a client it was not asked for —
        // the documented trigger for the authoritative full-snapshot rebuild.
        if (clients === 'claude') return tokscaleRows({ claude: CLAUDE_TOKENS, workbuddy: 1 });
        return tokscaleRows({ claude: CLAUDE_TOKENS });
      }
    });

    assert.deepEqual(calls, ['claude', 'claude,pi'], 'the unusable targeted result is rebuilt from a full scan');
    assert.equal(summary.today.clients.pi, PI_TOKENS, 'pi comes from the Pi Desktop store, not from tokscale');
    assert.equal(summary.today.clients.liveagent, LIVEAGENT_TOKENS, 'liveagent comes from its own database');
    assert.equal(
      summary.today.totalTokens,
      CLAUDE_TOKENS + PI_TOKENS + LIVEAGENT_TOKENS,
      'the rebuilt today snapshot must not lose the local partitions'
    );
    // month/allTime are derived from this same tick through applyPeriodDelta, so
    // a missing local partition would be subtracted out of both.
    for (const period of ['month', 'allTime']) {
      assert.equal(summary[period].clients.pi, PI_TOKENS, `${period} keeps the pi partition`);
      assert.equal(summary[period].clients.liveagent, LIVEAGENT_TOKENS, `${period} keeps the liveagent partition`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[collectorPath];
    if (previousPiDb === undefined) delete process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
    else process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH = previousPiDb;
    if (previousLiveAgentDb === undefined) delete process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
    else process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH = previousLiveAgentDb;
  }
});

test('a targeted tick that reuses the anchor still refreshes the local adapters', async (t) => {
  if (!sqlite) return t.skip('node:sqlite is not available');
  const previousPiDb = process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
  const previousLiveAgentDb = process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
  delete process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
  delete process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
  const home = makeHome();
  try {
    const { collectUsageOnce, localTodayKey } = freshCollector();
    // The anchor predates today's Pi Desktop usage: the reuse path would keep
    // this stale zero forever if the read were skipped for non-target clients.
    const anchorClients = { claude: CLAUDE_TOKENS, pi: 0, liveagent: 0 };
    const anchor = {
      dateKey: localTodayKey(),
      today: combinedPeriod(anchorClients),
      month: combinedPeriod(anchorClients),
      allTime: combinedPeriod(anchorClients),
      todayPartitions: {
        claude: clientPeriod('claude', CLAUDE_TOKENS),
        pi: clientPeriod('pi', 0),
        liveagent: clientPeriod('liveagent', 0)
      }
    };

    const summary = await collectUsageOnce({
      ...baseOptions,
      homeDir: home,
      targetClients: ['claude'],
      todayOnlyAnchor: anchor,
      runTokscale: async () => tokscaleRows({ claude: CLAUDE_TOKENS })
    });

    assert.equal(summary.today.clients.pi, PI_TOKENS);
    assert.equal(summary.today.clients.liveagent, LIVEAGENT_TOKENS);
    assert.equal(summary.today.clients.claude, CLAUDE_TOKENS);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete require.cache[collectorPath];
    if (previousPiDb === undefined) delete process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH;
    else process.env.TOKEN_MONITOR_PI_DESKTOP_DB_PATH = previousPiDb;
    if (previousLiveAgentDb === undefined) delete process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH;
    else process.env.TOKEN_MONITOR_LIVEAGENT_DB_PATH = previousLiveAgentDb;
  }
});
